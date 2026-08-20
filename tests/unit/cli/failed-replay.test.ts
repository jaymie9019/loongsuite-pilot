import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { ExportResultCode } from '@opentelemetry/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseFailedReplayArgs,
  runFailedCommand,
} from '../../../src/cli/failed-replay.js';
import { OtlpTraceFlusher } from '../../../src/flushers/otlp-trace-flusher.js';

const tempRoots: string[] = [];
const originalConfigPath = process.env.AGENT_DATA_COLLECTION_CONFIG;

function makeSpan() {
  return {
    name: 'droid turn',
    kind: 0,
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
    parentSpanId: undefined,
    startTime: [1_000, 0] as [number, number],
    endTime: [1_001, 0] as [number, number],
    duration: [1, 0] as [number, number],
    status: { code: 1 },
    attributes: { 'gen_ai.agent.type': 'droid' },
    links: [],
    events: [],
    ended: true,
    resource: { attributes: { 'service.name': 'failed-replay-test' } },
    instrumentationLibrary: { name: 'failed-replay-test' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalConfigPath === undefined) delete process.env.AGENT_DATA_COLLECTION_CONFIG;
  else process.env.AGENT_DATA_COLLECTION_CONFIG = originalConfigPath;
  await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('failed replay CLI', () => {
  it('requires an explicit, mutually-exclusive mode', () => {
    expect(parseFailedReplayArgs([]).error).toContain('--dry-run');
    expect(parseFailedReplayArgs(['--dry-run', '--execute']).error).toContain('mutually exclusive');
    expect(parseFailedReplayArgs(['--execute']).options?.mode).toBe('execute');
    expect(parseFailedReplayArgs(['--dry-run', '--unknown']).error).toContain('Unknown option');
  });

  it('inventories durable and legacy files without opening or printing payloads', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-failed-cli-'));
    tempRoots.push(dataDir);
    const pendingDir = path.join(dataDir, 'spool', 'otlp', 'v1', 'routes', 'route-a', 'pending');
    const deadLetterDir = path.join(dataDir, 'spool', 'otlp', 'v1', 'routes', 'route-a', 'dead-letter');
    const legacyDir = path.join(dataDir, 'logs', 'otlp-failed');
    await Promise.all([
      fs.mkdir(pendingDir, { recursive: true }),
      fs.mkdir(deadLetterDir, { recursive: true }),
      fs.mkdir(legacyDir, { recursive: true }),
    ]);
    const secret = 'do-not-print-this-prompt-or-secret';
    await Promise.all([
      fs.writeFile(path.join(pendingDir, 'pending.json'), secret),
      fs.writeFile(path.join(deadLetterDir, 'dead.json'), secret),
      fs.writeFile(path.join(legacyDir, 'legacy.jsonl'), secret),
    ]);

    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);

    const result = await runFailedCommand([
      'replay',
      '--data-dir', dataDir,
      '--dry-run',
      '--json',
    ]);

    expect(result).toBe(0);
    const report = JSON.parse(output) as {
      durableBefore: { routes: Array<{ pendingItems: number; deadLetterItems: number }> };
      legacyOtlpFailed: { files: number; migrationSupported: boolean };
    };
    expect(report.durableBefore.routes).toEqual([
      expect.objectContaining({ pendingItems: 1, deadLetterItems: 1 }),
    ]);
    expect(report.legacyOtlpFailed).toEqual(expect.objectContaining({
      files: 1,
      migrationSupported: false,
    }));
    expect(output).not.toContain(secret);
  });

  it('returns non-zero when execute makes no progress on pending durable items', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-failed-cli-execute-'));
    tempRoots.push(dataDir);
    const pendingDir = path.join(
      dataDir,
      'spool',
      'otlp',
      'v1',
      'routes',
      'orphaned-route',
      'pending',
    );
    await fs.mkdir(pendingDir, { recursive: true });
    await fs.writeFile(path.join(pendingDir, 'pending.json'), 'not opened by an unrelated route');

    const configPath = path.join(dataDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      dataDir,
      serviceName: 'failed-replay-test',
      otlpTrace: { endpoint: 'http://127.0.0.1:4318' },
    }));
    process.env.AGENT_DATA_COLLECTION_CONFIG = configPath;

    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);

    const result = await runFailedCommand([
      'replay',
      '--data-dir', dataDir,
      '--execute',
      '--json',
    ]);

    expect(result).toBe(1);
    expect(JSON.parse(output)).toEqual(expect.objectContaining({
      success: false,
      failureReasons: expect.arrayContaining(['pending_items_not_reduced']),
    }));
  });

  it('returns non-zero when execute finds any dead-letter item', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-failed-cli-dlq-'));
    tempRoots.push(dataDir);
    const deadLetterDir = path.join(
      dataDir,
      'spool',
      'otlp',
      'v1',
      'routes',
      'orphaned-route',
      'dead-letter',
    );
    await fs.mkdir(deadLetterDir, { recursive: true });
    await fs.writeFile(path.join(deadLetterDir, 'dead.json'), 'inventory only');

    const configPath = path.join(dataDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({
      dataDir,
      serviceName: 'failed-replay-test',
      otlpTrace: { endpoint: 'http://127.0.0.1:4318' },
    }));
    process.env.AGENT_DATA_COLLECTION_CONFIG = configPath;

    let output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);

    const result = await runFailedCommand([
      'replay',
      '--data-dir', dataDir,
      '--execute',
      '--json',
    ]);

    expect(result).toBe(1);
    expect(JSON.parse(output)).toEqual(expect.objectContaining({
      success: false,
      failureReasons: expect.arrayContaining(['dead_letter_items_present']),
    }));
  });

  it('returns non-zero and reports an authentication-paused route', async () => {
    const server = http.createServer((_request, response) => {
      response.statusCode = 401;
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const endpoint = `http://127.0.0.1:${port}`;
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-failed-cli-auth-'));
    tempRoots.push(dataDir);

    try {
      const seed = new OtlpTraceFlusher({
        enabled: true,
        endpoints: [{ name: 'user-otlp', endpoint }],
        protocol: 'http/protobuf',
        serviceName: 'failed-replay-test',
        appendAgentTypeToServiceName: false,
        dataDir,
      }, undefined, () => ({
        export: (_spans, callback) => callback({
          code: ExportResultCode.FAILED,
          error: new Error('seed offline'),
        }),
        shutdown: async () => undefined,
      }));
      await seed.enqueueSpansForAgent('droid', [makeSpan()] as any);
      await seed.flush();
      await seed.shutdown();

      const configPath = path.join(dataDir, 'config.json');
      await fs.writeFile(configPath, JSON.stringify({
        dataDir,
        serviceName: 'failed-replay-test',
        otlpTrace: { endpoint },
      }));
      process.env.AGENT_DATA_COLLECTION_CONFIG = configPath;

      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
        output += String(chunk);
        return true;
      }) as typeof process.stdout.write);

      const result = await runFailedCommand([
        'replay',
        '--data-dir', dataDir,
        '--execute',
        '--json',
      ]);

      expect(result).toBe(1);
      expect(JSON.parse(output)).toEqual(expect.objectContaining({
        success: false,
        failureReasons: expect.arrayContaining(['route_paused_authentication']),
        routeResults: [expect.objectContaining({ pausedHttpStatus: 401 })],
      }));
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
