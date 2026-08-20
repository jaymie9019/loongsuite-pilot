import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { Dirent } from 'node:fs';
import { createDroidLogParser } from './droid-parser.js';
import type { DroidLlmObservation } from './droid-types.js';

const LOG_TIME_GRACE_MS = 10 * 60 * 1_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;
const DROID_LOG_NAME_RE = /^droid-log-single\.log(?:[.-].*)?$/;

export interface ReadDroidLogObservationsOptions {
  logDir: string;
  sessionIds: Iterable<string>;
  minTimestamp?: number;
  maxTimestamp?: number;
  /** Live collection may bound I/O per rotation; omit for complete replay reads. */
  maxTailBytesPerFile?: number;
}

/** Apply the same bounded enrichment window to an already-streamed session group. */
export function filterDroidLogObservationsByWindow(
  observations: DroidLlmObservation[],
  minTimestamp?: number,
  maxTimestamp?: number,
): DroidLlmObservation[] {
  return observations.filter(observation =>
    (minTimestamp === undefined
      || observation.completedAtMs >= minTimestamp - LOG_TIME_GRACE_MS)
    && (maxTimestamp === undefined
      || observation.startedAtMs <= maxTimestamp + LOG_TIME_GRACE_MS));
}

/**
 * Select active and date-adjacent rotations before opening large log files.
 * The one-day margin tolerates local-time rotation around UTC midnight.
 */
export function selectDroidLogCandidateNames(
  names: string[],
  minTimestamp?: number,
  maxTimestamp?: number,
): string[] {
  const dateKeys = relevantUtcDates(minTimestamp, maxTimestamp);
  return names.filter(name => {
    if (!DROID_LOG_NAME_RE.test(name)) return false;
    if (name === 'droid-log-single.log' || dateKeys.size === 0) return true;
    return [...dateKeys].some(date => name.includes(date));
  }).sort();
}

/** Stream selected rotations oldest-first without retaining raw log lines. */
export async function readDroidLogObservations(
  options: ReadDroidLogObservationsOptions,
): Promise<DroidLlmObservation[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(options.logDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const regularNames = entries.filter(entry => entry.isFile()).map(entry => entry.name);
  const selectedNames = new Set(selectDroidLogCandidateNames(
    regularNames,
    options.minTimestamp,
    options.maxTimestamp,
  ));
  const candidates: Array<{ filePath: string; mtimeMs: number; size: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !selectedNames.has(entry.name)) continue;
    const filePath = path.join(options.logDir, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) candidates.push({
        filePath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    } catch {
      // A rotation can disappear between readdir and stat.
    }
  }
  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs
    || left.filePath.localeCompare(right.filePath));

  const parser = createDroidLogParser({ sessionIds: [...options.sessionIds] });
  for (const candidate of candidates) {
    const start = tailStart(candidate.size, options.maxTailBytesPerFile);
    parser.beginSegment({ truncated: start > 0 });
    let stream: fsSync.ReadStream | undefined;
    let lines: readline.Interface | undefined;
    try {
      let discardPartialLine = await startsMidLine(candidate.filePath, start);
      stream = fsSync.createReadStream(candidate.filePath, {
        encoding: 'utf8',
        ...(start > 0 ? { start } : {}),
      });
      lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lines) {
        if (discardPartialLine) {
          discardPartialLine = false;
          continue;
        }
        parser.pushLine(line);
      }
    } catch {
      // Logs are optional enrichment and may rotate during a read.
    } finally {
      lines?.close();
      stream?.destroy();
    }
  }

  return filterDroidLogObservationsByWindow(
    parser.finish(),
    options.minTimestamp,
    options.maxTimestamp,
  );
}

async function startsMidLine(filePath: string, start: number): Promise<boolean> {
  if (start === 0) return false;
  const handle = await fs.open(filePath, 'r');
  try {
    const previousByte = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(previousByte, 0, 1, start - 1);
    return bytesRead !== 1 || previousByte[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}

function tailStart(fileSize: number, maxTailBytesPerFile: number | undefined): number {
  if (maxTailBytesPerFile === undefined) return 0;
  if (!Number.isSafeInteger(maxTailBytesPerFile) || maxTailBytesPerFile <= 0) {
    throw new Error('Droid log tail byte limit must be a positive safe integer');
  }
  return Math.max(0, fileSize - maxTailBytesPerFile);
}

function relevantUtcDates(
  minTimestamp: number | undefined,
  maxTimestamp: number | undefined,
): Set<string> {
  if (minTimestamp === undefined && maxTimestamp === undefined) return new Set();
  const start = (minTimestamp ?? maxTimestamp ?? Date.now()) - ONE_DAY_MS;
  const end = (maxTimestamp ?? minTimestamp ?? Date.now()) + ONE_DAY_MS;
  const dates = new Set<string>();
  for (let time = start; time <= end; time += ONE_DAY_MS) {
    dates.add(new Date(time).toISOString().slice(0, 10));
  }
  dates.add(new Date(end).toISOString().slice(0, 10));
  return dates;
}
