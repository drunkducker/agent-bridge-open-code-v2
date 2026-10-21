#!/usr/bin/env node
// Dependency-free stdio MCP server (newline-delimited JSON-RPC 2.0) exposing ask_*/dispatch_* agent tools + run management.
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { run, parseFallbackTarget } from '../index.js';
import { createTracker } from '../telemetry/stats.js';
import { ev } from '../core/events.js';
import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { endpointNames, loadEndpoints } from '../adapters/endpoint.js';
import {
  dispatch,
  waitRun,
  cancelRun,
  loadRun,
  listRuns,
  summarize,
  sweep,
  abortAll,
  setKeep,
  sendMessage,
  checkMessages,
} from './runs.js';
import { resolvePermissionLevel } from '../core/config.js';
import { AgentError } from '../core/errors.js';
import { EventQuota } from '../core/events.js';
import { QuotaWaitState, selectQuotaRoute } from '../quota/routing.js';
import { QuotaPolicy, QuotaRouteCandidate, QuotaRouteSelection } from '../types/index.js';
import { VERSION } from '../core/version.js';
import { supportsProactiveQuota } from '../quota/proactive.js';

const BUILTIN_AGENTS = ['claude', 'codex', 'opencode', 'agy', 'pi', 'cursor', 'grok', 'gemini', 'devin', 'acp'];
const agentList = (env: NodeJS.ProcessEnv = process.env) => [...BUILTIN_AGENTS, ...endpointNames(env)];
const isEndpoint = (a: string) => !BUILTIN_AGENTS.includes(a);

const RANK: Record<string, number> = { 'read-only': 0, plan: 1, edit: 2, full: 3 };
export const DEFAULT_MODEL: Record<string, string> = {
  claude: 'haiku',
  codex: 'gpt-5.6-luna',
  opencode: 'opencode-go/glm-5.3-flash',
  agy: 'gemini-3.8-flash-low',
  cursor: 'auto',
  grok: 'grok-4.7',
  gemini: 'gemini-3.5-flash',
  devin: 'devin-default',
  acp: 'default',
};
const DEFAULT_TIMEOUT_S = 300;
export const MAX_WAIT_SECONDS = 30;
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const META = '[agentbridge] ';
const sha = (t: any) => createHash('sha256').update(String(t ?? '')).digest('hex');
const badOption = (message: string) => new AgentError('BAD_OPTION', message);

export interface Attestation {
  agent: string;
  sessionId: string | null;
  depth: number;
  model: string | null;
  textSha: string;
  promptSha: string | null;
  bind: string | null;
  callId: string;
  hmac: string;
}

export function attestKey(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENTBRIDGE_ATTEST_KEY) return env.AGENTBRIDGE_ATTEST_KEY;
  return ((attestKey as any).fallback ||= randomBytes(32).toString('hex'));
}

const ATT_FIELDS: (keyof Attestation)[] = [
  'agent',
  'sessionId',
  'depth',
  'model',
  'textSha',
  'promptSha',
  'bind',
  'callId',
];
const mac = (key: string, a: any) =>
  createHmac('sha256', key)
    .update(JSON.stringify(ATT_FIELDS.map((k) => a[k] ?? null)))
    .digest('hex');

/** Server-side attestation */
export function attest(st: any, env: NodeJS.ProcessEnv = process.env): Attestation {
  const a = {
    agent: st.agent,
    sessionId: st.sessionId ?? null,
    depth: st.depth,
    model: st.model ?? null,
    textSha: sha(st.text),
    promptSha: st.promptSha ?? null,
    bind: env.AGENTBRIDGE_ATTEST_BIND ?? null,
    callId: randomUUID(),
  };
  return { ...a, hmac: mac(attestKey(env), a) };
}

export function verifyAttestation(a: any, key: string, text?: string): boolean {
  if (!a || typeof a.hmac !== 'string' || !key) return false;
  if (a.hmac !== mac(key, a)) return false;
  return text === undefined || a.textSha === sha(text);
}

export const maxDepth = (env: NodeJS.ProcessEnv = process.env): number => {
  const s = env.AGENTBRIDGE_MAX_DEPTH;
  const n = Number(s);
  return s !== undefined && s !== '' && Number.isFinite(n) && n >= 0 ? n : 2;
};

export const curDepth = (env: NodeJS.ProcessEnv = process.env): number => {
  const n = Number(env.AGENTBRIDGE_DEPTH);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const subdelegationAllowed = (env: NodeJS.ProcessEnv): boolean => env.AGENTBRIDGE_SUBDELEGATION !== 'false';

function askSchema(agent: string) {
  return {
    name: `ask_${agent}`,
    description: isEndpoint(agent)
      ? `Send a prompt to the "${agent}" chat-model endpoint (HTTP, OpenAI/Anthropic-compatible; plain chat, no tools or file access) and return its answer, session id and token usage. Omit model to use the endpoint default. For work likely to take over 30 seconds, use dispatch_${agent} and wait_run.`
    : `Delegate a prompt to the ${agent} coding agent (a separate process) and return its final answer, session id and token usage. For work likely to take over 30 seconds, use dispatch_${agent} and wait_run.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Prompt for the agent' },
        subdelegation: {
          type: 'boolean',
          description: 'Allow this agent to delegate work to its own agents (default true). Set false to require it to do the work itself.',
        },
        quotaPolicy: {
          type: 'object',
          description: 'Select an ordered agent route using measured remaining quota; optional cancelable wait for a reset.',
          properties: {
            minRemainingPercent: { type: 'number', minimum: 0, maximum: 100, description: 'Minimum measured primary-window quota remaining (inclusive).' },
            waitForReset: { type: 'boolean', description: 'Wait cancelably for the earliest route to become eligible (default false).' },
            maxWaitMs: { type: 'number', exclusiveMinimum: 0, description: 'Optional maximum time to wait for quota, independent of agent execution timeout.' },
          },
          additionalProperties: false,
          required: ['minRemainingPercent'],
        },
        dangerouslySkipPermissions: {
          type: 'boolean',
          description: 'Claude only: explicitly bypass permission prompts. Requires effective full permissions and the operator ceiling.',
        },
        yolo: {
          type: 'boolean',
          description: 'Codex only: run with Codex --yolo, bypassing approval prompts and sandbox restrictions. Requires permissions="full" and the configured operator ceiling.',
        },
        model: { type: 'string', description: 'Default: cheapest model for the agent' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        permissions: {
          type: 'string',
          enum: ['read-only', 'plan', 'edit', 'full'],
          description: 'Default: read-only (safe). Pass edit or full if modifying files or running tools. Never exceeds the ceiling.',
        },
        harness: {
          type: 'string',
          enum: ['auto', 'claude', 'pi', 'none'],
          description: 'Execution harness for endpoint models (default: auto for edit/tools, direct API for read-only)',
        },
        cwd: { type: 'string' },
        timeout: {
          type: 'number',
          exclusiveMinimum: 0,
          description: 'Legacy alias for timeoutSeconds. Seconds, but values >= 1000 are read as milliseconds (2400 = 2.4s, not 40 min). Prefer timeoutSeconds.',
        },
        timeoutSeconds: { type: 'number', exclusiveMinimum: 0, description: 'Run lifetime in SECONDS, always (default 300). 2400 = 40 min.' },
        session: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['new', 'ephemeral', 'continue', 'fork'] },
            id: { type: 'string' },
          },
          required: ['mode'],
        },
        systemPrompt: { type: 'string' },
        fallback: {
          type: 'array',
          maxItems: 5,
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  agent: { type: 'string', description: 'Fallback provider name; use the string form for quota syntax such as codex@15:model.' },
                  model: { type: 'string' },
                  minRemainingPercent: { type: 'number', minimum: 0, maximum: 100, description: 'Per-route measured minimum quota remaining; requires quotaPolicy.' },
                },
                required: ['agent'],
                additionalProperties: false,
              },
            ],
          },
          description:
            'Agents to try, in order, if this one fails with fallbackOn (default RATE_LIMITED): "codex", "codex@15:model", "ollama:glm-5.3-flash:cloud", or {agent, model?, minRemainingPercent?}. Per-route quota thresholds require quotaPolicy. Each starts a new session with its own model; not used if this agent already ran tools with edit/full permissions.',
        },
        fallbackOn: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['RATE_LIMITED', 'NOT_LOGGED_IN', 'NOT_INSTALLED', 'TIMEOUT', 'AGENT_FAILED'],
          },
        },
        offline: {
          type: 'boolean',
          description: 'Disable web search, web fetch, and external network tools (strict offline / air-gapped mode)',
        },
        mcpPassthrough: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Names of host MCP servers to pass through to child agent (e.g. ["rea"]). Blocked if offline is true or in read-only/plan mode.',
        },
        skills: {
          type: 'boolean',
          description: 'Enable discovery of shared skills from ~/.agents/skills/ (default false for strict isolation)',
        },
        transport: {
          type: 'string',
          enum: ['cli', 'app-server', 'stdio', 'auto'],
          description:
            'Execution transport mode. "app-server" runs a persistent JSON-RPC 2.0 daemon (fast zero cold-start, live interactive approvals for Codex); "cli" uses standard batch process spawn.',
        },
      },
      required: ['prompt'],
    },
  };
}

export function toolSchema(agent: string, kind = 'ask'): any {
  const s: any = askSchema(agent);
  if (kind === 'dispatch') {
    s.name = `dispatch_${agent}`;
    s.description = `Start ${agent} asynchronously; returns a run id immediately. Use wait_run/check_run/cancel_run. For work likely to take over 30 seconds, dispatch and wait with wait_run.`;
    s.inputSchema.properties.idempotencyKey = {
      type: 'string',
      description: 'Repeating a dispatch with the same key returns the existing run',
    };
  }
  return s;
}

export const RUN_TOOLS = [
  {
    name: 'wait_run',
    description: 'Wait for an async run to finish (or time out) and return its state/result. Default wait is 30 seconds; requests above 30 seconds are capped at 30 seconds per call. Call again to continue waiting.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, timeoutSeconds: { type: 'number', exclusiveMinimum: 0, description: 'Default 30 seconds; each wait is capped at 30 seconds.' } },
      required: ['id'],
    },
  },
  {
    name: 'check_run',
    description: 'Status, elapsed time, last events and tokens of an async run.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'cancel_run',
    description: 'Cancel a running async run (kills the child agent).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'retain_run',
    description: 'Retain a run record (exempt from registry GC) - worker lifecycle.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'release_run',
    description: 'Release a retained run record (eligible for GC).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'send_message',
    description: 'Append a message to the inbox of a run id or agent name (no live injection into a running agent).',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string' }, from: { type: 'string' }, text: { type: 'string' } },
      required: ['to', 'text'],
    },
  },
  {
    name: 'check_messages',
    description: 'Read (and mark read) unread inbox messages for a run id or agent name.',
    inputSchema: {
      type: 'object',
      properties: { for: { type: 'string' }, markRead: { type: 'boolean' } },
      required: ['for'],
    },
  },
  {
    name: 'list_runs',
    description: 'List async runs from the registry (~/.agentbridge/runs).',
    inputSchema: { type: 'object', properties: { state: { type: 'string' }, limit: { type: 'number' } } },
  },
];

export const CHECKPOINT_TOOLS = [
  {
    name: 'checkpoint_create',
    description: 'Create an instant snapshot of the repository in hidden refs (refs/agentbridge/checkpoints/...) without altering branches or staging index.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Brief description of the checkpoint' },
        sessionId: { type: 'string', description: 'Optional session identifier' },
        cwd: { type: 'string', description: 'Repository directory path' },
      },
    },
  },
  {
    name: 'checkpoint_rollback',
    description: 'Rollback working tree files to a previously saved checkpoint snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Checkpoint ID to restore' },
        cwd: { type: 'string', description: 'Repository directory path' },
      },
      required: ['id'],
    },
  },
  {
    name: 'checkpoint_list',
    description: 'List saved checkpoints in the repository.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional session identifier filter' },
        cwd: { type: 'string', description: 'Repository directory path' },
      },
    },
  },
  {
    name: 'checkpoint_diff',
    description: 'Show unified diff between current workspace and a saved checkpoint snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Checkpoint ID to compare against' },
        cwd: { type: 'string', description: 'Repository directory path' },
      },
      required: ['id'],
    },
  },
];

export const QUOTA_TOOLS = [
  {
    name: 'check_quota',
    description: 'Query proactive quota and rate limit status for an agent (codex, claude, etc.). Returns used percentage, remaining percentage, window duration, reset time, and whether it is ok to proceed.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name (e.g. "codex", "claude")' },
        model: { type: 'string', description: 'Optional model name for model-specific provider quota' },
        thresholdPercent: { type: 'number', description: 'Maximum acceptable used percent before throttling (default 95)' },
      },
      required: ['agent'],
    },
  },
];

export const allTools = (env: NodeJS.ProcessEnv = process.env): any[] => {
  const L = agentList(env);
  let ceiling = 'full';
  try {
    ceiling = resolvePermissionLevel(undefined, { env }).ceiling;
  } catch {
    /* ignore */
  }
  const cpTools =
    ceiling === 'read-only' || ceiling === 'plan'
      ? CHECKPOINT_TOOLS.filter((t) => t.name !== 'checkpoint_rollback')
      : CHECKPOINT_TOOLS;
  const spawningTools = subdelegationAllowed(env)
    ? [...L.map((a) => toolSchema(a)), ...L.map((a) => toolSchema(a, 'dispatch'))]
    : [];
  return [
    ...spawningTools,
    ...RUN_TOOLS,
    ...cpTools,
    ...QUOTA_TOOLS,
  ];
};

export function resolvePerms(requested?: string, env: NodeJS.ProcessEnv = process.env, cwd?: string): string {
  try {
    const { permissions } = resolvePermissionLevel(requested as any, { env, cwd });
    return permissions;
  } catch (err: any) {
    throw badOption(err.message);
  }
}

function safeEndpointModel(agent: string, env: NodeJS.ProcessEnv) {
  try {
    return loadEndpoints(env)[agent]?.defaultModel;
  } catch {
    return undefined;
  }
}

export function prepare(agent: string, args: any, env: NodeJS.ProcessEnv = process.env) {
  if (!subdelegationAllowed(env)) throw badOption('subdelegation is disabled by AGENTBRIDGE_SUBDELEGATION=false');
  const depth = curDepth(env),
    max = maxDepth(env);
  if (depth >= max) {
    throw badOption(
      `Recursion guard: AGENTBRIDGE_DEPTH=${depth} has reached max ${max}; refusing to spawn another agent`
    );
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw badOption('arguments must be an object');
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw badOption('prompt must be a non-empty string');
  if (Object.prototype.hasOwnProperty.call(args, 'subdelegation') && typeof args.subdelegation !== 'boolean') {
    throw badOption('subdelegation must be a boolean');
  }
  let quotaPolicy: QuotaPolicy | undefined;
  if (Object.prototype.hasOwnProperty.call(args, 'quotaPolicy')) {
    const raw = args.quotaPolicy;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badOption('quotaPolicy must be an object');
    const unknownPolicyKeys = Object.keys(raw).filter((key) => !['minRemainingPercent', 'waitForReset', 'maxWaitMs'].includes(key));
    if (unknownPolicyKeys.length) throw badOption(`quotaPolicy has unknown field(s): ${unknownPolicyKeys.join(', ')}`);
    if (typeof raw.minRemainingPercent !== 'number' || !Number.isFinite(raw.minRemainingPercent) || raw.minRemainingPercent < 0 || raw.minRemainingPercent > 100) {
      throw badOption('quotaPolicy.minRemainingPercent must be a finite percentage in [0,100]');
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'waitForReset') && typeof raw.waitForReset !== 'boolean') {
      throw badOption('quotaPolicy.waitForReset must be a boolean');
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'maxWaitMs') && (typeof raw.maxWaitMs !== 'number' || !Number.isFinite(raw.maxWaitMs) || raw.maxWaitMs <= 0)) {
      throw badOption('quotaPolicy.maxWaitMs must be a positive finite number');
    }
    quotaPolicy = { minRemainingPercent: raw.minRemainingPercent, ...(raw.waitForReset !== undefined ? { waitForReset: raw.waitForReset } : {}), ...(raw.maxWaitMs !== undefined ? { maxWaitMs: raw.maxWaitMs } : {}) };
  }
  if (Object.prototype.hasOwnProperty.call(args, 'dangerouslySkipPermissions') && typeof args.dangerouslySkipPermissions !== 'boolean') {
    throw badOption('dangerouslySkipPermissions must be a boolean');
  }
  if (Object.prototype.hasOwnProperty.call(args, 'yolo') && typeof args.yolo !== 'boolean') {
    throw badOption('yolo must be a boolean');
  }
  const perms = resolvePerms(args.permissions, env);
  if (args.dangerouslySkipPermissions === true) {
    if (agent !== 'claude') throw badOption('dangerouslySkipPermissions is only supported for Claude');
    if (perms !== 'full') throw badOption('dangerouslySkipPermissions requires effective full permissions');
  }
  if (args.yolo === true) {
    if (agent !== 'codex') throw badOption('yolo is only supported for Codex');
    if (perms !== 'full') throw badOption('yolo requires effective full permissions');
  }
  const mk = (a: string) => `AGENTBRIDGE_MODEL_${a.toUpperCase()}`;
  const model = args.model ?? env[mk(agent)] ?? (isEndpoint(agent) ? safeEndpointModel(agent, env) : DEFAULT_MODEL[agent]);
  const opts: any = { prompt: args.prompt, permissions: perms, model };
  for (const k of ['effort', 'cwd', 'session', 'systemPrompt', 'harness', 'offline']) {
    if (args[k] != null) opts[k] = args[k];
  }
  if (quotaPolicy) opts.quotaPolicy = quotaPolicy;
  if (args.dangerouslySkipPermissions === true) opts.dangerouslySkipPermissions = true;
  if (args.yolo === true) opts.yolo = true;
  const childAllowsSubdelegation = subdelegationAllowed(env) && args.subdelegation !== false;
  if (!childAllowsSubdelegation) {
    const instruction = 'Do this task yourself. Do not delegate, spawn subagents, or call any tool that starts another agent.';
    opts.systemPrompt = [opts.systemPrompt, instruction].filter(Boolean).join('\n\n');
  }
  if (env.AGENTBRIDGE_CHILD_CWD) opts.cwd = env.AGENTBRIDGE_CHILD_CWD;
  let ts = DEFAULT_TIMEOUT_S;
  if (env.AGENTBRIDGE_DEFAULT_TIMEOUT_S !== undefined) {
    const configured = Number(env.AGENTBRIDGE_DEFAULT_TIMEOUT_S);
    if (!Number.isFinite(configured) || configured <= 0) {
      throw badOption('AGENTBRIDGE_DEFAULT_TIMEOUT_S must be a finite positive number of seconds');
    }
    ts = configured;
  }
  const hasTimeoutSeconds = Object.prototype.hasOwnProperty.call(args, 'timeoutSeconds');
  const hasTimeoutAlias = Object.prototype.hasOwnProperty.call(args, 'timeout');
  for (const key of ['timeoutSeconds', 'timeout'] as const) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
    const value = args[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw badOption(`${key} must be a finite positive number`);
    }
  }
  const rawTimeout = hasTimeoutSeconds ? args.timeoutSeconds : hasTimeoutAlias ? args.timeout : undefined;
  // timeoutSeconds is always seconds; only the legacy `timeout` alias guesses ms for values >= 1000.
  if (rawTimeout !== undefined) ts = hasTimeoutSeconds || rawTimeout < 1000 ? rawTimeout : rawTimeout / 1000;
  opts.timeoutMs = Math.round(ts * 1000);
  const childDepth = depth + 1;
  const models = Object.fromEntries(agentList(env).filter((a) => env[mk(a)]).map((a) => [mk(a), env[mk(a)]]));
  opts.env = {
    AGENTBRIDGE_DEPTH: String(childDepth),
    AGENTBRIDGE_MAX_DEPTH: String(max),
    AGENTBRIDGE_PERMS: perms,
    AGENTBRIDGE_SUBDELEGATION: String(childAllowsSubdelegation),
    ...models,
  };
  return { opts, perms, childDepth, max, model };
}

function fallbackOptions(args: any, env: NodeJS.ProcessEnv) {
  if (args.fallback != null && (!Array.isArray(args.fallback) || args.fallback.length > 5)) {
    throw badOption('fallback must be an array of at most 5 agents');
  }
  const chain = (args.fallback ?? []).map(parseFallbackTarget);
  for (const target of chain) {
    if (target.minRemainingPercent !== undefined) {
      if (typeof target.minRemainingPercent !== 'number' || !Number.isFinite(target.minRemainingPercent) || target.minRemainingPercent < 0 || target.minRemainingPercent > 100) {
        throw badOption('fallback minRemainingPercent must be a finite percentage in [0,100]');
      }
      if (!args.quotaPolicy) throw badOption('fallback minRemainingPercent requires quotaPolicy');
      if (!supportsProactiveQuota(target.agent)) throw badOption(`Quota thresholds are unavailable for fallback agent "${target.agent}"`);
    }
  }
  const on = args.fallbackOn ?? ['RATE_LIMITED'];
  if (
    !Array.isArray(on) ||
    on.some((c) => !['RATE_LIMITED', 'NOT_LOGGED_IN', 'NOT_INSTALLED', 'TIMEOUT', 'AGENT_FAILED'].includes(c))
  ) {
    throw badOption('fallbackOn has an unsupported code');
  }
  for (const t of chain) {
    if (!agentList(env).includes(t.agent)) {
      throw badOption(`fallback agent "${t.agent}" is not one of: ${agentList(env).join(', ')}`);
    }
  }
  return { chain, on };
}

async function execute(agent: string, args: any, ctx: any): Promise<any> {
  const { env } = ctx;
  const { chain, on } = fallbackOptions(args, env);
  const { fallback, fallbackOn, ...base } = args;
  void fallback;
  void fallbackOn;
  const perms = resolvePerms(base.permissions, env);
  if (base.quotaPolicy) return executeQuotaRouted(agent, base, chain, on, perms, ctx);
  const attempts: any[] = [];
  let cur = { agent, args: base };
  for (let i = 0; ; i++) {
    let tools = 0;
    try {
      const st = await executeOne(cur.agent, cur.args, {
        ...ctx,
        onEvent: (e: any) => {
          if (e.type === 'tool') tools++;
          ctx.onEvent?.(e);
        },
      });
      return attempts.length
        ? {
            ...st,
            fallback: {
              used: cur.agent,
              attempts,
              contextLost: base.session?.mode === 'continue' || base.session?.mode === 'fork',
            },
          }
        : st;
    } catch (e: any) {
      const next = chain[i];
      if (!(next && on.includes(e?.code) && !ctx.signal?.aborted)) throw e;
      if (tools && perms !== 'read-only' && perms !== 'plan') {
        throw Object.assign(e, {
          fallbackSkipped: `${cur.agent} already ran tools under "${perms}" permissions; not repeating the task on ${next.agent}`,
        });
      }
      attempts.push({
        agent: cur.agent,
        code: e.code,
        message: String(e.message).slice(0, 300),
        ...(e.retryAfterMs != null ? { retryAfterMs: e.retryAfterMs } : {}),
      });
      ctx.onEvent?.(ev.fallback(cur.agent, next.agent, e.code, e.message));
      const { effort, session, model, yolo, ...keep } = base;
      void effort;
      void model;
      cur = {
        agent: next.agent,
        args: {
          ...keep,
          ...(next.model ? { model: next.model } : {}),
          ...(yolo && next.agent === 'codex' ? { yolo: true } : {}),
          ...(session?.mode === 'ephemeral' ? { session } : {}),
        },
      };
    }
  }
}

async function quotaRouteSelection(
  candidates: QuotaRouteCandidate[],
  quotaPolicy: QuotaPolicy,
  ctx: any,
  excluded: Set<string>,
  cooldowns: Map<string, number>,
  waitState: QuotaWaitState,
  offline = false
): Promise<QuotaRouteSelection> {
  const iterator = selectQuotaRoute({
    candidates,
    quotaPolicy,
    env: { ...(ctx.env || {}), ...(offline ? { AGENTBRIDGE_OFFLINE: '1' } : {}) },
    signal: ctx.signal,
    exclude: excluded,
    cooldowns,
    waitState,
  });
  for (;;) {
    const step = await iterator.next();
    if (step.done) return step.value;
    ctx.onEvent?.(step.value as EventQuota);
  }
}

async function executeQuotaRouted(
  agent: string,
  base: any,
  chain: Array<{ agent: string; model?: string; minRemainingPercent?: number }>,
  on: string[],
  perms: string,
  ctx: any
): Promise<any> {
  const defaultRouteModel = (candidateAgent: string): string | undefined => {
    if (candidateAgent !== 'agy' && candidateAgent !== 'gemini') return undefined;
    const configured = ctx.env?.[`AGENTBRIDGE_MODEL_${candidateAgent.toUpperCase()}`];
    return configured || DEFAULT_MODEL[candidateAgent];
  };
  const routes: Array<{ agent: string; model?: string; minRemainingPercent?: number; id: string }> =
    [{ agent, model: base.model }, ...chain].map((route, index) => ({
      ...route,
      model: route.model || defaultRouteModel(route.agent),
      id: `c${index}`,
    }));
  const candidates: QuotaRouteCandidate[] = routes.map(({ id, agent: candidateAgent, model, minRemainingPercent }) => ({
    id,
    agent: candidateAgent,
    ...(model ? { model } : {}),
    ...(minRemainingPercent !== undefined ? { minRemainingPercent } : {}),
  }));
  const excluded = new Set<string>();
  const cooldowns = new Map<string, number>();
  const waitState: QuotaWaitState = { remainingMs: base.quotaPolicy.maxWaitMs };
  const attempts: any[] = [];
  let pendingTransition: { from: string; code: string; message: string } | null = null;
  let firstSelection = true;
  for (;;) {
    const selection = await quotaRouteSelection(candidates, base.quotaPolicy, ctx, excluded, cooldowns, waitState, base.offline === true);
    const route = routes[selection.index];
    if (!route || route.id !== selection.id) throw new AgentError('AGENT_FAILED', 'Quota selector returned an unknown route');
    if (firstSelection && selection.index > 0) {
      for (const skipped of routes.slice(0, selection.index)) {
        attempts.push({ agent: skipped.agent, code: 'QUOTA_ROUTED', message: 'Skipped by quota eligibility policy' });
      }
      pendingTransition = { from: agent, code: 'QUOTA_ROUTED', message: 'Selected a route with sufficient quota' };
    }
    firstSelection = false;
    if (pendingTransition) {
      ctx.onEvent?.(ev.fallback(pendingTransition.from, route.agent, pendingTransition.code, pendingTransition.message));
      pendingTransition = null;
    }
    const { effort, session, model, ...keep } = base;
    void effort;
    void model;
    const routeArgs = route.id === 'c0'
      ? { ...base, ...(route.model ? { model: route.model } : {}) }
      : { ...keep, ...(route.model ? { model: route.model } : {}), ...(session?.mode === 'ephemeral' ? { session } : {}) };
    delete routeArgs.fallback;
    delete routeArgs.fallbackOn;
    // The bridge has already selected and gated this candidate. Keep the policy at this routing layer.
    delete routeArgs.quotaPolicy;
    if (route.agent !== 'claude') delete routeArgs.dangerouslySkipPermissions;
    if (route.agent !== 'codex') delete routeArgs.yolo;
    let tools = 0;
    try {
      const st = await executeOne(route.agent, routeArgs, {
        ...ctx,
        env: selection.env,
        onEvent: (event: any) => {
          if (event.type === 'tool') tools++;
          ctx.onEvent?.(event);
        },
      });
      const result = { ...st, agent: route.agent };
      return attempts.length || selection.index > 0
        ? { ...result, fallback: { used: route.agent, attempts, contextLost: selection.index > 0 && (base.session?.mode === 'continue' || base.session?.mode === 'fork') } }
        : result;
    } catch (error: any) {
      if (!on.includes(error?.code) || ctx.signal?.aborted) throw error;
      const hasOtherCandidate = routes.some((candidate) => candidate.id !== route.id && !excluded.has(candidate.id));
      if (tools && perms !== 'read-only' && perms !== 'plan' && (hasOtherCandidate || base.quotaPolicy.waitForReset)) {
        throw Object.assign(error, {
          fallbackSkipped: `${route.agent} already ran tools under "${perms}" permissions; not repeating the task on another route`,
        });
      }
      if (error?.code === 'RATE_LIMITED') {
        if (!hasOtherCandidate && !base.quotaPolicy.waitForReset) throw error;
        const cooldownMs = Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0 ? error.retryAfterMs : 30_000;
        cooldowns.set(route.id, Date.now() + cooldownMs);
      } else {
        if (!hasOtherCandidate) throw error;
        excluded.add(route.id);
      }
      attempts.push({
        agent: route.agent,
        code: error.code,
        message: String(error.message).slice(0, 300),
        ...(error.retryAfterMs != null ? { retryAfterMs: error.retryAfterMs } : {}),
      });
      pendingTransition = { from: route.agent, code: error.code, message: String(error.message).slice(0, 300) };
    }
  }
}

async function executeOne(agent: string, args: any, { env, onEvent, signal }: any): Promise<any> {
  const { opts, perms, childDepth, max } = prepare(agent, args, env);
  opts.signal = signal;
  const passthroughAsked = Array.isArray(args?.mcpPassthrough) && args.mcpPassthrough.length > 0;
  if (isEndpoint(agent)) {
    const it = run(agent, opts);
    let r: any, sid: string | undefined;
    for (;;) {
      const x = await it.next();
      if (x.done) {
        r = x.value;
        break;
      }
      if (x.value.type === 'session') sid = x.value.id;
      onEvent?.(x.value);
    }
    return {
      agent,
      text: r.text,
      sessionId: r.sessionId ?? sid ?? null,
      promptSha: sha(args.prompt),
      usage: r.usage,
      model: r.model,
      durationMs: r.durationMs,
      permissions: perms,
      depth: childDepth,
      toolCalls: [],
      ...(passthroughAsked ? { warnings: ['mcpPassthrough: not supported for endpoint/chat agents; ignored'] } : {}),
    };
  }
  const { mcpConfigFor, resolvePassthrough } = await import('./attach.js');
  const models = Object.fromEntries(
    agentList(env).filter((a) => env[`AGENTBRIDGE_MODEL_${a.toUpperCase()}`]).map((a) => [a, env[`AGENTBRIDGE_MODEL_${a.toUpperCase()}`]])
  );
  opts.env.AGENTBRIDGE_ATTEST_KEY = attestKey(env);
  const grandchildEnv: Record<string, string> = {
    AGENTBRIDGE_DEPTH: String(childDepth),
    AGENTBRIDGE_MAX_DEPTH: String(max),
    AGENTBRIDGE_PERMS: perms,
    AGENTBRIDGE_SUBDELEGATION: opts.env.AGENTBRIDGE_SUBDELEGATION,
    AGENTBRIDGE_ATTEST_KEY: attestKey(env),
    ...Object.fromEntries(Object.entries(models).map(([name, value]) => [`AGENTBRIDGE_MODEL_${name.toUpperCase()}`, value])),
  };
  if (env.AGENTBRIDGE_HOME) grandchildEnv.AGENTBRIDGE_HOME = env.AGENTBRIDGE_HOME;
  if (env.AGENTBRIDGE_ATTEST_BIND) grandchildEnv.AGENTBRIDGE_ATTEST_BIND = env.AGENTBRIDGE_ATTEST_BIND;
  if (env.AGENTBRIDGE_ROOT) grandchildEnv.AGENTBRIDGE_ROOT = env.AGENTBRIDGE_ROOT;
  if (env.AGENTBRIDGE_DEFAULT_TIMEOUT_S) grandchildEnv.AGENTBRIDGE_DEFAULT_TIMEOUT_S = env.AGENTBRIDGE_DEFAULT_TIMEOUT_S;
  if (args.skills != null) {
    if (typeof args.skills !== 'boolean') throw badOption('skills must be a boolean');
    opts.skills = args.skills;
  }
  if (args.transport != null) {
    opts.transport = args.transport;
  }
  if (args.mcpPassthrough != null && !(Array.isArray(args.mcpPassthrough) && args.mcpPassthrough.every((x: any) => typeof x === 'string'))) {
    throw badOption('mcpPassthrough must be an array of server names');
  }
  const { servers: passthroughServers, drops } = resolvePassthrough({
    passthrough: args.mcpPassthrough,
    cwd: opts.cwd || process.cwd(),
    offline: !!opts.offline,
    permissions: perms,
    env: { ...env, ...grandchildEnv },
  });
  const warnings = passthroughAsked ? drops.map((d) => `mcpPassthrough: "${d.name}" dropped (${d.reason})`) : [];
  let httpBridge: any = null;
  if (agent === 'codex') {
    const serverName = 'agentbridge_http';
    httpBridge = await serveHttp({ env: grandchildEnv });
    opts.extraArgs = [
      ...(opts.extraArgs || []),
      '-c',
      `mcp_servers.${serverName}.url="${httpBridge.url}"`,
      '-c',
      `mcp_servers.${serverName}.bearer_token_env_var="AGENTBRIDGE_ATTEST_KEY"`,
      '-c',
      `mcp_servers.${serverName}.default_tools_approval_mode="approve"`,
      '-c',
      `mcp_servers.${serverName}.tool_timeout_sec=300`,
    ];
    for (const [name, srv] of Object.entries<any>(passthroughServers)) {
      const k = `mcp_servers.${name}`;
      opts.extraArgs.push('-c', `${k}.command=${JSON.stringify(srv.command)}`, '-c', `${k}.default_tools_approval_mode="approve"`);
      if (srv.args?.length) opts.extraArgs.push('-c', `${k}.args=[${srv.args.map((x: any) => JSON.stringify(x)).join(',')}]`);
      const envs = Object.entries(srv.env || {});
      if (envs.length) {
        opts.extraArgs.push('-c', `${k}.env={${envs.map(([x, y]) => `${JSON.stringify(x)}=${JSON.stringify(String(y))}`).join(',')}}`);
      }
    }
  } else {
    const childBridge = mcpConfigFor(agent, {
      depth: childDepth,
      maxDepth: max,
      permissions: perms,
      models,
      home: env.AGENTBRIDGE_HOME,
      attestBind: env.AGENTBRIDGE_ATTEST_BIND,
      root: env.AGENTBRIDGE_ROOT,
      defaultTimeoutS: env.AGENTBRIDGE_DEFAULT_TIMEOUT_S,
      subdelegation: opts.env.AGENTBRIDGE_SUBDELEGATION === 'true',
    });
    const combinedServers = { ...childBridge, ...passthroughServers };
    if (Object.keys(combinedServers).length) {
      opts.mcpServers = combinedServers;
    }
  }
  try {
    const it = run(agent, opts);
    let r: any, sid: string | undefined;
    const tools: string[] = [];
    for (;;) {
      const x = await it.next();
      if (x.done) {
        r = x.value;
        break;
      }
      if (x.value.type === 'session') sid = x.value.id;
      if (x.value.type === 'tool' && x.value.output === undefined) tools.push(x.value.name);
      onEvent?.(x.value);
    }
    return {
      agent,
      text: r.text,
      sessionId: r.sessionId ?? sid ?? null,
      promptSha: sha(args.prompt),
      usage: r.usage,
      model: r.model,
      durationMs: r.durationMs,
      permissions: perms,
      depth: childDepth,
      toolCalls: tools,
      ...(passthroughAsked && warnings.length ? { warnings } : {}),
    };
  } finally {
    if (httpBridge) await httpBridge.close();
  }
}

const asResult = (st: any, env: NodeJS.ProcessEnv) => {
  const attestation = attest(st, env);
  return {
    content: [
      { type: 'text', text: st.text || '' },
      { type: 'text', text: META + JSON.stringify(attestation) },
      ...(st.warnings?.length ? st.warnings.map((w: string) => ({ type: 'text', text: `${META}WARNING: ${w}` })) : []),
    ],
    structuredContent: { ...st, attestation },
  };
};
const errResult = (m: string, error?: any) => ({
  isError: true,
  content: [{ type: 'text', text: m }],
  ...(error ? { structuredContent: { error } } : {}),
});

const bounded = (value: unknown, max = 500): string | undefined =>
  value == null ? undefined : String(value).slice(0, max);

function structuredError(error: any, signal?: AbortSignal) {
  const cancelled = signal?.aborted === true;
  const reason = signal?.reason;
  const code = cancelled ? (error?.code === 'REQUEST_CANCELLED' ? 'REQUEST_CANCELLED' : 'ABORTED') : error?.code || 'AGENT_FAILED';
  const message = cancelled
    ? bounded(typeof reason === 'string' ? reason : reason?.message, 500) || 'MCP request cancelled'
    : bounded(error?.message, 500) || 'MCP tool call failed';
  const detail: Record<string, any> = {};
  if (cancelled) {
    detail.cause = 'REQUEST_CANCELLED';
    detail.reason = bounded(typeof reason === 'string' ? reason : reason?.message, 300) || 'MCP request cancelled';
  } else if (error?.cause != null) detail.cause = bounded(error.cause, 200);
  if (!cancelled && code === 'AGENT_FAILED' && Number.isFinite(error?.exitCode) && error.exitCode !== 0) detail.cause = 'CHILD_DIED';
  if (error?.agent != null) detail.agent = bounded(error.agent, 100);
  if (error?.reason != null) detail.reason = bounded(error.reason, 200);
  if (Number.isFinite(error?.exitCode)) detail.exitCode = error.exitCode;
  if (error?.stderr != null) detail.stderr = bounded(error.stderr, 500);
  if (error?.status != null) detail.status = bounded(error.status, 100);
  if (error?.retryAfterMs != null && Number.isFinite(error.retryAfterMs)) detail.retryAfterMs = Math.min(7 * 86400000, Math.max(0, error.retryAfterMs));
  if (error?.fallbackSkipped != null) detail.fallbackSkipped = bounded(error.fallbackSkipped, 300);
  const fallbackAttempts = Array.isArray(error?.fallback) ? error.fallback : error?.fallback?.attempts;
  if (Array.isArray(fallbackAttempts)) {
    detail.fallback = {
      attempts: fallbackAttempts.slice(0, 5).map((attempt: any) => ({
      ...(attempt?.agent != null ? { agent: bounded(attempt.agent, 100) } : {}),
      ...(attempt?.code != null ? { code: bounded(attempt.code, 100) } : {}),
      ...(attempt?.message != null ? { message: bounded(attempt.message, 300) } : {}),
      ...(attempt?.retryAfterMs != null && Number.isFinite(attempt.retryAfterMs) ? { retryAfterMs: Math.min(7 * 86400000, Math.max(0, attempt.retryAfterMs)) } : {}),
      })),
      ...(error.fallback.used != null ? { used: bounded(error.fallback.used, 100) } : {}),
      ...(error.fallback.contextLost != null ? { contextLost: !!error.fallback.contextLost } : {}),
    };
  }
  return { code, message, ...(Object.keys(detail).length ? { detail } : {}) };
}

export async function callTool(
  agent: string,
  args: any,
  {
    env = process.env,
    progress,
    signal,
  }: { env?: NodeJS.ProcessEnv; progress?: (p: number, message: string) => void; signal?: AbortSignal } = {}
): Promise<any> {
  prepare(agent, args, env);
  let n = 0;
  let tr: any = null;
  try {
    tr = createTracker({
      agent,
      opts: { prompt: String(args.prompt ?? ''), model: args.model, cwd: env.AGENTBRIDGE_CHILD_CWD || args.cwd, session: args.session },
      env,
      origin: 'bridge-sync',
    });
  } catch {
    /* ignore */
  }
  let st: any;
  try {
    st = await execute(agent, args, {
      env,
      signal,
      onEvent: (e: any) => {
        try {
          tr?.onEvent(e);
        } catch {
          /* ignore */
        }
        if (e.type === 'text') progress?.(++n, `${agent}: ${String(e.delta).slice(0, 200)}`);
        else if (e.type === 'tool' && e.output === undefined) progress?.(++n, `${agent} tool: ${e.name}`);
        else if (e.type === 'quota') progress?.(++n, String(e.message || 'Quota routing update').slice(0, 200));
      },
    });
  } catch (e) {
    try {
      tr?.finish({ error: e });
    } catch {
      /* ignore */
    }
    if (signal?.aborted) {
      const err: any = new Error(structuredError(e, signal).message, { cause: e });
      err.code = 'ABORTED';
      err.requestReason = signal.reason;
      throw err;
    }
    if ((e as any)?.code === 'AGENT_FAILED' && Number.isFinite((e as any)?.exitCode) && (e as any).exitCode !== 0 && (e as any).cause == null) {
      (e as any).cause = 'CHILD_DIED';
    }
    throw e;
  }
  try {
    tr?.finish({ result: { text: st.text, sessionId: st.sessionId, usage: st.usage, model: st.model, agent: st.agent ?? agent, fallback: st.fallback } });
  } catch {
    /* ignore */
  }
  return asResult(st, env);
}

export async function callAny(name: string, args: any, ctx: any = {}): Promise<any> {
  const env = ctx.env || process.env;
  let m: RegExpExecArray | null;
  if ((m = /^ask_(\w+)$/.exec(name)) && agentList(env).includes(m[1])) return callTool(m[1], args, ctx);
  if ((m = /^dispatch_(\w+)$/.exec(name)) && agentList(env).includes(m[1])) {
    const agent = m[1],
      p = prepare(agent, args, env);
    fallbackOptions(args, env);
    const { rec, deduped } = dispatch({
      agent,
      model: p.model,
      cwd: args.cwd,
      key: args.idempotencyKey,
      prompt: String(args.prompt ?? ''),
      env,
      exec: ({ onEvent, signal }: any) => execute(agent, args, { env, onEvent, signal }),
    });
    const o = { runId: rec.id, state: rec.state, deduped };
    return { content: [{ type: 'text', text: JSON.stringify(o) }], structuredContent: o };
  }
  if (name === 'list_runs') {
    const l = listRuns(env)
      .filter((r) => !args?.state || r.state === args.state)
      .slice(0, args?.limit || 50)
      .map(summarize);
    return { content: [{ type: 'text', text: JSON.stringify(l) }], structuredContent: { runs: l } };
  }
  if (name === 'send_message') {
    if (!args?.to || typeof args.text !== 'string') return errResult('to and text are required');
    const msg = sendMessage(env, args);
    return { content: [{ type: 'text', text: JSON.stringify(msg) }], structuredContent: msg };
  }
  if (name === 'check_messages') {
    if (!args?.for) return errResult('for is required');
    const l = checkMessages(env, { for: args.for, markRead: args.markRead !== false });
    return { content: [{ type: 'text', text: JSON.stringify(l) }], structuredContent: { messages: l } };
  }
  if (name === 'retain_run' || name === 'release_run') {
    const a =
      typeof args?.id === 'string'
        ? setKeep(args.id, name === 'retain_run', env)
        : { error: `Unknown run id: ${args?.id}`, rec: undefined as any };
    if (a.error) return errResult(a.error);
    const r = a.rec;
    return { content: [{ type: 'text', text: JSON.stringify(summarize(r)) }], structuredContent: summarize(r) };
  }
  if (['wait_run', 'check_run', 'cancel_run'].includes(name)) {
    const id = args?.id;
    const r0 = loadRun(id as string, env);
    if (typeof id !== 'string' || !r0) return errResult(`Unknown run id: ${id}`);
    let r: any;
    let waitMeta: any = {};
    if (name === 'cancel_run') {
      const c = cancelRun(id, env);
      if (c.error) return errResult(c.error);
      r = c.rec;
    } else {
      if (name === 'wait_run') {
        const requestedTimeoutSeconds = args.timeoutSeconds === undefined ? MAX_WAIT_SECONDS : args.timeoutSeconds;
        if (typeof requestedTimeoutSeconds !== 'number' || !Number.isFinite(requestedTimeoutSeconds) || requestedTimeoutSeconds <= 0) {
          throw badOption('timeoutSeconds must be a finite positive number');
        }
        const waitTimeoutSeconds = Math.min(requestedTimeoutSeconds, MAX_WAIT_SECONDS);
        waitMeta = { requestedTimeoutSeconds, waitTimeoutSeconds, waitCapped: requestedTimeoutSeconds > MAX_WAIT_SECONDS };
        r = await waitRun(id, waitTimeoutSeconds * 1000, env, ctx.signal);
      } else r = r0;
    }
    const done = r.state === 'done';
    const out: any = { ...summarize(r), ...waitMeta, ...(done ? { text: r.result?.text, result: r.result } : {}) };
    const content = [{ type: 'text', text: done ? r.result?.text || '' : JSON.stringify(summarize(r)) }];
    if (done) {
      const attestation = attest(r.result, env);
      content.push({ type: 'text', text: META + JSON.stringify(attestation) });
      out.attestation = attestation;
    }
    return { content, structuredContent: out, ...(r.state === 'error' ? { isError: true } : {}) };
  }
  if (name === 'checkpoint_create') {
    const cwdTarget = path.resolve(args?.cwd || process.cwd());
    const allowedRoot = env.AGENTBRIDGE_ROOT ? path.resolve(env.AGENTBRIDGE_ROOT) : null;
    if (allowedRoot) {
      const rel = path.relative(allowedRoot, cwdTarget);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return errResult(`Forbidden: cwd "${cwdTarget}" is outside authorized AGENTBRIDGE_ROOT "${allowedRoot}"`);
      }
    }
    const { ceiling } = resolvePermissionLevel(args?.permissions, { env, cwd: cwdTarget });
    if (ceiling === 'read-only' || args?.permissions === 'read-only') {
      return errResult(`Permission denied: checkpoint_create is not allowed under read-only permissions`);
    }
    const { createCheckpoint } = await import('../extras/checkpoint.js');
    const cp = createCheckpoint(cwdTarget, { message: args?.message, sessionId: args?.sessionId });
    return { content: [{ type: 'text', text: JSON.stringify(cp) }], structuredContent: cp };
  }
  if (name === 'checkpoint_rollback') {
    const cwdTarget = path.resolve(args?.cwd || process.cwd());
    const allowedRoot = env.AGENTBRIDGE_ROOT ? path.resolve(env.AGENTBRIDGE_ROOT) : null;
    if (allowedRoot) {
      const rel = path.relative(allowedRoot, cwdTarget);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return errResult(`Forbidden: cwd "${cwdTarget}" is outside authorized AGENTBRIDGE_ROOT "${allowedRoot}"`);
      }
    }
    const { ceiling } = resolvePermissionLevel(args?.permissions, { env, cwd: cwdTarget });
    if (ceiling === 'read-only' || ceiling === 'plan' || args?.permissions === 'read-only' || args?.permissions === 'plan') {
      return errResult(`Permission denied: checkpoint_rollback is not allowed under "${ceiling}" permissions`);
    }
    const { rollbackCheckpoint } = await import('../extras/checkpoint.js');
    const res = rollbackCheckpoint(cwdTarget, args?.id);
    return { content: [{ type: 'text', text: JSON.stringify(res) }], structuredContent: res };
  }
  if (name === 'checkpoint_list') {
    const cwdTarget = path.resolve(args?.cwd || process.cwd());
    const allowedRoot = env.AGENTBRIDGE_ROOT ? path.resolve(env.AGENTBRIDGE_ROOT) : null;
    if (allowedRoot) {
      const rel = path.relative(allowedRoot, cwdTarget);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return errResult(`Forbidden: cwd "${cwdTarget}" is outside authorized AGENTBRIDGE_ROOT "${allowedRoot}"`);
      }
    }
    const { listCheckpoints } = await import('../extras/checkpoint.js');
    const list = listCheckpoints(cwdTarget, args?.sessionId);
    return { content: [{ type: 'text', text: JSON.stringify(list) }], structuredContent: { checkpoints: list } };
  }
  if (name === 'checkpoint_diff') {
    const cwdTarget = path.resolve(args?.cwd || process.cwd());
    const allowedRoot = env.AGENTBRIDGE_ROOT ? path.resolve(env.AGENTBRIDGE_ROOT) : null;
    if (allowedRoot) {
      const rel = path.relative(allowedRoot, cwdTarget);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return errResult(`Forbidden: cwd "${cwdTarget}" is outside authorized AGENTBRIDGE_ROOT "${allowedRoot}"`);
      }
    }
    const { diffCheckpoint } = await import('../extras/checkpoint.js');
    const diff = diffCheckpoint(cwdTarget, args?.id);
    return { content: [{ type: 'text', text: diff || '(no differences)' }], structuredContent: { id: args?.id, diff } };
  }
  if (name === 'check_quota') {
    const { getProactiveQuotaStatus, formatQuotaStatus } = await import('../quota/proactive.js');
    const agent = args?.agent || 'codex';
    if (args?.model != null && typeof args.model !== 'string') throw badOption('model must be a string');
    const status = await getProactiveQuotaStatus(agent, undefined, {
      model: args?.model,
      thresholdPercent: args?.thresholdPercent,
      env,
      signal: ctx.signal,
    });
    const measured = status.supported !== false && status.measured === true && status.source !== 'unmetered' &&
      (status.status === 'ok' || status.status === 'offline') &&
      typeof status.usedPercent === 'number' && Number.isFinite(status.usedPercent);
    const remainingPercent = measured && typeof status.usedPercent === 'number' ? Math.max(0, 100 - status.usedPercent) : null;
    const result = {
      ...status,
      remainingPercent,
      formatted: formatQuotaStatus(status),
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }
  return undefined;
}

const isJsonRpcObject = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const validJsonRpcId = (v: any): boolean => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const invalidJsonRpcRequest = (id: any = null) => ({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });

function makeHandler({ env, send }: { env: NodeJS.ProcessEnv; send: (m: any) => void }) {
  const inflight = new Map<any, AbortController>();
  attestKey(env);
  setTimeout(() => {
    try {
      sweep(env);
    } catch {
      /* ignore */
    }
  }, 1500).unref?.();
  const handle = async (msg: any, transportSignal?: AbortSignal): Promise<any> => {
    if (!isJsonRpcObject(msg)) return invalidJsonRpcRequest();
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
    const id = msg.id;
    const method = msg.method;
    const params = msg.params;
    const isReq = hasId;
    if (
      msg.jsonrpc !== '2.0' ||
      typeof method !== 'string' ||
      (hasId && !validJsonRpcId(id))
    ) {
      return invalidJsonRpcRequest(hasId && validJsonRpcId(id) ? id : null);
    }
    try {
      if (method === 'initialize') {
        if (!isReq) return undefined;
        const v = SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0];
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: v,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'agentbridge', version: VERSION },
          },
        };
      }
      if (method === 'notifications/cancelled') {
        if (isReq) return invalidJsonRpcRequest(id);
        const controller = inflight.get(params?.requestId);
        if (controller) {
          const clientReason = bounded(params?.reason?.message ?? params?.reason, 300);
          controller.abort({ code: 'REQUEST_CANCELLED', ...(clientReason ? { message: clientReason } : {}) });
        }
        return undefined;
      }
      if (!isReq) return undefined;
      if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: allTools(env) } };
      if (method === 'tools/call') {
        const name = params?.name;
        if (!allTools(env).some((t) => t.name === name)) {
          return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        }
        const ac = new AbortController();
        inflight.set(id, ac);
        const inheritTransportAbort = () => {
          if (!ac.signal.aborted) {
            ac.abort(transportSignal?.reason ?? { code: 'REQUEST_CANCELLED', message: 'CLIENT_DISCONNECTED' });
          }
        };
        if (transportSignal?.aborted) inheritTransportAbort();
        else transportSignal?.addEventListener('abort', inheritTransportAbort, { once: true });
        const token = params?._meta?.progressToken;
        const progress =
          token === undefined
            ? undefined
            : (p: number, message: string) =>
                send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: p, message } });
        try {
          return {
            jsonrpc: '2.0',
            id,
            result: await callAny(name, params.arguments ?? {}, { env, progress, signal: ac.signal }),
          };
        } catch (e: any) {
          const error = structuredError(e, ac.signal);
          return { jsonrpc: '2.0', id, result: errResult(`${error.code}: ${error.message}`, error) };
        } finally {
          transportSignal?.removeEventListener('abort', inheritTransportAbort);
          inflight.delete(id);
        }
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    } catch (e: any) {
      return isReq ? { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } } : undefined;
    }
  };
  return { handle, inflight };
}

export function serve({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  exitOnEnd = false,
}: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  exitOnEnd?: boolean;
} = {}): { shutdown: () => Promise<void> } {
  const send = (m: any) => output.write(JSON.stringify(m) + '\n');
  const { handle, inflight } = makeHandler({ env, send });
  const process1 = async (msg: any) => {
    if (Array.isArray(msg)) {
      if (!msg.length) {
        return send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: empty batch' } });
      }
      const out = (await Promise.all(msg.map((item) => handle(item)))).filter(Boolean);
      if (out.length) send(out);
    } else {
      const r = await handle(msg);
      if (r) send(r);
    }
  };
  let buf = '',
    scan = 0;
  (input as any).setEncoding?.('utf8');
  const maxLine = Number(env.AGENTBRIDGE_MCP_MAX_LINE_BYTES) || 16 * 1024 * 1024;
  let discarding = false; // dropping the rest of an oversized line until its newline
  input.on('data', (chunk: any) => {
    if (discarding) {
      const nl = String(chunk).indexOf('\n');
      if (nl < 0) return;
      discarding = false;
      chunk = String(chunk).slice(nl + 1);
    }
    buf += chunk;
    if (buf.length > maxLine && buf.indexOf('\n') < 0) {
      buf = '';
      scan = 0;
      discarding = true;
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Request line exceeds ${maxLine} bytes; dropped` } });
      return;
    }
    let i: number;
    while ((i = buf.indexOf('\n', scan)) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      scan = 0;
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      process1(msg);
    }
    scan = buf.length;
  });
  const shutdown = async () => {
    for (const a of inflight.values()) a.abort();
    await abortAll(env).catch(() => {});
    if (exitOnEnd) process.exit(0);
  };
  input.on('end', shutdown);
  return { shutdown };
}

export interface ServeHttpResult {
  server: http.Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function serveHttp({
  port = 0,
  host = '127.0.0.1',
  env = process.env,
  path: httpPath = '/mcp',
}: {
  port?: number;
  host?: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
} = {}): Promise<ServeHttpResult> {
  const { handle, inflight } = makeHandler({ env, send: () => {} });
  const postLifecycles = new Set<AbortController>();
  const authorized = (req: http.IncomingMessage) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const a = Buffer.from(String(token || '')),
      b = Buffer.from(attestKey(env));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const respond = (res: http.ServerResponse, status: number, body?: any) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith(httpPath)) {
      return respond(res, 404, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Not found' } });
    }
    if (!authorized(req)) {
      return respond(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
    }
    const postController = new AbortController();
    postLifecycles.add(postController);
    const abortDisconnectedPost = () => {
      if (!postController.signal.aborted) {
        postController.abort({ code: 'REQUEST_CANCELLED', message: 'CLIENT_DISCONNECTED' });
      }
    };
    const onRequestAborted = () => abortDisconnectedPost();
    const onResponseClose = () => {
      if (!res.writableEnded) {
        abortDisconnectedPost();
        cleanupPost();
      }
    };
    req.once('aborted', onRequestAborted);
    res.once('close', onResponseClose);
    const cleanupPost = () => {
      req.off('aborted', onRequestAborted);
      req.off('close', onRequestClose);
      res.off('close', onResponseClose);
      res.off('finish', cleanupPost);
      postLifecycles.delete(postController);
    };
    const onRequestClose = () => {
      if (req.aborted) {
        abortDisconnectedPost();
        cleanupPost();
      }
    };
    req.once('close', onRequestClose);
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 8 * 1024 * 1024) req.destroy();
    });
    req.on('end', async () => {
      let msg: any;
      try {
        msg = JSON.parse(body);
      } catch {
        cleanupPost();
        return respond(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      try {
        if (postController.signal.aborted) return;
        if (Array.isArray(msg)) {
          if (!msg.length) {
            return respond(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: empty batch' } });
          }
          const out = (await Promise.all(msg.map((item) => handle(item, postController.signal)))).filter(Boolean);
          return out.length ? respond(res, 200, out) : respond(res, 202);
        }
        const r = await handle(msg, postController.signal);
        return r ? respond(res, 200, r) : respond(res, 202);
      } finally {
        cleanupPost();
      }
    });
    res.once('finish', cleanupPost);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address() as any;
      resolve({
        server,
        port: addr.port,
        url: `http://${host}:${addr.port}${httpPath}`,
        close: (() => {
          let closePromise: Promise<void> | undefined;
          return () => {
            if (closePromise) return closePromise;
            for (const controller of postLifecycles) {
              if (!controller.signal.aborted) {
                controller.abort({ code: 'REQUEST_CANCELLED', message: 'HTTP_BRIDGE_CLOSED' });
              }
            }
            // Also cover any request controller that has not yet made it into the POST set.
            for (const controller of inflight.values()) {
              if (!controller.signal.aborted) {
                controller.abort({ code: 'REQUEST_CANCELLED', message: 'HTTP_BRIDGE_CLOSED' });
              }
            }
            closePromise = new Promise<void>((r) => server.close(() => r()));
            server.closeIdleConnections?.();
            server.closeAllConnections?.();
            return closePromise;
          };
        })(),
      });
    });
  });
}

const isMcpEntry = () => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
};

if (isMcpEntry()) {
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (...a: any[]) => (process.stderr.write as any)(...a);
  for (const k of ['log', 'info', 'debug'] as const) {
    (console as any)[k] = (...a: any[]) => console.error(...a);
  }
  const { shutdown } = serve({ output: { write: (d: any) => realWrite(d) } as any, exitOnEnd: true });
  for (const sg of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sg, () => shutdown().finally(() => process.exit(0)));
  }
}
