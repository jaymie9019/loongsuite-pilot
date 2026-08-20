import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createTraceState, SpanKind, TraceFlags } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { Resource } from '@opentelemetry/resources';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DurableOtlpQueue,
  DurableOtlpQueueCapacityError,
  inspectDurableOtlpSpool,
  type DurableOtlpQueueExporter,
} from '../../../src/flushers/durable-otlp-queue.js';
import { OtlpTraceFlusher } from '../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

type ExportAction = ExportResult | ((spans: ReadableSpan[], callback: (result: ExportResult) => void) => void);

class ScriptedExporter implements DurableOtlpQueueExporter {
  readonly calls: ReadableSpan[][] = [];
  readonly shutdown = vi.fn(async () => undefined);

  constructor(private readonly actions: ExportAction[]) {}

  export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    this.calls.push(spans);
    const action = this.actions.shift() ?? this.actions[this.actions.length - 1];
    if (typeof action === 'function') {
      action(spans, callback);
      return;
    }
    queueMicrotask(() => callback(action ?? {
      code: ExportResultCode.FAILED,
      error: new Error('no scripted exporter result'),
    }));
  }
}

function failed(message: string, httpStatus?: number, extra: Record<string, unknown> = {}): ExportResult {
  const error = Object.assign(new Error(message), extra) as Error & { code?: number };
  if (httpStatus !== undefined) error.code = httpStatus;
  return { code: ExportResultCode.FAILED, error };
}

const success: ExportResult = { code: ExportResultCode.SUCCESS };

function makeSpan(payload = 'hello'): ReadableSpan {
  const traceState = createTraceState('vendor=value');
  return {
    name: 'chat gpt-5',
    kind: SpanKind.CLIENT,
    spanContext: () => ({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      traceFlags: TraceFlags.SAMPLED,
      traceState,
      isRemote: false,
    }),
    parentSpanId: 'c'.repeat(16),
    startTime: [1_700_000_000, 123],
    endTime: [1_700_000_001, 456],
    duration: [1, 333],
    status: { code: 1, message: 'ok' },
    attributes: {
      'gen_ai.span.kind': 'LLM',
      'gen_ai.request.model': 'gpt-5',
      'test.payload': payload,
      'test.array': ['a', 'b'],
    },
    links: [{
      context: {
        traceId: 'd'.repeat(32),
        spanId: 'e'.repeat(16),
        traceFlags: TraceFlags.NONE,
        traceState: createTraceState('link=value'),
        isRemote: true,
      },
      attributes: { relationship: 'follows' },
      droppedAttributesCount: 2,
    }],
    events: [{
      name: 'first-token',
      time: [1_700_000_000, 999],
      attributes: { index: 1 },
      droppedAttributesCount: 3,
    }],
    ended: true,
    resource: new Resource({
      'service.name': 'loongsuite-pilot-droid',
      'gen_ai.agent.type': 'droid',
    }),
    instrumentationLibrary: {
      name: '@loongsuite/otel-util-genai',
      version: '0.1.0',
      schemaUrl: 'https://opentelemetry.io/schemas/1.30.0',
    },
    droppedAttributesCount: 4,
    droppedEventsCount: 5,
    droppedLinksCount: 6,
  };
}

function makeQueue(
  dataDir: string,
  exporter: DurableOtlpQueueExporter,
  overrides: Partial<ConstructorParameters<typeof DurableOtlpQueue>[0]> = {},
): DurableOtlpQueue {
  return new DurableOtlpQueue({
    dataDir,
    routeId: 'primary-0123456789abcdef',
    endpointIdentity: JSON.stringify({
      name: 'primary',
      url: 'https://collector.example/v1/traces',
      serviceName: 'loongsuite-pilot',
    }),
    endpointName: 'primary',
    exporter,
    retryBaseDelayMs: 60_000,
    retryMaxDelayMs: 60_000,
    sendTimeoutMs: 5_000,
    random: () => 0,
    ...overrides,
  });
}

function exportLocally(queue: DurableOtlpQueue, spans = [makeSpan()]): Promise<ExportResult> {
  return new Promise(resolve => queue.export(spans, resolve));
}

async function waitUntil(assertion: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition was not met before timeout');
}

async function findFiles(root: string, suffix: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith(suffix)) result.push(child);
    }
  }
  await walk(root);
  return result;
}

function makeTurnEntries(): AgentActivityEntry[] {
  const common = {
    'event.id': 'event-request',
    'user.id': 'test-user',
    'gen_ai.session.id': 'droid-session',
    'gen_ai.turn.id': 'droid-turn',
    'gen_ai.agent.type': 'droid',
    'gen_ai.provider.name': 'factory',
    'gen_ai.request.model': 'gpt-5',
    'gen_ai.response.model': 'gpt-5',
    trace_id: '1'.repeat(32),
  };
  return [{
    ...common,
    time_unix_nano: '1700000000000000000',
    'event.name': 'llm.request',
    'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }],
  }, {
    ...common,
    time_unix_nano: '1700000001000000000',
    'event.id': 'event-response',
    'event.name': 'llm.response',
    'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'world' }] }],
    'gen_ai.response.finish_reasons': ['stop'],
    'gen_ai.usage.input_tokens': 3,
    'gen_ai.usage.output_tokens': 1,
  }] as AgentActivityEntry[];
}

async function runNodeScript(script: string, env: Record<string, string>): Promise<void> {
  const scriptPath = path.join(path.dirname(env.DATA_DIR), `durable-queue-child-${randomUUID()}.mjs`);
  await fs.writeFile(scriptPath, script, { mode: 0o600 });
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], {
        cwd: process.cwd(),
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`node child failed (code=${code}, signal=${signal}): ${stderr}`));
      });
    });
  } finally {
    await fs.unlink(scriptPath).catch(() => undefined);
  }
}

describe('DurableOtlpQueue', () => {
  let dataDir: string;
  const queues: DurableOtlpQueue[] = [];

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-durable-otlp-'));
  });

  afterEach(async () => {
    await Promise.allSettled(queues.map(queue => queue.shutdown()));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  function track(queue: DurableOtlpQueue): DurableOtlpQueue {
    queues.push(queue);
    return queue;
  }

  it('acks only after atomic persistence, keeps payload private, and deletes only after remote success', async () => {
    let remoteCallback: ((result: ExportResult) => void) | undefined;
    let localAcked = false;
    const exporter = new ScriptedExporter([
      (_spans, callback) => {
        expect(localAcked).toBe(true);
        remoteCallback = callback;
      },
    ]);
    const queue = track(makeQueue(dataDir, exporter));

    const result = await new Promise<ExportResult>(resolve => {
      queue.export([makeSpan()], (value) => {
        localAcked = true;
        resolve(value);
      });
    });
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    await waitUntil(() => exporter.calls.length === 1);

    const spoolRoot = path.join(dataDir, 'spool', 'otlp', 'v1');
    const pending = (await findFiles(spoolRoot, '.json'))
      .filter(file => path.basename(path.dirname(file)) === 'pending');
    expect(pending).toHaveLength(1);
    const raw = await fs.readFile(pending[0], 'utf8');
    expect(raw).not.toContain('https://collector.example');
    expect(raw).toContain('first-token');

    if (process.platform !== 'win32') {
      expect((await fs.stat(spoolRoot)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.dirname(pending[0]))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(pending[0])).mode & 0o777).toBe(0o600);
    }

    remoteCallback?.(success);
    await waitUntil(async () => (await queue.inspect()).pendingItems === 0);
    expect((await queue.inspect()).deadLetterItems).toBe(0);

    const inventory = await inspectDurableOtlpSpool(dataDir);
    expect(inventory.routes).toHaveLength(1);
    expect(inventory.routes[0].pendingItems).toBe(0);
  });

  it('keeps rejecting a renamed item until its pending directory is durably synced', async () => {
    let syncFails = true;
    const syncDirectory = vi.fn(async () => {
      if (syncFails) throw new Error('injected pending directory fsync failure');
    });
    const exporter = new ScriptedExporter([failed('offline')]);
    const queue = track(makeQueue(dataDir, exporter, { syncDirectory }));

    const first = await exportLocally(queue);
    expect(first.code).toBe(ExportResultCode.FAILED);
    expect(first.error?.message).toContain('injected pending directory fsync failure');
    const pending = (await findFiles(path.join(dataDir, 'spool', 'otlp', 'v1'), '.json'))
      .filter(file => path.basename(path.dirname(file)) === 'pending');
    expect(pending).toHaveLength(1);

    const retryWhileSyncStillFails = await exportLocally(queue);
    expect(retryWhileSyncStillFails.code).toBe(ExportResultCode.FAILED);
    expect(retryWhileSyncStillFails.error?.message).toContain('injected pending directory fsync failure');

    syncFails = false;
    expect((await exportLocally(queue)).code).toBe(ExportResultCode.SUCCESS);
    expect(syncDirectory).toHaveBeenCalledTimes(3);
  });

  it('does not acknowledge an existing final item for a different route', async () => {
    const queue = track(makeQueue(dataDir, new ScriptedExporter([failed('offline')])));
    expect((await exportLocally(queue)).code).toBe(ExportResultCode.SUCCESS);
    await queue.waitForIdle();

    const pending = (await findFiles(path.join(dataDir, 'spool', 'otlp', 'v1'), '.json'))
      .filter(file => path.basename(path.dirname(file)) === 'pending');
    expect(pending).toHaveLength(1);
    const envelope = JSON.parse(await fs.readFile(pending[0], 'utf8')) as Record<string, unknown>;
    envelope.routeId = 'different-route';
    await fs.writeFile(pending[0], `${JSON.stringify(envelope)}\n`);

    const retry = await exportLocally(queue);
    expect(retry.code).toBe(ExportResultCode.FAILED);
    expect(retry.error?.message).toContain('queue route mismatch');
  });

  it('does not acknowledge an existing final item whose envelope id differs from the current batch', async () => {
    const queue = track(makeQueue(dataDir, new ScriptedExporter([failed('offline')])));
    expect((await exportLocally(queue)).code).toBe(ExportResultCode.SUCCESS);
    await queue.waitForIdle();

    const pending = (await findFiles(path.join(dataDir, 'spool', 'otlp', 'v1'), '.json'))
      .filter(file => path.basename(path.dirname(file)) === 'pending');
    expect(pending).toHaveLength(1);
    const envelope = JSON.parse(await fs.readFile(pending[0], 'utf8')) as {
      id: string;
      spans: Array<{ name: string }>;
    };
    envelope.spans[0].name = 'different-but-internally-valid-payload';
    envelope.id = createHash('sha256').update(JSON.stringify(envelope.spans)).digest('hex');
    await fs.writeFile(pending[0], `${JSON.stringify(envelope)}\n`);

    const retry = await exportLocally(queue);
    expect(retry.code).toBe(ExportResultCode.FAILED);
    expect(retry.error?.message).toContain('existing item id mismatch');
  });

  it('does not acknowledge an existing final item whose payload no longer matches its id', async () => {
    const queue = track(makeQueue(dataDir, new ScriptedExporter([failed('offline')])));
    expect((await exportLocally(queue)).code).toBe(ExportResultCode.SUCCESS);
    await queue.waitForIdle();

    const pending = (await findFiles(path.join(dataDir, 'spool', 'otlp', 'v1'), '.json'))
      .filter(file => path.basename(path.dirname(file)) === 'pending');
    expect(pending).toHaveLength(1);
    const envelope = JSON.parse(await fs.readFile(pending[0], 'utf8')) as {
      spans: Array<{ name: string }>;
    };
    envelope.spans[0].name = 'corrupted-after-rename';
    await fs.writeFile(pending[0], `${JSON.stringify(envelope)}\n`);

    const retry = await exportLocally(queue);
    expect(retry.code).toBe(ExportResultCode.FAILED);
    expect(retry.error?.message).toContain('queue payload hash mismatch');
  });

  it('flush drains a locally accepted live batch before shutdown closes the startup queue', async () => {
    const exporter = new ScriptedExporter([success]);
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'primary', endpoint: 'https://collector.example' }],
      protocol: 'http/protobuf',
      serviceName: 'loongsuite-pilot',
      dataDir,
    }, undefined, () => exporter);

    await flusher.sendBatch(makeTurnEntries());
    await flusher.flush();
    await flusher.shutdown();

    expect(exporter.calls.length).toBeGreaterThan(0);
  });

  it('wires OtlpTraceFlusher acceptance to the durable-local ack when dataDir is explicit', async () => {
    let remoteCallback: ((result: ExportResult) => void) | undefined;
    const exporter = new ScriptedExporter([
      (_spans, callback) => { remoteCallback = callback; },
    ]);
    const factory = vi.fn(() => exporter);
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'primary', endpoint: 'https://collector.example' }],
      protocol: 'http/protobuf',
      serviceName: 'loongsuite-pilot',
      dataDir,
    }, undefined, factory);

    const acceptance = await flusher.enqueueSpansForAgent('droid', [makeSpan()]);
    expect(acceptance.acceptedRouteIds).toHaveLength(1);
    expect(acceptance.acceptedRouteIds[0]).toMatch(/^route-[0-9a-f]{24}$/);
    expect(factory).toHaveBeenCalledTimes(1);
    await waitUntil(() => exporter.calls.length === 1);
    expect((await inspectDurableOtlpSpool(dataDir)).routes[0].pendingItems).toBe(1);

    remoteCallback?.(success);
    await waitUntil(async () => (await inspectDurableOtlpSpool(dataDir)).routes[0].pendingItems === 0);
    await flusher.shutdown();
  });

  it('rejects strict local acceptance when the durable spool cannot initialize', async () => {
    await fs.writeFile(path.join(dataDir, 'spool'), 'not-a-directory');
    const exporter = new ScriptedExporter([success]);
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'primary', endpoint: 'https://collector.example' }],
      protocol: 'http/protobuf',
      serviceName: 'loongsuite-pilot',
      dataDir,
    }, undefined, () => exporter);

    await expect(flusher.enqueueSpansForAgent('droid', [makeSpan()]))
      .rejects.toThrow(/durable|directory|ENOTDIR/i);
    expect(exporter.calls).toHaveLength(0);
    await flusher.shutdown();
  });

  it('converts AgentActivityEntry records and returns route ids only after every local fsync ack', async () => {
    let remoteCallback: ((result: ExportResult) => void) | undefined;
    const exporter = new ScriptedExporter([
      (_spans, callback) => { remoteCallback = callback; },
    ]);
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'primary', endpoint: 'https://collector.example' }],
      protocol: 'http/protobuf',
      serviceName: 'loongsuite-pilot',
      dataDir,
    }, undefined, () => exporter);

    const acceptance = await flusher.sendBatchStrict(makeTurnEntries());
    expect(acceptance.acceptedRouteIds).toHaveLength(1);
    expect(acceptance.acceptedRouteIds[0]).toMatch(/^route-[0-9a-f]{24}$/);
    expect((await inspectDurableOtlpSpool(dataDir)).routes[0].pendingItems).toBe(1);

    await waitUntil(() => remoteCallback !== undefined);
    remoteCallback!(success);
    await flusher.shutdown();
  });

  it('exposes the durable-participant batch seam used by source checkpoint acknowledgement', async () => {
    const exporter = new ScriptedExporter([failed('offline')]);
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'primary', endpoint: 'https://collector.example' }],
      protocol: 'http/protobuf',
      serviceName: 'loongsuite-pilot',
      dataDir,
    }, undefined, () => exporter);

    await expect(flusher.sendBatchWithLocalDurableAck(makeTurnEntries()))
      .resolves.toBeUndefined();
    expect((await inspectDurableOtlpSpool(dataDir)).routes[0].pendingItems).toBe(1);
    await flusher.shutdown();
  });

  it('inspects and explicitly replays configured durable routes without exposing endpoint secrets', async () => {
    const exporter = new ScriptedExporter([failed('offline'), success]);
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{
        name: 'renamed-primary',
        endpoint: 'https://collector.example',
        headers: { Authorization: 'secret-value' },
      }],
      protocol: 'http/protobuf',
      serviceName: 'loongsuite-pilot',
      dataDir,
    }, undefined, () => exporter);

    await flusher.enqueueSpansForAgent('droid', [makeSpan()]);
    await waitUntil(() => exporter.calls.length === 1);
    const before = await flusher.inspectDurableQueues();
    expect(before).toEqual([expect.objectContaining({
      routeId: expect.stringMatching(/^route-[0-9a-f]{24}$/),
      pendingItems: 1,
      deadLetterItems: 0,
    })]);
    expect(JSON.stringify(before)).not.toContain('collector.example');
    expect(JSON.stringify(before)).not.toContain('secret-value');

    const after = await flusher.replayDurableQueues();
    expect(after).toEqual([expect.objectContaining({ pendingItems: 0, deadLetterItems: 0 })]);
    expect(exporter.calls).toHaveLength(2);
    await flusher.shutdown();
  });

  it('replays a complete span request after restart', async () => {
    const firstExporter = new ScriptedExporter([failed('socket closed')]);
    const first = track(makeQueue(dataDir, firstExporter));
    expect((await exportLocally(first)).code).toBe(ExportResultCode.SUCCESS);
    await first.waitForIdle();
    expect((await first.inspect()).pendingItems).toBe(1);
    await first.shutdown();

    const replayExporter = new ScriptedExporter([success]);
    const replay = track(makeQueue(dataDir, replayExporter));
    await waitUntil(() => replayExporter.calls.length === 1);
    await waitUntil(async () => (await replay.inspect()).pendingItems === 0);

    const restored = replayExporter.calls[0][0];
    expect(restored.spanContext()).toMatchObject({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    });
    expect(restored.spanContext().traceState?.serialize()).toBe('vendor=value');
    expect(restored.parentSpanId).toBe('c'.repeat(16));
    expect(restored.events).toEqual([expect.objectContaining({
      name: 'first-token',
      attributes: { index: 1 },
      droppedAttributesCount: 3,
    })]);
    expect(restored.links[0].context.traceState?.serialize()).toBe('link=value');
    expect(restored.links[0]).toMatchObject({
      attributes: { relationship: 'follows' },
      droppedAttributesCount: 2,
    });
    expect(restored.resource.attributes).toMatchObject({
      'service.name': 'loongsuite-pilot-droid',
      'gen_ai.agent.type': 'droid',
    });
    expect(restored.instrumentationLibrary).toEqual({
      name: '@loongsuite/otel-util-genai',
      version: '0.1.0',
      schemaUrl: 'https://opentelemetry.io/schemas/1.30.0',
    });
    expect(restored.droppedAttributesCount).toBe(4);
    expect(restored.droppedEventsCount).toBe(5);
    expect(restored.droppedLinksCount).toBe(6);
  });

  it('allows only one process to drain a pending route', async () => {
    const seed = track(makeQueue(dataDir, new ScriptedExporter([failed('offline')])));
    expect((await exportLocally(seed)).code).toBe(ExportResultCode.SUCCESS);
    await seed.waitForIdle();
    await seed.shutdown();

    const readyFile = path.join(dataDir, 'children.ready');
    const callsFile = path.join(dataDir, 'remote.calls');
    const queueModule = path.join(dataDir, 'durable-otlp-queue.bundle.cjs');
    await build({
      entryPoints: [path.resolve('src/flushers/durable-otlp-queue.ts')],
      outfile: queueModule,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
    const childScript = `
      import * as fs from 'node:fs/promises';
      const queueModule = await import(process.env.QUEUE_MODULE);
      const { DurableOtlpQueue } = queueModule.default ?? queueModule;
      await fs.appendFile(process.env.READY_FILE, process.pid + '\\n');
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const ready = await fs.readFile(process.env.READY_FILE, 'utf8');
        if (ready.trim().split(/\\n/).length >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const exporter = {
        export(_spans, callback) {
          void fs.appendFile(process.env.CALLS_FILE, process.pid + '\\n').then(() => {
            setTimeout(() => callback({ code: 0 }), 200);
          });
        },
        async shutdown() {},
      };
      const queue = new DurableOtlpQueue({
        dataDir: process.env.DATA_DIR,
        routeId: 'primary-0123456789abcdef',
        endpointIdentity: JSON.stringify({
          name: 'primary',
          url: 'https://collector.example/v1/traces',
          serviceName: 'loongsuite-pilot',
        }),
        endpointName: 'primary',
        exporter,
        retryBaseDelayMs: 60000,
        retryMaxDelayMs: 60000,
        sendTimeoutMs: 5000,
      });
      await queue.replayNow();
      await queue.shutdown();
    `;
    const childEnv = {
      DATA_DIR: dataDir,
      READY_FILE: readyFile,
      CALLS_FILE: callsFile,
      QUEUE_MODULE: queueModule,
    };

    await Promise.all([
      runNodeScript(childScript, childEnv),
      runNodeScript(childScript, childEnv),
    ]);

    const calls = (await fs.readFile(callsFile, 'utf8')).trim().split(/\n/);
    expect(calls).toHaveLength(1);
    expect((await inspectDurableOtlpSpool(dataDir)).routes[0].pendingItems).toBe(0);
  }, 15_000);

  it('reclaims a drain lock whose recorded owner PID no longer exists', async () => {
    const seed = track(makeQueue(dataDir, new ScriptedExporter([failed('offline')])));
    expect((await exportLocally(seed)).code).toBe(ExportResultCode.SUCCESS);
    await seed.waitForIdle();
    await seed.shutdown();

    const inventory = await inspectDurableOtlpSpool(dataDir);
    const staleLock = path.join(
      dataDir,
      'spool',
      'otlp',
      'v1',
      '.locks',
      `${inventory.routes[0].routeDirectory}.drain.lock`,
    );
    await fs.mkdir(staleLock, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(staleLock, 'owner.json'), `${JSON.stringify({
      schemaVersion: 1,
      pid: 2_147_483_647,
      createdAt: Date.now() - 60_000,
      token: 'f'.repeat(32),
    })}\n`, { mode: 0o600 });

    const replay = track(makeQueue(dataDir, new ScriptedExporter([success])));
    await waitUntil(async () => (await replay.inspect()).pendingItems === 0);
    await waitUntil(async () => {
      try {
        await fs.lstat(staleLock);
        return false;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT';
      }
    });
  });

  it('serializes cross-process capacity checks so concurrent enqueues cannot exceed the hard cap', async () => {
    const initialized = track(makeQueue(dataDir, new ScriptedExporter([failed('offline')])));
    await initialized.inspect();
    await initialized.shutdown();
    const before = await inspectDurableOtlpSpool(dataDir);
    const maxBytes = before.totalBytes + 1_500_000;

    const queueModule = path.join(dataDir, 'durable-otlp-queue-cap.bundle.cjs');
    await build({
      entryPoints: [path.resolve('src/flushers/durable-otlp-queue.ts')],
      outfile: queueModule,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
    const readyFile = path.join(dataDir, 'capacity.ready');
    const resultsFile = path.join(dataDir, 'capacity.results');
    const childScript = `
      import * as fs from 'node:fs/promises';
      const queueModule = await import(process.env.QUEUE_MODULE);
      const { DurableOtlpQueue } = queueModule.default ?? queueModule;
      const exporter = {
        export() {},
        async shutdown() {},
      };
      const queue = new DurableOtlpQueue({
        dataDir: process.env.DATA_DIR,
        routeId: 'primary-0123456789abcdef',
        endpointIdentity: JSON.stringify({
          name: 'primary',
          url: 'https://collector.example/v1/traces',
          serviceName: 'loongsuite-pilot',
        }),
        endpointName: 'primary',
        exporter,
        maxBytes: Number(process.env.MAX_BYTES),
        sendTimeoutMs: 100,
        retryBaseDelayMs: 60000,
        retryMaxDelayMs: 60000,
      });
      await queue.inspect();
      await fs.appendFile(process.env.READY_FILE, process.pid + '\\n');
      while ((await fs.readFile(process.env.READY_FILE, 'utf8')).trim().split(/\\n/).length < 2) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const payload = process.env.CHILD_ID.repeat(1024 * 1024);
      const span = {
        name: 'capacity-test', kind: 0,
        spanContext: () => ({ traceId: process.env.CHILD_ID.repeat(32), spanId: process.env.CHILD_ID.repeat(16), traceFlags: 1 }),
        startTime: [1700000000, 0], endTime: [1700000001, 0], duration: [1, 0],
        status: { code: 0 }, attributes: { payload }, links: [], events: [], ended: true,
        resource: { attributes: { 'service.name': 'test' } },
        instrumentationLibrary: { name: 'test' },
        droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
      };
      const result = await new Promise(resolve => queue.export([span], resolve));
      await fs.appendFile(process.env.RESULTS_FILE, process.env.CHILD_ID + ':' + result.code + '\\n');
      await queue.shutdown();
    `;
    const common = {
      DATA_DIR: dataDir,
      READY_FILE: readyFile,
      RESULTS_FILE: resultsFile,
      QUEUE_MODULE: queueModule,
      MAX_BYTES: String(maxBytes),
    };
    await Promise.all([
      runNodeScript(childScript, { ...common, CHILD_ID: 'a' }),
      runNodeScript(childScript, { ...common, CHILD_ID: 'b' }),
    ]);

    const results = (await fs.readFile(resultsFile, 'utf8')).trim().split(/\n/);
    expect(results.filter(line => line.endsWith(`:${ExportResultCode.SUCCESS}`))).toHaveLength(1);
    expect(results.filter(line => line.endsWith(`:${ExportResultCode.FAILED}`))).toHaveLength(1);
    expect((await inspectDurableOtlpSpool(dataDir)).totalBytes).toBeLessThanOrEqual(maxBytes);
  }, 20_000);

  it.each([
    ['network failure', failed('ECONNRESET')],
    ['HTTP 429', failed('throttled', 429)],
    ['HTTP 503', failed('unavailable', 503)],
  ])('retries %s without dropping the item', async (_label, firstResult) => {
    const exporter = new ScriptedExporter([firstResult, success]);
    const queue = track(makeQueue(dataDir, exporter, {
      retryBaseDelayMs: 2,
      retryMaxDelayMs: 2,
    }));

    expect((await exportLocally(queue)).code).toBe(ExportResultCode.SUCCESS);
    await waitUntil(() => exporter.calls.length >= 2);
    await waitUntil(async () => (await queue.inspect()).pendingItems === 0);
    expect((await queue.inspect()).deadLetterItems).toBe(0);
  });

  it('honors Retry-After metadata when a custom exporter preserves it', async () => {
    const exporter = new ScriptedExporter([
      failed('throttled', 429, { retryAfterMs: 80 }),
      success,
    ]);
    const queue = track(makeQueue(dataDir, exporter, {
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    }));

    expect((await exportLocally(queue)).code).toBe(ExportResultCode.SUCCESS);
    await waitUntil(() => exporter.calls.length === 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(exporter.calls).toHaveLength(1);
    await waitUntil(() => exporter.calls.length === 2);
    await waitUntil(async () => (await queue.inspect()).pendingItems === 0);
  });

  it.each([401, 403])('pauses the route on HTTP %s and preserves pending data', async (status) => {
    const exporter = new ScriptedExporter([failed('auth rejected', status)]);
    const queue = track(makeQueue(dataDir, exporter));

    expect((await exportLocally(queue)).code).toBe(ExportResultCode.SUCCESS);
    await queue.waitForIdle();
    expect(await queue.inspect()).toMatchObject({
      pendingItems: 1,
      deadLetterItems: 0,
      pausedHttpStatus: status,
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(exporter.calls).toHaveLength(1);
  });

  it('moves HTTP 400 to dead-letter without deleting its payload', async () => {
    const exporter = new ScriptedExporter([failed('bad request', 400)]);
    const queue = track(makeQueue(dataDir, exporter));

    expect((await exportLocally(queue)).code).toBe(ExportResultCode.SUCCESS);
    await queue.waitForIdle();
    expect(await queue.inspect()).toMatchObject({ pendingItems: 0, deadLetterItems: 1 });
    const deadLetterFiles = await findFiles(path.join(dataDir, 'spool', 'otlp', 'v1'), '.http-400.json');
    expect(deadLetterFiles).toHaveLength(1);
    expect(await fs.readFile(deadLetterFiles[0], 'utf8')).toContain('first-token');
  });

  it('enforces one hard cap across routes and never evicts existing data', async () => {
    const first = track(makeQueue(dataDir, new ScriptedExporter([failed('offline')])));
    expect((await exportLocally(first)).code).toBe(ExportResultCode.SUCCESS);
    await first.waitForIdle();
    const before = await inspectDurableOtlpSpool(dataDir);
    expect(before.routes[0].pendingItems).toBe(1);

    const second = track(makeQueue(dataDir, new ScriptedExporter([failed('offline')]), {
      routeId: 'secondary-fedcba9876543210',
      endpointIdentity: JSON.stringify({
        name: 'secondary',
        url: 'https://secondary.example/v1/traces',
        serviceName: 'loongsuite-pilot',
      }),
      endpointName: 'secondary',
      maxBytes: before.totalBytes + 1_024,
    }));
    await second.inspect(); // materialize the second route manifest before capacity accounting

    const result = await exportLocally(second, [makeSpan('x'.repeat(8_000))]);
    expect(result.code).toBe(ExportResultCode.FAILED);
    expect(result.error).toBeInstanceOf(DurableOtlpQueueCapacityError);

    const after = await inspectDurableOtlpSpool(dataDir);
    expect(after.routes.reduce((sum, route) => sum + route.pendingItems, 0)).toBe(1);
    expect((await first.inspect()).pendingItems).toBe(1);
  });

  it('refuses a route manifest identity mismatch instead of replaying to another endpoint', async () => {
    const first = track(makeQueue(dataDir, new ScriptedExporter([success])));
    await first.inspect();
    await first.shutdown();

    const mismatched = track(makeQueue(dataDir, new ScriptedExporter([success]), {
      endpointIdentity: JSON.stringify({
        name: 'primary',
        url: 'https://different.example/v1/traces',
        serviceName: 'loongsuite-pilot',
      }),
    }));
    await expect(mismatched.inspect()).rejects.toThrow(/identity mismatch/);
  });

  it('keeps the durable route stable across auth rotation and replays with the new credential', async () => {
    const firstExporter = new ScriptedExporter([failed('offline')]);
    const first = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{
        name: 'primary',
        endpoint: 'https://collector.example',
        headers: { Authorization: 'old-token', 'x-cms-workspace': 'workspace-a' },
      }],
      protocol: 'http/protobuf',
      serviceName: 'loongsuite-pilot',
      dataDir,
    }, undefined, () => firstExporter);
    await first.enqueueSpansForAgent('droid', [makeSpan()]);
    await waitUntil(() => firstExporter.calls.length === 1);
    await first.shutdown();

    const replayExporter = new ScriptedExporter([success]);
    const replay = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{
        name: 'primary',
        endpoint: 'https://collector.example',
        headers: { Authorization: 'new-token', 'x-cms-workspace': 'workspace-a' },
      }],
      protocol: 'http/protobuf',
      serviceName: 'loongsuite-pilot',
      dataDir,
    }, undefined, () => replayExporter);
    await waitUntil(() => replayExporter.calls.length === 1);
    await waitUntil(async () => (await replay.inspectDurableQueues())[0].pendingItems === 0);
    expect((await inspectDurableOtlpSpool(dataDir)).routes).toHaveLength(1);
    await replay.shutdown();
  });

  it('orphans the old route instead of replaying it after workspace identity changes', async () => {
    const firstExporter = new ScriptedExporter([failed('offline')]);
    const first = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{
        name: 'primary',
        endpoint: 'https://collector.example',
        headers: { Authorization: 'token', 'x-cms-workspace': 'workspace-a' },
      }],
      protocol: 'http/protobuf',
      serviceName: 'loongsuite-pilot',
      dataDir,
    }, undefined, () => firstExporter);
    await first.enqueueSpansForAgent('droid', [makeSpan()]);
    await waitUntil(() => firstExporter.calls.length === 1);
    await first.shutdown();

    const wrongWorkspaceExporter = new ScriptedExporter([success]);
    const changed = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{
        name: 'primary',
        endpoint: 'https://collector.example',
        headers: { Authorization: 'token', 'x-cms-workspace': 'workspace-b' },
      }],
      protocol: 'http/protobuf',
      serviceName: 'loongsuite-pilot',
      dataDir,
    }, undefined, () => wrongWorkspaceExporter);
    await changed.inspectDurableQueues();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(wrongWorkspaceExporter.calls).toHaveLength(0);
    const inventory = await inspectDurableOtlpSpool(dataDir);
    expect(inventory.routes).toHaveLength(2);
    expect(inventory.routes.reduce((sum, route) => sum + route.pendingItems, 0)).toBe(1);
    await changed.shutdown();
  });
});
