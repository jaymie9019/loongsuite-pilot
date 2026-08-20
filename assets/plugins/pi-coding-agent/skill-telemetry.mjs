/**
 * Exact-evidence Skill telemetry adapter for Pi/OMP.
 *
 * This module deliberately does not infer Skill use from arbitrary paths,
 * system prompts, or Bash text. It only accepts OMP's structured
 * `skill-prompt`, a canonical root `skill://` Read, or an exact catalog root
 * file match. Telemetry is fail-open and never exports Skill bodies or paths.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const SKILL_ROOT_FILE = 'SKILL.md';

export function createPiSkillTelemetryAdapter({ emitRecord, reportError }) {
  const state = {
    enabled: false,
    captureContent: true,
    catalog: [],
    byName: new Map(),
    byPath: new Map(),
    pendingReads: new Map(),
    emittedActivations: new Set(),
  };

  function clearRuntimeState() {
    state.catalog = [];
    state.byName.clear();
    state.byPath.clear();
    state.pendingReads.clear();
    state.emittedActivations.clear();
  }

  async function configure({ pi, config, agentType, captureContent, resetSession = false }) {
    if (resetSession) {
      clearRuntimeState();
    } else {
      state.catalog = [];
      state.byName.clear();
      state.byPath.clear();
      state.pendingReads.clear();
    }
    const skillConfig = resolveSkillTelemetryConfig(config, agentType);
    state.enabled = skillConfig.enabled;
    state.captureContent = captureContent;
    if (!state.enabled) {
      clearRuntimeState();
      return;
    }
    await refreshCatalog(pi);
  }

  async function refreshCatalog(pi) {
    if (!state.enabled) return;
    try {
      const active = await readActiveSkills(pi);
      const entries = active
        .map(normalizeCatalogEntry)
        .filter(Boolean);
      setCatalog(entries);
    } catch (error) {
      setCatalog([]);
      reportError?.('skill_catalog', error);
    }
  }

  function setCatalog(entries) {
    state.catalog = entries;
    state.byName.clear();
    state.byPath.clear();
    for (const entry of entries) {
      appendIndex(state.byName, entry.name, entry);
      appendIndex(state.byPath, entry.filePath, entry);
    }
  }

  async function onMessageStart(event, ctx, makeFields) {
    if (!state.enabled) return;
    const message = event?.message ?? event;
    const isCustomMessage = message?.role === 'custom' || message?.type === 'custom_message';
    if (!isCustomMessage || message?.customType !== 'skill-prompt') return;
    const details = message.details;
    const name = normalizeSkillName(details?.name);
    const observedPath = canonicalFilePath(details?.path);
    if (!name || !observedPath || path.basename(observedPath).toLowerCase() !== SKILL_ROOT_FILE.toLowerCase()) {
      return;
    }

    const catalogMatch = uniqueMatch(state.byPath.get(observedPath));
    if (catalogMatch && catalogMatch.name !== name) return;
    if (!catalogMatch && state.byName.has(name)) return;

    const startedAt = timestampMillis(message.timestamp ?? event?.timestamp ?? Date.now());
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const attribution = typeof message.attribution === 'string' ? message.attribution : 'agent';
    const activationId = deterministicActivationId({
      sessionId,
      timestamp: startedAt,
      name,
      filePath: observedPath,
      attribution,
    });
    if (state.emittedActivations.has(activationId)) return;
    state.emittedActivations.add(activationId);

    const skill = buildSkillAttributes({
      name,
      description: catalogMatch?.description,
      filePath: catalogMatch?.filePath ?? observedPath,
      activationId,
      trigger: attribution === 'user' ? 'user_command' : 'agent_injected',
      provenance: 'skill_prompt',
      confidence: 'direct',
      captureContent: state.captureContent,
    });
    const endedAt = timestampStrictlyAfter(startedAt, startedAt);
    emitRecord({
      ...makeFields(startedAt),
      'event.name': 'tool.call',
      'gen_ai.tool.name': 'load_skill',
      'gen_ai.tool.type': 'extension',
      'gen_ai.tool.call.id': activationId,
      ...skill,
    });
    emitRecord({
      ...makeFields(endedAt),
      'event.name': 'tool.result',
      'gen_ai.tool.name': 'load_skill',
      'gen_ai.tool.type': 'extension',
      'gen_ai.tool.call.id': activationId,
      'gen_ai.tool.call.duration': endedAt - startedAt,
      'tool.result.status': 'success',
      ...skill,
    });
  }

  function onToolStart(event) {
    if (!state.enabled || normalizeToolName(event?.toolName) !== 'read') return;
    const callId = normalizeCallId(event?.toolCallId);
    const requestedPath = extractReadPath(event?.args);
    if (!callId || !requestedPath) return;

    const skillUri = parseSkillUri(requestedPath);
    if (skillUri) {
      if (!skillUri.isRoot) return;
      state.pendingReads.set(callId, {
        callId,
        requestedPath,
        skillName: skillUri.name,
        provenance: 'explicit_skill_uri',
        confidence: 'direct',
      });
      return;
    }

    if (path.basename(requestedPath).toLowerCase() !== SKILL_ROOT_FILE.toLowerCase()) return;
    state.pendingReads.set(callId, {
      callId,
      requestedPath,
      provenance: 'catalog_exact_path',
      confidence: 'exact_match',
    });
  }

  function onToolEnd(event) {
    const callId = normalizeCallId(event?.toolCallId);
    if (!callId) return undefined;
    const pending = state.pendingReads.get(callId);
    state.pendingReads.delete(callId);
    if (!state.enabled || !pending || normalizeToolName(event?.toolName) !== 'read') return undefined;

    const resolvedPath = canonicalFilePath(event?.result?.details?.resolvedPath);
    const pathMatch = resolvedPath ? uniqueMatch(state.byPath.get(resolvedPath)) : undefined;
    let catalogMatch = pathMatch;
    if (!catalogMatch && pending.skillName) {
      catalogMatch = uniqueMatch(state.byName.get(pending.skillName));
    }
    if (!catalogMatch) return undefined;
    if (pending.skillName && catalogMatch.name !== pending.skillName) return undefined;

    return buildSkillAttributes({
      name: catalogMatch.name,
      description: catalogMatch.description,
      filePath: catalogMatch.filePath,
      activationId: callId,
      trigger: 'model_read',
      provenance: pending.provenance,
      confidence: pending.confidence,
      captureContent: state.captureContent,
    });
  }

  function shutdown() {
    state.enabled = false;
    clearRuntimeState();
  }

  return {
    configure,
    refreshCatalog,
    onMessageStart,
    onToolStart,
    onToolEnd,
    shutdown,
  };
}

function resolveSkillTelemetryConfig(config, agentType) {
  const configured = config?.agents?.[agentType]?.skillTelemetry
    ?? config?.agents?.['pi-coding-agent']?.skillTelemetry;
  return {
    enabled: parseConfigBool(configured?.enabled) === true
      && (configured?.mode ?? 'exact') === 'exact'
      && (configured?.versionStrategy ?? 'content_sha256') === 'content_sha256'
      && parseConfigBool(configured?.weakPathHeuristics) !== true,
  };
}

async function readActiveSkills(pi) {
  if (typeof pi?.pi?.getActiveSkills === 'function') {
    const value = await pi.pi.getActiveSkills();
    const skills = arrayValue(value);
    if (skills.length > 0) return skills;
  }
  if (typeof pi?.getActiveSkills === 'function') {
    const value = await pi.getActiveSkills();
    const skills = arrayValue(value);
    if (skills.length > 0) return skills;
  }
  if (typeof pi?.getCommands === 'function') {
    const commands = arrayValue(await pi.getCommands());
    return commands.filter(command => command?.source === 'skill');
  }
  return [];
}

function parseConfigBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.skills)) return value.skills;
  return [];
}

function normalizeCatalogEntry(value) {
  const name = normalizeSkillName(value?.name);
  const filePath = canonicalFilePath(value?.filePath ?? value?.path ?? value?.skillPath);
  if (!name || !filePath || path.basename(filePath).toLowerCase() !== SKILL_ROOT_FILE.toLowerCase()) {
    return null;
  }
  return Object.freeze({
    name,
    description: typeof value.description === 'string' ? value.description : undefined,
    filePath,
  });
}

function buildSkillAttributes({
  name,
  description,
  filePath,
  activationId,
  trigger,
  provenance,
  confidence,
  captureContent,
}) {
  const revision = readSkillRevision(filePath);
  return {
    'gen_ai.skill.id': name,
    'gen_ai.skill.name': name,
    ...(captureContent && description ? { 'gen_ai.skill.description': description } : {}),
    ...(revision ? {
      'gen_ai.skill.version': `sha256:${revision.slice(0, 12)}`,
      'loongsuite.skill.content_sha256': revision,
      'loongsuite.skill.revision_source': 'observed_file',
    } : {}),
    'loongsuite.skill.activation_id': activationId,
    'loongsuite.skill.trigger': trigger,
    'loongsuite.skill.provenance': provenance,
    'loongsuite.skill.confidence': confidence,
  };
}

function readSkillRevision(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) return undefined;
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return undefined;
  }
}

function deterministicActivationId({ sessionId, timestamp, name, filePath, attribution }) {
  const digest = crypto.createHash('sha256')
    .update([sessionId, timestamp, name, filePath, attribution].join('\0'))
    .digest('hex');
  return `skill_${digest.slice(0, 32)}`;
}

function parseSkillUri(value) {
  if (typeof value !== 'string' || !value.startsWith('skill://')) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'skill:' || url.username || url.password || url.port || url.search || url.hash) {
      return undefined;
    }
    const name = normalizeSkillName(decodeURIComponent(url.hostname));
    if (!name) return undefined;
    const decodedPath = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '');
    return {
      name,
      isRoot: decodedPath === '' || decodedPath.toLowerCase() === SKILL_ROOT_FILE.toLowerCase(),
    };
  } catch {
    return undefined;
  }
}

function extractReadPath(args) {
  if (!args || typeof args !== 'object') return undefined;
  const value = args.path ?? args.filePath ?? args.file_path;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function canonicalFilePath(value) {
  if (typeof value !== 'string' || !value.trim() || value.startsWith('skill://')) return undefined;
  const raw = value.trim();
  const expanded = raw === '~' || raw.startsWith('~/')
    ? path.join(os.homedir(), raw.slice(2))
    : raw;
  const absolute = path.resolve(expanded);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    try {
      return path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
    } catch {
      return path.normalize(absolute);
    }
  }
}

function appendIndex(index, key, value) {
  const values = index.get(key) ?? [];
  values.push(value);
  index.set(key, values);
}

function uniqueMatch(values) {
  return Array.isArray(values) && values.length === 1 ? values[0] : undefined;
}

function normalizeSkillName(value) {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  if (!name || name.length > 256 || /[\0\r\n]/.test(name)) return undefined;
  return name;
}

function normalizeToolName(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeCallId(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function timestampMillis(timestamp = Date.now()) {
  if (Number.isFinite(timestamp)) return Math.trunc(timestamp);
  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return Date.now();
}

function timestampStrictlyAfter(timestamp, startedAt) {
  const millis = timestampMillis(timestamp);
  return Number.isFinite(startedAt) ? Math.max(millis, Math.trunc(startedAt) + 1) : millis;
}
