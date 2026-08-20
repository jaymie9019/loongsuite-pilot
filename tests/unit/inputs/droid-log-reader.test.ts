import { mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  readDroidLogObservations,
  selectDroidLogCandidateNames,
} from '../../../src/inputs/droid/droid-log-reader.js';

const FIXTURE = fileURLToPath(
  new URL('../../fixtures/droid/golden-v2/droid.log', import.meta.url),
);
const SESSION_ID = '11111111-2222-4333-8444-555555555555';

const readStreamTracker = vi.hoisted(() => ({
  opens: [] as Array<{ filePath: string; start?: number }>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: ((...args: Parameters<typeof actual.createReadStream>) => {
      const options = args[1] as { start?: number } | undefined;
      readStreamTracker.opens.push({
        filePath: String(args[0]),
        start: options?.start,
      });
      return actual.createReadStream(...args);
    }) as typeof actual.createReadStream,
  };
});

describe('Droid streamed log reader', () => {
  it('keeps active and date-adjacent rotations while excluding old/unrelated files', () => {
    const at = Date.parse('2026-08-19T12:41:00Z');
    expect(selectDroidLogCandidateNames([
      'console.log',
      'droid-log-single.log.2026-08-01',
      'droid-log-single.log.2026-08-18',
      'droid-log-single.log.2026-08-19',
      'droid-log-single.log.2026-08-19.1',
      'droid-log-single.log.2026-08-20',
      'droid-log-single.log',
    ], at, at)).toEqual([
      'droid-log-single.log',
      'droid-log-single.log.2026-08-18',
      'droid-log-single.log.2026-08-19',
      'droid-log-single.log.2026-08-19.1',
      'droid-log-single.log.2026-08-20',
    ]);
  });

  it('joins calls across rotations and retains only the requested session', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-streamed-logs-'));
    const logDir = path.join(root, 'logs');
    await mkdir(logDir, { recursive: true });
    const lines = (await readFile(FIXTURE, 'utf8')).trim().split('\n');
    const otherSessionLines = lines.map(line => line.replace(
      SESSION_ID,
      '99999999-9999-4999-8999-999999999999',
    ));
    const first = path.join(logDir, 'droid-log-single.log.2026-08-19');
    const second = path.join(logDir, 'droid-log-single.log.2026-08-19.1');
    await writeFile(first, `${[...lines.slice(0, 2), ...otherSessionLines.slice(0, 2)].join('\n')}\n`);
    await writeFile(second, `${[...lines.slice(2), ...otherSessionLines.slice(2)].join('\n')}\n`);
    await utimes(first, new Date('2026-08-19T12:40:00Z'), new Date('2026-08-19T12:40:00Z'));
    await utimes(second, new Date('2026-08-19T12:42:00Z'), new Date('2026-08-19T12:42:00Z'));

    const observations = await readDroidLogObservations({
      logDir,
      sessionIds: [SESSION_ID],
      minTimestamp: Date.parse('2026-08-19T12:41:00Z'),
      maxTimestamp: Date.parse('2026-08-19T12:42:00Z'),
    });

    expect(observations).toHaveLength(2);
    expect(observations.every(item => item.sessionId === SESSION_ID)).toBe(true);
    expect(observations.map(item => item.usage)).toMatchObject([
      { inputTokens: 20196, outputTokens: 162, totalTokens: 20358 },
      { inputTokens: 20405, outputTokens: 41, totalTokens: 20446 },
    ]);
  });

  it('reads only the bounded tail and discards the first partial line', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-streamed-tail-'));
    const logDir = path.join(root, 'logs');
    await mkdir(logDir, { recursive: true });
    const fixture = await readFile(FIXTURE, 'utf8');
    const prefix = 'PREFIX_MUST_NOT_BE_READ'.repeat(4_096);
    const filePath = path.join(logDir, 'droid-log-single.log');
    const contents = `${prefix}\n${fixture}`;
    await writeFile(filePath, contents);
    const maxTailBytesPerFile = Buffer.byteLength(fixture) + 64;
    readStreamTracker.opens.length = 0;

    const observations = await readDroidLogObservations({
      logDir,
      sessionIds: [SESSION_ID],
      maxTailBytesPerFile,
    });

    expect(observations.map(item => item.usage.totalTokens)).toEqual([20358, 20446]);
    expect(readStreamTracker.opens).toHaveLength(1);
    const [open] = readStreamTracker.opens;
    expect(open.filePath).toBe(filePath);
    expect(open.start).toBeGreaterThan(0);
    expect(Buffer.byteLength(contents) - open.start!).toBe(maxTailBytesPerFile);
  });

  it('retains the first complete line when the tail starts at a line boundary', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-streamed-tail-boundary-'));
    const logDir = path.join(root, 'logs');
    await mkdir(logDir, { recursive: true });
    const fixture = await readFile(FIXTURE, 'utf8');
    const prefix = 'IRRELEVANT_PREFIX';
    const filePath = path.join(logDir, 'droid-log-single.log');
    await writeFile(filePath, `${prefix}\n${fixture}`);

    const observations = await readDroidLogObservations({
      logDir,
      sessionIds: [SESSION_ID],
      maxTailBytesPerFile: Buffer.byteLength(fixture),
    });

    expect(observations.map(item => item.usage.totalTokens)).toEqual([20358, 20446]);
  });

  it('resynchronizes after a tail starts between sendMessage and Streaming result', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-streamed-tail-resync-'));
    const logDir = path.join(root, 'logs');
    await mkdir(logDir, { recursive: true });
    const fixture = await readFile(FIXTURE, 'utf8');
    const lines = fixture.trimEnd().split(/\r?\n/);
    const retainedTail = `${lines.slice(1).join('\n')}\n`;
    const filePath = path.join(logDir, 'droid-log-single.log');
    await writeFile(filePath, fixture);

    const observations = await readDroidLogObservations({
      logDir,
      sessionIds: [SESSION_ID],
      maxTailBytesPerFile: Buffer.byteLength(retainedTail),
    });

    expect(observations.map(item => ({
      responseId: item.responseId,
      totalTokens: item.usage.totalTokens,
      timeToFirstTokenNs: item.timeToFirstTokenNs,
    }))).toEqual([{
      responseId: '00000000-0000-4000-8000-000000000102',
      totalTokens: 20446,
      timeToFirstTokenNs: 2_198_000_000,
    }]);
  });

  it('keeps replay-style reads unbounded when no tail limit is provided', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-streamed-full-'));
    const logDir = path.join(root, 'logs');
    await mkdir(logDir, { recursive: true });
    const fixture = await readFile(FIXTURE, 'utf8');
    const filePath = path.join(logDir, 'droid-log-single.log');
    await writeFile(filePath, `${'X'.repeat(16 * 1024 * 1024 + 256)}\n${fixture}`);
    readStreamTracker.opens.length = 0;

    const observations = await readDroidLogObservations({
      logDir,
      sessionIds: [SESSION_ID],
    });

    expect(observations.map(item => item.usage.totalTokens)).toEqual([20358, 20446]);
    expect(readStreamTracker.opens).toEqual([{ filePath, start: undefined }]);
  });
});
