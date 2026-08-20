import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { Dirent, FSWatcher } from 'node:fs';
import type { AgentActivityEntry, InputState } from '../../types/index.js';
import { ClientType, CollectionMethod } from '../../types/index.js';
import { BaseInput, type InputOptions } from '../base/base-input.js';
import {
  buildDroidEvents,
  type DroidSettingsUsageScope,
} from './droid-event-builder.js';
import {
  readDroidSettings,
  usageFromDroidSettings,
} from './droid-parser.js';
import {
  filterDroidLogObservationsByWindow,
  readDroidLogObservations,
} from './droid-log-reader.js';
import type {
  DroidHookEvent,
  DroidLlmObservation,
  DroidRecord,
  DroidSessionSettings,
  DroidUsage,
} from './droid-types.js';

const OFFSET_MAP_KEY = 'droidTranscriptBytes';
const FILE_META_MAP_KEY = 'droidTranscriptFiles';
const USAGE_MAP_KEY = 'droidSessionUsage';
const INITIALIZED_KEY = 'droidInitialized';
const STABILITY_RETRY_MS = 5_000;
const NEW_SESSION_SETTINGS_GRACE_MS = 15_000;
const HOOK_ORPHAN_GRACE_MS = 60 * 60 * 1_000;
const SUPPORTED_TRANSCRIPT_VERSION = 2;
const MAX_SCAN_DEPTH = 16;
const MAX_SCAN_DIRECTORIES = 4_096;
const MAX_SCAN_FILES = 100_000;
const LIVE_LOG_TAIL_BYTES_PER_FILE = 16 * 1024 * 1024;

interface DroidTranscriptMeta {
  size: number;
  mtimeMs: number;
  identity?: string;
  pendingBoundarySignature?: string;
  handledBoundaryAtMs: number;
  settingsGraceStartedAtMs?: number;
}

interface DroidHookHint extends DroidHookEvent {
  transcriptPath: string;
  eventFile: string;
  sessionDir: string;
}

interface ParsedRecord {
  record: DroidRecord;
  endOffset: number;
}

interface ParsedRange {
  records: ParsedRecord[];
  nextOffset: number;
  complete: boolean;
}

interface TerminalBoundary {
  offset: number;
  identity: string;
  observedAtMs: number;
}

interface PendingLogEnrichment {
  transcriptPath: string;
  sessionId: string;
  segment: DroidRecord[];
  settings?: DroidSessionSettings;
  hookEvents: DroidHookEvent[];
  matchingHints: DroidHookHint[];
  minTimestamp?: number;
  maxTimestamp?: number;
  boundary: TerminalBoundary;
  currentUsage?: DroidUsage;
  initialUsage?: DroidUsage;
  settingsUsageScope: DroidSettingsUsageScope;
}

export interface DroidInputOptions extends InputOptions {
  factoryRoot?: string;
  hookEventDir?: string;
}

/**
 * Factory Droid input. Hooks are wakeup/stability hints; transcript + settings
 * + Droid's version-gated local log remain the telemetry sources of truth.
 */
export class DroidInput extends BaseInput {
  readonly id = 'droid-transcript';
  readonly agentType = ClientType.Droid;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;

  private readonly factoryRoot: string;
  private readonly sessionsDir: string;
  private readonly logsDir: string;
  private readonly hookEventDir: string;
  private watchers: FSWatcher[] = [];
  private stabilityRetry: ReturnType<typeof setTimeout> | null = null;
  private stagedCheckpointState: Partial<InputState> | undefined;
  private rollbackCheckpointState: InputState | undefined;
  private readonly stagedHookFiles = new Set<string>();
  private readonly stagedHookDirs = new Set<string>();

  constructor(opts: DroidInputOptions) {
    super(opts);
    this.factoryRoot = opts.factoryRoot ?? path.join(homedir(), '.factory');
    this.sessionsDir = path.join(this.factoryRoot, 'sessions');
    this.logsDir = path.join(this.factoryRoot, 'logs');
    this.hookEventDir = opts.hookEventDir
      ?? path.join(homedir(), '.loongsuite-pilot', 'state', 'droid', 'hook-events');
  }

  static getWatchPaths(root = path.join(homedir(), '.factory')): string[] {
    return [root, path.join(root, 'sessions'), path.join(root, 'logs')];
  }

  static async checkAvailability(root = path.join(homedir(), '.factory')): Promise<boolean> {
    try {
      return (await fs.stat(path.join(root, 'sessions'))).isDirectory();
    } catch {
      return false;
    }
  }

  protected override async onStart(): Promise<void> {
    await fs.mkdir(this.hookEventDir, { recursive: true });
    this.watchDirectory(this.sessionsDir);
    this.watchDirectory(this.logsDir);
    this.watchDirectory(this.hookEventDir);
  }

  protected override async onStop(): Promise<void> {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    if (this.stabilityRetry) {
      clearTimeout(this.stabilityRetry);
      this.stabilityRetry = null;
    }
  }

  protected override async beforeCheckpoint(): Promise<void> {
    if (this.stagedCheckpointState) {
      // StateStore mutates in memory before its atomic file write. Preserve the
      // prior cursor so a failed checkpoint write cannot make this process skip
      // a source range that is still present on disk.
      this.rollbackCheckpointState = structuredClone(this.getState());
      this.setState(this.stagedCheckpointState);
    }
  }

  protected override async afterCheckpoint(): Promise<void> {
    for (const file of this.stagedHookFiles) {
      await fs.unlink(file).catch(() => undefined);
    }
    for (const dir of this.stagedHookDirs) {
      await fs.rmdir(dir).catch(() => undefined);
    }
    this.clearStagedCycle();
  }

  protected override async onCycleFailed(): Promise<void> {
    // The transcript offset and structural Stop hint must remain available for
    // retry when the durable OTLP sink rejects local acceptance.
    if (this.rollbackCheckpointState) {
      this.stateStore.set(this.id, this.rollbackCheckpointState);
    }
    this.clearStagedCycle();
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    this.clearStagedCycle();
    const state = this.getState();
    const initialized = state.extra?.[INITIALIZED_KEY] === true;
    const offsets = normalizeOffsetMap(state.extra?.[OFFSET_MAP_KEY]);
    const fileMeta = normalizeFileMetaMap(state.extra?.[FILE_META_MAP_KEY]);
    const usageMap = normalizeUsageMap(state.extra?.[USAGE_MAP_KEY]);
    const nextOffsets = { ...offsets };
    const nextFileMeta = { ...fileMeta };
    const nextUsageMap = { ...usageMap };
    const scan = await this.scanTranscriptFiles();
    const hookHints = await this.readHookHints();
    const transcriptPaths = await this.resolveTranscriptPaths([
      ...scan.files,
      ...hookHints.map(hint => hint.transcriptPath),
    ]);
    const entries: AgentActivityEntry[] = [];
    const pendingLogEnrichments: PendingLogEnrichment[] = [];

    if (scan.complete) {
      await this.removeDeletedCheckpoints(
        new Set(transcriptPaths),
        nextOffsets,
        nextFileMeta,
        nextUsageMap,
      );
    }

    for (const transcriptPath of transcriptPaths) {
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(transcriptPath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }

      const identity = fileIdentity(stat);
      const priorMeta = fileMeta[transcriptPath];
      const replacedOrTruncated = priorMeta !== undefined
        && (priorMeta.identity !== identity || stat.size < (offsets[transcriptPath] ?? 0));
      let committedOffset = replacedOrTruncated ? 0 : offsets[transcriptPath];
      const settingsPath = transcriptPath.replace(/\.jsonl$/i, '.settings.json');
      const settings = await readDroidSettings(settingsPath);
      const currentUsage = usageFromDroidSettings(settings);
      const sessionStart = await readSessionStart(transcriptPath);
      if (sessionStart?.version !== SUPPORTED_TRANSCRIPT_VERSION) {
        this.logger.warn('unsupported Droid transcript version; leaving file uncommitted', {
          transcriptPath,
          version: sessionStart?.version,
        });
        continue;
      }

      if (!initialized && committedOffset === undefined) {
        committedOffset = stat.size;
        if (currentUsage) nextUsageMap[transcriptPath] = currentUsage;
        await this.removeHookHintsForBaseline(hookHints, transcriptPath);
      } else {
        committedOffset ??= 0;
      }
      if (committedOffset > stat.size) committedOffset = 0;
      if (replacedOrTruncated) delete nextUsageMap[transcriptPath];
      nextOffsets[transcriptPath] = committedOffset;

      const parsed = await readJsonlRange(transcriptPath, committedOffset, stat.size);
      if (!parsed) continue;
      const matchingHints = await this.hintsForTranscript(hookHints, transcriptPath);
      const boundary = resolveTerminalBoundary(parsed, matchingHints);
      const signature = boundary
        ? [identity, stat.size, stat.mtimeMs, boundary.offset, boundary.identity].join(':')
        : undefined;
      const stableBoundary = signature !== undefined
        && priorMeta?.pendingBoundarySignature === signature;

      if (boundary && stableBoundary) {
        const segment = parsed.records
          .filter(item => item.endOffset <= boundary.offset)
          .map(item => item.record);
        if (!segment.some(record => record.type === 'session_start')) {
          segment.unshift(sessionStart);
        }
        const sessionId = sessionIdFromRecords(segment)
          ?? path.basename(transcriptPath, '.jsonl');
        const hookEvents = matchingHints
          .filter(hint => hint.observedAtMs > (priorMeta?.handledBoundaryAtMs ?? 0)
            && hint.observedAtMs <= boundary.observedAtMs)
          .map(toPublicHookEvent);
        const timestamps = segment
          .map(timestampMs)
          .filter((value): value is number => value !== undefined);
        pendingLogEnrichments.push({
          transcriptPath,
          sessionId,
          settings,
          hookEvents,
          matchingHints,
          segment,
          minTimestamp: timestamps.length > 0 ? Math.min(...timestamps) : undefined,
          maxTimestamp: timestamps.length > 0 ? Math.max(...timestamps) : undefined,
          boundary,
          currentUsage,
          initialUsage: usageMap[transcriptPath],
          settingsUsageScope: committedOffset === 0 && boundary.offset === stat.size
            ? 'complete_transcript'
            : 'session_aggregate',
        });
      } else if (boundary) {
        this.scheduleStabilityRetry();
      } else if (
        parsed.records.length === 0
        && currentUsage
        && usageIsAtLeast(currentUsage, usageMap[transcriptPath])
      ) {
        // Exact logs may allow a segment to commit before settings lands. A
        // later settings-only write still refreshes the absolute baseline for
        // subsequent turn deltas even though transcript EOF has not changed.
        nextUsageMap[transcriptPath] = currentUsage;
      }

      nextFileMeta[transcriptPath] = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        identity,
        pendingBoundarySignature: signature,
        handledBoundaryAtMs: priorMeta?.handledBoundaryAtMs ?? 0,
        settingsGraceStartedAtMs: !replacedOrTruncated
          && priorMeta !== undefined
          && priorMeta.pendingBoundarySignature === signature
          ? priorMeta.settingsGraceStartedAtMs
          : undefined,
      };
    }

    if (pendingLogEnrichments.length > 0) {
      const mergedWindow = mergeLogObservationWindows(pendingLogEnrichments);
      const observations = await readDroidLogObservations({
        logDir: this.logsDir,
        sessionIds: new Set(pendingLogEnrichments.map(item => item.sessionId)),
        minTimestamp: mergedWindow.minTimestamp,
        maxTimestamp: mergedWindow.maxTimestamp,
        maxTailBytesPerFile: LIVE_LOG_TAIL_BYTES_PER_FILE,
      });
      const observationsBySession = groupObservationsBySession(observations);

      for (const pending of pendingLogEnrichments) {
        const sessionObservations = filterDroidLogObservationsByWindow(
          observationsBySession.get(pending.sessionId) ?? [],
          pending.minTimestamp,
          pending.maxTimestamp,
        );
        const settings = pending.settingsUsageScope === 'complete_transcript'
          && !pending.initialUsage
          && !hasUsableSettingsUsage(pending.currentUsage)
          && pending.settings
          ? { ...pending.settings, tokenUsage: undefined }
          : pending.settings;
        const built = await buildDroidEvents(pending.segment, {
          sessionId: pending.sessionId,
          settings,
          hookEvents: pending.hookEvents,
          observations: sessionObservations,
          initialUsage: pending.initialUsage,
          settingsUsageScope: pending.settingsUsageScope,
        });
        const graceMeta = nextFileMeta[pending.transcriptPath];
        if (needsNewSessionSettingsGrace(
          built.entries,
          pending.currentUsage,
          pending.initialUsage,
          pending.settingsUsageScope,
        )) {
          const now = Date.now();
          const graceStartedAtMs = graceMeta.settingsGraceStartedAtMs ?? now;
          const remainingMs = NEW_SESSION_SETTINGS_GRACE_MS - (now - graceStartedAtMs);
          if (remainingMs > 0) {
            graceMeta.settingsGraceStartedAtMs = graceStartedAtMs;
            this.scheduleStabilityRetry(Math.min(STABILITY_RETRY_MS, remainingMs));
            continue;
          }
        }
        if (canCommitEnrichedSegment(
          built.entries,
          pending.currentUsage,
          pending.initialUsage,
        )) {
          entries.push(...built.entries);
          nextOffsets[pending.transcriptPath] = pending.boundary.offset;
          if (built.finalUsage) nextUsageMap[pending.transcriptPath] = built.finalUsage;
          await this.removeCommittedHookHints(
            pending.matchingHints,
            pending.boundary.observedAtMs,
          );
          nextFileMeta[pending.transcriptPath] = {
            ...nextFileMeta[pending.transcriptPath],
            pendingBoundarySignature: undefined,
            handledBoundaryAtMs: pending.boundary.observedAtMs,
            settingsGraceStartedAtMs: undefined,
          };
        } else {
          // Transcript can become stable before its sibling settings file is
          // atomically replaced. Keep both offset and hook pending so the same
          // segment is rebuilt once an absolute usage checkpoint advances.
          this.scheduleStabilityRetry();
        }
      }
    }

    this.stagedCheckpointState = {
      extra: {
        // A partial/failed discovery pass must not arm history collection for
        // files that were missed. Seen files retain their EOF baselines while
        // the input remains uninitialized until one complete scan succeeds.
        [INITIALIZED_KEY]: initialized || scan.complete,
        [OFFSET_MAP_KEY]: nextOffsets,
        [FILE_META_MAP_KEY]: nextFileMeta,
        [USAGE_MAP_KEY]: nextUsageMap,
      },
    };
    return entries.sort(compareEntriesByTime);
  }

  private clearStagedCycle(): void {
    this.stagedCheckpointState = undefined;
    this.rollbackCheckpointState = undefined;
    this.stagedHookFiles.clear();
    this.stagedHookDirs.clear();
  }

  private watchDirectory(dir: string): void {
    try {
      const watcher = fsSync.watch(dir, { recursive: true }, () => this.requestCollection());
      watcher.on('error', () => undefined);
      this.watchers.push(watcher);
    } catch {
      // Polling remains authoritative when a path is absent or recursive watch is unsupported.
    }
  }

  private scheduleStabilityRetry(delayMs = STABILITY_RETRY_MS): void {
    if (!this.running || this.stabilityRetry) return;
    this.stabilityRetry = setTimeout(() => {
      this.stabilityRetry = null;
      this.requestCollection();
    }, delayMs);
  }

  private async scanTranscriptFiles(): Promise<{ files: string[]; complete: boolean }> {
    const files: string[] = [];
    let complete = true;
    let scannedDirectories = 0;
    const pending: Array<{ dir: string; depth: number }> = [{
      dir: this.sessionsDir,
      depth: 0,
    }];
    while (pending.length > 0) {
      const current = pending.pop()!;
      scannedDirectories++;
      if (scannedDirectories > MAX_SCAN_DIRECTORIES) {
        complete = false;
        break;
      }
      let children: Dirent[];
      try {
        children = await fs.readdir(current.dir, { withFileTypes: true });
      } catch {
        complete = false;
        continue;
      }
      for (const child of children) {
        if (child.isSymbolicLink()) continue;
        const childPath = path.join(current.dir, child.name);
        if (child.isFile() && child.name.endsWith('.jsonl')) {
          files.push(childPath);
          if (files.length >= MAX_SCAN_FILES) {
            complete = false;
            pending.length = 0;
            break;
          }
        } else if (child.isDirectory()) {
          if (current.depth >= MAX_SCAN_DEPTH) {
            complete = false;
          } else {
            pending.push({ dir: childPath, depth: current.depth + 1 });
          }
        }
      }
    }
    return { files, complete };
  }

  private async resolveTranscriptPaths(candidates: string[]): Promise<string[]> {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(this.sessionsDir);
    } catch {
      return [];
    }
    const resolved = new Set<string>();
    for (const candidate of candidates) {
      if (!path.isAbsolute(candidate) || !candidate.endsWith('.jsonl')) continue;
      let realCandidate: string;
      try {
        realCandidate = await fs.realpath(candidate);
      } catch {
        continue;
      }
      if (isPathWithin(realRoot, realCandidate)) resolved.add(realCandidate);
    }
    return [...resolved].sort();
  }

  private async readHookHints(): Promise<DroidHookHint[]> {
    let sessionDirs: Dirent[];
    try {
      sessionDirs = await fs.readdir(this.hookEventDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const hints: DroidHookHint[] = [];
    for (const sessionEntry of sessionDirs) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDir = path.join(this.hookEventDir, sessionEntry.name);
      let names: string[];
      try {
        names = (await fs.readdir(sessionDir)).sort();
      } catch {
        continue;
      }
      for (const name of names) {
        const eventFile = path.join(sessionDir, name);
        if (name.startsWith('.') && name.endsWith('.tmp')) {
          try {
            const stat = await fs.stat(eventFile);
            if (Date.now() - stat.mtimeMs > HOOK_ORPHAN_GRACE_MS) await fs.unlink(eventFile);
          } catch {
            // Concurrent cleanup/writer.
          }
          continue;
        }
        if (!name.endsWith('.json')) continue;
        try {
          const value = JSON.parse(await fs.readFile(eventFile, 'utf8')) as unknown;
          if (!isObject(value)) throw new Error('invalid hook event');
          const transcriptPath = stringValue(value.transcript_path);
          const eventName = stringValue(value.hook_event_name);
          const observedAtMs = finiteNumber(value.observed_at_ms);
          if (!transcriptPath || !eventName || observedAtMs === undefined) {
            throw new Error('incomplete hook event');
          }
          hints.push({
            transcriptPath,
            eventFile,
            sessionDir,
            eventName,
            observedAtMs,
            sessionId: stringValue(value.session_id),
            toolName: stringValue(value.tool_name),
            toolCallId: stringValue(value.tool_call_id),
            model: stringValue(value.model),
            apiProvider: stringValue(value.api_provider),
          });
        } catch {
          await fs.unlink(eventFile).catch(() => undefined);
        }
      }
      await fs.rmdir(sessionDir).catch(() => undefined);
    }
    return hints;
  }

  private async hintsForTranscript(
    hints: DroidHookHint[],
    transcriptPath: string,
  ): Promise<DroidHookHint[]> {
    const matching: DroidHookHint[] = [];
    for (const hint of hints) {
      let realHintPath: string;
      try {
        realHintPath = await fs.realpath(hint.transcriptPath);
      } catch {
        continue;
      }
      if (realHintPath === transcriptPath) matching.push(hint);
    }
    return matching.sort((left, right) => left.observedAtMs - right.observedAtMs);
  }

  private async removeCommittedHookHints(
    hints: DroidHookHint[],
    throughMs: number,
  ): Promise<void> {
    const dirs = new Set<string>();
    for (const hint of hints) {
      if (hint.observedAtMs > throughMs) continue;
      this.stagedHookFiles.add(hint.eventFile);
      dirs.add(hint.sessionDir);
    }
    for (const dir of dirs) this.stagedHookDirs.add(dir);
  }

  private async removeHookHintsForBaseline(
    hints: DroidHookHint[],
    transcriptPath: string,
  ): Promise<void> {
    const matching = await this.hintsForTranscript(hints, transcriptPath);
    await this.removeCommittedHookHints(matching, Number.POSITIVE_INFINITY);
  }

  private async removeDeletedCheckpoints(
    currentPaths: Set<string>,
    offsets: Record<string, number>,
    meta: Record<string, DroidTranscriptMeta>,
    usage: Record<string, DroidUsage>,
  ): Promise<void> {
    for (const filePath of new Set([
      ...Object.keys(offsets),
      ...Object.keys(meta),
      ...Object.keys(usage),
    ])) {
      if (currentPaths.has(filePath)) continue;
      try {
        await fs.stat(filePath);
      } catch (error) {
        if (!isNotFoundError(error)) continue;
        delete offsets[filePath];
        delete meta[filePath];
        delete usage[filePath];
      }
    }
  }

}

function groupObservationsBySession(
  observations: DroidLlmObservation[],
): Map<string, DroidLlmObservation[]> {
  const grouped = new Map<string, DroidLlmObservation[]>();
  for (const observation of observations) {
    const session = grouped.get(observation.sessionId) ?? [];
    session.push(observation);
    grouped.set(observation.sessionId, session);
  }
  return grouped;
}

function mergeLogObservationWindows(
  pending: PendingLogEnrichment[],
): { minTimestamp?: number; maxTimestamp?: number } {
  let minTimestamp: number | undefined;
  let maxTimestamp: number | undefined;
  for (const item of pending) {
    if (item.minTimestamp === undefined || item.maxTimestamp === undefined) return {};
    minTimestamp = minTimestamp === undefined
      ? item.minTimestamp
      : Math.min(minTimestamp, item.minTimestamp);
    maxTimestamp = maxTimestamp === undefined
      ? item.maxTimestamp
      : Math.max(maxTimestamp, item.maxTimestamp);
  }
  return { minTimestamp, maxTimestamp };
}

function canCommitEnrichedSegment(
  entries: AgentActivityEntry[],
  currentUsage: DroidUsage | undefined,
  initialUsage: DroidUsage | undefined,
): boolean {
  const actualResponses = entries.filter(entry =>
    entry['event.name'] === 'llm.response'
    && entry['agent.droid.response.synthetic'] !== 'cancelled_boundary');
  if (actualResponses.length === 0) return true;
  if (actualResponses.every(entry =>
    entry['agent.droid.usage.completeness'] === 'per_call')) {
    return true;
  }
  // The caller holds a complete new session through its bounded settings
  // grace before reaching this fallback. Afterwards, preserve content with
  // explicit missing/session-level completeness instead of retaining forever.
  if (!initialUsage) return true;
  return usageHasAdvanced(currentUsage, initialUsage);
}

function needsNewSessionSettingsGrace(
  entries: AgentActivityEntry[],
  currentUsage: DroidUsage | undefined,
  initialUsage: DroidUsage | undefined,
  settingsUsageScope: DroidSettingsUsageScope,
): boolean {
  if (
    settingsUsageScope !== 'complete_transcript'
    || hasUsableSettingsUsage(currentUsage)
    || initialUsage
  ) {
    return false;
  }
  const actualResponses = entries.filter(entry =>
    entry['event.name'] === 'llm.response'
    && entry['agent.droid.response.synthetic'] !== 'cancelled_boundary');
  return actualResponses.length > 0
    && !actualResponses.every(entry =>
      entry['agent.droid.usage.completeness'] === 'per_call');
}

function hasUsableSettingsUsage(usage: DroidUsage | undefined): usage is DroidUsage {
  return usage !== undefined && usage.totalTokens > 0;
}

function usageHasAdvanced(
  currentUsage: DroidUsage | undefined,
  initialUsage: DroidUsage | undefined,
): boolean {
  if (!currentUsage) return false;
  if (!initialUsage) return currentUsage.totalTokens > 0;
  return usageIsAtLeast(currentUsage, initialUsage)
    && (
      currentUsage.inputTokens > initialUsage.inputTokens
      || currentUsage.outputTokens > initialUsage.outputTokens
      || currentUsage.totalTokens > initialUsage.totalTokens
    );
}

function usageIsAtLeast(
  currentUsage: DroidUsage,
  initialUsage: DroidUsage | undefined,
): boolean {
  if (!initialUsage) return true;
  return currentUsage.inputTokens >= initialUsage.inputTokens
    && currentUsage.outputTokens >= initialUsage.outputTokens
    && currentUsage.totalTokens >= initialUsage.totalTokens;
}

function resolveTerminalBoundary(
  parsed: ParsedRange,
  hints: DroidHookHint[],
): TerminalBoundary | undefined {
  let boundary: TerminalBoundary | undefined;
  for (const item of parsed.records) {
    const message = item.record.message;
    if (
      message?.visibility !== 'user_only'
      || (message.hookEventName !== 'Stop' && message.hookEventName !== 'SessionEnd')
    ) {
      continue;
    }
    const observedAtMs = finiteNumber(message.hookEndTime)
      ?? timestampMs(item.record)
      ?? finiteNumber(message.hookStartTime);
    if (observedAtMs === undefined) continue;
    boundary = {
      offset: item.endOffset,
      identity: stringValue(item.record.id)
        ?? `${message.hookEventName}:${observedAtMs}`,
      observedAtMs,
    };
  }
  if (boundary) return boundary;

  const external = hints
    .filter(hint => hint.eventName === 'Stop' || hint.eventName === 'SessionEnd')
    .sort((left, right) => right.observedAtMs - left.observedAtMs)[0];
  if (!external || parsed.records.length === 0 || !parsed.complete) return undefined;
  // A Stop hook can be consumed after Droid has already appended the next
  // prompt. Never checkpoint the whole current EOF: cap the boundary at the
  // last source record whose own timestamp is not after the hook observation.
  // Missing timestamps fail closed because an exact boundary cannot be proven.
  const eligible = parsed.records.filter(item => {
    const timestamp = timestampMs(item.record);
    return timestamp !== undefined && timestamp <= external.observedAtMs;
  });
  const lastEligible = eligible[eligible.length - 1];
  if (!lastEligible) return undefined;
  return {
    offset: lastEligible.endOffset,
    identity: `${external.eventName}:${external.observedAtMs}`,
    observedAtMs: external.observedAtMs,
  };
}

async function readJsonlRange(
  filePath: string,
  startOffset: number,
  endOffset: number,
): Promise<ParsedRange | null> {
  if (startOffset >= endOffset) return { records: [], nextOffset: startOffset, complete: true };
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let content: Buffer;
  try {
    handle = await fs.open(filePath, 'r');
    content = Buffer.alloc(endOffset - startOffset);
    const { bytesRead } = await handle.read(content, 0, content.length, startOffset);
    content = content.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }

  const records: ParsedRecord[] = [];
  let lineStart = 0;
  let nextOffset = startOffset;
  for (let index = 0; index < content.length; index++) {
    if (content[index] !== 0x0a) continue;
    const end = startOffset + index + 1;
    const record = parseJsonlLine(content.subarray(lineStart, index));
    if (record === null) return { records, nextOffset, complete: false };
    if (record) records.push({ record, endOffset: end });
    lineStart = index + 1;
    nextOffset = end;
  }
  if (lineStart < content.length) {
    const record = parseJsonlLine(content.subarray(lineStart));
    if (record === null) {
      return { records, nextOffset, complete: false };
    }
    if (record) {
      nextOffset = startOffset + content.length;
      records.push({ record, endOffset: nextOffset });
    }
  }
  return { records, nextOffset, complete: true };
}

async function readSessionStart(filePath: string): Promise<DroidRecord | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
    const parsed = JSON.parse(firstLine) as unknown;
    return isObject(parsed) && parsed.type === 'session_start'
      ? parsed as DroidRecord
      : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseJsonlLine(line: Buffer): DroidRecord | undefined | null {
  const text = line.toString('utf8').replace(/\r$/, '').trim();
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return isObject(value) ? value as DroidRecord : null;
  } catch {
    return null;
  }
}

function sessionIdFromRecords(records: DroidRecord[]): string | undefined {
  const start = records.find(record => record.type === 'session_start');
  return stringValue(start?.id);
}

function toPublicHookEvent(hint: DroidHookHint): DroidHookEvent {
  return {
    eventName: hint.eventName,
    observedAtMs: hint.observedAtMs,
    sessionId: hint.sessionId,
    transcriptPath: hint.transcriptPath,
    toolName: hint.toolName,
    toolCallId: hint.toolCallId,
    model: hint.model,
    apiProvider: hint.apiProvider,
  };
}

function timestampMs(record: DroidRecord): number | undefined {
  if (typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)) {
    return record.timestamp;
  }
  if (typeof record.timestamp === 'string') {
    const parsed = Date.parse(record.timestamp);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeOffsetMap(value: unknown): Record<string, number> {
  if (!isObject(value)) return {};
  const result: Record<string, number> = {};
  for (const [filePath, offset] of Object.entries(value)) {
    if (typeof offset === 'number' && Number.isInteger(offset) && offset >= 0) {
      result[filePath] = offset;
    }
  }
  return result;
}

function normalizeFileMetaMap(value: unknown): Record<string, DroidTranscriptMeta> {
  if (!isObject(value)) return {};
  const result: Record<string, DroidTranscriptMeta> = {};
  for (const [filePath, raw] of Object.entries(value)) {
    if (!isObject(raw)) continue;
    const size = finiteNumber(raw.size);
    const mtimeMs = finiteNumber(raw.mtimeMs);
    if (size === undefined || mtimeMs === undefined) continue;
    result[filePath] = {
      size,
      mtimeMs,
      identity: stringValue(raw.identity),
      pendingBoundarySignature: stringValue(raw.pendingBoundarySignature),
      handledBoundaryAtMs: finiteNumber(raw.handledBoundaryAtMs) ?? 0,
      settingsGraceStartedAtMs: finiteNumber(raw.settingsGraceStartedAtMs),
    };
  }
  return result;
}

function normalizeUsageMap(value: unknown): Record<string, DroidUsage> {
  if (!isObject(value)) return {};
  const result: Record<string, DroidUsage> = {};
  for (const [filePath, raw] of Object.entries(value)) {
    if (!isObject(raw)) continue;
    const inputTokens = finiteNumber(raw.inputTokens);
    const outputTokens = finiteNumber(raw.outputTokens);
    const totalTokens = finiteNumber(raw.totalTokens);
    if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) continue;
    result[filePath] = {
      inputTokens,
      outputTokens,
      totalTokens,
      cacheReadTokens: finiteNumber(raw.cacheReadTokens),
      cacheCreationTokens: finiteNumber(raw.cacheCreationTokens),
      reasoningTokens: finiteNumber(raw.reasoningTokens),
    };
  }
  return result;
}

function fileIdentity(stat: Awaited<ReturnType<typeof fs.stat>>): string {
  return `${stat.dev}:${stat.ino}`;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function compareEntriesByTime(left: AgentActivityEntry, right: AgentActivityEntry): number {
  const leftTime = BigInt(left.time_unix_nano);
  const rightTime = BigInt(right.time_unix_nano);
  if (leftTime < rightTime) return -1;
  if (leftTime > rightTime) return 1;
  return 0;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
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
