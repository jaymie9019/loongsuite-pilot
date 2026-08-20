import * as fs from 'node:fs/promises';
import type {
  DroidLlmObservation,
  DroidRawUsage,
  DroidRecord,
  DroidSessionSettings,
  DroidUsage,
} from './droid-types.js';

const LOG_PREFIX_RE = /^\[([^\]]+)]\s+\w+:\s+\[([^\]]+)](?:\s+[^|]+)?\s+\|\s+Context:\s+(\{.*\})\s*$/;
const SUPPORTED_DROID_LOG_VERSIONS = new Set(['0.199.0', '0.200.0']);

interface PendingLogCall {
  sessionId: string;
  startedAtMs: number;
  timeToFirstTokenNs?: number;
  modelId?: string;
  apiProvider?: string;
  logVersion?: string;
}

export interface DroidLogParserOptions {
  /** Ignore unrelated sessions before retaining any parser state. */
  sessionIds?: Iterable<string>;
}

export interface DroidLogParser {
  /** Start one physical log segment; truncated segments resync each session at its next send. */
  beginSegment(options: { truncated: boolean }): void;
  /** Consume one complete log line. Parser state intentionally spans files. */
  pushLine(line: string): void;
  /** Return a deterministic snapshot of all uniquely joined observations. */
  finish(): DroidLlmObservation[];
}

export async function readDroidTranscript(filePath: string): Promise<DroidRecord[]> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    return [];
  }
  return parseDroidTranscriptText(text);
}

export function parseDroidTranscriptText(text: string): DroidRecord[] {
  const records: DroidRecord[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (isObject(value)) records.push(value as DroidRecord);
    } catch {
      // A partial or malformed line must not hide the rest of a recoverable transcript.
    }
  }
  return records;
}

export async function readDroidSettings(
  filePath: string,
): Promise<DroidSessionSettings | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    return isObject(value) ? value as DroidSessionSettings : undefined;
  } catch {
    return undefined;
  }
}

/** Convert Factory's raw counters into AgentLoop's canonical inclusive input count. */
export function canonicalDroidUsage(
  raw: DroidRawUsage | undefined,
): DroidUsage | undefined {
  if (!raw) return undefined;
  const directInput = finiteNumber(raw.inputTokens) ?? 0;
  const outputTokens = finiteNumber(raw.outputTokens) ?? 0;
  const cacheReadTokens = finiteNumber(raw.cacheReadTokens) ?? 0;
  const cacheCreationTokens = finiteNumber(raw.cacheCreationTokens) ?? 0;
  const reasoningTokens = finiteNumber(raw.thinkingTokens) ?? 0;
  const inputTokens = directInput + cacheReadTokens + cacheCreationTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens,
  };
}

export function usageFromDroidSettings(
  settings: DroidSessionSettings | undefined,
): DroidUsage | undefined {
  // inclusiveTokenUsage includes child/subagent sessions and would double count
  // once those child transcripts are collected independently.
  return canonicalDroidUsage(settings?.tokenUsage);
}

/**
 * Join the three Factory log records that describe one model call:
 * `[LLM] sendMessage`, TTFT metric, and `[Agent] Streaming result`.
 */
export function parseDroidLogLines(text: string): DroidLlmObservation[] {
  const parser = createDroidLogParser();
  for (const line of text.split(/\r?\n/)) parser.pushLine(line);
  return parser.finish();
}

/**
 * Stateful parser for large/rotated Droid logs. Feed files oldest-first and
 * reuse one instance so a sendMessage at the end of one file can be joined to
 * its Streaming result at the beginning of the next file.
 */
export function createDroidLogParser(
  options: DroidLogParserOptions = {},
): DroidLogParser {
  return new IncrementalDroidLogParser(options);
}

class IncrementalDroidLogParser implements DroidLogParser {
  private readonly pendingBySession = new Map<string, PendingLogCall[]>();
  private readonly ambiguousResultsToDrop = new Map<string, number>();
  private readonly orphanSendsToDrop = new Map<string, number>();
  private readonly observations: DroidLlmObservation[] = [];
  private readonly observationKeys = new Set<string>();
  private readonly sendKeys = new Set<string>();
  private readonly sessionIds?: Set<string>;
  private resyncTruncatedSegment = false;
  private readonly synchronizedSessions = new Set<string>();

  constructor(options: DroidLogParserOptions) {
    if (options.sessionIds !== undefined) {
      this.sessionIds = new Set(options.sessionIds);
    }
  }

  beginSegment(options: { truncated: boolean }): void {
    if (!options.truncated) return;
    this.resyncTruncatedSegment = true;
    this.synchronizedSessions.clear();

    // A byte tail can omit the sendMessage for a retained result. Pending
    // correlation and orphan/ambiguity counters from a preceding physical
    // segment are therefore unsafe across this boundary. Completed observation
    // and send keys remain so overlapped rotations are still deduplicated.
    this.pendingBySession.clear();
    this.ambiguousResultsToDrop.clear();
    this.orphanSendsToDrop.clear();
  }

  pushLine(rawLine: string): void {
    const match = LOG_PREFIX_RE.exec(rawLine.trim());
    if (!match) return;
    const timestamp = Date.parse(match[1]);
    if (!Number.isFinite(timestamp)) return;
    let context: Record<string, unknown>;
    try {
      const parsed = JSON.parse(match[3]) as unknown;
      if (!isObject(parsed)) return;
      context = parsed;
    } catch {
      return;
    }
    const tags = isObject(context.tags) ? context.tags : {};
    const sessionId = stringValue(tags.sessionId) ?? stringValue(context.sessionId);
    if (!sessionId || (this.sessionIds && !this.sessionIds.has(sessionId))) return;
    const source = match[2];
    const logVersion = stringValue(tags.version) ?? stringValue(context.version);
    if (!logVersion || !SUPPORTED_DROID_LOG_VERSIONS.has(logVersion)) return;
    const isSendMessage = source === 'LLM' && rawLine.includes('sendMessage');
    const awaitingSemanticBoundary = this.resyncTruncatedSegment
      && !this.synchronizedSessions.has(sessionId);
    if (awaitingSemanticBoundary && !isSendMessage) return;

    if (isSendMessage) {
      const modelId = stringValue(context.modelId) ?? stringValue(tags.modelId);
      if (takeCounter(this.orphanSendsToDrop, pendingCorrelationKey(sessionId, modelId))) return;
      const sendKey = [
        sessionId,
        timestamp,
        modelId ?? '',
        finiteNumber(context.messageThreadLength) ?? '',
        finiteNumber(context.toolCount) ?? '',
      ].join(':');
      // Rotated logs commonly overlap. Without a Factory call id, identical
      // send records are not distinguishable, so retaining a second pending
      // item would make every subsequent join ambiguous.
      if (this.sendKeys.has(sendKey)) return;
      this.sendKeys.add(sendKey);
      const pending: PendingLogCall = {
        sessionId,
        startedAtMs: timestamp,
        modelId,
        apiProvider: stringValue(context.apiProvider),
        logVersion,
      };
      const list = this.pendingBySession.get(sessionId) ?? [];
      list.push(pending);
      this.pendingBySession.set(sessionId, list);
      if (awaitingSemanticBoundary) this.synchronizedSessions.add(sessionId);
      return;
    }

    if (source === 'metrics_log_chat_client_time_to_first_token') {
      const metricModelId = stringValue(context.modelId) ?? stringValue(tags.modelId);
      const eligible = eligiblePending(
        this.pendingBySession.get(sessionId),
        timestamp,
        metricModelId,
      );
      // After model narrowing, multiple same-model calls still have no stable
      // correlation key in the allowlisted 0.199.0/0.200.0 schemas. Attach
      // TTFT only to a unique pending call.
      if (eligible.length !== 1) return;
      const pending = eligible[0];
      const seconds = finiteNumber(context.value);
      if (seconds !== undefined && seconds >= 0) {
        pending.timeToFirstTokenNs = Math.round(seconds * 1_000_000_000);
      }
      pending.modelId ??= metricModelId;
      pending.apiProvider ??= stringValue(context.apiProvider);
      return;
    }

    if (source !== 'Agent' || !rawLine.includes('Streaming result')) return;
    const responseId = stringValue(context.upstreamRequestId);
    const resultModelId = stringValue(context.modelId) ?? stringValue(tags.modelId);
    const counterKey = pendingCorrelationKey(sessionId, resultModelId);
    const directInput = finiteNumber(context.inputTokens) ?? 0;
    const cacheReadTokens = finiteNumber(context.cacheReadInputTokens) ?? 0;
    const cacheCreationTokens = finiteNumber(context.contextCount) ?? 0;
    const inputTokens = directInput + cacheReadTokens + cacheCreationTokens;
    const outputTokens = finiteNumber(context.outputTokens) ?? 0;
    const key = responseId
      ? `${sessionId}:response:${responseId}`
      : `${sessionId}:${timestamp}:${inputTokens}:${outputTokens}`;
    // An overlapped rotated file can repeat a completed result without its
    // send record. Ignore it before orphan accounting so it cannot poison the
    // next legitimate call in this session.
    if (this.observationKeys.has(key)) return;
    if (takeCounter(this.ambiguousResultsToDrop, counterKey)) return;
    const list = this.pendingBySession.get(sessionId) ?? [];
    const eligible = eligiblePending(list, timestamp, resultModelId);
    if (eligible.length !== 1) {
      if (eligible.length === 0) {
        incrementCounter(this.orphanSendsToDrop, counterKey, 1);
      } else {
        const ambiguous = new Set(eligible);
        const retained = list.filter(item => !ambiguous.has(item));
        if (retained.length > 0) this.pendingBySession.set(sessionId, retained);
        else this.pendingBySession.delete(sessionId);
        // The current result accounts for one of the ambiguous sends; discard
        // the remaining results before considering any newer pending call.
        incrementCounter(this.ambiguousResultsToDrop, counterKey, eligible.length - 1);
      }
      return;
    }
    const pending = eligible[0];
    const remaining = list.filter(item => item !== pending);
    if (remaining.length > 0) this.pendingBySession.set(sessionId, remaining);
    else this.pendingBySession.delete(sessionId);
    const completedAtMs = timestamp;
    // Factory 0.199.0/0.200.0 calls newly-added prompt context `contextCount`.
    // It is the same counter persisted as settings.tokenUsage.cacheCreationTokens.
    const observation: DroidLlmObservation = {
      sessionId,
      startedAtMs: pending.startedAtMs,
      completedAtMs,
      timeToFirstTokenNs: pending.timeToFirstTokenNs,
      modelId: resultModelId ?? pending.modelId,
      apiProvider: stringValue(context.apiProvider) ?? pending.apiProvider,
      responseId,
      finishReason: normalizeFinishReason(stringValue(context.reason)),
      logVersion,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        reasoningTokens: finiteNumber(context.reasoningTokens) ?? 0,
      },
    };
    if (!this.observationKeys.has(key)) {
      this.observationKeys.add(key);
      this.observations.push(observation);
    }
  }

  finish(): DroidLlmObservation[] {
    return [...this.observations].sort((left, right) =>
      left.completedAtMs - right.completedAtMs
      || left.startedAtMs - right.startedAtMs
      || (left.responseId ?? '').localeCompare(right.responseId ?? ''));
  }
}

function eligiblePending(
  list: PendingLogCall[] | undefined,
  timestamp: number,
  modelId?: string,
): PendingLogCall[] {
  const eligible = list?.filter(item => item.startedAtMs <= timestamp) ?? [];
  // Factory 0.199.0/0.200.0 does not expose a call id on sendMessage, but both
  // TTFT and Streaming result normally carry modelId. Distinct-model internal
  // calls (for example title generation beside the root agent) can therefore
  // be joined safely. Multiple pending calls for the same model remain
  // ambiguous and are deliberately not paired by FIFO.
  return modelId === undefined
    ? eligible
    : eligible.filter(item => item.modelId === modelId);
}

function pendingCorrelationKey(sessionId: string, modelId: string | undefined): string {
  return `${sessionId}\0${modelId ?? '*'}`;
}

function incrementCounter(map: Map<string, number>, key: string, count: number): void {
  if (count <= 0) return;
  map.set(key, (map.get(key) ?? 0) + count);
}

function takeCounter(map: Map<string, number>, key: string): boolean {
  const count = map.get(key) ?? 0;
  if (count <= 0) return false;
  if (count === 1) map.delete(key);
  else map.set(key, count - 1);
  return true;
}

function normalizeFinishReason(reason: string | undefined): string | undefined {
  if (reason === 'tool-calls' || reason === 'tool_calls' || reason === 'tool-use') {
    return 'tool_call';
  }
  if (reason === 'end-turn' || reason === 'end_turn') return 'stop';
  return reason;
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
