#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodePayload } from './shared/decode-payload.mjs';

const EVENT_NAMES = new Map([
  ['session-start', 'SessionStart'],
  ['user-prompt-submit', 'UserPromptSubmit'],
  ['pre-tool-use', 'PreToolUse'],
  ['post-tool-use', 'PostToolUse'],
  ['stop', 'Stop'],
  ['subagent-stop', 'SubagentStop'],
  ['session-end', 'SessionEnd'],
]);

function readStdin() {
  return decodePayload(fs.readFileSync(0));
}

function stringField(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeSessionDirName(sessionId) {
  const readable = path.basename(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)
    || 'session';
  const digest = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
  return `${readable}-${digest}`;
}

try {
  const payload = JSON.parse(readStdin() || '{}');
  const sessionId = stringField(payload.session_id);
  const transcriptPath = stringField(payload.transcript_path);
  if (!sessionId || !transcriptPath) throw new Error('missing Droid session identity');
  const eventName = stringField(payload.hook_event_name)
    ?? EVENT_NAMES.get(process.argv[2])
    ?? process.argv[2]
    ?? 'unknown';
  const observedAtMs = Date.now();
  // Keep the spool structural-only. Prompt, model response, tool arguments,
  // tool result, owner and host identifiers stay in their source files.
  const record = {
    observed_at_ms: observedAtMs,
    hook_event_name: eventName,
    session_id: sessionId,
    transcript_path: transcriptPath,
    tool_name: stringField(payload.tool_name) ?? stringField(payload.hook_matcher),
    tool_call_id: stringField(payload.tool_call_id)
      ?? stringField(payload.call_id)
      ?? stringField(payload.tool_use_id),
    model: stringField(payload.model),
    api_provider: stringField(payload.api_provider),
  };
  const installedDataDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR ?? installedDataDir;
  const dir = path.join(
    dataDir,
    'state',
    'droid',
    'hook-events',
    safeSessionDirName(sessionId),
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const unique = `${observedAtMs}-${process.pid}-${crypto.randomUUID()}`;
  const temporary = path.join(dir, `.${unique}.tmp`);
  const destination = path.join(dir, `${unique}.json`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
} catch {
  // Wakeup hints must never block Droid, even on malformed input or a read-only disk.
}

process.stdout.write('{}\n');
