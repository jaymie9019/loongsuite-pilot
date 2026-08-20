import { execFile, execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HookStrategy } from '../../../src/deployment/hook-strategy.js';
import { HookManager } from '../../../src/hooks/hook-manager.js';
import type { AgentDefinition } from '../../../src/types/index.js';

const processor = path.resolve('assets/hooks/droid-hook-event-writer.mjs');

interface EventRecord {
  filePath: string;
  value: Record<string, unknown>;
}

function runWriterAsync(input: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [processor, 'pre-tool-use'], { env }, error => {
      if (error) reject(error);
      else resolve();
    });
    child.stdin?.end(input);
  });
}

async function readEventRecords(dataDir: string): Promise<EventRecord[]> {
  const root = path.join(dataDir, 'state', 'droid', 'hook-events');
  const sessionDirs = await readdir(root, { withFileTypes: true });
  const records: EventRecord[] = [];
  for (const sessionDir of sessionDirs) {
    if (!sessionDir.isDirectory()) continue;
    const dir = path.join(root, sessionDir.name);
    for (const eventFile of await readdir(dir)) {
      if (!eventFile.endsWith('.json')) continue;
      const filePath = path.join(dir, eventFile);
      records.push({
        filePath,
        value: JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>,
      });
    }
  }
  return records;
}

describe('Droid hook event writer', () => {
  it('persists only structural wakeup fields and always fails open', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'droid-hook-'));
    const input = JSON.stringify({
      session_id: 'safe-session',
      transcript_path: '/tmp/safe/session.jsonl',
      cwd: 'DO_NOT_PERSIST_CWD',
      hook_event_name: 'PreToolUse',
      tool_name: 'Execute',
      call_id: 'safe-call',
      model: 'claude-opus-fixture',
      api_provider: 'bedrock_anthropic',
      prompt: 'DO_NOT_PERSIST_PROMPT',
      tool_input: { command: 'DO_NOT_PERSIST_ARGUMENTS' },
      tool_response: 'DO_NOT_PERSIST_RESULT',
    });
    const output = execFileSync(process.execPath, [processor, 'pre-tool-use'], {
      input,
      encoding: 'utf8',
      env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir },
    });

    expect(output.trim()).toBe('{}');
    const records = await readEventRecords(dataDir);
    expect(records).toHaveLength(1);
    expect(records[0].value).toMatchObject({
      hook_event_name: 'PreToolUse',
      session_id: 'safe-session',
      transcript_path: '/tmp/safe/session.jsonl',
      tool_name: 'Execute',
      tool_call_id: 'safe-call',
      model: 'claude-opus-fixture',
      api_provider: 'bedrock_anthropic',
    });
    expect(Object.keys(records[0].value).sort()).toEqual([
      'api_provider',
      'hook_event_name',
      'model',
      'observed_at_ms',
      'session_id',
      'tool_call_id',
      'tool_name',
      'transcript_path',
    ]);
    expect(JSON.stringify(records[0].value)).not.toContain('DO_NOT_PERSIST');

    expect(() => execFileSync(process.execPath, [processor, 'stop'], {
      input: '{bad-json',
      encoding: 'utf8',
      env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir },
    })).not.toThrow();
    expect(() => execFileSync(process.execPath, [processor, 'stop'], {
      input: JSON.stringify({ prompt: 'missing session identity' }),
      encoding: 'utf8',
      env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir },
    })).not.toThrow();
    expect(await readEventRecords(dataDir)).toHaveLength(1);
  });

  it('atomically creates one immutable private file per concurrent Hook process', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'droid-hook-concurrent-'));
    const env = { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir };
    await Promise.all(Array.from({ length: 24 }, (_, index) =>
      runWriterAsync(
        JSON.stringify({
          session_id: 'parallel-session',
          transcript_path: '/tmp/parallel-session.jsonl',
          hook_event_name: 'PreToolUse',
          tool_name: 'Execute',
          call_id: `call-${index}`,
        }),
        env,
      )));

    const eventRoot = path.join(dataDir, 'state', 'droid', 'hook-events');
    const sessionDirs = await readdir(eventRoot, { withFileTypes: true });
    expect(sessionDirs.filter(entry => entry.isDirectory())).toHaveLength(1);
    const sessionDir = path.join(eventRoot, sessionDirs[0].name);
    const names = await readdir(sessionDir);
    expect(names.filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(names.filter(name => name.endsWith('.json'))).toHaveLength(24);
    expect((await stat(sessionDir)).mode & 0o777).toBe(0o700);

    const records = await readEventRecords(dataDir);
    expect(records).toHaveLength(24);
    expect(new Set(records.map(record => record.value.tool_call_id)).size).toBe(24);
    await Promise.all(records.map(async record => {
      expect((await stat(record.filePath)).mode & 0o777).toBe(0o600);
    }));
  });

  it('installs and uninstalls all declared Droid hooks without touching user hooks', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'droid-hook-install-'));
    const settingsPath = path.join(root, '.factory', 'settings.json');
    const hooksDir = path.join(root, 'pilot', 'hooks');
    const logDir = path.join(root, 'pilot', 'logs');
    const pilotCommand = path.join(hooksDir, 'droid-loongsuite-pilot-hook.sh');
    const userCommand = '/opt/user-owned-hook.sh';
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await mkdir(hooksDir, { recursive: true });
    await writeFile(pilotCommand, '#!/bin/sh\nexit 0\n');
    await chmod(pilotCommand, 0o755);
    await writeFile(settingsPath, JSON.stringify({
      model: 'user-selected-model',
      hooks: {
        Stop: [{
          matcher: '*',
          hooks: [{ command: userCommand, type: 'command' }],
        }],
      },
    }, null, 2));

    const declared = JSON.parse(
      await readFile(path.resolve('agents.d/droid.json'), 'utf8'),
    ) as AgentDefinition;
    const definition: AgentDefinition = {
      ...declared,
      hook: {
        ...declared.hook!,
        settingsPath,
        hookCommand: pilotCommand,
      },
    };
    const strategy = new HookStrategy(new HookManager(hooksDir, logDir));

    await expect(strategy.deploy(definition)).resolves.toMatchObject({ success: true });
    const installed = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      model: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(installed.model).toBe('user-selected-model');
    expect(installed.hooks.Stop.some(group =>
      group.hooks.some(hook => hook.command === userCommand))).toBe(true);
    for (const event of definition.hook!.events) {
      const suffix = event.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
      expect(installed.hooks[event].some(group =>
        group.hooks.some(hook => hook.command === `${pilotCommand} ${suffix}`))).toBe(true);
    }

    await expect(strategy.undeploy(definition)).resolves.toBe(true);
    const uninstalled = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      model: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    expect(uninstalled.model).toBe('user-selected-model');
    expect(uninstalled.hooks.Stop).toEqual([{
      matcher: '*',
      hooks: [{ command: userCommand, type: 'command' }],
    }]);
    expect(JSON.stringify(uninstalled)).not.toContain(pilotCommand);
  });
});
