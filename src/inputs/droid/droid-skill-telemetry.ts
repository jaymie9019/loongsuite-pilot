import { createHash } from 'node:crypto';
import type { AgentActivityEntry, AgentSkillTelemetryConfig } from '../../types/index.js';

const DROID_SKILL_TOOL_NAME = 'skill';
const MAX_SKILL_RESULT_BYTES = 1024 * 1024;

export interface DroidSkillActivation {
  attributes: Partial<AgentActivityEntry>;
}

export function detectDroidSkillActivation(input: {
  toolName: string;
  toolCallId: string;
  argumentsValue: unknown;
  config?: AgentSkillTelemetryConfig;
}): DroidSkillActivation | undefined {
  if (!isExactSkillTelemetryEnabled(input.config)) return undefined;
  if (input.toolName.toLowerCase() !== DROID_SKILL_TOOL_NAME) return undefined;
  if (!isObject(input.argumentsValue)) return undefined;

  const name = normalizeSkillName(input.argumentsValue.skill);
  if (!name) return undefined;

  return {
    attributes: {
      'gen_ai.skill.id': name,
      'gen_ai.skill.name': name,
      'loongsuite.skill.activation_id': input.toolCallId,
      'loongsuite.skill.trigger': 'model_tool',
      'loongsuite.skill.provenance': 'native_skill_tool',
      'loongsuite.skill.confidence': 'direct',
    },
  };
}

export function observeDroidSkillRevision(
  resultValue: unknown,
  failed: boolean,
): Partial<AgentActivityEntry> | undefined {
  if (failed || typeof resultValue !== 'string' || resultValue.length === 0) return undefined;
  const bytes = Buffer.byteLength(resultValue, 'utf8');
  if (bytes > MAX_SKILL_RESULT_BYTES) return undefined;

  const revision = createHash('sha256').update(resultValue, 'utf8').digest('hex');
  return {
    'gen_ai.skill.version': `sha256:${revision.slice(0, 12)}`,
    'loongsuite.skill.content_sha256': revision,
    'loongsuite.skill.revision_source': 'observed_tool_result',
  };
}

function isExactSkillTelemetryEnabled(config: AgentSkillTelemetryConfig | undefined): boolean {
  return config?.enabled === true
    && config.mode === 'exact'
    && config.versionStrategy === 'content_sha256'
    && config.weakPathHeuristics === false;
}

function normalizeSkillName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  if (!name || name.length > 256 || /[\0\r\n]/.test(name)) return undefined;
  return name;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
