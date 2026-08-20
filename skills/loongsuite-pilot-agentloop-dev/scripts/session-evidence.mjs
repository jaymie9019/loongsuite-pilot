#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

function usage() {
  console.error('Usage: session-evidence.mjs <session-id> [--factory-root PATH] [--data-dir PATH]');
}

function parseArgs(argv) {
  const result = {
    sessionId: '',
    factoryRoot: path.join(homedir(), '.factory'),
    dataDir: process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(homedir(), '.loongsuite-pilot'),
  };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (!result.sessionId && !value.startsWith('--')) {
      result.sessionId = value;
    } else if (value === '--factory-root') {
      result.factoryRoot = argv[++index] || '';
    } else if (value === '--data-dir') {
      result.dataDir = argv[++index] || '';
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(result.sessionId)) {
    throw new Error('session ID must contain only letters, digits, dot, underscore, or hyphen');
  }
  if (!result.factoryRoot || !result.dataDir) throw new Error('path argument is empty');
  return result;
}

async function findTranscript(root, sessionId) {
  const sessionsRoot = path.join(root, 'sessions');
  const wanted = `${sessionId}.jsonl`;
  const pending = [{ directory: sessionsRoot, depth: 0 }];
  let visitedDirectories = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.depth > 16 || visitedDirectories++ > 4096) continue;
    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current.directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push({ directory: candidate, depth: current.depth + 1 });
      } else if (entry.isFile() && entry.name === wanted) {
        return realpath(candidate);
      }
    }
  }
  return null;
}

function increment(record, key) {
  record[key] = (record[key] || 0) + 1;
}

function inspectContent(content, counts) {
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (typeof part.type === 'string') increment(counts, part.type);
  }
}

async function inspectTranscript(file) {
  const summary = {
    path: file,
    bytes: (await stat(file)).size,
    records: 0,
    malformedRecords: 0,
    sessionVersion: null,
    roles: {},
    visibility: {},
    contentTypes: {},
    hookEvents: {},
    models: [],
    providers: [],
    firstTimestamp: null,
    lastTimestamp: null,
  };
  const models = new Set();
  const providers = new Set();
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      summary.malformedRecords++;
      continue;
    }
    summary.records++;
    if (record.type === 'session_start') summary.sessionVersion = record.version ?? null;
    const message = record.message;
    if (!message || typeof message !== 'object') continue;
    if (typeof message.role === 'string') increment(summary.roles, message.role);
    increment(summary.visibility, typeof message.visibility === 'string' ? message.visibility : 'default');
    inspectContent(message.content, summary.contentTypes);
    if (typeof message.hookEventName === 'string') increment(summary.hookEvents, message.hookEventName);
    if (typeof message.modelId === 'string') models.add(message.modelId);
    if (typeof message.apiProvider === 'string') providers.add(message.apiProvider);
    if (typeof record.timestamp === 'string') {
      if (!summary.firstTimestamp || record.timestamp < summary.firstTimestamp) summary.firstTimestamp = record.timestamp;
      if (!summary.lastTimestamp || record.timestamp > summary.lastTimestamp) summary.lastTimestamp = record.timestamp;
    }
  }
  summary.models = [...models].sort();
  summary.providers = [...providers].sort();
  return summary;
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function canonicalUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const cacheRead = number(value.cacheReadInputTokens ?? value.cacheReadTokens);
  const cacheCreation = number(value.contextCount ?? value.cacheCreationTokens);
  const input = number(value.inputTokens) + cacheRead + cacheCreation;
  const output = number(value.outputTokens);
  if (input === 0 && output === 0) return null;
  return { inputTokens: input, outputTokens: output, totalTokens: input + output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheCreation };
}

async function inspectSettings(transcriptPath) {
  const file = transcriptPath.replace(/\.jsonl$/, '.settings.json');
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return {
      path: file,
      model: typeof value.model === 'string' ? value.model : null,
      provider: value.apiProviderLock ?? value.providerLock ?? null,
      tokenUsage: canonicalUsage(value.tokenUsage),
      lastCallTokenUsage: canonicalUsage(value.lastCallTokenUsage),
    };
  } catch (error) {
    return { path: file, available: false, reason: error.code ?? error.name };
  }
}

async function inspectCheckpoint(dataDir, transcriptPath) {
  const file = path.join(dataDir, 'logs', 'input-state.json');
  try {
    const state = JSON.parse(await readFile(file, 'utf8'));
    const extra = state['droid-transcript']?.extra ?? {};
    const meta = extra.droidTranscriptFiles?.[transcriptPath] ?? null;
    return {
      file,
      initialized: extra.droidInitialized === true,
      offset: extra.droidTranscriptBytes?.[transcriptPath] ?? null,
      fileSize: meta?.size ?? null,
      handledBoundaryAtMs: meta?.handledBoundaryAtMs ?? null,
      pendingBoundary: Boolean(meta?.pendingBoundarySignature),
      usage: extra.droidSessionUsage?.[transcriptPath] ?? null,
    };
  } catch (error) {
    return { file, available: false, reason: error.code ?? error.name };
  }
}

async function listDroidOutputFiles(outputDir) {
  try {
    return (await readdir(outputDir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && /^droid-.*\.jsonl$/.test(entry.name))
      .map(entry => path.join(outputDir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

async function inspectOutput(dataDir, sessionId) {
  const summary = {
    entries: 0,
    malformedRecords: 0,
    events: {},
    traces: [],
    turns: [],
    models: [],
    providers: [],
    responseUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  };
  const traces = new Set();
  const turns = new Set();
  const models = new Set();
  const providers = new Set();
  for (const file of await listDroidOutputFiles(path.join(dataDir, 'logs', 'output'))) {
    const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes(sessionId)) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        summary.malformedRecords++;
        continue;
      }
      if (entry['gen_ai.session.id'] !== sessionId) continue;
      summary.entries++;
      increment(summary.events, entry['event.name'] ?? 'unknown');
      if (typeof entry.trace_id === 'string') traces.add(entry.trace_id);
      if (typeof entry['gen_ai.turn.id'] === 'string') turns.add(entry['gen_ai.turn.id']);
      if (typeof entry['gen_ai.response.model'] === 'string') models.add(entry['gen_ai.response.model']);
      if (typeof entry['gen_ai.provider.name'] === 'string') providers.add(entry['gen_ai.provider.name']);
      if (entry['event.name'] === 'llm.response') {
        summary.responseUsage.inputTokens += number(entry['gen_ai.usage.input_tokens']);
        summary.responseUsage.outputTokens += number(entry['gen_ai.usage.output_tokens']);
        summary.responseUsage.totalTokens += number(entry['gen_ai.usage.total_tokens']);
      }
    }
  }
  summary.traces = [...traces].sort();
  summary.turns = [...turns].sort();
  summary.models = [...models].sort();
  summary.providers = [...providers].sort();
  return summary;
}

async function inspectHookHints(dataDir, sessionId) {
  const directory = path.join(dataDir, 'state', 'droid', 'hook-events', sessionId);
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return { directory, count: 0 };
    const entries = await readdir(directory, { withFileTypes: true });
    return { directory, count: entries.filter(entry => entry.isFile() && entry.name.endsWith('.json')).length };
  } catch {
    return { directory, count: 0 };
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    throw error;
  }
  const transcriptPath = await findTranscript(options.factoryRoot, options.sessionId);
  if (!transcriptPath) {
    console.log(JSON.stringify({ sessionId: options.sessionId, source: { found: false } }, null, 2));
    process.exitCode = 2;
    return;
  }
  const [transcript, settings, checkpoint, output, hookHints] = await Promise.all([
    inspectTranscript(transcriptPath),
    inspectSettings(transcriptPath),
    inspectCheckpoint(options.dataDir, transcriptPath),
    inspectOutput(options.dataDir, options.sessionId),
    inspectHookHints(options.dataDir, options.sessionId),
  ]);
  console.log(JSON.stringify({
    sessionId: options.sessionId,
    source: transcript,
    settings,
    checkpoint,
    output,
    hookHints,
    note: 'content-free local evidence only; durable queue and AgentLoop visibility require separate checks',
  }, null, 2));
}

main().catch(error => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
