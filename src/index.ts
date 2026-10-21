import { AgentError, asRateLimited } from './core/errors.js';
import { ev } from './core/events.js';
import { loadEndpoints, endpointNames, makeEndpointAdapter } from './adapters/endpoint.js';
import { AgentAdapter, AgentEvent, FallbackTarget, RunOptions, RunResult } from './types/index.js';
import { installIde } from './cli/install-ide.js';
import { SubagentRoster } from './bridge/subagent-roster.js';
import { resolvePermissionLevel } from './core/config.js';
import { formatMemoryForPrompt } from './telemetry/memory.js';
import { supportsProactiveQuota } from './quota/proactive.js';

export { AgentError, asRateLimited, retryAfterMs, looksRateLimited, rateLimitKind } from './core/errors.js';
export { ev } from './core/events.js';
export { loadEndpoints, endpointNames, saveEndpoint, endpointsFile } from './adapters/endpoint.js';
export {
  loadConfig,
  saveConfig,
  setConfigValue,
  getConfigValue,
  resetConfigValue,
  getDefaultPermissions,
  getPermissionsCeiling,
  resolvePermissionLevel,
  findProjectRoot,
  projectConfigFile,
  PERMISSION_RANK,
  PERMISSION_LEVELS,
} from './core/config.js';
import { BUILTIN_AGENTS } from './core/catalog.js';

export {
  BUILTIN_AGENTS,
  VALID_ACCOUNT_AGENTS,
  isBuiltinAgent,
  isValidAccountAgent,
  type BuiltinAgentName,
  type ValidAccountAgentName,
} from './core/catalog.js';

const NAMES: readonly string[] = BUILTIN_AGENTS;
const cache = new Map<string, Promise<AgentAdapter>>();

async function loadEndpoint(name: string): Promise<AgentAdapter> {
  const cfg = loadEndpoints()[name];
  if (!cfg) {
    throw new AgentError('BAD_OPTION', `Unknown agent "${name}". Expected one of: ${[...NAMES, ...endpointNames()].join(', ')}`);
  }
  return makeEndpointAdapter(cfg);
}

async function load(name: string): Promise<AgentAdapter> {
  if (!NAMES.includes(name)) return loadEndpoint(name);
  if (!cache.has(name)) {
    cache.set(
      name,
      import(`./adapters/${name}.js`).then(
        (m) => m.default,
        (e) => {
          cache.delete(name);
          throw new AgentError('AGENT_FAILED', `Cannot load adapter "${name}": ${e.message}`);
        }
      )
    );
  }
  return cache.get(name)!;
}

/** Lazy registry */
export const agents = {
  builtin: NAMES,
  get names(): string[] {
    return [...NAMES, ...endpointNames()];
  },
  get: load,
  get claude(): Promise<AgentAdapter> {
    return load('claude');
  },
  get codex(): Promise<AgentAdapter> {
    return load('codex');
  },
  get opencode(): Promise<AgentAdapter> {
    return load('opencode');
  },
  get agy(): Promise<AgentAdapter> {
    return load('agy');
  },
  get pi(): Promise<AgentAdapter> {
    return load('pi');
  },
  get cursor(): Promise<AgentAdapter> {
    return load('cursor');
  },
  get grok(): Promise<AgentAdapter> {
    return load('grok');
  },
  get gemini(): Promise<AgentAdapter> {
    return load('gemini');
  },
  get devin(): Promise<AgentAdapter> {
    return load('devin');
  },
  get acp(): Promise<AgentAdapter> {
    return load('acp');
  },
  async models(name: string): Promise<string[]> {
    const a = await load(name);
    return a.models ? a.models() : [];
  },
};

const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
const SESSION_MODES = ['new', 'ephemeral', 'continue', 'fork'];
const KNOWN = new Set([
  'prompt',
  'model',
  'effort',
  'permissions',
  'cwd',
  'timeoutMs',
  'signal',
  'session',
  'systemPrompt',
  'mcpServers',
  'env',
  'jsonSchema',
  'extraArgs',
  'isolated',
  'fallback',
  'fallbackOn',
  'quotaPolicy',
  'dangerouslySkipPermissions',
  'yolo',
  'images',
  'harness',
  'offline',
  'defaultPermissions',
  'transport',
  'appServer',
  'skills',
  'mcpPassthrough',
  'writableRoots',
]);
const HARNESS_MODES = ['auto', 'claude', 'pi', 'none'];
const TRANSPORTS = ['cli', 'app-server', 'stdio', 'auto'];
const FALLBACK_ON = ['RATE_LIMITED', 'NOT_LOGGED_IN', 'NOT_INSTALLED', 'TIMEOUT', 'AGENT_FAILED'];
const bad = (m: string) => new AgentError('BAD_OPTION', m);
const isObj = (v: any): boolean => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate + normalize RunOptions. Throws BAD_OPTION. Returns a new object with defaults applied. */
export function validateOptions(opts: RunOptions): RunOptions {
  if (!isObj(opts)) throw bad('opts must be an object');
  for (const k of Object.keys(opts)) {
    if (!KNOWN.has(k)) throw bad(`Unknown option "${k}"`);
  }
  const o: RunOptions = { ...opts };
  if (typeof o.prompt !== 'string' || !o.prompt.trim()) throw bad('prompt must be a non-empty string');
  const memHeader = '[PROJECT CONVENTIONS & MEMORY';
  if (!o.prompt.includes(memHeader)) {
    try {
      const memoryBlock = formatMemoryForPrompt(o.cwd);
      if (memoryBlock) {
        o.prompt = `${memoryBlock}\n\n${o.prompt}`;
      }
    } catch {
      /* non-fatal if memory fails to load */
    }
  }
  for (const k of ['model', 'cwd', 'systemPrompt'] as const) {
    if (o[k] != null && typeof o[k] !== 'string') throw bad(`${k} must be a string`);
  }
  if (o.effort != null && !EFFORT.includes(o.effort)) throw bad(`effort must be one of ${EFFORT.join('|')}`);
  const effectiveEnv = o.env ? { ...process.env, ...o.env } : process.env;
  const resolved = resolvePermissionLevel(o.permissions, {
    env: effectiveEnv,
    cwd: o.cwd || process.cwd(),
  });
  o.permissions = resolved.permissions;
  if (resolved.isDefault) {
    (o as any).defaultPermissions = true;
  }
  if (o.harness != null && !HARNESS_MODES.includes(o.harness)) {
    throw bad(`harness must be one of ${HARNESS_MODES.join('|')}`);
  }
  if (o.transport != null && !TRANSPORTS.includes(o.transport)) {
    throw bad(`transport must be one of ${TRANSPORTS.join('|')}`);
  }
  if (o.appServer != null && typeof o.appServer !== 'boolean') {
    throw bad('appServer must be a boolean');
  }
  if (o.offline != null && typeof o.offline !== 'boolean') {
    throw bad('offline must be a boolean');
  }
  if (o.dangerouslySkipPermissions != null && typeof o.dangerouslySkipPermissions !== 'boolean') {
    throw bad('dangerouslySkipPermissions must be a boolean');
  }
  if (o.dangerouslySkipPermissions && o.permissions !== 'full') {
    throw bad('dangerouslySkipPermissions requires permissions="full"');
  }
  if (o.yolo != null && typeof o.yolo !== 'boolean') throw bad('yolo must be a boolean');
  if (o.yolo && o.permissions !== 'full') throw bad('yolo requires permissions="full"');
  if (o.quotaPolicy != null) {
    if (!isObj(o.quotaPolicy) || !Number.isFinite(o.quotaPolicy.minRemainingPercent) || o.quotaPolicy.minRemainingPercent < 0 || o.quotaPolicy.minRemainingPercent > 100) {
      throw bad('quotaPolicy.minRemainingPercent must be a finite percentage in [0,100]');
    }
    for (const key of Object.keys(o.quotaPolicy)) {
      if (!['minRemainingPercent', 'waitForReset', 'maxWaitMs'].includes(key)) throw bad(`Unknown quotaPolicy option "${key}"`);
    }
    if (o.quotaPolicy.waitForReset != null && typeof o.quotaPolicy.waitForReset !== 'boolean') {
      throw bad('quotaPolicy.waitForReset must be a boolean');
    }
    if (o.quotaPolicy.maxWaitMs != null && (!Number.isFinite(o.quotaPolicy.maxWaitMs) || o.quotaPolicy.maxWaitMs <= 0)) {
      throw bad('quotaPolicy.maxWaitMs must be a positive finite number');
    }
  }
  if (o.timeoutMs != null && !(Number.isFinite(o.timeoutMs) && o.timeoutMs > 0)) {
    throw bad('timeoutMs must be a positive number');
  }
  if (
    o.signal != null &&
    !(
      typeof o.signal === 'object' &&
      typeof (o.signal as any).aborted === 'boolean' &&
      typeof o.signal.addEventListener === 'function'
    )
  ) {
    throw bad('signal must be an AbortSignal');
  }
  if (o.session != null) {
    if (!isObj(o.session) || !SESSION_MODES.includes(o.session.mode)) {
      throw bad(`session.mode must be one of ${SESSION_MODES.join('|')}`);
    }
    if (o.session.id != null && (typeof o.session.id !== 'string' || !o.session.id)) {
      throw bad('session.id must be a non-empty string');
    }
    if (o.session.id != null && (o.session.mode === 'new' || o.session.mode === 'ephemeral')) {
      throw bad(`session.id is not allowed with mode "${o.session.mode}"`);
    }
  }
  if (o.mcpServers != null) {
    if (!isObj(o.mcpServers)) throw bad('mcpServers must be an object');
    for (const [n, s] of Object.entries(o.mcpServers)) {
      if (!isObj(s) || typeof s.command !== 'string' || !s.command) {
        throw bad(`mcpServers.${n}.command must be a string`);
      }
      if (s.args != null && !(Array.isArray(s.args) && s.args.every((a) => typeof a === 'string'))) {
        throw bad(`mcpServers.${n}.args must be string[]`);
      }
      if (s.env != null && !isObj(s.env)) throw bad(`mcpServers.${n}.env must be an object`);
      if (s.timeout != null && (typeof s.timeout !== 'number' || s.timeout <= 0 || !Number.isFinite(s.timeout))) {
        throw bad(`mcpServers.${n}.timeout must be a positive number`);
      }
    }
  }
  if (o.env != null && !isObj(o.env)) throw bad('env must be an object');
  if (o.jsonSchema != null && !isObj(o.jsonSchema)) throw bad('jsonSchema must be an object');
  if (o.isolated != null && typeof o.isolated !== 'boolean') throw bad('isolated must be boolean');
  if (o.extraArgs != null && !(Array.isArray(o.extraArgs) && o.extraArgs.every((a) => typeof a === 'string'))) {
    throw bad('extraArgs must be string[]');
  }
  if (o.images != null) {
    if (
      !Array.isArray(o.images) ||
      o.images.length > 8 ||
      o.images.some(
        (i) =>
          !isObj(i) ||
          !/^image\/(png|jpe?g|gif|webp)$/i.test(i.mediaType || '') ||
          typeof i.data !== 'string' ||
          !i.data
      )
    ) {
      throw bad('images must be at most 8 items of {mediaType: image/png|jpeg|gif|webp, data: base64}');
    }
  }
  if (o.fallback != null) {
    if (!Array.isArray(o.fallback) || o.fallback.length > 5) throw bad('fallback must be an array of at most 5 agents');
    o.fallback = o.fallback.map(parseFallbackTarget as any);
  }
  if (!o.quotaPolicy && o.fallback?.some((target) => typeof target !== 'string' && target.minRemainingPercent !== undefined)) {
    throw bad('fallback minRemainingPercent requires quotaPolicy');
  }
  for (const target of o.fallback || []) {
    if (typeof target !== 'string' && target.minRemainingPercent !== undefined && !supportsProactiveQuota(target.agent)) {
      throw bad(`Quota thresholds are unavailable for fallback agent "${target.agent}"`);
    }
  }
  if (o.fallbackOn != null) {
    if (
      !Array.isArray(o.fallbackOn) ||
      !o.fallbackOn.length ||
      o.fallbackOn.some((c) => !FALLBACK_ON.includes(c))
    ) {
      throw bad(`fallbackOn must be a non-empty subset of ${FALLBACK_ON.join('|')}`);
    }
  }
  return o;
}

/** "codex", "codex@15:model", "ollama:glm-5.3-flash:cloud" or {agent, model?} -> a normalized fallback target. */
export function parseFallbackTarget(t: any): FallbackTarget {
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    if (typeof t.agent !== 'string' || !t.agent || (t.model != null && typeof t.model !== 'string')) {
      throw bad('fallback entries need a string "agent" (and optional string "model")');
    }
    if (t.minRemainingPercent !== undefined && (typeof t.minRemainingPercent !== 'number' || !Number.isFinite(t.minRemainingPercent) || t.minRemainingPercent < 0 || t.minRemainingPercent > 100)) {
      throw bad('fallback minRemainingPercent must be a finite percentage in [0,100]');
    }
    return {
      agent: t.agent,
      ...(t.model ? { model: t.model } : {}),
      ...(t.minRemainingPercent === undefined ? {} : { minRemainingPercent: t.minRemainingPercent }),
    };
  }
  if (typeof t !== 'string' || !t.trim()) throw bad('fallback entries must be "agent", "agent:model", "agent@percent:model" or {agent, model}');
  const s = t.trim();
  const colon = s.indexOf(':');
  const head = colon < 0 ? s : s.slice(0, colon);
  const model = colon < 0 ? undefined : s.slice(colon + 1);
  const at = head.lastIndexOf('@');
  if (at < 0) return { agent: head, ...(model ? { model } : {}) };
  const agent = head.slice(0, at);
  const rawThreshold = head.slice(at + 1);
  const threshold = rawThreshold.trim() === '' ? NaN : Number(rawThreshold);
  if (!agent || !Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw bad('fallback minRemainingPercent must be a finite percentage in [0,100]');
  }
  if (colon >= 0 && !model) throw bad('fallback model must be non-empty when a quota threshold is specified');
  return { agent, minRemainingPercent: threshold, ...(model ? { model } : {}) };
}

/** Stream normalized events; the generator's return value is the Result. */
export async function* run(agent: string | AgentAdapter, opts: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
  const o = validateOptions(opts);
  const primaryName = typeof agent === 'string' ? agent.toLowerCase() : agent.name?.toLowerCase();
  if (o.yolo && primaryName !== 'codex') throw bad('yolo is only supported when the primary agent is Codex');
  if (o.quotaPolicy) return yield* runQuotaRouted(agent, o);
  const { fallback = [], fallbackOn = ['RATE_LIMITED'], ...base } = o;
  const attempts: any[] = [];
  let cur: { agent: string | AgentAdapter; opts: RunOptions } = { agent, opts: base };
  for (let i = 0; ; i++) {
    let sideEffects = false;
    try {
      const it = attempt(cur.agent, cur.opts);
      try {
        for (;;) {
          const x = await it.next();
          if (x.done) {
            return attempts.length
              ? {
                  ...x.value,
                  fallback: {
                    used: typeof cur.agent === 'string' ? cur.agent : cur.agent.name || 'agent',
                    attempts,
                    contextLost: base.session?.mode === 'continue' || base.session?.mode === 'fork',
                  },
                }
              : x.value;
          }
          if (x.value.type === 'tool') sideEffects = true;
          yield x.value;
        }
      } finally {
        await (it as any).return?.();
      }
    } catch (e: any) {
      const next = fallback[i] as any;
      const eligible = e instanceof AgentError && (fallbackOn as string[]).includes(e.code) && next && !base.signal?.aborted;
      if (!eligible) {
        if (attempts.length && e instanceof AgentError) {
          (e as any).fallback = {
            attempts: [
              ...attempts,
              { agent: typeof cur.agent === 'string' ? cur.agent : cur.agent.name || 'agent', code: e.code, message: e.message },
            ],
          };
        }
        throw e;
      }
      if (sideEffects && base.permissions !== 'read-only' && base.permissions !== 'plan') {
        const agentName = typeof cur.agent === 'string' ? cur.agent : cur.agent.name || 'agent';
        (e as any).fallbackSkipped = `${agentName} already ran tools under "${base.permissions}" permissions; repeating the task on ${next.agent || next} could duplicate side effects`;
        throw e;
      }
      const curAgentName = typeof cur.agent === 'string' ? cur.agent : cur.agent.name || 'agent';
      attempts.push({
        agent: curAgentName,
        ...(cur.opts.model ? { model: cur.opts.model } : {}),
        code: e.code,
        message: e.message,
        ...(e.retryAfterMs != null ? { retryAfterMs: e.retryAfterMs } : {}),
      });
      yield ev.fallback(curAgentName, next.agent || next, e.code, e.message);
      const { extraArgs, effort, session, model, ...keep } = base;
      const { dangerouslySkipPermissions, yolo, ...fallbackKeep } = keep;
      const nextIsClaude = next.agent === 'claude' || next.agent === 'anthropic';
      const nextIsCodex = next.agent === 'codex';
      void extraArgs;
      void effort;
      void session;
      void model;
      void dangerouslySkipPermissions;
      void yolo;
      cur = {
        agent: next.agent,
        opts: {
          ...fallbackKeep,
          ...(next.model ? { model: next.model } : {}),
          ...(session?.mode === 'ephemeral' ? { session } : {}),
          ...(base.dangerouslySkipPermissions && nextIsClaude ? { dangerouslySkipPermissions: true } : {}),
          ...(base.yolo && nextIsCodex ? { yolo: true } : {}),
        },
      };
    }
  }
}

async function* runQuotaRouted(agent: string | AgentAdapter, options: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
  const { selectQuotaRoute } = await import('./quota/routing.js');
  const fallback = options.fallback || [];
  const routeDefaultModel = (name: string): string | undefined => {
    const normalized = name.toLowerCase();
    if (normalized === 'agy' || normalized === 'antigravity') return 'gemini-3.8-flash-low';
    if (normalized === 'gemini') return options.env?.GEMINI_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash';
    return undefined;
  };
  const candidates = [agent, ...fallback].map((target: any, index) => {
    const t = typeof target === 'string' ? parseFallbackTarget(target) : typeof target === 'object' && 'agent' in target ? target : { agent: target };
    const name = typeof t.agent === 'string' ? t.agent : (t.agent.name || 'agent');
    return {
      id: `c${index}`,
      agent: name,
      model: t.model || (index === 0 ? options.model : undefined) || routeDefaultModel(name),
      ...(t.minRemainingPercent === undefined ? {} : { minRemainingPercent: t.minRemainingPercent }),
    };
  });
  const primaryName = candidates[0]?.agent?.toLowerCase();
  if (options.dangerouslySkipPermissions && primaryName !== 'claude' && primaryName !== 'anthropic') {
    throw bad('dangerouslySkipPermissions is only supported by Claude');
  }
  const excluded = new Set<string>();
  const cooldowns = new Map<string, number>();
  const waitState = { remainingMs: options.quotaPolicy?.maxWaitMs };
  const attempts: any[] = [];
  const accountedRoutes = new Set<string>();
  let pendingFallback: { from: string; code: string; message: string } | undefined;

  const select = async function* (): AsyncGenerator<AgentEvent, any, void> {
    const iterator = selectQuotaRoute({
      candidates,
      quotaPolicy: options.quotaPolicy!,
      env: {
        ...(options.env as NodeJS.ProcessEnv | undefined),
        ...(options.offline ? { AGENTBRIDGE_OFFLINE: '1' } : {}),
      },
      signal: options.signal,
      exclude: excluded,
      cooldowns,
      waitState,
    });
    for (;;) {
      const step = await iterator.next();
      if (step.done) return step.value;
      yield step.value;
    }
  };

  for (;;) {
    const routing = select();
    let selection: any;
    try {
      for (;;) {
        const step = await routing.next();
        if (step.done) { selection = step.value; break; }
        yield step.value;
      }
    } catch (e: any) {
      if (attempts.length && e instanceof AgentError) (e as any).fallback = { attempts };
      throw e;
    }
    const selectedIndex: number = selection.index;
    const selectedName: string = selection.agent;
    const target: any = selectedIndex === 0 ? agent : (fallback[selectedIndex - 1] as any).agent;
    const isClaude = selectedName.toLowerCase() === 'claude' || selectedName.toLowerCase() === 'anthropic';
    for (const skipped of candidates.slice(0, selectedIndex)) {
      if (accountedRoutes.has(skipped.id)) continue;
      attempts.push({
        agent: skipped.agent,
        ...(skipped.model ? { model: skipped.model } : {}),
        code: 'QUOTA_ROUTED',
        message: 'Skipped by quota eligibility policy',
      });
      accountedRoutes.add(skipped.id);
    }
    if (pendingFallback) {
      yield ev.fallback(pendingFallback.from, selectedName, pendingFallback.code, pendingFallback.message);
      pendingFallback = undefined;
    } else if (selectedIndex > 0 && attempts.length) {
      const first = candidates[0];
      yield ev.fallback(first.agent, selectedName, 'QUOTA_ROUTED', 'Skipped by quota eligibility policy');
    }
    const { fallback: _fallback, fallbackOn: _fallbackOn, quotaPolicy: _quotaPolicy,
      extraArgs, effort, session, model, dangerouslySkipPermissions, yolo, ...keep } = options;
    void _fallback; void _fallbackOn; void _quotaPolicy;
    const runOpts: RunOptions = {
      ...keep,
      env: selection.env,
      ...(selection.model ? { model: selection.model } : {}),
      ...(extraArgs && selectedIndex === 0 ? { extraArgs } : {}),
      ...(effort && selectedIndex === 0 ? { effort } : {}),
      ...(selectedIndex === 0 ? (session ? { session } : {}) : session?.mode === 'ephemeral' ? { session } : {}),
      ...(dangerouslySkipPermissions && isClaude ? { dangerouslySkipPermissions: true } : {}),
      ...(yolo && primaryName === 'codex' && selectedName.toLowerCase() === 'codex' ? { yolo: true } : {}),
    };
    let routeTools = false;
    try {
      const it = attempt(target, runOpts);
      try {
        for (;;) {
          const x = await it.next();
          if (x.done) {
            return attempts.length
              ? { ...x.value, fallback: { used: selectedName, attempts, contextLost: selectedIndex > 0 && (options.session?.mode === 'continue' || options.session?.mode === 'fork') } }
              : x.value;
          }
          if (x.value.type === 'tool') routeTools = true;
          yield x.value;
        }
      } finally {
        await (it as any).return?.();
      }
    } catch (e: any) {
      const eligible = e instanceof AgentError && (options.fallbackOn || ['RATE_LIMITED']).includes(e.code as any) && !options.signal?.aborted;
      const hasOtherCandidate = candidates.some((candidate: any) => candidate.id !== selection.id && !excluded.has(candidate.id));
      if (!eligible || (e.code !== 'RATE_LIMITED' && !hasOtherCandidate)) {
        if (attempts.length && e instanceof AgentError) (e as any).fallback = { attempts: [...attempts, { agent: selectedName, code: e.code, message: e.message }] };
        throw e;
      }
      if (routeTools && options.permissions !== 'read-only' && options.permissions !== 'plan') {
        (e as any).fallbackSkipped = `${selectedName} already ran tools under "${options.permissions}" permissions; repeating the task could duplicate side effects`;
        throw e;
      }
      excluded.add(selection.id);
      attempts.push({ agent: selectedName, ...(selection.model ? { model: selection.model } : {}), code: e.code, message: e.message,
        ...(e.retryAfterMs != null ? { retryAfterMs: e.retryAfterMs } : {}) });
      accountedRoutes.add(selection.id);
      if (e.code === 'RATE_LIMITED') cooldowns.set(selection.id, Date.now() + Math.max(30_000, e.retryAfterMs || 0));
      pendingFallback = { from: selectedName, code: e.code, message: e.message };
      // RATE_LIMITED can retry the same route after its cooldown (single-provider chains included).
      if (e.code === 'RATE_LIMITED') excluded.delete(selection.id);
    }
  }
}

async function* attempt(agent: string | AgentAdapter, o: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
  const adapter = typeof agent === 'string' ? await load(agent) : agent;
  if (!adapter || typeof adapter.run !== 'function') throw bad('agent must be a name or adapter object');
  if (o.dangerouslySkipPermissions && adapter.name?.toLowerCase() !== 'claude') {
    throw bad('dangerouslySkipPermissions is only supported by Claude');
  }
  if (o.signal?.aborted) throw new AgentError('ABORTED', 'Aborted before start');
  try {
    return yield* adapter.run(validateOptions(o));
  } catch (e) {
    throw asRateLimited(e);
  }
}

/** Run to completion and return the Result. */
export async function ask(agent: string | AgentAdapter, opts: RunOptions): Promise<RunResult> {
  const it = run(agent, opts);
  for (;;) {
    const { value, done } = await it.next();
    if (done) return value;
  }
}

// Telemetry
export {
  runWithTelemetry,
  runTracked,
  askWithTelemetry,
  stats,
  contextOf,
  setContextWindow,
  setPolicy,
  getPolicy,
  handoff,
  compact,
  wait,
  waitAll,
} from './telemetry/index.js';

// Extras
export { fanout, race, parseTarget, execOne } from './extras/parallel.js';
export { validate as validateSchema, extractJson, askWithSchema } from './extras/schema.js';
export { withWorktree, runInWorktree, createSandbox } from './extras/worktree.js';
export {
  createCheckpoint,
  listCheckpoints,
  rollbackCheckpoint,
  diffCheckpoint,
  deleteCheckpoint,
  type CheckpointInfo,
  type CheckpointOptions,
} from './extras/checkpoint.js';
export { Budget, runBudgeted } from './extras/budget.js';
export { doctor } from './extras/doctor.js';
export {
  autoRepair,
  type RepairOptions,
  type RepairResult,
  type RepairAttempt,
} from './extras/repair.js';
export {
  runReviewLoop,
  runEnsemble,
  parseReviewVerdict,
  type ReviewLoopOptions,
  type ReviewLoopResult,
  type ReviewVerdict,
  type TurnRecord,
  type EnsembleOptions,
  type EnsembleResult,
  type EnsembleAgentConfig,
  type AgentEnsembleOutput,
} from './extras/consensus.js';
export { runPipeline } from './extras/pipeline.js';

// IDE MCP Installer
export {
  installIde,
  getIdeConfigPath,
  type InstallIdeOptions,
  type InstallIdeResult,
  type IdeTarget,
  type IdeScope,
} from './cli/install-ide.js';

// CommonMark boundary-aware streaming
export {
  splitBufferedAssistantText,
  createMarkdownStreamFilter,
  type MarkdownStreamFilter,
  type MarkdownStreamFilterOptions,
  type SplitResult,
} from './core/markdown-stream.js';

// Subagent Native Roster
export {
  SubagentRoster,
  type SubagentNode,
  type SubagentStatus,
  type TokenUsage,
  type RegisterSubagentOptions,
  type UpdateStatusOptions,
} from './bridge/subagent-roster.js';

// Project Memory
export {
  loadMemory,
  saveMemory,
  addRule,
  addDecision,
  setVariable,
  clearMemory,
  formatMemoryForPrompt,
  type ProjectMemory,
  type MemoryDecision,
} from './telemetry/memory.js';

// Proactive Quota Checking
export {
  fetchAnthropicUsage,
  fetchCodexUsage,
  getProactiveQuotaStatus,
  parseAnthropicUsage,
  parseCodexUsage,
  formatQuotaStatus,
  formatQuotaForPrompt,
  setQuotaFixture,
  clearQuotaFixtures,
  supportsProactiveQuota,
  type ProactiveQuotaHealth,
  type AnthropicUsage,
  type CodexUsage,
} from './quota/proactive.js';
export { selectQuotaRoute, type SelectQuotaRouteOptions } from './quota/routing.js';

// Multiple Accounts Management
export {
  listAccounts,
  addAccount,
  removeAccount,
  setActiveAccount,
  getActiveAccount,
  getAccountEnv,
  getAccountsAsPool,
  loadAccountsManifest,
  saveAccountsManifest,
  type AccountRecord,
  type AccountsManifest,
} from './core/accounts.js';

// Proxy Server
export { startProxy, type ProxyOptions, type RunningProxy } from './server/index.js';

// Types
export * from './types/index.js';

export default { agents, run, ask, AgentError, installIde, SubagentRoster };
export { runAsSubagent } from './bridge/subagent.js';
export { mcpConfigFor } from './bridge/attach.js';
