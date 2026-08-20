import { createHash } from 'node:crypto';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { ClientType } from '../../types/index.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { usageFromDroidSettings } from './droid-parser.js';
import type {
  DroidBuildOptions,
  DroidBuildResult,
  DroidContentBlock,
  DroidHookEvent,
  DroidLlmObservation,
  DroidMessagePart,
  DroidRecord,
  DroidUsage,
} from './droid-types.js';

const MAX_TOOL_PAYLOAD_BYTES = 64 * 1024;
const MAX_TOOL_PREVIEW_BYTES = 8 * 1024;

interface SessionMetadata {
  cwd?: string;
  parentSessionId?: string;
}

interface TurnContext {
  turnId: string;
  traceId: string;
  entrySpanId: string;
  agentSpanId: string;
  ordinal: number;
  stepOrdinal: number;
  firstStep: boolean;
  pendingDelta: Array<Record<string, JsonValue>>;
  lastInputAtMs?: number;
  finalResponse?: AgentActivityEntry;
  lastResponse?: AgentActivityEntry;
}

interface StepContext {
  turn: TurnContext;
  stepId: string;
  stepSpanId: string;
  llmSpanId: string;
  model?: string;
  provider: string;
}

interface ToolContext {
  callId: string;
  name: string;
  step: StepContext;
  callTimestamp: number;
  spanId: string;
}

interface ResolvedHook extends DroidHookEvent {
  consumed?: boolean;
}

export type DroidSettingsUsageScope = 'complete_transcript' | 'session_aggregate';

export interface DroidEventBuildOptions extends DroidBuildOptions {
  /**
   * Provenance for settings.tokenUsage. Standard usage is safe only when the
   * supplied records cover the complete current transcript and contain one
   * real LLM response. Incremental callers must keep the session total as a
   * diagnostic because an unobserved baseline may contain earlier calls.
   */
  settingsUsageScope?: DroidSettingsUsageScope;
}

export async function buildDroidEvents(
  records: DroidRecord[],
  opts: DroidEventBuildOptions,
): Promise<DroidBuildResult> {
  const metadata = sessionMetadata(records);
  const hooks = collectHookEvents(records, opts.hookEvents);
  const observations = new ObservationResolver(opts.sessionId, opts.observations);
  const transcriptLlmResponseCount = records.filter(record =>
    record.message?.role === 'assistant'
    && contentBlocks(record.message.content).length > 0).length;
  const built: AgentActivityEntry[] = [];
  const tools = new Map<string, ToolContext>();
  let turn: TurnContext | undefined;

  const push = async (entry: AgentActivityEntry, source?: DroidRecord) => {
    if (metadata.cwd) {
      entry['workspace.path'] = metadata.cwd;
      entry['agent.droid.cwd'] = metadata.cwd;
      await enrichCanonicalEntryWithGit(entry, { 'agent.droid.cwd': metadata.cwd }, 'droid');
    }
    if (source?.id) entry['agent.droid.source_record_id'] = source.id;
    if (metadata.parentSessionId) {
      entry['agent.droid.parent_session.id'] = metadata.parentSessionId;
    }
    built.push(entry);
  };

  const closeCancelledTurn = async (source: DroidRecord, boundaryTimestamp: number) => {
    if (!turn || turn.finalResponse) return;
    if (turn.lastResponse) {
      turn.lastResponse['gen_ai.response.finish_reasons'] = ['cancelled'];
      turn.lastResponse['gen_ai.turn.end'] = true;
      const messages = turn.lastResponse['gen_ai.output.messages'];
      if (Array.isArray(messages)) {
        for (const message of messages) {
          if (isObject(message)) message.finish_reason = 'cancelled';
        }
      }
      turn.finalResponse = turn.lastResponse;
    } else {
      // A Stop/SessionEnd hook or a subsequent real prompt is an explicit turn
      // boundary even when Droid never persisted an assistant message. Emit a
      // synthetic empty LLM pair so downstream conversion can close STEP/LLM
      // deterministically instead of leaving an orphaned turn open forever.
      const step = createStep(opts, turn, source, undefined);
      const requestTimestamp = turn.lastInputAtMs ?? boundaryTimestamp;
      const request = baseStepEntry(
        'llm.request',
        opts,
        metadata,
        step,
        `request:${step.stepId}:cancelled-boundary`,
        requestTimestamp,
        step.llmSpanId,
      );
      request['gen_ai.request.id'] = step.stepId;
      if (step.model) request['gen_ai.request.model'] = step.model;
      request['gen_ai.turn.start'] = true;
      if (turn.pendingDelta.length > 0) {
        request['gen_ai.input.messages_delta'] = turn.pendingDelta;
      }
      const response = baseStepEntry(
        'llm.response',
        opts,
        metadata,
        step,
        `response:${step.stepId}:cancelled-boundary`,
        boundaryTimestamp,
        step.llmSpanId,
      );
      response['gen_ai.response.id'] = stableId(
        opts.sessionId,
        `response:${step.stepId}:cancelled-boundary`,
      );
      if (step.model) response['gen_ai.response.model'] = step.model;
      response['gen_ai.response.finish_reasons'] = ['cancelled'];
      response['gen_ai.turn.end'] = true;
      response['agent.droid.usage.completeness'] = 'missing';
      response['agent.droid.response.synthetic'] = 'cancelled_boundary';
      await push(request, source);
      await push(response, source);
      turn.lastResponse = response;
      turn.finalResponse = response;
      turn.pendingDelta = [];
      turn.firstStep = false;
    }
    for (const [callId, tool] of tools) {
      if (tool.step.turn !== turn) continue;
      const result = baseStepEntry(
        'tool.result',
        opts,
        metadata,
        tool.step,
        `tool-result:${callId}`,
        boundaryTimestamp,
        tool.spanId,
      );
      result['gen_ai.tool.name'] = tool.name;
      result['gen_ai.tool.call.id'] = callId;
      result['tool.result.status'] = 'cancelled';
      const duration = boundaryTimestamp - tool.callTimestamp;
      if (duration >= 0) result['gen_ai.tool.call.duration'] = duration;
      await push(result, source);
      tools.delete(callId);
    }
  };

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const message = record.message;
    if (record.type === 'session_start' || !message) continue;
    if (message.visibility === 'user_only') {
      if (message.hookEventName === 'Stop' || message.hookEventName === 'SessionEnd') {
        await closeCancelledTurn(
          record,
          finiteNumber(message.hookEndTime) ?? timestampMs(record) ?? Date.now(),
        );
      }
      continue;
    }
    if (message.visibility === 'llm_only') continue;

    if (message.role === 'user' && !hasToolResults(message.content)) {
      const parts = messageParts(message.content, 'user');
      if (parts.length === 0) continue;
      const timestamp = timestampMs(record) ?? Date.now();
      await closeCancelledTurn(record, timestamp);
      const ordinal = (turn?.ordinal ?? 0) + 1;
      const turnSeed = stringValue(record.id) ?? `${ordinal}:${timestamp}`;
      const turnId = stringValue(record.id) ?? stableId(opts.sessionId, `turn:${turnSeed}`);
      turn = {
        turnId,
        traceId: stableHexParts([opts.sessionId, turnId, 'turn'], 32),
        entrySpanId: stableHexParts([opts.sessionId, turnId, 'entry', '1'], 16),
        agentSpanId: stableHexParts([opts.sessionId, turnId, 'agent', '1'], 16),
        ordinal,
        stepOrdinal: 0,
        firstStep: true,
        pendingDelta: [{ role: 'user', parts }],
        lastInputAtMs: timestamp,
      };
      tools.clear();
      const prompt = baseEntry(
        'other',
        opts,
        metadata,
        turn,
        `prompt:${turnSeed}`,
        timestamp,
      );
      prompt.span_id = turn.agentSpanId;
      prompt['gen_ai.input.messages_delta'] = turn.pendingDelta;
      await push(prompt, record);
      continue;
    }

    if (message.role === 'user' && hasToolResults(message.content)) {
      if (!turn) continue;
      for (const block of contentBlocks(message.content)) {
        if (block.type !== 'tool_result') continue;
        const callId = stringValue(block.tool_use_id);
        if (!callId) continue;
        const tool = tools.get(callId);
        const hook = takeToolHook(hooks, 'PostToolUse', callId, tool?.name);
        const resultTimestamp = hook?.observedAtMs ?? timestampMs(record);
        if (!tool || resultTimestamp === undefined) continue;
        const result = baseStepEntry(
          'tool.result',
          opts,
          metadata,
          tool.step,
          `tool-result:${callId}`,
          resultTimestamp,
          tool.spanId,
        );
        result['gen_ai.tool.name'] = tool.name;
        result['gen_ai.tool.call.id'] = callId;
        const output = boundedToolJsonValue(block.content);
        if (output !== undefined) result['gen_ai.tool.call.result'] = output;
        const failed = block.is_error === true;
        result['tool.result.status'] = failed ? 'failure' : 'success';
        if (failed) result['error.type'] = 'tool_execution_failed';
        const duration = resultTimestamp - tool.callTimestamp;
        if (duration >= 0) result['gen_ai.tool.call.duration'] = duration;
        await push(result, record);
        tools.delete(callId);
        turn.pendingDelta.push({
          role: 'tool',
          parts: [{
            type: 'tool_call_response',
            id: callId,
            response: output ?? null,
          }],
        });
        turn.lastInputAtMs = resultTimestamp;
      }
      continue;
    }

    if (message.role !== 'assistant' || !turn) continue;
    const blocks = contentBlocks(message.content);
    if (blocks.length === 0) continue;
    const assistantTimestamp = timestampMs(record);
    const observation = observations.take(assistantTimestamp);
    const step = createStep(opts, turn, record, observation);
    const responseTimestamp = observation?.completedAtMs
      ?? assistantTimestamp
      ?? terminalHookTimestamp(hooks)
      ?? turn.lastInputAtMs
      ?? Date.now();
    const requestTimestamp = observation?.startedAtMs
      ?? turn.lastInputAtMs
      ?? responseTimestamp;
    const request = baseStepEntry(
      'llm.request',
      opts,
      metadata,
      step,
      `request:${step.stepId}`,
      requestTimestamp,
      step.llmSpanId,
    );
    request['gen_ai.request.id'] = step.stepId;
    if (step.model) request['gen_ai.request.model'] = step.model;
    if (turn.firstStep) request['gen_ai.turn.start'] = true;
    if (turn.pendingDelta.length > 0) request['gen_ai.input.messages_delta'] = turn.pendingDelta;

    const toolBlocks = blocks.filter(block => block.type === 'tool_use');
    const terminalBoundary = hasTerminalBoundaryAfter(hooks, assistantTimestamp);
    const finishReason = observation?.finishReason
      ?? (toolBlocks.length > 0 ? 'tool_call' : terminalBoundary ? 'stop' : 'unknown');
    const response = baseStepEntry(
      'llm.response',
      opts,
      metadata,
      step,
      `response:${stringValue(record.id) ?? step.stepId}`,
      responseTimestamp,
      step.llmSpanId,
    );
    response['gen_ai.response.id'] = observation?.responseId
      ?? stringValue(record.id)
      ?? stableId(opts.sessionId, `response:${step.stepId}`);
    if (step.model) response['gen_ai.response.model'] = step.model;
    response['gen_ai.response.finish_reasons'] = [finishReason];
    const outputParts = blocks.flatMap(toAssistantPart);
    if (outputParts.length > 0) {
      response['gen_ai.output.messages'] = [{
        role: 'assistant',
        parts: outputParts,
        finish_reason: finishReason,
      }];
    }
    if (observation) {
      applyPerCallUsage(response, observation);
      response['agent.droid.usage.completeness'] = 'per_call';
    } else {
      response['agent.droid.usage.completeness'] = 'missing';
    }
    if (finishReason === 'stop') {
      response['gen_ai.turn.end'] = true;
      turn.finalResponse = response;
    }

    await push(request, record);
    await push(response, record);
    turn.lastResponse = response;

    const assistantDelta: DroidMessagePart[] = [];
    for (const block of toolBlocks) {
      const callId = stringValue(block.id);
      const name = stringValue(block.name);
      if (!callId || !name) continue;
      const hook = takeToolHook(hooks, 'PreToolUse', callId, name);
      const callTimestamp = hook?.observedAtMs ?? responseTimestamp;
      const toolSpanId = stableHexParts([opts.sessionId, turn.turnId, 'tool', callId], 16);
      const call = baseStepEntry(
        'tool.call',
        opts,
        metadata,
        step,
        `tool-call:${callId}`,
        callTimestamp,
        toolSpanId,
      );
      call['gen_ai.tool.name'] = name;
      call['gen_ai.tool.call.id'] = callId;
      const args = boundedToolJsonValue(block.input);
      if (args !== undefined) call['gen_ai.tool.call.arguments'] = args;
      await push(call, record);
      tools.set(callId, {
        callId,
        name,
        step,
        callTimestamp,
        spanId: toolSpanId,
      });
      const part: DroidMessagePart = { type: 'tool_call', id: callId, name };
      if (args !== undefined) part.arguments = args;
      assistantDelta.push(part);
    }

    turn.pendingDelta = assistantDelta.length > 0
      ? [{ role: 'assistant', parts: assistantDelta }]
      : [];
    turn.lastInputAtMs = responseTimestamp;
    turn.firstStep = false;
  }

  // settings.tokenUsage is Droid's authoritative absolute counter. Exact log
  // observations are segment deltas, never an absolute replacement: they can
  // advance a known checkpoint but must remain unknown without one.
  const settingsUsage = usageFromDroidSettings(opts.settings);
  const observedDelta = sumUsage(observations.consumedForSession());
  const observedFinalUsage = opts.initialUsage && observedDelta
    ? addUsage(opts.initialUsage, observedDelta)
    : undefined;
  const finalUsage = resolveCumulativeUsage(
    settingsUsage,
    opts.initialUsage,
    observedFinalUsage,
  );
  if (settingsUsage && finalUsage) {
    applyAggregateUsage(
      built,
      finalUsage,
      opts.initialUsage,
      opts.settingsUsageScope ?? 'session_aggregate',
      transcriptLlmResponseCount,
    );
  }

  return { entries: built, finalUsage };
}

class ObservationResolver {
  private static readonly MAX_COMPLETION_SKEW_MS = 1_000;
  private readonly available: Array<DroidLlmObservation & { consumed?: boolean }>;

  constructor(sessionId: string, observations: DroidLlmObservation[] = []) {
    this.available = observations
      .filter(item => item.sessionId === sessionId)
      .sort((left, right) => left.completedAtMs - right.completedAtMs)
      .map(item => ({ ...item }));
  }

  take(assistantTimestamp: number | undefined): DroidLlmObservation | undefined {
    if (assistantTimestamp === undefined) return undefined;
    const candidates = this.available.filter(item =>
      !item.consumed
      && Math.abs(item.completedAtMs - assistantTimestamp)
        <= ObservationResolver.MAX_COMPLETION_SKEW_MS);
    // Do not guess when concurrent/retried model calls make the time join
    // ambiguous. Aggregate settings remain available as an explicit fallback.
    if (candidates.length !== 1) return undefined;
    const selected = candidates[0];
    selected.consumed = true;
    return selected;
  }

  consumedForSession(): DroidLlmObservation[] {
    return this.available.filter(item => item.consumed);
  }
}

function sessionMetadata(records: DroidRecord[]): SessionMetadata {
  const start = records.find(record => record.type === 'session_start');
  return {
    cwd: stringValue(start?.cwd),
    parentSessionId: stringValue(start?.parent) ?? stringValue(start?.callingSessionId),
  };
}

function collectHookEvents(
  records: DroidRecord[],
  external: DroidHookEvent[] = [],
): ResolvedHook[] {
  const embedded: ResolvedHook[] = [];
  for (const record of records) {
    const message = record.message;
    if (message?.visibility !== 'user_only') continue;
    const eventName = stringValue(message.hookEventName);
    if (!eventName) continue;
    const observedAtMs = finiteNumber(message.hookEndTime)
      ?? timestampMs(record)
      ?? finiteNumber(message.hookStartTime);
    if (observedAtMs === undefined) continue;
    embedded.push({
      eventName,
      observedAtMs,
      toolName: stringValue(message.hookMatcher),
      toolCallId: stringValue(message.hookToolCallId),
    });
  }
  return [...embedded, ...external]
    .filter(event => Number.isFinite(event.observedAtMs))
    .sort((left, right) => left.observedAtMs - right.observedAtMs);
}

function takeToolHook(
  hooks: ResolvedHook[],
  eventName: 'PreToolUse' | 'PostToolUse',
  callId: string,
  toolName?: string,
): ResolvedHook | undefined {
  const exact = hooks.find(event =>
    !event.consumed
    && event.eventName === eventName
    && event.toolCallId === callId);
  const match = exact ?? hooks.find(event =>
    !event.consumed
    && event.eventName === eventName
    && event.toolCallId === undefined
    && (toolName === undefined || event.toolName === undefined || event.toolName === toolName));
  if (match) match.consumed = true;
  return match;
}

function terminalHookTimestamp(hooks: ResolvedHook[]): number | undefined {
  const timestamps = hooks
    .filter(event => event.eventName === 'Stop' || event.eventName === 'SessionEnd')
    .map(event => event.observedAtMs);
  return timestamps.length > 0 ? Math.min(...timestamps) : undefined;
}

function hasTerminalBoundaryAfter(
  hooks: ResolvedHook[],
  timestamp: number | undefined,
): boolean {
  return hooks.some(event =>
    (event.eventName === 'Stop' || event.eventName === 'SessionEnd')
    && (timestamp === undefined || event.observedAtMs >= timestamp));
}

function createStep(
  opts: DroidBuildOptions,
  turn: TurnContext,
  record: DroidRecord,
  observation: DroidLlmObservation | undefined,
): StepContext {
  turn.stepOrdinal++;
  const stepId = `${turn.turnId}:s${turn.stepOrdinal}`;
  return {
    turn,
    stepId,
    stepSpanId: stableHexParts([
      opts.sessionId,
      turn.turnId,
      'step',
      String(turn.stepOrdinal),
    ], 16),
    llmSpanId: stableHexParts([
      opts.sessionId,
      turn.turnId,
      'llm',
      String(turn.stepOrdinal),
    ], 16),
    model: stringValue(record.message?.modelId)
      ?? observation?.modelId
      ?? stringValue(opts.settings?.model),
    provider: stringValue(record.message?.apiProvider)
      ?? stringValue(opts.settings?.apiProviderLock)
      ?? stringValue(opts.settings?.providerLock)
      ?? 'factory',
  };
}

function baseEntry(
  eventName: AgentActivityEntry['event.name'],
  opts: DroidBuildOptions,
  metadata: SessionMetadata,
  turn: TurnContext,
  eventSeed: string,
  timestamp: number,
): AgentActivityEntry {
  return {
    time_unix_nano: millisecondsToNanoseconds(timestamp),
    observed_time_unix_nano: millisecondsToNanoseconds(Date.now()),
    'event.id': stableId(opts.sessionId, `${turn.turnId}:${eventSeed}`),
    'event.name': eventName,
    // InputManager injects the configured Pilot user id. Droid transcript
    // owner/host identifiers are deliberately not copied into telemetry.
    'user.id': '',
    trace_id: turn.traceId,
    'gen_ai.session.id': opts.sessionId,
    'gen_ai.turn.id': turn.turnId,
    'gen_ai.agent.type': ClientType.Droid,
    'gen_ai.agent.id': opts.sessionId,
    'gen_ai.provider.name': canonicalProvider(
      stringValue(opts.settings?.apiProviderLock)
        ?? stringValue(opts.settings?.providerLock),
    ),
    'agent.droid.entry.span_id': turn.entrySpanId,
    'agent.droid.agent.span_id': turn.agentSpanId,
  };
}

function baseStepEntry(
  eventName: AgentActivityEntry['event.name'],
  opts: DroidBuildOptions,
  metadata: SessionMetadata,
  step: StepContext,
  eventSeed: string,
  timestamp: number,
  spanId: string,
): AgentActivityEntry {
  const entry = baseEntry(eventName, opts, metadata, step.turn, eventSeed, timestamp);
  entry.span_id = spanId;
  entry.parent_span_id = step.stepSpanId;
  entry['gen_ai.step.id'] = step.stepId;
  entry['gen_ai.provider.name'] = canonicalProvider(step.provider);
  entry['agent.droid.api_provider'] = step.provider;
  entry['agent.droid.step.span_id'] = step.stepSpanId;
  return entry;
}

function applyPerCallUsage(
  response: AgentActivityEntry,
  observation: DroidLlmObservation,
): void {
  const usage = observation.usage;
  response['gen_ai.usage.input_tokens'] = usage.inputTokens;
  response['gen_ai.usage.output_tokens'] = usage.outputTokens;
  response['gen_ai.usage.total_tokens'] = usage.totalTokens;
  if (usage.cacheReadTokens !== undefined) {
    response['gen_ai.usage.cache_read.input_tokens'] = usage.cacheReadTokens;
  }
  if (usage.cacheCreationTokens !== undefined) {
    response['gen_ai.usage.cache_creation.input_tokens'] = usage.cacheCreationTokens;
  }
  if (usage.reasoningTokens !== undefined) {
    response['gen_ai.usage.reasoning_tokens'] = usage.reasoningTokens;
  }
  if (observation.timeToFirstTokenNs !== undefined) {
    response['gen_ai.response.time_to_first_token'] = observation.timeToFirstTokenNs;
  }
}

function applyAggregateUsage(
  entries: AgentActivityEntry[],
  finalUsage: DroidUsage,
  initialUsage: DroidUsage | undefined,
  settingsUsageScope: DroidSettingsUsageScope,
  transcriptLlmResponseCount: number,
): void {
  const responses = entries.filter(entry => entry['event.name'] === 'llm.response');
  if (responses.length === 0 || responses.some(entry => entry['agent.droid.usage.completeness'] === 'per_call')) {
    return;
  }
  const terminal = responses[responses.length - 1];
  if (initialUsage) {
    const delta = subtractUsage(finalUsage, initialUsage);
    if (delta.inputTokens === 0 && delta.outputTokens === 0 && delta.totalTokens === 0) {
      return;
    }
    const turnIds = new Set(responses
      .map(entry => entry['gen_ai.turn.id'])
      .filter((value): value is string => typeof value === 'string' && value.length > 0));
    // A cumulative settings delta may cover every turn appended since the last
    // poll. Without per-turn snapshots, assigning that segment total to the
    // final turn would be false precision; leave each response explicitly
    // missing while still advancing the session checkpoint.
    if (turnIds.size !== 1) return;
    if (
      responses.length === 1
      && transcriptLlmResponseCount === 1
      && terminal['agent.droid.response.synthetic'] === undefined
    ) {
      terminal['agent.droid.usage.completeness'] = 'single_call_delta';
      applyUsage(terminal, delta);
    } else {
      terminal['agent.droid.usage.completeness'] = 'turn_aggregate';
      applyNamespacedUsage(terminal, 'agent.droid.turn.usage', delta);
    }
  } else {
    terminal['agent.droid.usage.completeness'] = 'session_aggregate';
    applyNamespacedUsage(terminal, 'agent.droid.session.usage', finalUsage);
    if (
      settingsUsageScope === 'complete_transcript'
      && transcriptLlmResponseCount === 1
      && responses.length === 1
      && terminal['agent.droid.response.synthetic'] === undefined
    ) {
      applyUsage(terminal, finalUsage);
    }
  }
}

function applyNamespacedUsage(
  entry: AgentActivityEntry,
  namespace: string,
  usage: DroidUsage,
): void {
  entry[`${namespace}.input_tokens`] = usage.inputTokens;
  entry[`${namespace}.output_tokens`] = usage.outputTokens;
  entry[`${namespace}.total_tokens`] = usage.totalTokens;
  if (usage.cacheReadTokens !== undefined) {
    entry[`${namespace}.cache_read_tokens`] = usage.cacheReadTokens;
  }
  if (usage.cacheCreationTokens !== undefined) {
    entry[`${namespace}.cache_creation_tokens`] = usage.cacheCreationTokens;
  }
  if (usage.reasoningTokens !== undefined) {
    entry[`${namespace}.reasoning_tokens`] = usage.reasoningTokens;
  }
}

function applyUsage(entry: AgentActivityEntry, usage: DroidUsage): void {
  entry['gen_ai.usage.input_tokens'] = usage.inputTokens;
  entry['gen_ai.usage.output_tokens'] = usage.outputTokens;
  entry['gen_ai.usage.total_tokens'] = usage.totalTokens;
  if (usage.cacheReadTokens !== undefined) {
    entry['gen_ai.usage.cache_read.input_tokens'] = usage.cacheReadTokens;
  }
  if (usage.cacheCreationTokens !== undefined) {
    entry['gen_ai.usage.cache_creation.input_tokens'] = usage.cacheCreationTokens;
  }
  if (usage.reasoningTokens !== undefined) {
    entry['gen_ai.usage.reasoning_tokens'] = usage.reasoningTokens;
  }
}

function subtractUsage(finalUsage: DroidUsage, initialUsage: DroidUsage): DroidUsage {
  const delta = (finalValue: number | undefined, initialValue: number | undefined) =>
    Math.max(0, (finalValue ?? 0) - (initialValue ?? 0));
  return {
    inputTokens: delta(finalUsage.inputTokens, initialUsage.inputTokens),
    outputTokens: delta(finalUsage.outputTokens, initialUsage.outputTokens),
    totalTokens: delta(finalUsage.totalTokens, initialUsage.totalTokens),
    cacheReadTokens: delta(finalUsage.cacheReadTokens, initialUsage.cacheReadTokens),
    cacheCreationTokens: delta(finalUsage.cacheCreationTokens, initialUsage.cacheCreationTokens),
    reasoningTokens: delta(finalUsage.reasoningTokens, initialUsage.reasoningTokens),
  };
}

function addUsage(initialUsage: DroidUsage, delta: DroidUsage): DroidUsage {
  const add = (initialValue: number | undefined, deltaValue: number | undefined) =>
    (initialValue ?? 0) + (deltaValue ?? 0);
  return {
    inputTokens: add(initialUsage.inputTokens, delta.inputTokens),
    outputTokens: add(initialUsage.outputTokens, delta.outputTokens),
    totalTokens: add(initialUsage.totalTokens, delta.totalTokens),
    cacheReadTokens: add(initialUsage.cacheReadTokens, delta.cacheReadTokens),
    cacheCreationTokens: add(initialUsage.cacheCreationTokens, delta.cacheCreationTokens),
    reasoningTokens: add(initialUsage.reasoningTokens, delta.reasoningTokens),
  };
}

function resolveCumulativeUsage(
  settingsUsage: DroidUsage | undefined,
  initialUsage: DroidUsage | undefined,
  observedFinalUsage: DroidUsage | undefined,
): DroidUsage | undefined {
  if (!initialUsage) return settingsUsage;
  const observationFloor = observedFinalUsage ?? initialUsage;
  // A settings rename can lag behind transcript/log writes. Never move an
  // absolute checkpoint backwards or discard a larger exact per-call floor.
  return settingsUsage && usageAtLeast(settingsUsage, observationFloor)
    ? settingsUsage
    : observationFloor;
}

function usageAtLeast(candidate: DroidUsage, floor: DroidUsage): boolean {
  const atLeast = (value: number | undefined, minimum: number | undefined) =>
    (value ?? 0) >= (minimum ?? 0);
  return atLeast(candidate.inputTokens, floor.inputTokens)
    && atLeast(candidate.outputTokens, floor.outputTokens)
    && atLeast(candidate.totalTokens, floor.totalTokens)
    && atLeast(candidate.cacheReadTokens, floor.cacheReadTokens)
    && atLeast(candidate.cacheCreationTokens, floor.cacheCreationTokens)
    && atLeast(candidate.reasoningTokens, floor.reasoningTokens);
}

function sumUsage(observations: DroidLlmObservation[]): DroidUsage | undefined {
  if (observations.length === 0) return undefined;
  return observations.reduce<DroidUsage>((sum, item) => ({
    inputTokens: sum.inputTokens + item.usage.inputTokens,
    outputTokens: sum.outputTokens + item.usage.outputTokens,
    totalTokens: sum.totalTokens + item.usage.totalTokens,
    cacheReadTokens: (sum.cacheReadTokens ?? 0) + (item.usage.cacheReadTokens ?? 0),
    cacheCreationTokens: (sum.cacheCreationTokens ?? 0) + (item.usage.cacheCreationTokens ?? 0),
    reasoningTokens: (sum.reasoningTokens ?? 0) + (item.usage.reasoningTokens ?? 0),
  }), {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
  });
}

function contentBlocks(content: unknown): DroidContentBlock[] {
  return Array.isArray(content)
    ? content.filter((block): block is DroidContentBlock => isObject(block))
    : typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : [];
}

function hasToolResults(content: unknown): boolean {
  return contentBlocks(content).some(block => block.type === 'tool_result');
}

function messageParts(content: unknown, _role: string): DroidMessagePart[] {
  return contentBlocks(content).flatMap(block => {
    if (block.type === 'text' && typeof block.text === 'string') {
      return [{ type: 'text', content: block.text }];
    }
    return [];
  });
}

function toAssistantPart(block: DroidContentBlock): DroidMessagePart[] {
  if (block.type === 'text' && typeof block.text === 'string') {
    return [{ type: 'text', content: block.text }];
  }
  if (block.type === 'thinking') {
    const content = stringValue(block.thinking) ?? stringValue(block.text);
    return content ? [{ type: 'reasoning', content }] : [];
  }
  if (block.type === 'tool_use') {
    const id = stringValue(block.id);
    const name = stringValue(block.name);
    if (!id || !name) return [];
    const part: DroidMessagePart = { type: 'tool_call', id, name };
    const args = boundedToolJsonValue(block.input);
    if (args !== undefined) part.arguments = args;
    return [part];
  }
  return [];
}

function timestampMs(record: DroidRecord): number | undefined {
  if (typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)) {
    return record.timestamp;
  }
  if (typeof record.timestamp === 'string') {
    const value = Date.parse(record.timestamp);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

function millisecondsToNanoseconds(timestamp: number): string {
  const wholeMilliseconds = Math.trunc(timestamp);
  const fractionalNanoseconds = Math.round((timestamp - wholeMilliseconds) * 1_000_000);
  return (
    BigInt(wholeMilliseconds) * 1_000_000n
    + BigInt(fractionalNanoseconds)
  ).toString();
}

function stableId(namespace: string, seed: string): string {
  const hex = stableHex(`${namespace}:${seed}`, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableHex(seed: string, length: number): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, length);
}

function stableHexParts(parts: string[], length: number): string {
  return stableHex(parts.join('\0'), length);
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    return value.map(toJsonValue).filter((item): item is JsonValue => item !== undefined);
  }
  if (isObject(value)) {
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, raw] of Object.entries(value)) {
      const converted = toJsonValue(raw);
      if (converted !== undefined) result[key] = converted;
    }
    return result;
  }
  return String(value);
}

function boundedToolJsonValue(value: unknown): JsonValue | undefined {
  const converted = toJsonValue(value);
  if (converted === undefined) return undefined;
  const serialized = JSON.stringify(converted);
  const originalBytes = Buffer.byteLength(serialized, 'utf8');
  if (originalBytes <= MAX_TOOL_PAYLOAD_BYTES) return converted;
  return {
    truncated: true,
    original_bytes: originalBytes,
    preview: truncateUtf8(serialized, MAX_TOOL_PREVIEW_BYTES),
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) return value;
  return `${buffer.subarray(0, maxBytes).toString('utf8')}...[truncated]`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function canonicalProvider(provider: string | undefined): string {
  switch (provider?.toLowerCase()) {
    case 'bedrock_anthropic':
    case 'bedrock':
    case 'aws-bedrock':
      return 'aws.bedrock';
    case 'anthropic':
      return 'anthropic';
    case 'vertex_ai':
    case 'vertex-ai':
      return 'gcp.vertex_ai';
    default:
      return provider ?? 'factory';
  }
}
