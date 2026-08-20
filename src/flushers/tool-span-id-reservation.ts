import type { Context } from '@opentelemetry/api';
import {
  RandomIdGenerator,
  type IdGenerator,
} from '@opentelemetry/sdk-trace-base';
import type {
  EntryInvocation,
  ExecuteToolInvocation,
  ExtendedTelemetryHandler,
  InvokeAgentInvocation,
  ReactStepInvocation,
} from '@loongsuite/otel-util-genai';
import type { LLMInvocation } from '@loongsuite/otel-util-genai';
import type { AgentActivityEntry } from '../types/index.js';

const VALID_SPAN_ID_RE = /^[0-9a-f]{16}$/;
const ZERO_SPAN_ID = '0'.repeat(16);

function validSpanId(value: unknown): value is string {
  return typeof value === 'string'
    && VALID_SPAN_ID_RE.test(value)
    && value !== ZERO_SPAN_ID;
}

/**
 * OTel's public startSpan API cannot accept a caller-selected span id. This
 * generator provides one reserved id for the immediately following span and
 * otherwise delegates to the SDK's cryptographically random generator.
 */
export class ReservedToolSpanIdGenerator implements IdGenerator {
  private readonly fallback = new RandomIdGenerator();
  private reserved?: string;

  generateTraceId = (): string => this.fallback.generateTraceId();

  generateSpanId = (): string => {
    const reserved = this.reserved;
    this.reserved = undefined;
    return reserved ?? this.fallback.generateSpanId();
  };

  reserve(spanId: unknown): boolean {
    if (!validSpanId(spanId)) return false;
    this.reserved = spanId;
    return true;
  }

  clear(): void {
    this.reserved = undefined;
  }
}

/**
 * Maps converter tool invocations back to their canonical event span_id.
 * Duplicate/conflicting ids fail open instead of selecting an ambiguous id.
 */
export class ToolSpanIdReservations {
  private readonly byToolCallId = new Map<string, string>();
  private entrySpanIds: string[] = [];
  private agentSpanIds: string[] = [];
  private stepSpanIds: string[] = [];
  private llmSpanIds: string[] = [];

  prepare(records: AgentActivityEntry[]): void {
    this.clear();
    const conflicts = new Set<string>();

    // The event-log converter exposes no public span-id hook for ENTRY,
    // AGENT, STEP, or LLM. Droid replay requires all of those spans to keep
    // stable IDs, so the adapter stamps private reservation attributes which
    // are consumed here and never passed through to exported attributes.
    const droidRecords = records.filter(
      record => record['gen_ai.agent.type'] === 'droid',
    );
    this.entrySpanIds = uniqueValidIds(
      droidRecords.map(record => record['agent.droid.entry.span_id']),
    );
    this.agentSpanIds = uniqueValidIds(
      droidRecords.map(record => record['agent.droid.agent.span_id']),
    );

    const stepOrder = new Map<string, string>();
    for (const record of droidRecords) {
      const stepId = record['gen_ai.step.id'];
      const spanId = record['agent.droid.step.span_id'];
      if (typeof stepId !== 'string' || stepOrder.has(stepId) || !validSpanId(spanId)) continue;
      stepOrder.set(stepId, spanId);
    }
    this.stepSpanIds = [...stepOrder.values()];

    // Droid emits one LLM request/response pair per STEP. Converter visits
    // steps in first-seen order and LLM pairs before tools, so request order
    // is the exact reservation order used by startLlm().
    this.llmSpanIds = uniqueValidIds(
      droidRecords
        .filter(record => record['event.name'] === 'llm.request')
        .map(record => record.span_id),
    );

    for (const record of records) {
      const eventName = record['event.name'];
      if (eventName !== 'tool.call' && eventName !== 'tool.result') continue;

      const toolCallId = record['gen_ai.tool.call.id'];
      const spanId = record.span_id;
      if (typeof toolCallId !== 'string' || !toolCallId || !validSpanId(spanId)) continue;

      const existing = this.byToolCallId.get(toolCallId);
      if (existing && existing !== spanId) {
        conflicts.add(toolCallId);
        this.byToolCallId.delete(toolCallId);
      } else if (!conflicts.has(toolCallId)) {
        this.byToolCallId.set(toolCallId, spanId);
      }
    }
  }

  take(toolCallId: string | null | undefined): string | undefined {
    if (!toolCallId) return undefined;
    const spanId = this.byToolCallId.get(toolCallId);
    this.byToolCallId.delete(toolCallId);
    return spanId;
  }

  takeEntry(): string | undefined {
    return this.entrySpanIds.shift();
  }

  takeAgent(): string | undefined {
    return this.agentSpanIds.shift();
  }

  takeStep(): string | undefined {
    return this.stepSpanIds.shift();
  }

  takeLlm(): string | undefined {
    return this.llmSpanIds.shift();
  }

  clear(): void {
    this.byToolCallId.clear();
    this.entrySpanIds = [];
    this.agentSpanIds = [];
    this.stepSpanIds = [];
    this.llmSpanIds = [];
  }
}

function uniqueValidIds(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!validSpanId(value) || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/**
 * Decorate the converter handler so the generator reservation is active only
 * for the synchronous startExecuteTool -> startSpan call.
 */
export function attachReservedToolSpanIds(
  handler: ExtendedTelemetryHandler,
  idGenerator: ReservedToolSpanIdGenerator,
  attachDroidHierarchy = false,
): ToolSpanIdReservations {
  const reservations = new ToolSpanIdReservations();
  const originalTool = handler.startExecuteTool;

  // Unit tests mock the third-party handler with a minimal object.
  if (typeof originalTool !== 'function') return reservations;

  handler.startExecuteTool = function startExecuteToolWithReservedId(
    invocation: ExecuteToolInvocation,
    parentContext?: Context,
    startTime?: number,
  ): ExecuteToolInvocation {
    const spanId = reservations.take(invocation.toolCallId);
    if (spanId) idGenerator.reserve(spanId);
    try {
      return originalTool.call(handler, invocation, parentContext, startTime);
    } finally {
      // Prevent a converter/SDK exception from leaking the reservation to the
      // next unrelated span.
      idGenerator.clear();
    }
  };

  // Keep the third-party handler byte-for-byte equivalent for every existing
  // agent. Only Droid needs deterministic ENTRY/AGENT/STEP/LLM reservations;
  // wrapping these methods globally changes nested converter behavior.
  if (!attachDroidHierarchy) return reservations;

  const originalEntry = handler.startEntry;
  if (typeof originalEntry === 'function') {
    handler.startEntry = function startEntryWithReservedId(
      invocation: EntryInvocation,
      parentContext?: Context,
      startTime?: number,
    ): EntryInvocation {
      return withReservedSpanId(idGenerator, reservations.takeEntry(), () =>
        originalEntry.call(handler, invocation, parentContext, startTime));
    };
  }

  const originalAgent = handler.startInvokeAgent;
  if (typeof originalAgent === 'function') {
    handler.startInvokeAgent = function startInvokeAgentWithReservedId(
      invocation: InvokeAgentInvocation,
      parentContext?: Context,
      startTime?: number,
    ): InvokeAgentInvocation {
      return withReservedSpanId(idGenerator, reservations.takeAgent(), () =>
        originalAgent.call(handler, invocation, parentContext, startTime));
    };
  }

  const originalStep = handler.startReactStep;
  if (typeof originalStep === 'function') {
    handler.startReactStep = function startReactStepWithReservedId(
      invocation: ReactStepInvocation,
      parentContext?: Context,
      startTime?: number,
    ): ReactStepInvocation {
      return withReservedSpanId(idGenerator, reservations.takeStep(), () =>
        originalStep.call(handler, invocation, parentContext, startTime));
    };
  }

  const originalLlm = handler.startLlm;
  if (typeof originalLlm === 'function') {
    handler.startLlm = function startLlmWithReservedId(
      invocation: LLMInvocation,
      parentContext?: Context,
      startTime?: number,
    ): LLMInvocation {
      return withReservedSpanId(idGenerator, reservations.takeLlm(), () =>
        originalLlm.call(handler, invocation, parentContext, startTime));
    };
  }

  return reservations;
}

function withReservedSpanId<T>(
  idGenerator: ReservedToolSpanIdGenerator,
  spanId: string | undefined,
  start: () => T,
): T {
  // Preserve the exact pre-Droid behavior for every other agent. Clearing an
  // unowned generator reservation here can erase a TOOL id reserved by an
  // outer/nested converter call.
  if (!spanId) return start();
  if (spanId) idGenerator.reserve(spanId);
  try {
    return start();
  } finally {
    idGenerator.clear();
  }
}
