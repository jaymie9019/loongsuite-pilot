import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDroidReplayPlan,
  enqueueReplayTurnsWithLedger,
  parseDroidReplayArgs,
  runDroidCommand,
  type DroidReplayTurn,
} from '../../../src/cli/droid-replay.js';

const FIXTURE_DIR = fileURLToPath(
  new URL('../../fixtures/droid/golden-v2/', import.meta.url),
);
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const USER_MESSAGE_ID = '00000000-0000-4000-8000-000000000003';

async function makeFactoryFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'droid-replay-'));
  const sessions = path.join(root, 'sessions', 'workspace-one');
  const logs = path.join(root, 'logs');
  await Promise.all([mkdir(sessions, { recursive: true }), mkdir(logs, { recursive: true })]);
  await cp(
    path.join(FIXTURE_DIR, 'session.jsonl'),
    path.join(sessions, `${SESSION_ID}.jsonl`),
  );
  await cp(
    path.join(FIXTURE_DIR, 'session.settings.json'),
    path.join(sessions, `${SESSION_ID}.settings.json`),
  );
  await cp(
    path.join(FIXTURE_DIR, 'droid.log'),
    path.join(logs, 'droid-log-single.log'),
  );
  return root;
}

async function writeDroidInputState(
  factoryRoot: string,
  dataDir: string,
  handledBoundaryAtMs: number,
): Promise<void> {
  const transcript = await realpath(path.join(
    factoryRoot,
    'sessions',
    'workspace-one',
    `${SESSION_ID}.jsonl`,
  ));
  const transcriptStat = await stat(transcript);
  await mkdir(path.join(dataDir, 'logs'), { recursive: true });
  await writeFile(path.join(dataDir, 'logs', 'input-state.json'), JSON.stringify({
    'droid-transcript': {
      extra: {
        droidInitialized: true,
        droidTranscriptBytes: {
          [transcript]: transcriptStat.size,
        },
        droidTranscriptFiles: {
          [transcript]: {
            size: transcriptStat.size,
            mtimeMs: transcriptStat.mtimeMs,
            identity: `${transcriptStat.dev}:${transcriptStat.ino}`,
            handledBoundaryAtMs,
          },
        },
      },
    },
  }), 'utf8');
}

async function captureReplaySummary(args: string[]): Promise<{
  code: number;
  summary?: Record<string, unknown>;
  stderr: string;
}> {
  let output = '';
  let stderr = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  const errorOutput = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  try {
    const code = await runDroidCommand(args);
    return {
      code,
      summary: output ? JSON.parse(output) as Record<string, unknown> : undefined,
      stderr,
    };
  } finally {
    stdout.mockRestore();
    errorOutput.mockRestore();
  }
}

function replayTurn(traceId: string, suffix: string): DroidReplayTurn {
  return {
    sessionId: `session-${suffix}`,
    turnId: `turn-${suffix}`,
    traceId,
    startedAtMs: 1,
    endedAtMs: 2,
    entries: [],
    usageCompleteness: ['missing'],
  };
}

afterEach(() => vi.restoreAllMocks());

describe('Droid replay CLI', () => {
  it('requires one selector and an explicit dry-run/execute mode', () => {
    expect(parseDroidReplayArgs(['--session-id', SESSION_ID]).error)
      .toContain('--dry-run');
    expect(parseDroidReplayArgs(['--dry-run']).error)
      .toContain('--session-id');
    expect(parseDroidReplayArgs([
      '--session-id', SESSION_ID, '--from', '2026-08-19T00:00:00Z', '--to', '2026-08-20T00:00:00Z', '--dry-run',
    ]).error).toContain('either');
    expect(parseDroidReplayArgs([
      '--session-id', SESSION_ID, '--dry-run', '--execute',
    ]).error).toContain('mutually exclusive');
    expect(parseDroidReplayArgs([
      '--session-id', SESSION_ID, '--execute',
    ]).options?.mode).toBe('execute');
  });

  it('unconditionally disables execute before source selection', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-replay-disabled-'));
    const result = await captureReplaySummary([
      'replay',
      '--session-id', 'explicit-session-does-not-exist',
      '--factory-root', path.join(root, 'factory'),
      '--data-dir', path.join(root, 'pilot'),
      '--execute',
      '--json',
    ]);

    expect(result.code).toBe(1);
    expect(result.summary).toBeUndefined();
    expect(result.stderr).toContain('temporarily disabled');
    expect(result.stderr).toContain('shared live/replay outbox/receipt');
    await expect(stat(path.join(root, 'pilot'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('scans nested sessions and builds only the complete golden turn', async () => {
    const factoryRoot = await makeFactoryFixture();
    const dataDir = path.join(factoryRoot, 'pilot');
    await writeDroidInputState(factoryRoot, dataDir, 0);
    const plan = await buildDroidReplayPlan({
      mode: 'dry-run',
      sessionId: SESSION_ID,
      factoryRoot,
      dataDir,
      json: false,
    });

    expect(plan.scannedTranscripts).toBe(1);
    expect(plan.unsupportedTranscripts).toBe(0);
    expect(plan.incompleteTurns).toBe(0);
    expect(plan.turns).toHaveLength(1);
    const turn = plan.turns[0];
    expect(turn.turnId).toBe(USER_MESSAGE_ID);
    expect(turn.traceId).toBe(createHash('sha256')
      .update([SESSION_ID, USER_MESSAGE_ID, 'turn'].join('\0'))
      .digest('hex')
      .slice(0, 32));
    expect(turn.entries.filter(entry => entry['event.name'] === 'llm.response')).toHaveLength(2);
    expect(turn.entries.filter(entry => entry['event.name'] === 'tool.call')).toHaveLength(1);
    expect(turn.usageCompleteness).toEqual(['per_call']);
  });

  it('prints a content-free dry-run summary', async () => {
    const factoryRoot = await makeFactoryFixture();
    const dataDir = path.join(factoryRoot, 'pilot');
    await writeDroidInputState(factoryRoot, dataDir, 0);
    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);

    const code = await runDroidCommand([
      'replay',
      '--session-id', SESSION_ID,
      '--factory-root', factoryRoot,
      '--data-dir', dataDir,
      '--dry-run',
      '--json',
    ]);

    expect(code).toBe(0);
    expect(output).toContain('"completeTurnsMatched": 1');
    expect(output).toContain('"llm.response": 2');
    expect(output).toContain('"tool.call": 1');
    expect(output).not.toContain('Run pwd once');
    expect(output).not.toContain('/workspace/droid-fixture');
    expect(output).not.toContain('fixture-user');
  });

  it('reports the whole transcript as skipped after live input committed a boundary', async () => {
    const factoryRoot = await makeFactoryFixture();
    const dataDir = path.join(factoryRoot, 'pilot');
    await writeDroidInputState(factoryRoot, dataDir, 1_787_143_298_380);

    // The receipt is transcript-scoped rather than turn-scoped. Conservatively
    // exclude every historical turn in the file once any live boundary was
    // committed, because AgentLoop does not deduplicate matching trace/span IDs.
    const result = await captureReplaySummary([
      'replay',
      '--session-id', SESSION_ID,
      '--factory-root', factoryRoot,
      '--data-dir', dataDir,
      '--dry-run',
      '--json',
    ]);

    expect(result.code).toBe(0);
    expect(result.summary).toMatchObject({
      mode: 'dry-run',
      scannedTranscripts: 1,
      liveProcessedSkipped: 1,
      completeTurnsMatched: 0,
      turnsSelected: 0,
      eventCounts: {},
    });
  });

  it('keeps an initial handledBoundaryAtMs=0 baseline eligible for historical replay', async () => {
    const factoryRoot = await makeFactoryFixture();
    const dataDir = path.join(factoryRoot, 'pilot');
    await writeDroidInputState(factoryRoot, dataDir, 0);

    const result = await captureReplaySummary([
      'replay',
      '--session-id', SESSION_ID,
      '--factory-root', factoryRoot,
      '--data-dir', dataDir,
      '--dry-run',
      '--json',
    ]);

    expect(result.code).toBe(0);
    expect(result.summary).toMatchObject({
      liveProcessedSkipped: 0,
      unsafeStateSkipped: 0,
      completeTurnsMatched: 1,
      turnsSelected: 1,
    });

    const execute = await captureReplaySummary([
      'replay',
      '--session-id', SESSION_ID,
      '--factory-root', factoryRoot,
      '--data-dir', dataDir,
      '--execute',
      '--json',
    ]);
    expect(execute.code).toBe(1);
    expect(execute.summary).toBeUndefined();
    expect(execute.stderr).toContain('temporarily disabled');
  });

  it('reports missing input state in dry-run', async () => {
    const factoryRoot = await makeFactoryFixture();
    const dataDir = path.join(factoryRoot, 'pilot');

    const result = await captureReplaySummary([
      'replay',
      '--session-id', SESSION_ID,
      '--factory-root', factoryRoot,
      '--data-dir', dataDir,
      '--dry-run',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(result.summary).toMatchObject({
      unsafeStateSkipped: 1,
      safetySkipReasons: { input_state_missing: 1 },
      completeTurnsMatched: 0,
      turnsSelected: 0,
    });
  });

  it('reports an incomplete baseline receipt in dry-run', async () => {
    const factoryRoot = await makeFactoryFixture();
    const dataDir = path.join(factoryRoot, 'pilot');
    await writeDroidInputState(factoryRoot, dataDir, 0);
    const statePath = path.join(dataDir, 'logs', 'input-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      'droid-transcript': { extra: { droidTranscriptFiles: Record<string, { identity?: string }> } };
    };
    const [receipt] = Object.values(
      state['droid-transcript'].extra.droidTranscriptFiles,
    );
    delete receipt.identity;
    await writeFile(statePath, JSON.stringify(state), 'utf8');

    const result = await captureReplaySummary([
      'replay',
      '--session-id', SESSION_ID,
      '--factory-root', factoryRoot,
      '--data-dir', dataDir,
      '--dry-run',
      '--json',
    ]);
    expect(result.code).toBe(0);
    expect(result.summary).toMatchObject({
      liveProcessedSkipped: 0,
      unsafeStateSkipped: 1,
      safetySkipReasons: { baseline_receipt_incomplete: 1 },
      completeTurnsMatched: 0,
      turnsSelected: 0,
    });
  });

  it('reports a baseline receipt with a pending boundary in dry-run', async () => {
    const factoryRoot = await makeFactoryFixture();
    const dataDir = path.join(factoryRoot, 'pilot');
    await writeDroidInputState(factoryRoot, dataDir, 0);
    const statePath = path.join(dataDir, 'logs', 'input-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      'droid-transcript': {
        extra: {
          droidTranscriptFiles: Record<string, { pendingBoundarySignature?: string }>;
        };
      };
    };
    const [receipt] = Object.values(
      state['droid-transcript'].extra.droidTranscriptFiles,
    );
    receipt.pendingBoundarySignature = 'candidate-boundary';
    await writeFile(statePath, JSON.stringify(state), 'utf8');

    const result = await captureReplaySummary([
      'replay',
      '--session-id', SESSION_ID,
      '--factory-root', factoryRoot,
      '--data-dir', dataDir,
      '--dry-run',
      '--json',
    ]);

    expect(result.code).toBe(0);
    expect(result.summary).toMatchObject({
      unsafeStateSkipped: 1,
      safetySkipReasons: { baseline_boundary_pending: 1 },
      completeTurnsMatched: 0,
      turnsSelected: 0,
    });
  });

  it('reports a transcript that grows after the baseline receipt in dry-run', async () => {
    const factoryRoot = await makeFactoryFixture();
    const dataDir = path.join(factoryRoot, 'pilot');
    await writeDroidInputState(factoryRoot, dataDir, 0);
    await appendFile(path.join(
      factoryRoot,
      'sessions',
      'workspace-one',
      `${SESSION_ID}.jsonl`,
    ), '\n');

    const result = await captureReplaySummary([
      'replay',
      '--session-id', SESSION_ID,
      '--factory-root', factoryRoot,
      '--data-dir', dataDir,
      '--dry-run',
      '--json',
    ]);

    expect(result.code).toBe(0);
    expect(result.summary).toMatchObject({
      unsafeStateSkipped: 1,
      safetySkipReasons: { source_not_at_baseline_eof: 1 },
      completeTurnsMatched: 0,
      turnsSelected: 0,
    });
  });

  it('keeps dry-run available while the Pilot runtime is active', async () => {
    const factoryRoot = await makeFactoryFixture();
    const dataDir = path.join(factoryRoot, 'pilot');
    await writeDroidInputState(factoryRoot, dataDir, 0);
    await writeFile(path.join(dataDir, 'logs', 'runtime.json'), JSON.stringify({
      status: 'active',
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    }), 'utf8');

    const result = await captureReplaySummary([
      'replay',
      '--session-id', SESSION_ID,
      '--factory-root', factoryRoot,
      '--data-dir', dataDir,
      '--dry-run',
      '--json',
    ]);

    expect(result.code).toBe(0);
    expect(result.summary).toMatchObject({
      completeTurnsMatched: 1,
      turnsSelected: 1,
    });
  });

  it('fails closed for an unknown transcript version', async () => {
    const factoryRoot = await makeFactoryFixture();
    const transcript = path.join(factoryRoot, 'sessions', 'workspace-one', `${SESSION_ID}.jsonl`);
    const text = await readFile(transcript, 'utf8');
    await writeFile(transcript, text.replace('"version":2', '"version":999'), 'utf8');
    const dataDir = path.join(factoryRoot, 'pilot');
    await writeDroidInputState(factoryRoot, dataDir, 0);

    const plan = await buildDroidReplayPlan({
      mode: 'dry-run',
      sessionId: SESSION_ID,
      factoryRoot,
      dataDir,
      json: false,
    });
    expect(plan.unsupportedTranscripts).toBe(1);
    expect(plan.turns).toHaveLength(0);

    const execute = await captureReplaySummary([
      'replay',
      '--session-id', SESSION_ID,
      '--factory-root', factoryRoot,
      '--data-dir', dataDir,
      '--execute',
      '--json',
    ]);
    expect(execute.code).toBe(1);
    expect(execute.summary).toBeUndefined();
    expect(execute.stderr).toContain('temporarily disabled');
  });

  it('fails closed when the persistent replay ledger is corrupt', async () => {
    const factoryRoot = await makeFactoryFixture();
    const dataDir = path.join(factoryRoot, 'pilot');
    const ledgerDir = path.join(dataDir, 'state', 'droid');
    await mkdir(ledgerDir, { recursive: true });
    await writeFile(path.join(ledgerDir, 'replay-ledger.json'), '{broken', 'utf8');
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);

    const code = await runDroidCommand([
      'replay',
      '--session-id', SESSION_ID,
      '--factory-root', factoryRoot,
      '--data-dir', dataDir,
      '--dry-run',
    ]);

    expect(code).toBe(1);
    expect(stderr).toContain('ledger is corrupt');
    expect(stderr).toContain('refusing to enqueue duplicate history');
  });

  it('serializes concurrent replay ledger updates without double enqueue or lost turns', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-replay-ledger-race-'));
    const ledgerPath = path.join(root, 'state', 'droid', 'replay-ledger.json');
    const first = replayTurn('a'.repeat(32), 'first');
    const second = replayTurn('b'.repeat(32), 'second');
    let sameTurnEnqueues = 0;

    await Promise.all([
      enqueueReplayTurnsWithLedger([first], ledgerPath, async () => {
        sameTurnEnqueues++;
        await new Promise(resolve => setTimeout(resolve, 20));
      }),
      enqueueReplayTurnsWithLedger([first], ledgerPath, async () => {
        sameTurnEnqueues++;
      }),
    ]);
    expect(sameTurnEnqueues).toBe(1);

    await Promise.all([
      enqueueReplayTurnsWithLedger([first], ledgerPath, async () => {
        throw new Error('existing turn must not enqueue again');
      }),
      enqueueReplayTurnsWithLedger([second], ledgerPath, async () => undefined),
    ]);
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      turns: Record<string, unknown>;
    };
    expect(Object.keys(ledger.turns).sort()).toEqual([first.traceId, second.traceId]);
    if (process.platform !== 'win32') {
      expect((await stat(ledgerPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('recovers a replay ledger lock whose owner process is gone', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-replay-ledger-stale-lock-'));
    const ledgerPath = path.join(root, 'state', 'droid', 'replay-ledger.json');
    const lockPath = path.join(path.dirname(ledgerPath), '.locks', 'replay-ledger.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      createdAt: 1,
      token: 'stale-owner-token',
    }));
    const turn = replayTurn('c'.repeat(32), 'stale');
    let enqueues = 0;

    await enqueueReplayTurnsWithLedger([turn], ledgerPath, async () => { enqueues++; });

    expect(enqueues).toBe(1);
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as {
      turns: Record<string, unknown>;
    };
    expect(ledger.turns[turn.traceId]).toBeDefined();
  });
});
