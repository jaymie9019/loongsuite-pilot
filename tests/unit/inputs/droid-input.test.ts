import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { DroidInput } from '../../../src/inputs/droid/droid-input.js';

const logReadTracker = vi.hoisted(() => ({
  opens: [] as Array<{ filePath: string; start?: number }>,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: ((...args: Parameters<typeof actual.createReadStream>) => {
      const options = args[1] as { start?: number } | undefined;
      logReadTracker.opens.push({
        filePath: String(args[0]),
        start: options?.start,
      });
      return actual.createReadStream(...args);
    }) as typeof actual.createReadStream,
  };
});

const FIXTURE_DIR = fileURLToPath(
  new URL('../../fixtures/droid/golden-v2/', import.meta.url),
);
const GOLDEN_SESSION_ID = '11111111-2222-4333-8444-555555555555';

class TestDroidInput extends DroidInput {
  async collectNow() {
    try {
      const entries = await this.collect();
      await this.beforeCheckpoint();
      await this.afterCheckpoint();
      return entries;
    } catch (error) {
      await this.onCycleFailed();
      throw error;
    }
  }

  collectStaged() {
    return this.collect();
  }

  async commitStaged() {
    await this.beforeCheckpoint();
    await this.stateStore.save();
    await this.afterCheckpoint();
  }

  async commitStagedWith(save: () => Promise<void>) {
    try {
      await this.beforeCheckpoint();
      await save();
      await this.afterCheckpoint();
    } catch (error) {
      await this.onCycleFailed();
      throw error;
    }
  }

  async discardStaged() {
    await this.onCycleFailed();
  }
}

let hookSequence = 0;

async function writeHookEvent(
  hookEventDir: string,
  record: Record<string, unknown>,
): Promise<string> {
  const transcriptPath = String(record.transcript_path ?? '');
  const sessionId = String(
    record.session_id ?? path.basename(transcriptPath, path.extname(transcriptPath)),
  );
  const sessionDir = path.join(hookEventDir, sessionId);
  await mkdir(sessionDir, { recursive: true });
  const observedAtMs = Number(record.observed_at_ms ?? 0);
  const eventFile = path.join(
    sessionDir,
    `${String(observedAtMs).padStart(16, '0')}-${hookSequence++}.json`,
  );
  await writeFile(eventFile, JSON.stringify({ ...record, session_id: sessionId }));
  return eventFile;
}

function turnRecords(
  sessionId: string,
  suffix: string,
  startedAtMs: number,
  includeSessionStart = true,
): Array<Record<string, unknown>> {
  const userId = `${suffix}-user`;
  const assistantId = `${suffix}-assistant`;
  const records: Array<Record<string, unknown>> = [];
  if (includeSessionStart) {
    records.push({
      type: 'session_start',
      id: sessionId,
      owner: 'OWNER_MUST_NOT_BE_EXPORTED',
      version: 2,
      cwd: `/workspace/${suffix}`,
      hostId: `host-${suffix}`,
    });
  }
  records.push(
    {
      type: 'message',
      id: userId,
      timestamp: new Date(startedAtMs).toISOString(),
      message: {
        role: 'user',
        content: [{ type: 'text', text: `prompt-${suffix}` }],
        interactionMode: 'auto',
      },
    },
    {
      type: 'message',
      id: assistantId,
      parentId: userId,
      timestamp: new Date(startedAtMs + 100).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `answer-${suffix}` }],
        modelId: 'claude-sonnet-fixture',
        apiProvider: 'bedrock_anthropic',
      },
    },
    {
      type: 'message',
      id: `${suffix}-stop`,
      parentId: assistantId,
      timestamp: new Date(startedAtMs + 120).toISOString(),
      message: {
        role: 'user',
        content: [],
        visibility: 'user_only',
        hookEventName: 'Stop',
        hookParentId: assistantId,
        hookStatus: 'completed',
      },
    },
  );
  return records;
}

function toJsonl(records: Array<Record<string, unknown>>, trailingNewline = true): string {
  const text = records.map(record => JSON.stringify(record)).join('\n');
  return trailingNewline ? `${text}\n` : text;
}

async function initializeInput(factoryRoot: string, hookEventDir: string, statePath: string) {
  const stateStore = new StateStore(statePath);
  await stateStore.load();
  const input = new TestDroidInput({ stateStore, factoryRoot, hookEventDir });
  return { input, stateStore };
}

describe('Droid transcript input', () => {
  it('opens each Droid log rotation once when one cycle enriches multiple stable sessions', async () => {
    logReadTracker.opens.length = 0;
    const root = await mkdtemp(path.join(tmpdir(), 'droid-input-batched-logs-'));
    const sessionsDir = path.join(root, 'sessions');
    const logsDir = path.join(root, 'logs');
    const hookEventDir = path.join(root, 'pilot-events');
    const statePath = path.join(root, 'state.json');
    await Promise.all([
      mkdir(sessionsDir, { recursive: true }),
      mkdir(logsDir, { recursive: true }),
    ]);

    const { input } = await initializeInput(root, hookEventDir, statePath);
    expect(await input.collectNow()).toEqual([]);

    const sessionIds = [
      '21111111-2222-4333-8444-555555555555',
      '31111111-2222-4333-8444-555555555555',
    ];
    const transcriptText = await readFile(`${FIXTURE_DIR}/session.jsonl`, 'utf8');
    const settingsText = await readFile(`${FIXTURE_DIR}/session.settings.json`, 'utf8');
    const logLines = (await readFile(`${FIXTURE_DIR}/droid.log`, 'utf8')).trim().split('\n');
    for (const sessionId of sessionIds) {
      await writeFile(
        path.join(sessionsDir, `${sessionId}.jsonl`),
        transcriptText.replaceAll(GOLDEN_SESSION_ID, sessionId),
      );
      await writeFile(path.join(sessionsDir, `${sessionId}.settings.json`), settingsText);
    }

    const rotatedLog = path.join(logsDir, 'droid-log-single.log.2026-08-19');
    const activeLog = path.join(logsDir, 'droid-log-single.log');
    const splitAt = Math.ceil(logLines.length / 2);
    await writeFile(rotatedLog, `${sessionIds.flatMap(sessionId =>
      logLines.slice(0, splitAt).map(line => line.replaceAll(GOLDEN_SESSION_ID, sessionId)))
      .join('\n')}\n`);
    const activeTail = `${sessionIds.flatMap(sessionId =>
      logLines.slice(splitAt).map(line => line.replaceAll(GOLDEN_SESSION_ID, sessionId)))
      .join('\n')}\n`;
    const activeContents = `${'X'.repeat(16 * 1024 * 1024 + 256)}\n${activeTail}`;
    await writeFile(activeLog, activeContents);
    await utimes(rotatedLog, new Date('2026-08-19T12:40:00Z'), new Date('2026-08-19T12:40:00Z'));
    await utimes(activeLog, new Date('2026-08-19T12:42:00Z'), new Date('2026-08-19T12:42:00Z'));

    // First sighting establishes both stability signatures; the next collection
    // is the single cycle that enriches both sessions.
    expect(await input.collectNow()).toEqual([]);
    const openedBeforeStableCycle = logReadTracker.opens.length;
    const entries = await input.collectNow();
    const openedInStableCycle = logReadTracker.opens.slice(openedBeforeStableCycle);

    expect(new Set(entries.map(entry => entry['gen_ai.session.id']))).toEqual(new Set(sessionIds));
    for (const sessionId of sessionIds) {
      const responses = entries.filter(entry =>
        entry['gen_ai.session.id'] === sessionId && entry['event.name'] === 'llm.response');
      expect(responses.map(entry => ({
        model: entry['gen_ai.response.model'],
        completeness: entry['agent.droid.usage.completeness'],
        totalTokens: entry['gen_ai.usage.total_tokens'],
      }))).toEqual([
        { model: 'claude-opus-4-7', completeness: 'per_call', totalTokens: 20358 },
        { model: 'claude-opus-4-7', completeness: 'per_call', totalTokens: 20446 },
      ]);
    }
    expect(openedInStableCycle.map(item => item.filePath).sort())
      .toEqual([activeLog, rotatedLog].sort());
    const activeOpen = openedInStableCycle.find(item => item.filePath === activeLog);
    expect(activeOpen?.start).toBeGreaterThan(0);
    expect(Buffer.byteLength(activeContents) - activeOpen!.start!).toBe(16 * 1024 * 1024);
  });

  it('baselines pre-existing history and remains idempotent across restart', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-input-baseline-'));
    const sessionsDir = path.join(root, 'sessions');
    const logsDir = path.join(root, 'logs');
    const hookEventDir = path.join(root, 'pilot-events');
    const statePath = path.join(root, 'state.json');
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    const transcript = path.join(sessionsDir, `${GOLDEN_SESSION_ID}.jsonl`);
    await copyFile(`${FIXTURE_DIR}/session.jsonl`, transcript);
    await copyFile(
      `${FIXTURE_DIR}/session.settings.json`,
      path.join(sessionsDir, `${GOLDEN_SESSION_ID}.settings.json`),
    );
    await copyFile(`${FIXTURE_DIR}/droid.log`, path.join(logsDir, 'droid-log-single.log'));
    await writeHookEvent(hookEventDir, {
      observed_at_ms: Date.parse('2026-08-19T12:41:38.380Z'),
      hook_event_name: 'Stop',
      session_id: GOLDEN_SESSION_ID,
      transcript_path: transcript,
    });

    const { input, stateStore } = await initializeInput(root, hookEventDir, statePath);
    expect(input.id).toBe('droid-transcript');
    expect(input.agentType).toBe('droid');
    expect(await input.collectNow()).toEqual([]);
    expect(await input.collectNow()).toEqual([]);

    const appended = turnRecords(
      GOLDEN_SESSION_ID,
      'after-baseline',
      Date.parse('2026-08-19T12:42:00.000Z'),
      false,
    );
    await appendFile(transcript, toJsonl(appended));
    await writeHookEvent(hookEventDir, {
      observed_at_ms: Date.parse('2026-08-19T12:42:00.120Z'),
      hook_event_name: 'Stop',
      session_id: GOLDEN_SESSION_ID,
      transcript_path: transcript,
    });

    expect(await input.collectNow()).toEqual([]);
    await writeFile(
      path.join(sessionsDir, `${GOLDEN_SESSION_ID}.settings.json`),
      JSON.stringify({
        model: 'claude-opus-4-7',
        apiProviderLock: 'bedrock_anthropic',
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 206,
          cacheCreationTokens: 214,
          cacheReadTokens: 40380,
          thinkingTokens: 0,
        },
      }),
    );
    const emitted = await input.collectNow();
    expect(emitted.map(entry => entry['event.name'])).toEqual([
      'other', 'llm.request', 'llm.response',
    ]);
    expect(emitted.every(entry =>
      String(entry['gen_ai.turn.id']).endsWith('after-baseline-user'))).toBe(true);
    expect(JSON.stringify(emitted)).not.toContain('Run pwd once');
    expect(JSON.stringify(emitted)).not.toContain('OWNER_MUST_NOT_BE_EXPORTED');
    await stateStore.save();

    const restartedStore = new StateStore(statePath);
    await restartedStore.load();
    const restarted = new TestDroidInput({
      stateStore: restartedStore,
      factoryRoot: root,
      hookEventDir,
    });
    expect(await restarted.collectNow()).toEqual([]);
    expect(await restarted.collectNow()).toEqual([]);
  });

  it('does not attribute a full-session settings total to one call after an unmetered baseline', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-input-unmetered-baseline-'));
    const sessionsDir = path.join(root, 'sessions');
    const hookEventDir = path.join(root, 'pilot-events');
    const statePath = path.join(root, 'state.json');
    const sessionId = '12121212-5656-4789-8aaa-121212121212';
    const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      transcript,
      toJsonl(turnRecords(sessionId, 'unmetered-history', 1_800_000_000_000)),
    );

    const { input } = await initializeInput(root, hookEventDir, statePath);
    expect(await input.collectNow()).toEqual([]);

    await appendFile(
      transcript,
      toJsonl(turnRecords(sessionId, 'after-unmetered-baseline', 1_800_000_001_000, false)),
    );
    await writeFile(path.join(sessionsDir, `${sessionId}.settings.json`), JSON.stringify({
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 9,
        cacheReadTokens: 20,
        cacheCreationTokens: 3,
      },
    }));
    await writeHookEvent(hookEventDir, {
      observed_at_ms: 1_800_000_001_120,
      hook_event_name: 'Stop',
      session_id: sessionId,
      transcript_path: transcript,
    });

    expect(await input.collectNow()).toEqual([]);
    const entries = await input.collectNow();
    expect(entries.map(entry => entry['event.name'])).toEqual([
      'other', 'llm.request', 'llm.response',
    ]);
    const response = entries.find(entry => entry['event.name'] === 'llm.response')!;
    expect(response).toMatchObject({
      'agent.droid.usage.completeness': 'session_aggregate',
      'agent.droid.session.usage.input_tokens': 123,
      'agent.droid.session.usage.output_tokens': 9,
      'agent.droid.session.usage.total_tokens': 132,
    });
    expect(response['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(response['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(response['gen_ai.usage.total_tokens']).toBeUndefined();
  });

  it('discovers both root-level and nested workspace-scoped Factory session files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-input-layouts-'));
    const sessionsDir = path.join(root, 'sessions');
    const hookEventDir = path.join(root, 'pilot-events');
    const statePath = path.join(root, 'state.json');
    await mkdir(sessionsDir, { recursive: true });
    const { input } = await initializeInput(root, hookEventDir, statePath);
    expect(await input.collectNow()).toEqual([]);

    const rootSessionId = '22222222-2222-4222-8222-222222222222';
    const workspaceSessionId = '33333333-3333-4333-8333-333333333333';
    const rootTranscript = path.join(sessionsDir, `${rootSessionId}.jsonl`);
    const workspaceDir = path.join(sessionsDir, '-workspace-fixture', 'nested');
    const workspaceTranscript = path.join(workspaceDir, `${workspaceSessionId}.jsonl`);
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(
      rootTranscript,
      toJsonl(turnRecords(rootSessionId, 'root-layout', 1_800_000_000_000)),
    );
    await writeFile(
      workspaceTranscript,
      toJsonl(turnRecords(workspaceSessionId, 'workspace-layout', 1_800_000_001_000)),
    );
    await writeFile(
      rootTranscript.replace(/\.jsonl$/, '.settings.json'),
      JSON.stringify({ tokenUsage: { inputTokens: 10, outputTokens: 2 } }),
    );
    await writeFile(
      workspaceTranscript.replace(/\.jsonl$/, '.settings.json'),
      JSON.stringify({ tokenUsage: { inputTokens: 20, outputTokens: 3 } }),
    );
    await writeHookEvent(hookEventDir, {
      observed_at_ms: 1_800_000_000_120,
      hook_event_name: 'Stop',
      session_id: rootSessionId,
      transcript_path: rootTranscript,
    });
    await writeHookEvent(hookEventDir, {
      observed_at_ms: 1_800_000_001_120,
      hook_event_name: 'Stop',
      session_id: workspaceSessionId,
      transcript_path: workspaceTranscript,
    });

    expect(await input.collectNow()).toEqual([]);
    const entries = await input.collectNow();
    expect(new Set(entries.map(entry => entry['gen_ai.session.id']))).toEqual(new Set([
      rootSessionId,
      workspaceSessionId,
    ]));
    expect(entries.filter(entry => entry['event.name'] === 'llm.response')).toHaveLength(2);
    expect(JSON.stringify(entries)).not.toContain('OWNER_MUST_NOT_BE_EXPORTED');
  });

  it('does not checkpoint past a partial JSONL tail and emits it once after completion', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-input-partial-'));
    const sessionsDir = path.join(root, 'sessions');
    const hookEventDir = path.join(root, 'pilot-events');
    const statePath = path.join(root, 'state.json');
    await mkdir(sessionsDir, { recursive: true });
    const { input } = await initializeInput(root, hookEventDir, statePath);
    expect(await input.collectNow()).toEqual([]);

    const sessionId = '44444444-4444-4444-8444-444444444444';
    const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);
    const records = turnRecords(sessionId, 'partial-tail', 1_800_000_010_000);
    const complete = toJsonl(records, false);
    const splitAt = complete.indexOf('answer-partial-tail') + 7;
    await writeFile(transcript, complete.slice(0, splitAt));
    const eventFile = await writeHookEvent(hookEventDir, {
      observed_at_ms: 1_800_000_010_120,
      hook_event_name: 'Stop',
      session_id: sessionId,
      transcript_path: transcript,
    });

    expect(await input.collectNow()).toEqual([]);
    expect(await input.collectNow()).toEqual([]);
    expect(await readFile(eventFile, 'utf8')).toContain(sessionId);

    await appendFile(transcript, complete.slice(splitAt));
    await writeFile(
      transcript.replace(/\.jsonl$/, '.settings.json'),
      JSON.stringify({ tokenUsage: { inputTokens: 10, outputTokens: 2 } }),
    );
    expect(await input.collectNow()).toEqual([]);
    const entries = await input.collectNow();
    expect(entries.map(entry => entry['event.name'])).toEqual([
      'other', 'llm.request', 'llm.response',
    ]);
    expect(entries.every(entry => entry['gen_ai.session.id'] === sessionId)).toBe(true);
    expect(entries.find(entry => entry['event.name'] === 'llm.response')?.['gen_ai.output.messages'])
      .toEqual([{ role: 'assistant', parts: [{ type: 'text', content: 'answer-partial-tail' }], finish_reason: 'stop' }]);
    expect(await input.collectNow()).toEqual([]);
  });

  it('leaves an unsupported transcript version and its Hook uncommitted across polls', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-input-version-gate-'));
    const sessionsDir = path.join(root, 'sessions');
    const hookEventDir = path.join(root, 'pilot-events');
    const statePath = path.join(root, 'state.json');
    const sessionId = '88888888-8888-4888-8888-888888888888';
    const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);
    await mkdir(sessionsDir, { recursive: true });
    const unsupported = turnRecords(
      sessionId,
      'unsupported-version',
      1_800_000_050_000,
    );
    unsupported[0].version = 3;
    await writeFile(transcript, toJsonl(unsupported));
    const eventFile = await writeHookEvent(hookEventDir, {
      observed_at_ms: 1_800_000_050_120,
      hook_event_name: 'Stop',
      session_id: sessionId,
      transcript_path: transcript,
    });

    const { input, stateStore } = await initializeInput(root, hookEventDir, statePath);
    expect(await input.collectNow()).toEqual([]);
    expect(await input.collectNow()).toEqual([]);
    expect(await readFile(eventFile, 'utf8')).toContain(sessionId);

    const state = stateStore.get('droid-transcript');
    const offsets = state.extra?.droidTranscriptBytes as Record<string, number> | undefined;
    const files = state.extra?.droidTranscriptFiles as Record<string, unknown> | undefined;
    expect(offsets?.[transcript]).toBeUndefined();
    expect(files?.[transcript]).toBeUndefined();

    await stateStore.save();
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as {
      'droid-transcript'?: { extra?: { droidTranscriptBytes?: Record<string, number> } };
    };
    expect(persisted['droid-transcript']?.extra?.droidTranscriptBytes?.[transcript])
      .toBeUndefined();
  });

  it('does not let a delayed external Stop checkpoint the next partial turn', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-input-stop-boundary-'));
    const sessionsDir = path.join(root, 'sessions');
    const hookEventDir = path.join(root, 'pilot-events');
    const statePath = path.join(root, 'state.json');
    await mkdir(sessionsDir, { recursive: true });
    const { input, stateStore } = await initializeInput(root, hookEventDir, statePath);
    expect(await input.collectNow()).toEqual([]);

    const sessionId = '99999999-9999-4999-8999-999999999999';
    const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);
    const firstStarted = 1_800_000_060_000;
    const secondStarted = firstStarted + 1_000;
    const first = turnRecords(sessionId, 'first-external-stop', firstStarted).slice(0, -1);
    const second = turnRecords(sessionId, 'second-after-stop', secondStarted, false);
    await writeFile(transcript, toJsonl([...first, second[0]]));
    await writeHookEvent(hookEventDir, {
      observed_at_ms: firstStarted + 120,
      hook_event_name: 'Stop',
      session_id: sessionId,
      transcript_path: transcript,
    });

    expect(await input.collectNow()).toEqual([]);
    const firstEntries = await input.collectNow();
    expect(firstEntries.map(entry => entry['event.name'])).toEqual([
      'other', 'llm.request', 'llm.response',
    ]);
    expect(firstEntries.every(entry => entry['gen_ai.turn.id'] === 'first-external-stop-user'))
      .toBe(true);
    const canonicalTranscript = await realpath(transcript);
    const checkpoint = (stateStore.get('droid-transcript').extra?.droidTranscriptBytes as Record<string, number>)[canonicalTranscript];
    expect(checkpoint).toBeLessThan((await readFile(transcript)).byteLength);

    await appendFile(transcript, toJsonl(second.slice(1)));
    expect(await input.collectNow()).toEqual([]);
    const secondEntries = await input.collectNow();
    expect(secondEntries.map(entry => entry['event.name'])).toEqual([
      'other', 'llm.request', 'llm.response',
    ]);
    expect(secondEntries.every(entry => entry['gen_ai.turn.id'] === 'second-after-stop-user'))
      .toBe(true);
  });

  it('keeps baseline mode after an incomplete initial scan', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-input-incomplete-scan-'));
    const hookEventDir = path.join(root, 'pilot-events');
    const statePath = path.join(root, 'state.json');
    const { input, stateStore } = await initializeInput(root, hookEventDir, statePath);

    // Missing sessions/ makes discovery incomplete and must not arm history.
    expect(await input.collectNow()).toEqual([]);
    expect(stateStore.get('droid-transcript').extra?.droidInitialized).toBe(false);

    const sessionsDir = path.join(root, 'sessions', 'workspace');
    await mkdir(sessionsDir, { recursive: true });
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);
    await writeFile(
      transcript,
      toJsonl(turnRecords(sessionId, 'late-discovered-history', 1_800_000_070_000)),
    );
    await writeHookEvent(hookEventDir, {
      observed_at_ms: 1_800_000_070_120,
      hook_event_name: 'Stop',
      session_id: sessionId,
      transcript_path: transcript,
    });

    expect(await input.collectNow()).toEqual([]);
    expect(await input.collectNow()).toEqual([]);
    expect(stateStore.get('droid-transcript').extra?.droidInitialized).toBe(true);
    const offsets = stateStore.get('droid-transcript').extra?.droidTranscriptBytes as Record<string, number>;
    const canonicalTranscript = await realpath(transcript);
    expect(offsets[canonicalTranscript]).toBe((await readFile(transcript)).byteLength);
  });

  it('holds a completed turn until delayed settings advance its usage baseline', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-input-delayed-settings-'));
    const sessionsDir = path.join(root, 'sessions');
    const hookEventDir = path.join(root, 'pilot-events');
    const statePath = path.join(root, 'state.json');
    const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);
    const settingsPath = path.join(sessionsDir, `${sessionId}.settings.json`);
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(transcript, toJsonl([{
      type: 'session_start',
      id: sessionId,
      version: 2,
      cwd: '/workspace/delayed-settings',
    }]));
    await writeFile(settingsPath, JSON.stringify({
      model: 'claude-sonnet-fixture',
      apiProviderLock: 'bedrock_anthropic',
      tokenUsage: { inputTokens: 10, outputTokens: 2 },
    }));

    const { input, stateStore } = await initializeInput(root, hookEventDir, statePath);
    expect(await input.collectNow()).toEqual([]);
    const canonicalTranscript = await realpath(transcript);
    const baselineOffset = (stateStore.get('droid-transcript').extra
      ?.droidTranscriptBytes as Record<string, number>)[canonicalTranscript];

    await appendFile(
      transcript,
      toJsonl(turnRecords(sessionId, 'delayed-settings-turn', 1_800_000_080_000, false)),
    );
    const eventFile = await writeHookEvent(hookEventDir, {
      observed_at_ms: 1_800_000_080_120,
      hook_event_name: 'Stop',
      session_id: sessionId,
      transcript_path: transcript,
    });

    expect(await input.collectNow()).toEqual([]);
    expect(await input.collectNow()).toEqual([]);
    const pendingOffset = (stateStore.get('droid-transcript').extra
      ?.droidTranscriptBytes as Record<string, number>)[canonicalTranscript];
    expect(pendingOffset).toBe(baselineOffset);
    expect(await readFile(eventFile, 'utf8')).toContain(sessionId);

    await writeFile(settingsPath, JSON.stringify({
      model: 'claude-sonnet-fixture',
      apiProviderLock: 'bedrock_anthropic',
      tokenUsage: { inputTokens: 15, outputTokens: 5 },
    }));
    const entries = await input.collectNow();
    expect(entries.map(entry => entry['event.name'])).toEqual([
      'other', 'llm.request', 'llm.response',
    ]);
    expect(entries.find(entry => entry['event.name'] === 'llm.response')).toMatchObject({
      'agent.droid.usage.completeness': 'single_call_delta',
      'gen_ai.usage.input_tokens': 5,
      'gen_ai.usage.output_tokens': 3,
      'gen_ai.usage.total_tokens': 8,
    });
    expect(await input.collectNow()).toEqual([]);
    await expect(readFile(eventFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('holds a brand-new single-call session for delayed settings within the bounded grace', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T05:00:00.000Z'));
    try {
      const root = await mkdtemp(path.join(tmpdir(), 'droid-input-new-session-settings-grace-'));
      const sessionsDir = path.join(root, 'sessions');
      const hookEventDir = path.join(root, 'pilot-events');
      const statePath = path.join(root, 'state.json');
      await mkdir(sessionsDir, { recursive: true });
      const { input, stateStore } = await initializeInput(root, hookEventDir, statePath);
      expect(await input.collectNow()).toEqual([]);

      const sessionId = 'bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc';
      const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);
      const settingsPath = path.join(sessionsDir, `${sessionId}.settings.json`);
      await writeFile(
        transcript,
        toJsonl(turnRecords(sessionId, 'new-session-settings-grace', 1_800_000_085_000)),
      );
      const eventFile = await writeHookEvent(hookEventDir, {
        observed_at_ms: 1_800_000_085_120,
        hook_event_name: 'Stop',
        session_id: sessionId,
        transcript_path: transcript,
      });
      await writeFile(settingsPath, JSON.stringify({
        model: 'claude-opus-4-7',
        apiProviderLock: 'bedrock_anthropic',
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }));

      // First sighting proves the boundary; the stable pass starts the settings
      // grace without acknowledging source bytes or consuming the Stop hint.
      expect(await input.collectNow()).toEqual([]);
      expect(await input.collectNow()).toEqual([]);
      const canonicalTranscript = await realpath(transcript);
      let offsets = stateStore.get('droid-transcript').extra
        ?.droidTranscriptBytes as Record<string, number>;
      expect(offsets[canonicalTranscript]).toBe(0);
      await expect(readFile(eventFile, 'utf8')).resolves.toContain(sessionId);

      vi.advanceTimersByTime(5_000);
      await writeFile(settingsPath, JSON.stringify({
        model: 'claude-opus-4-7',
        apiProviderLock: 'bedrock_anthropic',
        tokenUsage: {
          inputTokens: 32_321,
          outputTokens: 7,
          cacheReadTokens: 768,
          cacheCreationTokens: 0,
          thinkingTokens: 0,
        },
      }));

      const entries = await input.collectNow();
      expect(entries.map(entry => entry['event.name'])).toEqual([
        'other', 'llm.request', 'llm.response',
      ]);
      expect(entries.find(entry => entry['event.name'] === 'llm.response')).toMatchObject({
        'agent.droid.usage.completeness': 'session_aggregate',
        'gen_ai.usage.input_tokens': 33_089,
        'gen_ai.usage.output_tokens': 7,
        'gen_ai.usage.total_tokens': 33_096,
      });
      offsets = stateStore.get('droid-transcript').extra
        ?.droidTranscriptBytes as Record<string, number>;
      expect(offsets[canonicalTranscript]).toBe((await readFile(transcript)).byteLength);
      await expect(readFile(eventFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('commits missing usage after the new-session grace and never re-emits for late settings', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T06:00:00.000Z'));
    try {
      const root = await mkdtemp(path.join(tmpdir(), 'droid-input-settings-grace-timeout-'));
      const sessionsDir = path.join(root, 'sessions');
      const hookEventDir = path.join(root, 'pilot-events');
      const statePath = path.join(root, 'state.json');
      await mkdir(sessionsDir, { recursive: true });
      const { input, stateStore } = await initializeInput(root, hookEventDir, statePath);
      expect(await input.collectNow()).toEqual([]);

      const sessionId = 'bdbdbdbd-bdbd-4bdb-8bdb-bdbdbdbdbdbd';
      const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);
      const settingsPath = path.join(sessionsDir, `${sessionId}.settings.json`);
      await writeFile(
        transcript,
        toJsonl(turnRecords(sessionId, 'settings-grace-timeout', 1_800_000_086_000)),
      );
      const eventFile = await writeHookEvent(hookEventDir, {
        observed_at_ms: 1_800_000_086_120,
        hook_event_name: 'Stop',
        session_id: sessionId,
        transcript_path: transcript,
      });

      expect(await input.collectNow()).toEqual([]);
      expect(await input.collectNow()).toEqual([]);
      await stateStore.save();
      const restartedStore = new StateStore(statePath);
      await restartedStore.load();
      const restarted = new TestDroidInput({
        stateStore: restartedStore,
        factoryRoot: root,
        hookEventDir,
      });
      vi.advanceTimersByTime(20_000);

      const timedOutEntries = await restarted.collectNow();
      const response = timedOutEntries.find(entry => entry['event.name'] === 'llm.response')!;
      expect(response['agent.droid.usage.completeness']).toBe('missing');
      expect(response['gen_ai.usage.input_tokens']).toBeUndefined();
      expect(response['gen_ai.usage.output_tokens']).toBeUndefined();
      expect(response['gen_ai.usage.total_tokens']).toBeUndefined();
      const canonicalTranscript = await realpath(transcript);
      const offset = (restartedStore.get('droid-transcript').extra
        ?.droidTranscriptBytes as Record<string, number>)[canonicalTranscript];
      expect(offset).toBe((await readFile(transcript)).byteLength);
      await expect(readFile(eventFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      await writeFile(settingsPath, JSON.stringify({
        tokenUsage: {
          inputTokens: 32_321,
          outputTokens: 7,
          cacheReadTokens: 768,
          cacheCreationTokens: 0,
          thinkingTokens: 0,
        },
      }));
      expect(await restarted.collectNow()).toEqual([]);
      expect(await restarted.collectNow()).toEqual([]);
      expect((restartedStore.get('droid-transcript').extra
        ?.droidSessionUsage as Record<string, unknown>)[canonicalTranscript]).toMatchObject({
        inputTokens: 33_089,
        outputTokens: 7,
        totalTokens: 33_096,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not advance the transcript or delete Stop hints before durable acceptance', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-input-durable-ack-'));
    const sessionsDir = path.join(root, 'sessions');
    const hookEventDir = path.join(root, 'pilot-events');
    const statePath = path.join(root, 'state.json');
    await mkdir(sessionsDir, { recursive: true });
    const { input, stateStore } = await initializeInput(root, hookEventDir, statePath);
    expect(await input.collectNow()).toEqual([]);

    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);
    await writeFile(
      transcript,
      toJsonl(turnRecords(sessionId, 'durable-ack-turn', 1_800_000_090_000)),
    );
    await writeFile(
      transcript.replace(/\.jsonl$/, '.settings.json'),
      JSON.stringify({ tokenUsage: { inputTokens: 10, outputTokens: 2 } }),
    );
    const eventFile = await writeHookEvent(hookEventDir, {
      observed_at_ms: 1_800_000_090_120,
      hook_event_name: 'Stop',
      session_id: sessionId,
      transcript_path: transcript,
    });
    const canonicalTranscript = await realpath(transcript);

    // First sighting records the stability signature but does not emit.
    expect(await input.collectNow()).toEqual([]);
    const staged = await input.collectStaged();
    expect(staged.map(entry => entry['event.name'])).toEqual([
      'other', 'llm.request', 'llm.response',
    ]);
    let offsets = stateStore.get('droid-transcript').extra
      ?.droidTranscriptBytes as Record<string, number>;
    expect(offsets[canonicalTranscript]).toBe(0);
    await expect(readFile(eventFile, 'utf8')).resolves.toContain(sessionId);

    // Simulate queue capacity/disk rejection: neither source cursor nor hook is committed.
    await input.discardStaged();
    offsets = stateStore.get('droid-transcript').extra
      ?.droidTranscriptBytes as Record<string, number>;
    expect(offsets[canonicalTranscript]).toBe(0);
    await expect(readFile(eventFile, 'utf8')).resolves.toContain(sessionId);

    const retried = await input.collectStaged();
    expect(retried.map(entry => entry.trace_id)).toEqual(staged.map(entry => entry.trace_id));

    await expect(input.commitStagedWith(async () => {
      throw new Error('checkpoint disk write failed');
    })).rejects.toThrow('checkpoint disk write failed');
    offsets = stateStore.get('droid-transcript').extra
      ?.droidTranscriptBytes as Record<string, number>;
    expect(offsets[canonicalTranscript]).toBe(0);
    await expect(readFile(eventFile, 'utf8')).resolves.toContain(sessionId);

    const afterCheckpointRetry = await input.collectStaged();
    expect(afterCheckpointRetry.map(entry => entry.trace_id)).toEqual(
      staged.map(entry => entry.trace_id),
    );
    await input.commitStaged();
    offsets = stateStore.get('droid-transcript').extra
      ?.droidTranscriptBytes as Record<string, number>;
    expect(offsets[canonicalTranscript]).toBe((await readFile(transcript)).byteLength);
    await expect(readFile(eventFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
