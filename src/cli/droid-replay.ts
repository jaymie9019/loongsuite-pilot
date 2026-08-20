import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { Dirent } from 'node:fs';
import type { AgentActivityEntry } from '../types/index.js';
import { loadConfig } from '../core/config-loader.js';
import { withFilesystemLock } from '../flushers/durable-otlp-queue.js';
import {
  ensurePrivateDir,
  ensurePrivateFile,
  resolveHome,
  writeTextFileAtomic,
  type ExpectedFileState,
} from '../utils/fs-utils.js';
import { buildDroidEvents } from '../inputs/droid/droid-event-builder.js';
import {
  readDroidSettings,
  readDroidTranscript,
} from '../inputs/droid/droid-parser.js';
import { readDroidLogObservations } from '../inputs/droid/droid-log-reader.js';
import type { DroidRecord } from '../inputs/droid/droid-types.js';

const SUPPORTED_TRANSCRIPT_VERSIONS = new Set([2]);
const LEDGER_VERSION = 1;

export interface DroidReplayOptions {
  mode: 'dry-run' | 'execute';
  sessionId?: string;
  fromMs?: number;
  toMs?: number;
  factoryRoot: string;
  dataDir?: string;
  json: boolean;
}

export interface DroidReplayTurn {
  sessionId: string;
  turnId: string;
  traceId: string;
  startedAtMs: number;
  endedAtMs: number;
  entries: AgentActivityEntry[];
  usageCompleteness: string[];
}

interface ReplayLedgerEntry {
  sessionId: string;
  turnId: string;
  traceId: string;
  queuedAt: string;
}

interface ReplayLedger {
  version: 1;
  turns: Record<string, ReplayLedgerEntry>;
}

interface LoadedReplayLedger {
  ledger: ReplayLedger;
  expected: ExpectedFileState;
}

type ReplaySafetySkipReason =
  | 'input_state_missing'
  | 'input_state_corrupt'
  | 'input_state_invalid'
  | 'baseline_receipt_missing'
  | 'baseline_receipt_incomplete'
  | 'baseline_boundary_pending'
  | 'live_processed'
  | 'source_identity_changed'
  | 'source_not_at_baseline_eof'
  | 'source_metadata_changed';

interface DroidInputReplayState {
  offsets: Record<string, unknown>;
  files: Record<string, unknown>;
  unavailableReason?: ReplaySafetySkipReason;
}

interface ReplayTranscriptEligibility {
  eligible: boolean;
  canonicalPath: string;
  reason?: ReplaySafetySkipReason;
}

interface ReplayPlan {
  turns: DroidReplayTurn[];
  scannedTranscripts: number;
  liveProcessedSkipped: number;
  unsafeStateSkipped: number;
  safetySkipReasons: Partial<Record<ReplaySafetySkipReason, number>>;
  unsupportedTranscripts: number;
  incompleteTurns: number;
}

export async function runDroidCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderDroidHelp()}\n`);
    return 0;
  }
  if (subcommand !== 'replay') {
    process.stderr.write(`Unknown droid command: ${subcommand}\n\n${renderDroidHelp()}\n`);
    return 1;
  }

  const parsed = parseDroidReplayArgs(rest);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${renderDroidReplayHelp()}\n`);
    return 1;
  }
  if (parsed.help) {
    process.stdout.write(`${renderDroidReplayHelp()}\n`);
    return 0;
  }
  if (parsed.options!.mode === 'execute') {
    process.stderr.write(
      'Droid replay --execute is temporarily disabled: safe upload requires a future shared live/replay outbox/receipt. Use --dry-run to inspect strict eligibility.\n',
    );
    return 1;
  }

  try {
    const dataDir = await resolveReplayDataDir(parsed.options!.dataDir);
    const plan = await buildDroidReplayPlan({ ...parsed.options!, dataDir });
    const ledgerPath = path.join(dataDir, 'state', 'droid', 'replay-ledger.json');
    const ledger = (await loadReplayLedger(ledgerPath)).ledger;
    const pending = plan.turns.filter(turn => !ledger.turns[turn.traceId]);
    printReplaySummary(plan, pending, ledger, parsed.options!.json, false);
    return 0;
  } catch (err) {
    process.stderr.write(`Droid replay failed: ${safeErrorMessage(err)}\n`);
    return 1;
  }
}

export function parseDroidReplayArgs(args: string[]): {
  options?: DroidReplayOptions;
  error?: string;
  help?: boolean;
} {
  let mode: DroidReplayOptions['mode'] | undefined;
  let sessionId: string | undefined;
  let fromRaw: string | undefined;
  let toRaw: string | undefined;
  let factoryRoot = path.join(homedir(), '.factory');
  let dataDir: string | undefined;
  let json = false;

  const takeValue = (index: number, name: string): { value?: string; next: number; error?: string } => {
    const value = args[index + 1];
    return value && !value.startsWith('--')
      ? { value, next: index + 1 }
      : { next: index, error: `Missing value for ${name}` };
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--dry-run' || arg === '--execute') {
      const candidate = arg === '--execute' ? 'execute' : 'dry-run';
      if (mode && mode !== candidate) return { error: '--dry-run and --execute are mutually exclusive' };
      mode = candidate;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    const equal = /^--(session-id|from|to|factory-root|data-dir)=(.*)$/.exec(arg);
    let name: string | undefined;
    let value: string | undefined;
    if (equal) {
      name = equal[1];
      value = equal[2];
    } else if (['--session-id', '--from', '--to', '--factory-root', '--data-dir'].includes(arg)) {
      name = arg.slice(2);
      const taken = takeValue(index, arg);
      if (taken.error) return { error: taken.error };
      value = taken.value;
      index = taken.next;
    } else {
      return { error: `Unknown option: ${arg}` };
    }

    if (!value) return { error: `Missing value for --${name}` };
    if (name === 'session-id') sessionId = value;
    else if (name === 'from') fromRaw = value;
    else if (name === 'to') toRaw = value;
    else if (name === 'factory-root') factoryRoot = resolveHome(value);
    else if (name === 'data-dir') dataDir = resolveHome(value);
  }

  if (!mode) return { error: 'Choose --dry-run or explicitly acknowledge upload with --execute' };
  const hasRange = fromRaw !== undefined || toRaw !== undefined;
  if (sessionId && hasRange) return { error: 'Use either --session-id or --from/--to, not both' };
  if (!sessionId && !hasRange) return { error: 'A --session-id or complete --from/--to range is required' };
  if (hasRange && (!fromRaw || !toRaw)) return { error: 'Both --from and --to are required' };
  if (sessionId && !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) {
    return { error: 'Invalid --session-id' };
  }

  const fromMs = fromRaw ? Date.parse(fromRaw) : undefined;
  const toMs = toRaw ? Date.parse(toRaw) : undefined;
  if (fromRaw && !Number.isFinite(fromMs)) return { error: `Invalid --from timestamp: ${fromRaw}` };
  if (toRaw && !Number.isFinite(toMs)) return { error: `Invalid --to timestamp: ${toRaw}` };
  if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
    return { error: '--from must not be after --to' };
  }

  return {
    options: {
      mode,
      sessionId,
      fromMs,
      toMs,
      factoryRoot: path.resolve(factoryRoot),
      dataDir,
      json,
    },
  };
}

export async function buildDroidReplayPlan(options: DroidReplayOptions): Promise<ReplayPlan> {
  const transcriptFiles = await findTranscriptFiles(path.join(options.factoryRoot, 'sessions'));
  const selectedFiles = options.sessionId
    ? transcriptFiles.filter(file => path.basename(file, '.jsonl') === options.sessionId)
    : transcriptFiles;
  const inputState = await readDroidInputReplayState(options.dataDir);
  const recordsBySession = new Map<string, { records: DroidRecord[]; file: string }>();
  let liveProcessedSkipped = 0;
  let unsafeStateSkipped = 0;
  const safetySkipReasons: Partial<Record<ReplaySafetySkipReason, number>> = {};
  let unsupportedTranscripts = 0;

  for (const file of selectedFiles) {
    const eligibility = await evaluateReplayTranscriptEligibility(file, inputState);
    if (!eligibility.eligible) {
      const reason = eligibility.reason ?? 'input_state_invalid';
      safetySkipReasons[reason] = (safetySkipReasons[reason] ?? 0) + 1;
      if (reason === 'live_processed') liveProcessedSkipped++;
      else unsafeStateSkipped++;
      continue;
    }
    const records = await readDroidTranscript(eligibility.canonicalPath);
    const start = records.find(record => record.type === 'session_start');
    const sessionId = stringValue(start?.id) ?? path.basename(eligibility.canonicalPath, '.jsonl');
    if (options.sessionId && sessionId !== options.sessionId) continue;
    if (!SUPPORTED_TRANSCRIPT_VERSIONS.has(numberValue(start?.version) ?? -1)) {
      unsupportedTranscripts++;
      continue;
    }
    recordsBySession.set(sessionId, { records, file: eligibility.canonicalPath });
  }

  const recordTimestamps = [...recordsBySession.values()]
    .flatMap(source => source.records.map(recordTimestampMs))
    .filter((value): value is number => value !== undefined);
  const observations = recordsBySession.size === 0
    ? []
    : await readDroidLogObservations({
        logDir: path.join(options.factoryRoot, 'logs'),
        sessionIds: recordsBySession.keys(),
        minTimestamp: options.fromMs
          ?? (recordTimestamps.length > 0 ? Math.min(...recordTimestamps) : undefined),
        maxTimestamp: options.toMs
          ?? (recordTimestamps.length > 0 ? Math.max(...recordTimestamps) : undefined),
      });
  const turns: DroidReplayTurn[] = [];
  let incompleteTurns = 0;

  for (const [sessionId, source] of recordsBySession) {
    const settingsPath = source.file.replace(/\.jsonl$/i, '.settings.json');
    const settings = await readDroidSettings(settingsPath);
    const built = await buildDroidEvents(source.records, {
      sessionId,
      settings,
      observations: observations.filter(item => item.sessionId === sessionId),
    });
    const grouped = groupReplayTurns(built.entries, sessionId);
    incompleteTurns += grouped.incomplete;
    for (const turn of grouped.complete) {
      if (
        options.fromMs !== undefined
        && (turn.startedAtMs < options.fromMs || turn.startedAtMs > options.toMs!)
      ) continue;
      turns.push(turn);
    }
  }

  turns.sort((left, right) =>
    left.startedAtMs - right.startedAtMs
    || left.sessionId.localeCompare(right.sessionId)
    || left.turnId.localeCompare(right.turnId));
  return {
    turns,
    scannedTranscripts: selectedFiles.length,
    liveProcessedSkipped,
    unsafeStateSkipped,
    safetySkipReasons,
    unsupportedTranscripts,
    incompleteTurns,
  };
}

function groupReplayTurns(
  entries: AgentActivityEntry[],
  sessionId: string,
): { complete: DroidReplayTurn[]; incomplete: number } {
  const grouped = new Map<string, AgentActivityEntry[]>();
  for (const entry of entries) {
    const turnId = stringValue(entry['gen_ai.turn.id']);
    if (!turnId) continue;
    const group = grouped.get(turnId) ?? [];
    group.push(entry);
    grouped.set(turnId, group);
  }

  const complete: DroidReplayTurn[] = [];
  let incomplete = 0;
  for (const [turnId, group] of grouped) {
    const terminal = group.some(entry =>
      entry['event.name'] === 'llm.response'
      && entry['gen_ai.turn.end'] === true
      && terminalFinishReason(entry['gen_ai.response.finish_reasons']));
    if (!terminal) {
      incomplete++;
      continue;
    }
    const times = group.map(entry => nanoToMilliseconds(entry.time_unix_nano));
    const traceId = stringValue(group[0]?.trace_id);
    if (!traceId) {
      incomplete++;
      continue;
    }
    complete.push({
      sessionId,
      turnId,
      traceId,
      startedAtMs: Math.min(...times),
      endedAtMs: Math.max(...times),
      entries: group,
      usageCompleteness: [...new Set(group
        .map(entry => stringValue(entry['agent.droid.usage.completeness']))
        .filter((value): value is string => Boolean(value)))],
    });
  }
  return { complete, incomplete };
}

async function findTranscriptFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [path.resolve(root)];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) result.push(child);
    }
  }
  return result.sort();
}

async function resolveReplayDataDir(explicit?: string): Promise<string> {
  if (explicit) return path.resolve(resolveHome(explicit));
  const config = await loadConfig();
  return path.resolve(resolveHome(config.dataDir));
}

async function readDroidInputReplayState(dataDir?: string): Promise<DroidInputReplayState> {
  if (!dataDir) {
    return { offsets: {}, files: {}, unavailableReason: 'input_state_missing' };
  }
  const statePath = path.join(dataDir, 'logs', 'input-state.json');
  let raw: string;
  try {
    const stat = await fs.lstat(statePath);
    if (!stat.isFile()) {
      return { offsets: {}, files: {}, unavailableReason: 'input_state_invalid' };
    }
    raw = await fs.readFile(statePath, 'utf8');
  } catch (err) {
    return {
      offsets: {},
      files: {},
      unavailableReason: (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'input_state_missing'
        : 'input_state_invalid',
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    return { offsets: {}, files: {}, unavailableReason: 'input_state_corrupt' };
  }
  if (!isObject(value)) {
    return { offsets: {}, files: {}, unavailableReason: 'input_state_invalid' };
  }
  const droidState = value['droid-transcript'];
  if (droidState === undefined) return { offsets: {}, files: {} };
  if (!isObject(droidState)) {
    return { offsets: {}, files: {}, unavailableReason: 'input_state_invalid' };
  }
  const extra = droidState.extra;
  if (extra === undefined) return { offsets: {}, files: {} };
  if (!isObject(extra)) {
    return { offsets: {}, files: {}, unavailableReason: 'input_state_invalid' };
  }
  const transcriptOffsets = extra.droidTranscriptBytes;
  const transcriptFiles = extra.droidTranscriptFiles;
  if (
    (transcriptOffsets !== undefined && !isObject(transcriptOffsets))
    || (transcriptFiles !== undefined && !isObject(transcriptFiles))
  ) {
    return { offsets: {}, files: {}, unavailableReason: 'input_state_invalid' };
  }
  return {
    offsets: transcriptOffsets ?? {},
    files: transcriptFiles ?? {},
  };
}

async function evaluateReplayTranscriptEligibility(
  file: string,
  inputState: DroidInputReplayState,
): Promise<ReplayTranscriptEligibility> {
  let canonicalPath = path.resolve(file);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    canonicalPath = path.resolve(await fs.realpath(file));
    stat = await fs.stat(canonicalPath);
    if (!stat.isFile()) throw new Error('not a regular file');
  } catch {
    return { eligible: false, canonicalPath, reason: 'source_metadata_changed' };
  }
  if (inputState.unavailableReason) {
    return { eligible: false, canonicalPath, reason: inputState.unavailableReason };
  }
  const meta = inputState.files[canonicalPath];
  const offset = inputState.offsets[canonicalPath];
  if (meta === undefined && offset === undefined) {
    return { eligible: false, canonicalPath, reason: 'baseline_receipt_missing' };
  }
  if (!isObject(meta)) {
    return { eligible: false, canonicalPath, reason: 'baseline_receipt_incomplete' };
  }
  const handledBoundaryAtMs = meta.handledBoundaryAtMs;
  if (
    typeof handledBoundaryAtMs !== 'number'
    || !Number.isFinite(handledBoundaryAtMs)
    || handledBoundaryAtMs < 0
  ) {
    return { eligible: false, canonicalPath, reason: 'baseline_receipt_incomplete' };
  }
  if (handledBoundaryAtMs > 0) {
    return { eligible: false, canonicalPath, reason: 'live_processed' };
  }
  if (meta.pendingBoundarySignature !== undefined) {
    return { eligible: false, canonicalPath, reason: 'baseline_boundary_pending' };
  }
  const recordedSize = meta.size;
  const recordedMtimeMs = meta.mtimeMs;
  const recordedIdentity = meta.identity;
  if (
    typeof offset !== 'number'
    || !Number.isInteger(offset)
    || offset < 0
    || typeof recordedSize !== 'number'
    || !Number.isInteger(recordedSize)
    || recordedSize < 0
    || typeof recordedMtimeMs !== 'number'
    || !Number.isFinite(recordedMtimeMs)
    || typeof recordedIdentity !== 'string'
    || recordedIdentity.length === 0
  ) {
    return { eligible: false, canonicalPath, reason: 'baseline_receipt_incomplete' };
  }
  if (recordedIdentity !== `${stat.dev}:${stat.ino}`) {
    return { eligible: false, canonicalPath, reason: 'source_identity_changed' };
  }
  if (offset !== recordedSize || recordedSize !== stat.size) {
    return { eligible: false, canonicalPath, reason: 'source_not_at_baseline_eof' };
  }
  if (recordedMtimeMs !== stat.mtimeMs) {
    return { eligible: false, canonicalPath, reason: 'source_metadata_changed' };
  }
  return { eligible: true, canonicalPath };
}

async function loadReplayLedger(file: string): Promise<LoadedReplayLedger> {
  let raw: string;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error('replay ledger is not a regular file');
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        ledger: { version: LEDGER_VERSION, turns: Object.create(null) as Record<string, ReplayLedgerEntry> },
        expected: { exists: false },
      };
    }
    throw err;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('replay ledger is corrupt; refusing to enqueue duplicate history');
  }
  if (!isObject(value) || value.version !== LEDGER_VERSION || !isObject(value.turns)) {
    throw new Error('replay ledger schema is invalid; refusing to enqueue duplicate history');
  }
  const turns: Record<string, ReplayLedgerEntry> = Object.create(null) as Record<string, ReplayLedgerEntry>;
  for (const [traceId, candidate] of Object.entries(value.turns)) {
    if (
      !/^[0-9a-f]{32}$/.test(traceId)
      || !isObject(candidate)
      || candidate.traceId !== traceId
      || typeof candidate.sessionId !== 'string'
      || typeof candidate.turnId !== 'string'
      || typeof candidate.queuedAt !== 'string'
    ) {
      throw new Error('replay ledger contains an invalid turn; refusing to enqueue duplicate history');
    }
    turns[traceId] = candidate as unknown as ReplayLedgerEntry;
  }
  if (Array.isArray(value.turns)) {
    throw new Error('replay ledger schema is invalid; refusing to enqueue duplicate history');
  }
  if (Object.getPrototypeOf(value.turns) !== Object.prototype && Object.getPrototypeOf(value.turns) !== null) {
    throw new Error('replay ledger schema is invalid; refusing to enqueue duplicate history');
  }
  if (Object.keys(turns).length !== Object.keys(value.turns).length) {
    throw new Error('replay ledger schema is invalid; refusing to enqueue duplicate history');
  }
  return {
    ledger: { version: LEDGER_VERSION, turns },
    expected: { exists: true, content: raw },
  };
}

async function saveReplayLedger(
  file: string,
  ledger: ReplayLedger,
  expected: ExpectedFileState,
): Promise<void> {
  await ensurePrivateDir(path.dirname(file));
  await writeTextFileAtomic(file, `${JSON.stringify(ledger, null, 2)}\n`, {
    expected,
    mode: 0o600,
  });
  await ensurePrivateFile(file);
}

/**
 * Queue-first, ledger-second transaction. The ledger lock is intentionally
 * separate from the OTLP spool locks; deterministic queue items make a crash
 * between local ACK and ledger write safe to retry with at-least-once IDs.
 */
export async function enqueueReplayTurnsWithLedger(
  turns: DroidReplayTurn[],
  ledgerPath: string,
  enqueue: (turn: DroidReplayTurn) => Promise<void>,
): Promise<DroidReplayTurn[]> {
  const queued: DroidReplayTurn[] = [];
  const lockPath = path.join(path.dirname(ledgerPath), '.locks', 'replay-ledger.lock');
  for (const turn of turns) {
    const accepted = await withFilesystemLock(lockPath, async () => {
      const loaded = await loadReplayLedger(ledgerPath);
      if (loaded.ledger.turns[turn.traceId]) return false;
      await enqueue(turn);
      loaded.ledger.turns[turn.traceId] = {
        sessionId: turn.sessionId,
        turnId: turn.turnId,
        traceId: turn.traceId,
        queuedAt: new Date().toISOString(),
      };
      await saveReplayLedger(ledgerPath, loaded.ledger, loaded.expected);
      return true;
    });
    if (accepted) queued.push(turn);
  }
  return queued;
}

function printReplaySummary(
  plan: ReplayPlan,
  selected: DroidReplayTurn[],
  ledger: ReplayLedger,
  json: boolean,
  executed: boolean,
): void {
  const eventCounts: Record<string, number> = {};
  for (const turn of selected) {
    for (const entry of turn.entries) {
      const name = entry['event.name'];
      eventCounts[name] = (eventCounts[name] ?? 0) + 1;
    }
  }
  const payload = {
    mode: executed ? 'execute' : 'dry-run',
    scannedTranscripts: plan.scannedTranscripts,
    liveProcessedSkipped: plan.liveProcessedSkipped,
    unsafeStateSkipped: plan.unsafeStateSkipped,
    safetySkipReasons: plan.safetySkipReasons,
    unsupportedTranscripts: plan.unsupportedTranscripts,
    incompleteTurnsSkipped: plan.incompleteTurns,
    completeTurnsMatched: plan.turns.length,
    turnsSelected: selected.length,
    alreadyQueued: plan.turns.filter(turn => ledger.turns[turn.traceId]).length,
    eventCounts,
    turns: selected.map(turn => ({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      traceId: turn.traceId,
      startedAt: new Date(turn.startedAtMs).toISOString(),
      endedAt: new Date(turn.endedAtMs).toISOString(),
      entries: turn.entries.length,
      usageCompleteness: turn.usageCompleteness,
    })),
    ...(executed && selected.length > 0
      ? { acceptance: 'queued_locally_durable_not_remote_2xx' }
      : {}),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write([
    executed ? 'Droid replay execute' : 'Droid replay dry-run',
    `  transcripts scanned: ${payload.scannedTranscripts}`,
    `  live-processed transcripts skipped: ${payload.liveProcessedSkipped}`,
    `  unsafe-state transcripts skipped: ${payload.unsafeStateSkipped}`,
    `  safety skip reasons: ${JSON.stringify(payload.safetySkipReasons)}`,
    `  complete turns matched: ${payload.completeTurnsMatched}`,
    `  turns selected: ${payload.turnsSelected}`,
    `  already queued: ${payload.alreadyQueued}`,
    `  incomplete turns skipped: ${payload.incompleteTurnsSkipped}`,
    `  unsupported transcripts: ${payload.unsupportedTranscripts}`,
    `  events: ${JSON.stringify(payload.eventCounts)}`,
    ...(executed && selected.length > 0
      ? ['  accepted: local durable queue (AgentLoop 2xx is asynchronous)']
      : []),
  ].join('\n') + '\n');
}

function terminalFinishReason(value: unknown): boolean {
  return Array.isArray(value)
    && value.some(reason => ['stop', 'end_turn', 'cancelled', 'error'].includes(String(reason)));
}

function nanoToMilliseconds(value: string): number {
  try {
    return Number(BigInt(value) / 1_000_000n);
  } catch {
    return 0;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function recordTimestampMs(record: DroidRecord): number | undefined {
  if (typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)) {
    return record.timestamp;
  }
  if (typeof record.timestamp !== 'string') return undefined;
  const parsed = Date.parse(record.timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/[\r\n]+/g, ' ');
  return String(error).replace(/[\r\n]+/g, ' ');
}

export function renderDroidHelp(): string {
  return [
    'Usage: loongsuite-pilot droid <command>',
    '',
    'Commands:',
    '  replay   Inspect historical Droid turns; upload is temporarily disabled',
  ].join('\n');
}

export function renderDroidReplayHelp(): string {
  return [
    'Usage:',
    '  loongsuite-pilot droid replay --session-id <ID> --dry-run',
    '  loongsuite-pilot droid replay --from <ISO_TIME> --to <ISO_TIME> --dry-run',
    '  loongsuite-pilot droid replay <selector> --execute  # temporarily disabled',
    '',
    'Safety:',
    '  --execute is temporarily disabled and always exits 1 before source/queue access.',
    '  Safe upload requires a future shared live/replay outbox/receipt.',
    '  Only complete turns are included in dry-run. Output never prints prompt/tool content.',
    '  Dry-run reports strict eligibility; live-processed transcripts are skipped as a whole.',
    '',
    'Options:',
    '  --session-id <ID>       Select one Droid session',
    '  --from <ISO> --to <ISO> Select turns by source event start time',
    '  --dry-run               Inspect only',
    '  --execute               Temporarily disabled; always exits 1',
    '  --factory-root <path>   Override ~/.factory (diagnostics/tests)',
    '  --data-dir <path>       Override Pilot data directory',
    '  --json                  Machine-readable content-free summary',
  ].join('\n');
}
