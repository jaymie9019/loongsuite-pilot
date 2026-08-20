import type { JsonValue } from '../../types/index.js';

export interface DroidContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  [key: string]: unknown;
}

export interface DroidMessage {
  role?: string;
  content?: DroidContentBlock[] | string;
  visibility?: string;
  modelId?: string;
  apiProvider?: string;
  reasoningEffort?: string;
  hookEventName?: string;
  hookStatus?: string;
  hookMatcher?: string;
  hookToolCallId?: string;
  hookParentId?: string;
  hookStartTime?: number;
  hookEndTime?: number;
  [key: string]: unknown;
}

export interface DroidRecord {
  type?: string;
  id?: string;
  parentId?: string;
  timestamp?: string | number;
  title?: string;
  version?: number;
  cwd?: string;
  hostId?: string;
  parent?: string;
  callingSessionId?: string;
  message?: DroidMessage;
  [key: string]: unknown;
}

/** Canonical usage: inputTokens already includes cache read and cache creation. */
export interface DroidUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
}

export interface DroidRawUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  thinkingTokens?: number;
  factoryCredits?: number;
  [key: string]: unknown;
}

export interface DroidSessionSettings {
  model?: string;
  providerLock?: string;
  apiProviderLock?: string;
  reasoningEffort?: string;
  interactionMode?: string;
  tokenUsage?: DroidRawUsage;
  inclusiveTokenUsage?: DroidRawUsage;
  lastCallTokenUsage?: DroidRawUsage;
  [key: string]: unknown;
}

export interface DroidHookEvent {
  eventName: string;
  observedAtMs: number;
  sessionId?: string;
  transcriptPath?: string;
  toolName?: string;
  toolCallId?: string;
  model?: string;
  apiProvider?: string;
  usage?: DroidUsage;
}

export interface DroidLlmObservation {
  sessionId: string;
  startedAtMs: number;
  completedAtMs: number;
  timeToFirstTokenNs?: number;
  modelId?: string;
  apiProvider?: string;
  responseId?: string;
  finishReason?: string;
  logVersion?: string;
  usage: DroidUsage;
}

export interface DroidBuildOptions {
  sessionId: string;
  settings?: DroidSessionSettings;
  hookEvents?: DroidHookEvent[];
  observations?: DroidLlmObservation[];
  initialUsage?: DroidUsage;
}

export interface DroidBuildResult {
  entries: import('../../types/index.js').AgentActivityEntry[];
  finalUsage?: DroidUsage;
}

export type DroidMessagePart = Record<string, JsonValue>;
