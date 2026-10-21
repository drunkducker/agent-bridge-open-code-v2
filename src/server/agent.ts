// Agent mode of the proxy
import { realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createSandboxAsync, gitAsync, Sandbox } from '../extras/worktree.js';
import { HttpError, rid, sendJson } from './common.js';
import { permRank } from './config.js';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
/** A run whose changes were applied is dropped this long after the last activity on it. */
const APPLIED_GRACE_MS = 2 * 60 * 1000;

/** Effective run TTL: AGENTBRIDGE_AGENT_TTL_MS (test hook) wins, else config agentRunTtlMinutes, else 30 minutes. */
export function agentTtlMs(opts?: any): number {
  const env = Number(process.env.AGENTBRIDGE_AGENT_TTL_MS);
  if (env > 0) return env;
  const m = Number(opts?.cfg?.get?.()?.agentRunTtlMinutes);
  return m > 0 ? m * 60_000 : DEFAULT_TTL_MS;
}
const INLINE_DIFF_MAX = 256 * 1024;

export interface AgentRunRecord {
  id: string;
  sandbox: Sandbox;
  origin: string;
  agentRoot?: string;
  permissions?: string;
  created: number;
  last: number;
  applied: boolean;
  /** Set on apply; cleared when the run is reused. Applied runs stop counting toward the cap and expire sooner. */
  appliedAt?: number;
  /** false once a finished request proved the sandbox has no changes; true (unknown) otherwise. */
  dirty?: boolean;
  applying?: boolean;
  busy?: number;
}

export interface AgentStore {
  runs: Map<string, AgentRunRecord>;
  bySession: Map<string, string>;
  /** Sandboxes being created right now, keyed per x-ab-session (or unique per request). Each one holds a slot. */
  pending: Map<string, Promise<AgentRunRecord>>;
  /** Per-store sweeper timer: every store (default and per-proxy alike) must be swept and disposed on its own. */
  sweeper?: NodeJS.Timeout;
}

export function createAgentStore(): AgentStore {
  return {
    runs: new Map<string, AgentRunRecord>(),
    bySession: new Map<string, string>(),
    pending: new Map<string, Promise<AgentRunRecord>>(),
  };
}

const defaultStore: AgentStore = createAgentStore();
export const runs = defaultStore.runs;
export const bySession = defaultStore.bySession;

export function getStore(opts?: any): AgentStore {
  return opts?.agentStore || defaultStore;
}

export function sweep(store: AgentStore = defaultStore, ttlMs: number = agentTtlMs()) {
  const t = Date.now();
  for (const [id, r] of store.runs) {
    if (r.busy || r.applying) continue;
    if (r.last < t - ttlMs || (r.appliedAt && Math.max(r.appliedAt, r.last) < t - Math.min(APPLIED_GRACE_MS, ttlMs))) drop(id, store);
  }
}
export function drop(id: string, store: AgentStore = defaultStore, sync = false) {
  const r = store.runs.get(id);
  if (!r) return;
  store.runs.delete(id);
  for (const [k, v] of store.bySession) {
    if (v === id) store.bySession.delete(k);
  }
  try {
    if (sync) r.sandbox.cleanup();
    else r.sandbox.cleanupAsync().catch(() => {});
  } catch {
    /* best effort */
  }
}
export function ensureSweeper(store: AgentStore = defaultStore, opts?: any): void {
  if (!store.sweeper) {
    store.sweeper = setInterval(() => sweep(store, agentTtlMs(opts)), 60_000);
    store.sweeper.unref();
  }
}
/** Remove every sandbox (server shutdown / tests). Always stops the store's own sweeper timer. */
export function disposeAgentRuns(store?: AgentStore): void {
  const s = store || defaultStore;
  for (const id of [...s.runs.keys()]) drop(id, s, true);
  if (s.sweeper) {
    clearInterval(s.sweeper);
    s.sweeper = undefined;
  }
}

const real = (p: string) => {
  try {
    return realpathSync(path.resolve(p));
  } catch {
    return null;
  }
};
const inside = (root: string, p: string) => {
  const r = path.relative(root, p);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

export interface AgentSettingsResult {
  origin: string;
  permissions: string;
}

/** Throws the right HTTP error when agent mode is not allowed; returns the validated settings. */
export function agentSettings(req: any, opts: any): AgentSettingsResult {
  const c = opts.cfg.get();
  if (!c.agentRoot) {
    throw new HttpError(
      403,
      'Agent mode is disabled. Start the proxy with --agent-root <folder> (and --token) to enable it.',
      'permission_error',
      'agent_mode_disabled'
    );
  }
  if (!opts.token) {
    throw new HttpError(
      403,
      'Agent mode requires the proxy to run with --token (the agents can edit files and run commands).',
      'permission_error',
      'agent_mode_needs_token'
    );
  }
  const root = real(c.agentRoot);
  if (!root || !existsSync(root)) {
    throw new HttpError(500, `agentRoot "${c.agentRoot}" does not exist`, 'api_error', 'agent_root_missing');
  }
  const want = req.headers['x-ab-cwd'];
  const origin = real(path.resolve(root, typeof want === 'string' && want.trim() ? want.trim() : '.'));
  if (!origin || !inside(root, origin)) {
    throw new HttpError(
      403,
      'x-ab-cwd must be an existing folder inside the proxy agent root',
      'permission_error',
      'cwd_outside_agent_root'
    );
  }
  const ceiling = c.maxPermission;
  const rp = req.headers['x-ab-permissions'];
  const permissions =
    typeof rp === 'string' && rp.trim() ? rp.trim() : permRank('edit') <= permRank(ceiling) ? 'edit' : ceiling;
  if (permRank(permissions) < 0) {
    throw new HttpError(400, `x-ab-permissions must be one of read-only|plan|edit|full`, 'invalid_request_error', 'bad_permissions');
  }
  if (permRank(permissions) > permRank(ceiling)) {
    throw new HttpError(
      403,
      `Requested permissions "${permissions}" exceed the proxy ceiling "${ceiling}"`,
      'permission_error',
      'permissions_exceed_ceiling'
    );
  }
  return { origin, permissions };
}

export interface PreparedAgentRun {
  run: AgentRunRecord;
  cwd: string;
  permissions: string;
}

/** Runs that hold a slot: busy ones and everything not yet applied. Applied/deleted runs free theirs. */
const counts = (r: AgentRunRecord) => Boolean(r.busy) || !r.appliedAt;

/**
 * Reserve a slot for a new sandbox or throw 429. Only idle runs known to hold no changes and no x-ab-session may
 * be evicted to make room; a run with an unapplied diff (or unknown state) is never touched.
 */
function reserveSlot(store: AgentStore, max: number, ttlMs: number): void {
  if (!(max > 0)) return;
  const used = () => [...store.runs.values()].filter(counts).length + store.pending.size;
  if (used() < max) return;
  const bound = new Set(store.bySession.values());
  const evictable = [...store.runs.values()]
    .filter((r) => !r.busy && !r.applying && r.dirty === false && !r.appliedAt && !bound.has(r.id))
    .sort((a, b) => a.last - b.last);
  for (const r of evictable) {
    drop(r.id, store);
    if (used() < max) return;
  }
  const now = Date.now();
  const busy = [...store.runs.values()].some((r) => r.busy);
  const soonest = Math.min(...[...store.runs.values()].map((r) => r.last + ttlMs - now), Infinity);
  const retry = busy ? 10 : Math.min(600, Math.max(10, Math.ceil(soonest / 1000)));
  throw new HttpError(
    429,
    `Agent run limit reached (${max} sandboxes hold work or are running). Apply or DELETE finished runs at /agent/runs, or raise --agent-max-runs (0 = unlimited).`,
    'rate_limit_error',
    'agent_runs_limit',
    retry
  );
}

/** Sandbox for this request: reused for the same x-ab-session, else a fresh one (never blocks the event loop). */
export async function prepareAgentRun(req: any, opts: any, sessionKey?: string): Promise<PreparedAgentRun> {
  const store = getStore(opts);
  ensureSweeper(store, opts);
  const { origin, permissions } = agentSettings(req, opts);
  const mismatch = () =>
    new HttpError(
      400,
      'This session already works in another folder; start a new x-ab-session',
      'invalid_request_error',
      'session_cwd_mismatch'
    );
  let r = sessionKey ? store.runs.get(store.bySession.get(sessionKey)!) : undefined;
  if (r && r.origin !== origin) throw mismatch();
  if (!r) {
    const pkey = sessionKey ? `s:${sessionKey}` : `r:${rid('')}`;
    let p = sessionKey ? store.pending.get(pkey) : undefined;
    if (p) {
      // Another request of this session is creating the sandbox right now: share it.
      r = await p;
      if (r.origin !== origin) throw mismatch();
    } else {
      reserveSlot(store, Number(opts?.cfg?.get?.()?.agentMaxRuns ?? 8), agentTtlMs(opts));
      const c = opts?.cfg?.get?.() || {};
      p = (async () => {
        let sandbox: Sandbox;
        try {
          sandbox = await createSandboxAsync(origin);
        } catch (e: any) {
          throw new HttpError(500, `Cannot create the sandbox: ${e.message}`, 'api_error', 'sandbox_failed');
        }
        const rec: AgentRunRecord = {
          id: rid('run_'),
          sandbox,
          origin,
          agentRoot: real(c.agentRoot) || origin,
          permissions,
          created: Date.now(),
          last: Date.now(),
          applied: false,
          dirty: true,
          busy: 0,
        };
        store.runs.set(rec.id, rec);
        if (sessionKey) store.bySession.set(sessionKey, rec.id);
        return rec;
      })();
      store.pending.set(pkey, p);
      const clear = () => store.pending.delete(pkey);
      p.then(clear, clear);
      r = await p;
    }
  }
  r.last = Date.now();
  r.appliedAt = undefined; // reused: it is live work again, not a finished run
  r.busy = (r.busy || 0) + 1;
  return { run: r, cwd: r.sandbox.cwd, permissions };
}

/** After the agent finished: what it changed. */
export async function finishAgentRun(ctx: PreparedAgentRun): Promise<any> {
  const r = ctx.run;
  r.busy = Math.max(0, (r.busy || 1) - 1);
  r.last = Date.now();
  let d = { diff: '', files: [] as string[] };
  try {
    d = await r.sandbox.diffAsync(Boolean(r.busy));
    if (!r.busy) r.dirty = d.files.length > 0 || Boolean(d.diff.trim());
  } catch {
    /* sandbox gone */
  }
  r.last = Date.now();
  const big = d.diff.length > INLINE_DIFF_MAX;
  return {
    runId: r.id,
    mode: r.sandbox.mode,
    filesChanged: d.files,
    ...(big ? { diffOmitted: true, diffBytes: d.diff.length } : { diff: d.diff }),
    diffUrl: `/agent/runs/${r.id}/diff`,
    applyUrl: `/agent/runs/${r.id}/apply`,
  };
}

export function abortAgentRun(ctx?: PreparedAgentRun): void {
  if (ctx?.run) {
    ctx.run.busy = Math.max(0, (ctx.run.busy || 1) - 1);
    ctx.run.last = Date.now();
  }
}

const topOf = async (dir: string): Promise<string | null> => {
  try {
    return (await gitAsync(dir, ['rev-parse', '--show-toplevel'], { noConfig: true })).trim();
  } catch {
    return null;
  }
};
const gitApply = (cwd: string, args: string[], input: string) =>
  gitAsync(cwd, ['apply', '--whitespace=nowarn', ...args, '-'], { input, noConfig: true });

/** Routes: GET /agent/runs, GET /agent/runs/:id, GET .../diff, POST .../apply, DELETE /agent/runs/:id. */
export async function handleAgentRoutes(req: any, res: any, url: string, opts?: any): Promise<boolean> {
  const m = /^\/agent\/runs(?:\/([A-Za-z0-9_]+)(?:\/(diff|apply))?)?$/.exec(url);
  if (!m) return false;
  const store = getStore(opts);
  const [, id, action] = m;
  const meta = (r: AgentRunRecord) => ({
    runId: r.id,
    mode: r.sandbox.mode,
    origin: r.origin,
    created: Math.floor(r.created / 1000),
    applied: r.applied,
  });
  if (!id) {
    if (req.method !== 'GET') throw new HttpError(405, 'Use GET', 'invalid_request_error', 'method_not_allowed');
    sendJson(res, 200, { runs: [...store.runs.values()].map(meta) });
    return true;
  }
  const r = store.runs.get(id);
  if (!r) throw new HttpError(404, `Unknown or expired run ${id}`, 'invalid_request_error', 'run_not_found');
  r.last = Date.now();
  if (!action && req.method === 'GET') {
    const d = await r.sandbox.diffAsync(Boolean(r.busy));
    sendJson(res, 200, { ...meta(r), filesChanged: d.files });
    return true;
  }
  if (!action && req.method === 'DELETE') {
    if ((r.busy && r.busy > 0) || r.applying) {
      throw new HttpError(409, 'Cannot delete sandbox while agent run is active', 'invalid_request_error', 'sandbox_busy');
    }
    drop(id, store);
    sendJson(res, 200, { deleted: id });
    return true;
  }
  if (action === 'diff' && req.method === 'GET') {
    const d = await r.sandbox.diffAsync(Boolean(r.busy));
    res.writeHead(200, { 'content-type': 'text/x-diff; charset=utf-8' });
    res.end(d.diff);
    return true;
  }
  if (action === 'apply' && req.method === 'POST') {
    if (r.busy && r.busy > 0) throw new HttpError(409, 'The agent is still running in this sandbox', 'invalid_request_error', 'run_busy');
    if (r.applying) throw new HttpError(409, 'An apply is already in progress for this run', 'invalid_request_error', 'apply_in_progress');
    r.applying = true;
    try {
    const d = await r.sandbox.diffAsync();
    if (!d.diff.trim()) {
      sendJson(res, 200, { runId: id, applied: false, filesChanged: [], reason: 'no changes' });
      return true;
    }
    const effectiveRoot = r.agentRoot || r.origin;
    for (const f of d.files) {
      const full = path.resolve(r.origin, f);
      if (!inside(effectiveRoot, full) || !inside(r.origin, full)) {
        throw new HttpError(
          403,
          `Refusing to apply patch: modified file "${f}" is outside authorized agent root`,
          'permission_error',
          'diff_outside_agent_root'
        );
      }
    }
    for (const line of d.diff.split('\n')) {
      if (line.startsWith('--- a/') || line.startsWith('+++ b/')) {
        const p = line.slice(6).trim();
        if (p.includes('..') || path.isAbsolute(p)) {
          throw new HttpError(
            403,
            `Refusing to apply patch: path traversal detected in patch header "${p}"`,
            'permission_error',
            'diff_path_traversal'
          );
        }
      }
    }
    const cwd = (await topOf(r.origin)) || r.origin;
    try {
      await gitApply(cwd, ['--check'], d.diff);
      await gitApply(cwd, [], d.diff);
    } catch (e: any) {
      throw new HttpError(
        409,
        `The changes do not apply cleanly to ${r.origin}: ${String(e.stderr || e.message).trim().slice(0, 500)}`,
        'invalid_request_error',
        'apply_conflict'
      );
    }
    r.applied = true;
    r.appliedAt = Date.now();
    r.last = Date.now();
    sendJson(res, 200, { runId: id, applied: true, filesChanged: d.files, target: cwd });
    return true;
    } finally {
      r.applying = false;
    }
  }
  throw new HttpError(405, 'Method not allowed for this route', 'invalid_request_error', 'method_not_allowed');
}

export interface WithAgentModeResult {
  o: any;
  headers: Record<string, string>;
  finish: () => Promise<any> | any;
  abort: () => void;
}

export async function withAgentMode(o: any, req: any, opts: any): Promise<WithAgentModeResult> {
  if (o.target.mode !== 'agent') return { o, headers: {}, finish: () => null, abort() {} };
  const ctx = await prepareAgentRun(req, opts, o.sessionKey);
  let settled = false;
  return {
    o: {
      ...o,
      mode: 'agent',
      cwd: ctx.cwd,
      permissions: ctx.permissions,
      timeoutMs: opts.agentTimeoutMs || 20 * 60 * 1000,
    },
    headers: { 'x-agentbridge-run': ctx.run.id },
    finish() {
      if (settled) return null;
      settled = true;
      return finishAgentRun(ctx);
    },
    abort() {
      if (!settled) {
        settled = true;
        abortAgentRun(ctx);
      }
    },
  };
}
