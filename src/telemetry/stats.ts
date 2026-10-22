// Telemetry: per-run / per-session / global context accounting. Persists to <AGENTBRIDGE_HOME>/telemetry/.
import { spawnSync } from 'node:child_process';
import {
  unlinkSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  existsSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { home, listRuns, scheduleRetention } from '../bridge/runs.js';
import { resolveBinary, runCollect } from '../core/spawn.js';
import { LruMap } from '../core/lru.js';

export const telemetryDir = (env: NodeJS.ProcessEnv = process.env): string => path.join(home(env), 'telemetry');
const sub = (env: NodeJS.ProcessEnv, n: string): string => path.join(telemetryDir(env), n);
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const DEFAULT_WINDOWS: [string, RegExp, number][] = [
  ['claude', /\[1m\]|1m/i, 1_000_000],
  ['claude', /.*/, 200_000],
  ['codex', /gpt-5|codex|o[34]/i, 258_400],
  ['codex', /.*/, 200_000],
  ['opencode', /gemini/i, 1_000_000],
  ['opencode', /claude|sonnet|opus|haiku/i, 200_000],
  ['opencode', /gpt-5/i, 272_000],
  ['opencode', /gpt-4\.1/i, 1_000_000],
  ['opencode', /.*/, 128_000],
  ['agy', /gemini/i, 1_000_000],
  ['agy', /claude/i, 200_000],
  ['agy', /.*/, 128_000],
  ['gemini', /.*/, 1_000_000],
  ['cursor', /.*/, 200_000],
  ['grok', /.*/, 256_000],
  ['devin', /.*/, 200_000],
  ['pi', /gemini/i, 1_000_000],
  ['pi', /claude|sonnet|opus|haiku/i, 200_000],
  ['pi', /gpt-5/i, 272_000],
  ['pi', /.*/, 128_000],
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): any {
  try {
    return JSON.parse(readFileSync(path.join(telemetryDir(env), 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

export function setContextWindow(agent: string, model: string, tokens: number, env: NodeJS.ProcessEnv = process.env): any {
  if (!Number.isFinite(tokens) || tokens <= 0) throw new TypeError('tokens must be a positive number');
  const c = loadConfig(env);
  c.windows ||= {};
  (c.windows[agent] ||= {})[model || '*'] = tokens;
  writeJson(path.join(telemetryDir(env), 'config.json'), c);
  return c.windows;
}

export function windowFor(agent: string, model?: string | null, overrides: Record<string, any> = {}): { tokens: number; source: string } {
  const o = overrides?.[agent];
  if (o) {
    const m = String(model || '').toLowerCase();
    const k = Object.keys(o).find((x) => x !== '*' && m.includes(x.toLowerCase()));
    if (k) return { tokens: o[k], source: 'override' };
    if (o['*']) return { tokens: o['*'], source: 'override' };
  }
  for (const [a, re, t] of DEFAULT_WINDOWS) {
    if (a === agent && re.test(String(model || ''))) return { tokens: t, source: 'table' };
  }
  return { tokens: 128_000, source: 'table' };
}

export const estimateTokens = (s?: string | null): number => Math.ceil(String(s ?? '').length / 4);

function writeJson(f: string, obj: any): void {
  mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 1));
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, f);
      return;
    } catch (e) {
      if (i > 20) throw e;
    }
  }
}

const readJson = (f: string): any => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

const safe = (s: unknown): string => String(s).replace(/[^\w.-]/g, '_');
const sessionFile = (env: NodeJS.ProcessEnv, agent: string, sid: string): string =>
  path.join(sub(env, 'sessions'), `${safe(agent)}__${safe(sid)}.json`);
const runFile = (env: NodeJS.ProcessEnv, id: string): string => path.join(sub(env, 'runs'), `${safe(id)}.json`);

function tailLines(file: string, bytes = 400_000): string[] {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size,
      start = Math.max(0, size - bytes),
      buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } finally {
    closeSync(fd);
  }
}

function tailHead(file: string, bytes = 65_536): string[] {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(bytes, statSync(file).size));
    readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8').split('\n');
  } finally {
    closeSync(fd);
  }
}

function findFile(root: string, pred: (name: string) => boolean, depth = 5): string | null {
  let names: any;
  try {
    names = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of names) {
    const p = path.join(root, d.name);
    if (d.isDirectory()) {
      if (depth > 0) {
        const r = findFile(p, pred, depth - 1);
        if (r) return r;
      }
    } else if (pred(d.name)) return p;
  }
  return null;
}

export interface SessionContextResult {
  tokens: number;
  exact: boolean;
  source: string;
  model?: string;
  window?: number | null;
  file?: string;
}

const sessionContextCache = new LruMap<string, { result: SessionContextResult | null; cachedAt: number }>(1000);
const CACHE_TTL_MS = 30_000;
// opencode needs a subprocess per read: keep its results longer
const OPENCODE_CACHE_TTL_MS = Number(process.env.AGENTBRIDGE_OPENCODE_CTX_TTL_MS) || 120_000;
const ttlFor = (agent: string): number => (agent === 'opencode' ? OPENCODE_CACHE_TTL_MS : CACHE_TTL_MS);

interface ContextOpts {
  homeDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  refresh?: boolean;
  /** Never spawn: serve cached values (even stale) for agents that need a subprocess (opencode), else null. */
  cacheOnly?: boolean;
}

function ctxCacheKey(agent: string, sessionId: string, { homeDir = homedir(), cwd, env }: ContextOpts): string {
  const normalizeProfilePath = (p: string | undefined): string => {
    if (!p) return '';
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const profileRoot = agent === 'claude'
    ? env?.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude')
    : agent === 'codex'
    ? env?.CODEX_HOME || path.join(homeDir, '.codex')
    : '';
  let profileIdentity: unknown = normalizeProfilePath(profileRoot);
  if (agent === 'opencode') {
    const effectiveEnv = (key: string): string | undefined => env?.[key] !== undefined ? env[key] : process.env[key];
    const binary = resolveBinary('opencode', env || process.env);
    const profileHome = effectiveEnv('HOME') ?? (process.platform === 'win32' ? effectiveEnv('USERPROFILE') : undefined);
    profileIdentity = [
      normalizeProfilePath(cwd || process.cwd()),
      normalizeProfilePath(effectiveEnv('XDG_DATA_HOME')),
      normalizeProfilePath(effectiveEnv('XDG_CONFIG_HOME')),
      normalizeProfilePath(effectiveEnv('OPENCODE_CONFIG_DIR')),
      normalizeProfilePath(effectiveEnv('OPENCODE_CONFIG')),
      normalizeProfilePath(profileHome),
      normalizeProfilePath(binary || undefined),
    ];
  }
  return JSON.stringify([agent, sessionId, profileIdentity]);
}

function cacheGet(key: string, agent: string, allowStale = false): { hit: boolean; result: SessionContextResult | null } {
  const e = sessionContextCache.get(key);
  if (!e) return { hit: false, result: null };
  if (allowStale || Date.now() - e.cachedAt < ttlFor(agent)) return { hit: true, result: e.result };
  sessionContextCache.delete(key); // enforce TTL by eviction
  return { hit: false, result: null };
}

function parseOpencodeExport(stdout: string): SessionContextResult | null {
  const i = (stdout || '').indexOf('{');
  if (i < 0) return null;
  const j = JSON.parse(stdout.slice(i));
  const msgs = (j.messages || []).filter((m: any) => m.info?.role === 'assistant' && m.info.tokens);
  const last = msgs[msgs.length - 1];
  if (!last) return null;
  const t = last.info.tokens;
  return {
    tokens: (t.input || 0) + (t.output || 0) + (t.cache?.read || 0) + (t.cache?.write || 0),
    exact: true,
    source: 'opencode-export',
    model: last.info.modelID ? `${last.info.providerID ? last.info.providerID + '/' : ''}${last.info.modelID}` : undefined,
  };
}

// Async opencode export: bounded concurrency + in-flight coalescing so a dashboard poll can never stall the loop.
const EXPORT_CONCURRENCY = Number(process.env.AGENTBRIDGE_OPENCODE_EXPORT_CONCURRENCY) || 3;
let exportActive = 0;
const exportWaiters: (() => void)[] = [];
const exportInflight = new Map<string, Promise<SessionContextResult | null>>();
async function withExportSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (exportActive >= EXPORT_CONCURRENCY) await new Promise<void>((ok) => exportWaiters.push(ok));
  exportActive++;
  try {
    return await fn();
  } finally {
    exportActive--;
    exportWaiters.shift()?.();
  }
}

/** Async variant of readSessionContext: identical results, but opencode exports run off the event loop. */
export async function readSessionContextAsync(agent: string, sessionId: string, o: ContextOpts = {}): Promise<SessionContextResult | null> {
  if (!sessionId) return null;
  if (agent !== 'opencode') return readSessionContext(agent, sessionId, o);
  const key = ctxCacheKey(agent, sessionId, o);
  if (!o.refresh) {
    const c = cacheGet(key, agent, !!o.cacheOnly);
    if (c.hit) return c.result;
  }
  if (o.cacheOnly) return null;
  const pending = exportInflight.get(key);
  if (pending) return pending;
  const p = withExportSlot(async () => {
    const env = o.env;
    const bin = resolveBinary('opencode', env || process.env);
    let res: SessionContextResult | null = null;
    if (bin) {
      try {
        const r = await runCollect(bin, ['export', sessionId], { cwd: o.cwd || undefined, env: env as any, timeoutMs: 3_000, maxLine: 32 * 1024 * 1024 });
        if (r.exitCode === 0) res = parseOpencodeExport(r.stdout);
      } catch {
        /* fall through */
      }
    }
    if (res) sessionContextCache.set(key, { result: res, cachedAt: Date.now() });
    else sessionContextCache.delete(key);
    return res;
  }).finally(() => exportInflight.delete(key));
  exportInflight.set(key, p);
  return p;
}

export function readSessionContext(
  agent: string,
  sessionId: string,
  o: ContextOpts = {}
): SessionContextResult | null {
  const { homeDir = homedir(), cwd, env, refresh = false, cacheOnly = false } = o;
  if (!sessionId) return null;
  const cacheKey = ctxCacheKey(agent, sessionId, o);
  if (agent === 'opencode' && cacheOnly) return cacheGet(cacheKey, agent, true).result;
  if (!refresh) {
    const c = cacheGet(cacheKey, agent);
    if (c.hit) return c.result;
  }
  const miss = () => {
    sessionContextCache.delete(cacheKey);
    return null;
  };
  let res: SessionContextResult | null = null;
  try {
    if (agent === 'claude') {
      const claudeDir = env?.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
      const root = path.join(claudeDir, 'projects');
      let f: string | null = null;
      if (existsSync(root)) {
        for (const d of readdirSync(root)) {
          const c = path.join(root, d, `${sessionId}.jsonl`);
          if (existsSync(c)) {
            f = c;
            break;
          }
        }
      }
      if (!f) return miss();
      const lines = tailLines(f);
      for (let i = lines.length - 1; i >= 0; i--) {
        let j: any;
        try {
          j = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (j.type === 'user' && j.isCompactSummary) {
          const c = j.message?.content;
          const txt = typeof c === 'string' ? c : JSON.stringify(c || '');
          res = { tokens: estimateTokens(txt), exact: false, source: 'claude-compact-summary-estimate', file: f };
          break;
        }
        const u = j.type === 'assistant' && j.message?.usage;
        if (u && j.message?.model !== '<synthetic>') {
          const tokens =
            (u.input_tokens || 0) +
            (u.cache_creation_input_tokens || 0) +
            (u.cache_read_input_tokens || 0) +
            (u.output_tokens || 0);
          res = { tokens, exact: true, source: 'claude-session-file', model: j.message.model, file: f };
          break;
        }
      }
    } else if (agent === 'opencode') {
      const bin = resolveBinary('opencode', env);
      if (!bin) return miss();
      const r = spawnSync(bin, ['export', sessionId], {
        cwd: cwd || undefined,
        env: env ? { ...process.env, ...env } : undefined,
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      });
      if (r.status === 0) res = parseOpencodeExport(r.stdout || '');
    } else if (agent === 'codex') {
      const codexDir = env?.CODEX_HOME || path.join(homeDir, '.codex');
      const f = findFile(path.join(codexDir, 'sessions'), (n) => n.startsWith('rollout-') && n.endsWith(`${sessionId}.jsonl`));
      if (!f) return miss();
      const lines = tailLines(f, 800_000);
      let model: string | undefined;
      for (let i = lines.length - 1; i >= 0 && !model; i--) {
        if (lines[i].includes('"turn_context"')) {
          try {
            model = JSON.parse(lines[i]).payload?.model;
          } catch {
            /* */
          }
        }
      }
      if (!model) {
        for (const ln of tailHead(f)) {
          if (ln.includes('"turn_context"')) {
            try {
              model = JSON.parse(ln).payload?.model;
            } catch {
              /* */
            }
            if (model) break;
          }
        }
      }
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('token_count')) continue;
        let j: any;
        try {
          j = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        const info = j.payload?.info || j.info;
        const l = info?.last_token_usage;
        if (l) {
          res = {
            tokens: (l.input_tokens || 0) + (l.output_tokens || 0),
            exact: true,
            source: 'codex-session-file',
            window: info.model_context_window || null,
            model,
            file: f,
          };
          break;
        }
      }
    }
  } catch {
    /* fall through */
  }
  if (res) sessionContextCache.set(cacheKey, { result: res, cachedAt: Date.now() });
  else sessionContextCache.delete(cacheKey);
  return res;
}

/**
 * stats() without event-loop stalls: opencode context exports run async (bounded concurrency, capped per poll,
 * bounded wait) and stats() then reads only the cache. Slow exports finish in the background for the next poll.
 */
export async function statsAsync(
  o: Parameters<typeof stats>[0] & { maxExports?: number; exportBudgetMs?: number } = {}
): Promise<any> {
  const env = o.env || process.env;
  const now = o.now ?? Date.now();
  const sinceMs = o.sinceMs ?? 24 * 3600_000;
  const maxExports = o.maxExports ?? (Number(env.AGENTBRIDGE_UI_MAX_EXPORTS) || 30);
  const budget = o.exportBudgetMs ?? 2_000;
  const targets = listSessions(env, { limit: 1000 })
    .filter((x) => x.agent === 'opencode' && x.sessionId && now - (x.lastAt || 0) <= sinceMs)
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))
    .slice(0, maxExports);
  if (targets.length) {
    const all = Promise.allSettled(targets.map((x) => readSessionContextAsync('opencode', x.sessionId, { homeDir: o.homeDir, cwd: x.cwd, env })));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([all, new Promise<void>((ok) => (timer = setTimeout(ok, budget)))]);
    if (timer) clearTimeout(timer);
  }
  await new Promise<void>((ok) => setImmediate(ok));
  return stats({ ...o, cacheOnly: true });
}

export function runStatus(rec: any, { now = Date.now(), idleMs = 30_000, isAlive = alive }: { now?: number; idleMs?: number; isAlive?: (pid: number) => boolean } = {}): string {
  const st = rec.state;
  if (st === 'running') {
    if (rec.pid && !isAlive(rec.pid)) return 'lost';
    return now - rec.lastEventAt > idleMs ? 'idle' : 'active';
  }
  if (st === 'done') return 'finished';
  return st;
}

export function sessionStatus(runStatuses: string[]): 'active' | 'idle' | 'finished' {
  if (runStatuses.includes('active')) return 'active';
  if (runStatuses.includes('idle')) return 'idle';
  return 'finished';
}

const FILE_KEYS = ['file_path', 'filePath', 'path', 'notebook_path'];

export function createTracker({ agent, opts, env = process.env, origin = 'tracker' }: { agent: string; opts: any; env?: NodeJS.ProcessEnv; origin?: string }) {
  scheduleRetention(env);
  const now = Date.now();
  const rec: any = {
    id: randomUUID().slice(0, 12),
    origin,
    agent,
    requestedAgent: agent,
    effectiveAgent: agent,
    model: opts.model || null,
    cwd: opts.cwd || process.cwd(),
    pid: process.pid,
    sessionMode: opts.session?.mode || 'new',
    sessionId: opts.session?.id || null,
    state: 'running',
    startedAt: now,
    lastEventAt: now,
    endedAt: null,
    tools: { total: 0, byName: {} },
    usage: null,
    lastUsage: null,
    usageEvents: 0,
    cost: null,
    promptChars: opts.prompt.length,
    outChars: 0,
    files: [],
    error: null,
    timedOut: false,
    promptHead: opts.prompt.slice(0, 400),
    textTail: '',
  };
  const pending: Record<string, number> = {};
  const previousUsage = { input: 0, output: 0, cost: 0, hasCost: false };
  let attemptUsage = { input: 0, output: 0, cost: 0, hasCost: false };
  const publishUsage = () => {
    rec.usage = {
      input: previousUsage.input + attemptUsage.input,
      output: previousUsage.output + attemptUsage.output,
    };
    const cost = previousUsage.cost + attemptUsage.cost;
    rec.cost = previousUsage.hasCost || attemptUsage.hasCost ? cost : null;
  };
  let lastSave = 0,
    dirty = false;
  const save = (force?: boolean) => {
    if (!force && Date.now() - lastSave < 300) {
      dirty = true;
      return;
    }
    lastSave = Date.now();
    dirty = false;
    try {
      writeJson(runFile(env, rec.id), rec);
    } catch {
      /* telemetry must never break a run */
    }
  };
  save(true);
  return {
    rec,
    onEvent(e: any) {
      rec.lastEventAt = Date.now();
      if (e.type === 'session') rec.sessionId = e.id;
      else if (e.type === 'text') {
        rec.outChars += String(e.delta).length;
        rec.textTail = (rec.textTail + e.delta).slice(-3000);
      } else if (e.type === 'usage') {
        rec.usageEvents++;
        rec.lastUsage = { input: e.input || 0, output: e.output || 0 };
        if (e.incremental) {
          attemptUsage.input += e.input || 0;
          attemptUsage.output += e.output || 0;
          if (typeof e.cost === 'number') {
            attemptUsage.cost += e.cost;
            attemptUsage.hasCost = true;
          }
        } else {
          attemptUsage = {
            input: e.input || 0,
            output: e.output || 0,
            cost: e.cost || 0,
            hasCost: typeof e.cost === 'number',
          };
        }
        publishUsage();
      } else if (e.type === 'fallback') {
        previousUsage.input += attemptUsage.input;
        previousUsage.output += attemptUsage.output;
        previousUsage.cost += attemptUsage.cost;
        previousUsage.hasCost ||= attemptUsage.hasCost;
        attemptUsage = { input: 0, output: 0, cost: 0, hasCost: false };
        publishUsage();
      } else if (e.type === 'tool') {
        if (e.output === undefined || !pending[e.name]) {
          rec.tools.total++;
          rec.tools.byName[e.name] = (rec.tools.byName[e.name] || 0) + 1;
          if (e.output === undefined) pending[e.name] = (pending[e.name] || 0) + 1;
        } else pending[e.name]--;
        if (e.input && typeof e.input === 'object') {
          for (const k of FILE_KEYS) {
            const v = e.input[k];
            if (typeof v === 'string' && v && !rec.files.includes(v) && rec.files.length < 40) rec.files.push(v);
          }
        }
      }
      save(e.type === 'session' || e.type === 'usage');
    },
    finish({ result, error }: { result?: any; error?: any } = {}) {
      rec.endedAt = Date.now();
      if (result) {
        rec.state = result.timedOut ? 'timeout' : 'done';
        rec.timedOut = !!result.timedOut;
        rec.sessionId = result.sessionId ?? rec.sessionId;
        rec.model = result.model ?? rec.model;
        if (result.usage) {
          rec.usage = { input: result.usage.input ?? rec.usage?.input ?? 0, output: result.usage.output ?? rec.usage?.output ?? 0 };
          if (typeof result.usage.cost === 'number') rec.cost = result.usage.cost;
        }
        if (result.text && !rec.textTail) rec.textTail = String(result.text).slice(-3000);
        if (result.fallback?.used) {
          rec.effectiveAgent = result.fallback.used;
          rec.agent = result.fallback.used;
          rec.fallback = {
            used: result.fallback.used,
            attempts: (result.fallback.attempts || []).map((a: any) => ({ agent: a.agent, code: a.code })),
          };
        }
      } else {
        rec.state = error?.code === 'TIMEOUT' ? 'timeout' : error?.code === 'ABORTED' ? 'cancelled' : 'error';
        rec.timedOut = rec.state === 'timeout';
        rec.error = `${error?.code ? error.code + ': ' : ''}${error?.message || error}`;
      }
      save(true);
      if (rec.sessionId && rec.sessionMode !== 'ephemeral') {
        const eff = rec.effectiveAgent || rec.fallback?.used || rec.agent;
        const slow = eff === 'opencode'; // its context read is a subprocess: never block the caller's event loop on it
        try {
          foldIntoSession(rec, env, slow);
        } catch {
          /* ignore */
        }
        if (slow) {
          readSessionContextAsync(eff, rec.sessionId, { env, cwd: rec.cwd, refresh: true })
            .then(() => foldIntoSession(rec, env, true))
            .catch(() => {});
        }
      }
      return rec;
    },
    flush() {
      if (dirty) save(true);
    },
  };
}

function withLock<T>(lockPath: string, fn: () => T): T {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const t0 = Date.now();
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx');
      break;
    } catch (e: any) {
      if (e.code !== 'EEXIST' && e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 15_000) unlinkSync(lockPath);
      } catch {
        /* raced */
      }
      if (Date.now() - t0 > 20_000) throw new Error('session lock timeout');
      sleep(10 + Math.random() * 30);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (fd !== null) closeSync(fd);
    } catch {
      /* */
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* */
    }
  }
}

function foldIntoSession(run: any, env: NodeJS.ProcessEnv, cacheOnly = false): any {
  const effectiveAgent = run.effectiveAgent || run.fallback?.used || run.agent;
  const f = sessionFile(env, effectiveAgent, run.sessionId);
  return withLock(`${f}.lock`, () => foldLocked(run, env, f, cacheOnly));
}

function foldLocked(run: any, env: NodeJS.ProcessEnv, f: string, cacheOnly = false): void {
  const effectiveAgent = run.effectiveAgent || run.fallback?.used || run.agent;
  const s = readJson(f) || {
    agent: effectiveAgent,
    requestedAgent: run.requestedAgent || run.agent,
    effectiveAgent,
    sessionId: run.sessionId,
    firstAt: run.startedAt,
    runIds: [],
    runCount: 0,
    toolCalls: 0,
    toolsByName: {},
    cost: null,
    runningMs: 0,
    files: [],
    firstPrompt: run.promptHead,
  };
  s.agent = effectiveAgent;
  s.effectiveAgent = effectiveAgent;
  if (!s.requestedAgent) s.requestedAgent = run.requestedAgent || run.agent;
  s.model = run.model || s.model;
  s.cwd = run.cwd;
  s.lastAt = run.endedAt || Date.now();
  if (!s.runIds.includes(run.id)) {
    s.runIds = [...s.runIds, run.id].slice(-30);
    s.runCount++;
    s.toolCalls += run.tools.total;
    s.runningMs += (run.endedAt || Date.now()) - run.startedAt;
    for (const [k, v] of Object.entries(run.tools.byName)) s.toolsByName[k] = (s.toolsByName[k] || 0) + (v as number);
    if (run.cost != null) s.cost = (s.cost || 0) + run.cost;
    for (const x of run.files) if (!s.files.includes(x) && s.files.length < 60) s.files.push(x);
    s.lastText = run.textTail;
    s.lastPrompt = run.promptHead;
  }
  s.lastRun = { id: run.id, state: run.state };
  s.ctx = computeCtx(effectiveAgent, run.sessionId, run, s, env, undefined, cacheOnly, run.cwd);
  writeJson(f, s);
}

function computeCtx(agent: string, sessionId: string, run: any, s: any, env: NodeJS.ProcessEnv, homeDir?: string, cacheOnly = false, cwd?: string): any {
  const file = readSessionContext(agent, sessionId, { homeDir, env, cwd, refresh: !cacheOnly, cacheOnly });
  if (file) return { tokens: file.tokens, exact: file.exact, source: file.source, window: file.window || null, at: Date.now() };
  if (run?.lastUsage) {
    const u = run.lastUsage,
      t = u.input + u.output;
    if ((agent === 'opencode' || agent === 'agy' || agent === 'pi') && run.usageEvents > 0)
      return { tokens: t, exact: true, source: 'usage-event-last-step', at: Date.now() };
    return { tokens: t, exact: false, source: 'usage-aggregate', at: Date.now() };
  }
  const chars = (run?.promptChars || 0) + (run?.outChars || 0);
  return { tokens: Math.max(estimateTokens('x'.repeat(chars)), s?.ctx?.tokens || 0), exact: false, source: 'chars/4', at: Date.now() };
}

export function listSessions(env: NodeJS.ProcessEnv = process.env, { limit = 200, offset = 0 }: { limit?: number; offset?: number } = {}): any[] {
  let names: string[] = [];
  const dir = sub(env, 'sessions');
  try {
    names = (readdirSync(dir) as string[]).filter((n: string) => n.endsWith('.json'));
  } catch {
    /* none */
  }
  names.sort((a, b) => b.localeCompare(a));
  return names.slice(offset, offset + limit).map((n) => readJson(path.join(dir, n))).filter(Boolean);
}

export function listTrackedRuns(
  env: NodeJS.ProcessEnv = process.env,
  { limit = 200, offset = 0, pruneMax = 500 }: { limit?: number; offset?: number; pruneMax?: number } = {}
): any[] {
  let names: string[] = [];
  const dir = sub(env, 'runs');
  try {
    names = (readdirSync(dir) as string[]).filter((n: string) => n.endsWith('.json'));
  } catch {
    /* none */
  }
  if (names.length > pruneMax) {
    try {
      const statsList = names.map((n) => ({ name: n, mtime: statSync(path.join(dir, n)).mtimeMs }));
      statsList.sort((a, b) => a.mtime - b.mtime);
      const toDelete = statsList.slice(0, names.length - pruneMax);
      for (const item of toDelete) {
        try { unlinkSync(path.join(dir, item.name)); } catch {}
      }
      names = (readdirSync(dir) as string[]).filter((n: string) => n.endsWith('.json'));
    } catch {
      /* ignore */
    }
  }
  names.sort((a, b) => b.localeCompare(a));
  return names.slice(offset, offset + limit).map((n) => readJson(path.join(dir, n))).filter(Boolean);
}

export function loadTrackedRun(id: string, env: NodeJS.ProcessEnv = process.env): any {
  return readJson(runFile(env, id));
}

function ctxView(s: any, { env, homeDir, windows, refresh = false, cacheOnly = false }: { env: NodeJS.ProcessEnv; homeDir?: string; windows?: any; refresh?: boolean; cacheOnly?: boolean }): any {
  let ctx = s.ctx;
  let realModel: string | null = null;
  const f = readSessionContext(s.agent, s.sessionId, { homeDir, cwd: s.cwd, env, refresh, cacheOnly });
  if (f) {
    realModel = f.model || null;
    ctx = { tokens: f.tokens, exact: f.exact, source: f.source, window: f.window || null, at: Date.now() };
  }
  if (!s.model || s.model === 'default') s = { ...s, model: realModel || s.model };
  const w = ctx?.window && !windows?.[s.agent] ? { tokens: ctx.window, source: 'session-file' } : windowFor(s.agent, s.model, windows);
  let win = w.tokens,
    wsrc = w.source;
  const isOverflow = ctx && win > 0 && ctx.tokens > win;
  if (isOverflow && wsrc !== 'override') {
    wsrc += '+observed>window';
  }
  const tokens = ctx?.tokens ?? 0;
  return {
    sessionId: s.sessionId,
    agent: s.agent,
    model: s.model || null,
    tokens,
    exact: !!ctx?.exact,
    source: ctx?.source || 'none',
    window: win,
    windowSource: wsrc,
    pct: win ? +(tokens / win).toFixed(4) : null,
    overflow: !!isOverflow,
    measuredAt: ctx?.at || null,
  };
}

export function contextOf(
  sessionId: string,
  { agent, env = process.env, homeDir, windows, refresh = false }: { agent?: string; env?: NodeJS.ProcessEnv; homeDir?: string; windows?: any; refresh?: boolean } = {}
): any {
  const cfg = { ...(loadConfig(env).windows || {}), ...(windows || {}) };
  let s = listSessions(env).find((x) => x.sessionId === sessionId && (!agent || x.agent === agent));
  if (!s) {
    const cands = agent ? [agent] : ['claude', 'codex'];
    for (const a of cands) {
      const f = readSessionContext(a, sessionId, { homeDir, env, refresh });
      if (f)
        s = {
          agent: a,
          sessionId,
          model: f.model || null,
          ctx: { tokens: f.tokens, exact: f.exact, source: f.source, window: f.window, at: Date.now() },
        };
      if (s) break;
    }
    if (!s) {
      const b = listRuns(env).find((r) => r.sessionId === sessionId && (!agent || r.agent === agent));
      if (b)
        s = {
          agent: b.agent,
          sessionId,
          model: b.model,
          ctx: b.usage ? { tokens: (b.usage.input || 0) + (b.usage.output || 0), exact: false, source: 'usage-aggregate', at: b.endedAt || Date.now() } : null,
        };
    }
  }
  return s ? ctxView(s, { env, homeDir, windows: cfg, refresh }) : null;
}

export function stats({
  env = process.env,
  homeDir,
  idleMs = 30_000,
  sinceMs = 24 * 3600_000,
  windows,
  persist = true,
  now = Date.now(),
  runLimit = 200,
  cacheOnly = false,
}: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  idleMs?: number;
  sinceMs?: number;
  windows?: any;
  persist?: boolean;
  now?: number;
  runLimit?: number;
  /** Never spawn subprocesses for session context (opencode): use cached/stored values only. */
  cacheOnly?: boolean;
} = {}): any {
  const cfg = { ...(loadConfig(env).windows || {}), ...(windows || {}) };
  const tracked = listTrackedRuns(env);
  const seen = new Set(tracked.map((r) => r.id));
  const bridge = listRuns(env)
    .filter((r) => !seen.has(r.id))
    .map((r) => ({
      id: r.id,
      agent: r.agent,
      model: r.model,
      cwd: r.cwd,
      pid: r.pid,
      sessionId: r.sessionId,
      state: r.state === 'done' ? 'done' : r.state,
      startedAt: r.startedAt,
      lastEventAt: r.lastEventAt,
      endedAt: r.endedAt,
      tools: { total: (r.events || []).filter((e) => e.type === 'tool').length, byName: {}, partial: true },
      usage: r.usage,
      cost: r.usage?.cost ?? null,
      error: r.error,
      origin: 'bridge',
    }));
  const runs = [...tracked, ...bridge]
    .map((r: any) => {
      const status = runStatus(r, { now, idleMs });
      return {
        id: r.id,
        agent: r.agent,
        model: r.model,
        sessionId: r.sessionId,
        status,
        origin: r.origin || 'tracker',
        startedAt: r.startedAt,
        elapsedMs: (r.endedAt || now) - r.startedAt,
        lastEventAgoMs: r.endedAt ? null : now - r.lastEventAt,
        toolCalls: r.tools?.total ?? 0,
        toolCallsPartial: !!r.tools?.partial,
        toolsByName: r.tools?.byName || {},
        usage: r.usage || null,
        cost: r.cost ?? null,
        error: r.error || null,
        endedAt: r.endedAt || null,
        cwd: r.cwd || null,
        fallback: r.fallback || null,
      };
    })
    .sort((a, b) => b.startedAt - a.startedAt);

  const bySession = new Map<string, any>();
  for (const s of listSessions(env)) bySession.set(`${s.agent}/${s.sessionId}`, s);
  for (const r of runs) {
    if (r.sessionId && r.origin === 'bridge' && !bySession.has(`${r.agent}/${r.sessionId}`))
      bySession.set(`${r.agent}/${r.sessionId}`, {
        agent: r.agent,
        sessionId: r.sessionId,
        model: r.model,
        lastAt: r.startedAt + r.elapsedMs,
        runCount: 1,
        toolCalls: r.toolCalls,
        cost: r.cost,
        runningMs: r.elapsedMs,
        ctx: r.usage ? { tokens: (r.usage.input || 0) + (r.usage.output || 0), exact: false, source: 'usage-aggregate' } : null,
      });
  }
  for (const r of runs) {
    if (r.sessionId && !bySession.has(`${r.agent}/${r.sessionId}`) && (r.status === 'active' || r.status === 'idle'))
      bySession.set(`${r.agent}/${r.sessionId}`, {
        agent: r.agent,
        sessionId: r.sessionId,
        model: r.model,
        lastAt: now,
        runCount: 0,
        toolCalls: 0,
        runningMs: 0,
        ctx: null,
      });
  }

  const sessions = [...bySession.values()]
    .filter((s) => now - (s.lastAt || 0) <= sinceMs || runs.some((r) => r.sessionId === s.sessionId && (r.status === 'active' || r.status === 'idle')))
    .map((s) => {
      const c = ctxView(s, { env, homeDir, windows: cfg, cacheOnly });
      const mine = runs.filter((r) => r.sessionId === s.sessionId && r.agent === s.agent);
      const status = sessionStatus(mine.map((r) => r.status));
      return {
        ...c,
        status,
        runs: s.runCount || mine.length,
        toolCalls: s.toolCalls || 0,
        runningMs: s.runningMs || 0,
        cost: s.cost ?? null,
        lastAt: s.lastAt || null,
        cwd: s.cwd || null,
        files: (s.files || []).length,
      };
    })
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));

  const agentsAgg: Record<string, any> = {};
  for (const s of sessions) {
    const a = (agentsAgg[s.agent] ||= {
      sessions: 0,
      contextTokens: 0,
      exactTokens: 0,
      estimatedTokens: 0,
      windowTokens: 0,
      active: 0,
      toolCalls: 0,
      cost: null,
      runs: 0,
    });
    a.sessions++;
    a.contextTokens += s.tokens;
    s.exact ? (a.exactTokens += s.tokens) : (a.estimatedTokens += s.tokens);
    a.windowTokens += s.window || 0;
    if (s.status === 'active') a.active++;
    a.toolCalls += s.toolCalls;
    a.runs += s.runs;
    if (s.cost != null) a.cost = (a.cost || 0) + s.cost;
  }
  for (const a of Object.values(agentsAgg)) a.pct = a.windowTokens ? +(a.contextTokens / a.windowTokens).toFixed(4) : null;
  const total = sessions.reduce(
    (t, s) => ({ tokens: t.tokens + s.tokens, exact: t.exact + (s.exact ? s.tokens : 0), est: t.est + (s.exact ? 0 : s.tokens), win: t.win + (s.window || 0) }),
    { tokens: 0, exact: 0, est: 0, win: 0 }
  );
  const hot = sessions.filter((s) => s.pct != null && s.pct >= 0.7).sort((a, b) => b.pct - a.pct);
  const hot0 = [...sessions].filter((s) => s.pct != null).sort((a, b) => b.pct - a.pct)[0];
  const global = {
    contextTokens: total.tokens,
    exactTokens: total.exact,
    estimatedTokens: total.est,
    allExact: total.est === 0,
    windowTokens: total.win,
    maxPct: hot0 ? hot0.pct : 0,
    maxPctSession: hot0 ? { agent: hot0.agent, sessionId: hot0.sessionId } : null,
    sessions: sessions.length,
    activeRuns: runs.filter((r) => r.status === 'active').length,
    idleRuns: runs.filter((r) => r.status === 'idle').length,
    cost: sessions.some((s) => s.cost != null) ? sessions.reduce((c, s) => c + (s.cost || 0), 0) : null,
    advice: hot.map((s) => `${s.agent}/${s.sessionId} at ${(s.pct * 100).toFixed(0)}% of window: compact or handoff to an agent with more headroom`),
  };
  const out = { generatedAt: now, sinceMs, global, agents: agentsAgg, sessions, runs: runs.slice(0, runLimit) };
  if (persist) {
    try {
      writeJson(path.join(telemetryDir(env), 'stats.json'), out);
    } catch {
      /* ignore */
    }
  }
  return out;
}
