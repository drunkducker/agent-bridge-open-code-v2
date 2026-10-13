/** Core domain types for agentbridge */
import type {
  CoreEvent,
  EventSession,
  EventText,
  EventThinking,
  EventTool,
  EventUsage,
  EventError,
  EventRaw,
  EventFallback,
  EventQuota,
} from '../core/events.js';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type PermissionLevel = 'read-only' | 'edit' | 'full' | 'plan';
export type SessionMode = 'new' | 'ephemeral' | 'continue' | 'fork';

export type FallbackErrorCode =
  | 'RATE_LIMITED'
  | 'NOT_LOGGED_IN'
  | 'NOT_INSTALLED'
  | 'TIMEOUT'
  | 'AGENT_FAILED';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout?: number;
}

export interface ImageData {
  mediaType: string;
  data: string; // base64
}

export type ImageInput = ImageData;

export interface SessionConfig {
  mode: SessionMode;
  id?: string;
  [key: string]: any;
}

export interface FallbackTarget {
  agent: string;
  model?: string;
  minRemainingPercent?: number;
}

export interface QuotaPolicy {
  minRemainingPercent: number;
  waitForReset?: boolean;
  maxWaitMs?: number;
}

export interface QuotaRouteCandidate {
  id: string;
  agent: string;
  model?: string;
  minRemainingPercent?: number;
  env?: NodeJS.ProcessEnv;
}

export interface QuotaRouteSelection extends QuotaRouteCandidate {
  index: number;
  env: NodeJS.ProcessEnv;
  health?: import('../quota/proactive.js').ProactiveQuotaHealth;
}

export interface FallbackAttempt {
  agent: string;
  model?: string;
  code: string;
  message: string;
  retryAfterMs?: number;
}

export type HarnessKind = 'auto' | 'claude' | 'pi' | 'none';
export type TransportKind = 'cli' | 'app-server' | 'stdio' | 'auto';

export interface RunOptions {
  prompt: string;
  model?: string;
  effort?: EffortLevel;
  permissions?: PermissionLevel;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  session?: SessionConfig;
  systemPrompt?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string>;
  jsonSchema?: Record<string, any>;
  extraArgs?: string[];
  isolated?: boolean;
  fallback?: Array<string | FallbackTarget>;
  fallbackOn?: FallbackErrorCode[];
  quotaPolicy?: QuotaPolicy;
  dangerouslySkipPermissions?: boolean;
  yolo?: boolean;
  images?: ImageData[];
  harness?: HarnessKind;
  offline?: boolean;
  transport?: TransportKind;
  appServer?: boolean;
  skills?: boolean;
  mcpPassthrough?: string[];
  defaultPermissions?: boolean;
  writableRoots?: string[];
  [key: string]: any;
}

export interface NormalizedRunOptions extends Omit<RunOptions, 'fallback' | 'fallbackOn'> {
  permissions: PermissionLevel;
  fallback?: FallbackTarget[];
  fallbackOn?: FallbackErrorCode[];
}

export interface Usage {
  input: number;
  output: number;
  cachedInput?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoning?: number;
  cost?: number;
}

export interface FallbackInfo {
  used: string;
  attempts: FallbackAttempt[];
  contextLost?: boolean;
}

export interface RunResult {
  text: string;
  usage: Usage;
  sessionId?: string;
  cost?: number | null;
  stopReason?: string;
  fallback?: FallbackInfo;
  [key: string]: any;
}

export type AgentEvent = CoreEvent;

export type {
  EventSession,
  EventText,
  EventThinking,
  EventTool,
  EventUsage,
  EventError,
  EventRaw,
  EventFallback,
  EventQuota,
};

export interface AgentAdapter {
  name?: string;
  run(opts: RunOptions): AsyncGenerator<AgentEvent, RunResult, void>;
  models?(env?: NodeJS.ProcessEnv): Promise<string[]>;
  isInstalled?(): Promise<boolean>;
  [key: string]: any;
}
