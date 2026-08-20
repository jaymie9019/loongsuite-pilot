import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { loadConfig, buildOtlpTraceConfig } from '../core/config-loader.js';
import {
  OtlpTraceFlusher,
  type OtlpDurableRouteStatus,
} from '../flushers/otlp-trace-flusher.js';
import {
  inspectDurableOtlpSpool,
  type DurableOtlpSpoolInventory,
} from '../flushers/durable-otlp-queue.js';
import { GlobalAttributesProvider } from '../normalization/global-attributes.js';
import { resolveHome } from '../utils/fs-utils.js';

export interface FailedReplayOptions {
  mode: 'dry-run' | 'execute';
  dataDir?: string;
  json: boolean;
}

interface LegacyFailedInventory {
  files: number;
  bytes: number;
  migrationSupported: false;
  reason: string;
}

interface FailedReplayReport {
  mode: FailedReplayOptions['mode'];
  durableBefore: DurableOtlpSpoolInventory;
  durableAfter?: DurableOtlpSpoolInventory;
  routeResults?: OtlpDurableRouteStatus[];
  legacyOtlpFailed: LegacyFailedInventory;
  semantics: string;
  success?: boolean;
  failureReasons?: string[];
}

export async function runFailedCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    process.stdout.write(`${renderFailedHelp()}\n`);
    return 0;
  }
  if (subcommand !== 'replay') {
    process.stderr.write(`Unknown failed command: ${subcommand}\n\n${renderFailedHelp()}\n`);
    return 1;
  }

  const parsed = parseFailedReplayArgs(rest);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${renderFailedReplayHelp()}\n`);
    return 1;
  }
  if (parsed.help) {
    process.stdout.write(`${renderFailedReplayHelp()}\n`);
    return 0;
  }

  try {
    const options = parsed.options!;
    const dataDir = await resolveDataDir(options.dataDir);
    const durableBefore = await inspectDurableOtlpSpool(dataDir);
    const legacyOtlpFailed = await inspectLegacyFailedDirectory(
      path.join(dataDir, 'logs', 'otlp-failed'),
    );

    if (options.mode === 'dry-run') {
      printReport({
        mode: options.mode,
        durableBefore,
        legacyOtlpFailed,
        semantics: 'inventory_only_no_payloads_opened',
      }, options.json);
      return 0;
    }

    const config = await loadConfig();
    const configuredDataDir = path.resolve(resolveHome(config.dataDir));
    if (configuredDataDir !== dataDir) {
      throw new Error(
        `--data-dir (${dataDir}) does not match configured Pilot dataDir (${configuredDataDir})`,
      );
    }
    const otlpConfig = buildOtlpTraceConfig(config);
    if (!otlpConfig?.enabled || otlpConfig.endpoints.length === 0) {
      throw new Error('no AgentLoop/OTLP trace endpoint is configured');
    }

    const attributesProvider = new GlobalAttributesProvider(
      config.globalSpanAttributes ?? {},
      path.join(dataDir, 'span-attributes.json'),
    );
    const flusher = new OtlpTraceFlusher(
      { ...otlpConfig, dataDir },
      attributesProvider,
    );
    let routeResults: OtlpDurableRouteStatus[];
    try {
      routeResults = await flusher.replayDurableQueues();
    } finally {
      await flusher.shutdown();
    }
    const durableAfter = await inspectDurableOtlpSpool(dataDir);
    const failureReasons = evaluateExecuteFailureReasons(
      durableBefore,
      durableAfter,
      routeResults,
    );
    const success = failureReasons.length === 0;
    printReport({
      mode: options.mode,
      durableBefore,
      durableAfter,
      routeResults,
      legacyOtlpFailed,
      semantics: success
        ? 'remote_delivery_completed_no_pending_or_dead_letter_items'
        : 'remote_delivery_incomplete_check_failure_reasons',
      success,
      failureReasons,
    }, options.json);
    return success ? 0 : 1;
  } catch (err) {
    process.stderr.write(`Failed replay failed: ${safeErrorMessage(err)}\n`);
    return 1;
  }
}

function evaluateExecuteFailureReasons(
  before: DurableOtlpSpoolInventory,
  after: DurableOtlpSpoolInventory,
  routes: OtlpDurableRouteStatus[],
): string[] {
  const beforePending = before.routes.reduce((sum, route) => sum + route.pendingItems, 0);
  const afterPending = after.routes.reduce((sum, route) => sum + route.pendingItems, 0);
  const afterDeadLetter = after.routes.reduce((sum, route) => sum + route.deadLetterItems, 0);
  const reasons: string[] = [];

  if (afterPending > 0) {
    reasons.push(
      beforePending > 0 && afterPending >= beforePending
        ? 'pending_items_not_reduced'
        : 'pending_items_remaining',
    );
  }
  if (routes.some(route => route.pausedHttpStatus === 401 || route.pausedHttpStatus === 403)) {
    reasons.push('route_paused_authentication');
  }
  if (afterDeadLetter > 0) reasons.push('dead_letter_items_present');
  return reasons;
}

export function parseFailedReplayArgs(args: string[]): {
  options?: FailedReplayOptions;
  error?: string;
  help?: boolean;
} {
  let mode: FailedReplayOptions['mode'] | undefined;
  let dataDir: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--dry-run' || arg === '--execute') {
      const candidate = arg === '--execute' ? 'execute' : 'dry-run';
      if (mode && mode !== candidate) {
        return { error: '--dry-run and --execute are mutually exclusive' };
      }
      mode = candidate;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--data-dir' || arg.startsWith('--data-dir=')) {
      const value = arg.startsWith('--data-dir=') ? arg.slice('--data-dir='.length) : args[++index];
      if (!value || value.startsWith('--')) return { error: 'Missing value for --data-dir' };
      dataDir = path.resolve(resolveHome(value));
      continue;
    }
    return { error: `Unknown option: ${arg}` };
  }

  if (!mode) return { error: 'Choose --dry-run or explicitly acknowledge replay with --execute' };
  return { options: { mode, dataDir, json } };
}

async function resolveDataDir(explicit: string | undefined): Promise<string> {
  if (explicit) return path.resolve(resolveHome(explicit));
  const config = await loadConfig();
  return path.resolve(resolveHome(config.dataDir));
}

async function inspectLegacyFailedDirectory(root: string): Promise<LegacyFailedInventory> {
  let files = 0;
  let bytes = 0;
  const pending = [root];
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
      if (entry.isSymbolicLink()) continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.lstat(child);
      if (!stat.isFile()) continue;
      files++;
      bytes += stat.size;
    }
  }
  return {
    files,
    bytes,
    migrationSupported: false,
    reason: 'legacy files omit scope/events/links and cannot be replayed losslessly',
  };
}

function printReport(report: FailedReplayReport, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const beforePending = report.durableBefore.routes.reduce(
    (sum, route) => sum + route.pendingItems,
    0,
  );
  const afterPending = report.durableAfter?.routes.reduce(
    (sum, route) => sum + route.pendingItems,
    0,
  );
  const lines = [
    report.mode === 'execute' ? 'Failed replay execute' : 'Failed replay dry-run',
    `  durable routes: ${report.durableBefore.routes.length}`,
    `  pending before: ${beforePending}`,
    `  dead-letter: ${report.durableBefore.routes.reduce((sum, route) => sum + route.deadLetterItems, 0)}`,
    `  durable bytes: ${report.durableBefore.totalBytes}`,
    `  legacy files (inventory only): ${report.legacyOtlpFailed.files}`,
    `  legacy bytes: ${report.legacyOtlpFailed.bytes}`,
    `  legacy replay: unsupported (${report.legacyOtlpFailed.reason})`,
  ];
  if (afterPending !== undefined) {
    lines.push(`  pending after attempt: ${afterPending}`);
    for (const route of report.routeResults ?? []) {
      const paused = route.pausedHttpStatus === undefined
        ? ''
        : `, paused HTTP ${route.pausedHttpStatus}`;
      lines.push(`  route ${route.routeId}: pending=${route.pendingItems}, dead-letter=${route.deadLetterItems}${paused}`);
    }
    if (report.success) {
      lines.push('  result: complete; no pending or dead-letter items remain');
    } else {
      lines.push(`  result: incomplete (${(report.failureReasons ?? []).join(', ')})`);
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replace(/[\r\n]+/g, ' ');
  return String(error).replace(/[\r\n]+/g, ' ');
}

export function renderFailedHelp(): string {
  return [
    'Usage: loongsuite-pilot failed <command>',
    '',
    'Commands:',
    '  replay   Inspect or explicitly retry the durable OTLP queue',
  ].join('\n');
}

export function renderFailedReplayHelp(): string {
  return [
    'Usage:',
    '  loongsuite-pilot failed replay --dry-run',
    '  loongsuite-pilot failed replay --execute',
    '',
    'Safety:',
    '  --execute is mandatory for a delivery attempt; omitting both modes is an error.',
    '  Execute exits non-zero while pending items, auth-paused routes, or dead-letter items remain.',
    '  Dry-run reports counts and bytes without opening queued payloads.',
    '  Legacy logs/otlp-failed files are inventory-only and are never auto-replayed.',
    '',
    'Options:',
    '  --dry-run          Inspect only',
    '  --execute          Explicitly retry configured durable routes',
    '  --data-dir <path>  Override Pilot data directory (must match config for execute)',
    '  --json             Machine-readable content-free summary',
  ].join('\n');
}
