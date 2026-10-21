// Async run registry: ~/.agentbridge/runs/<id>.json (override root with AGENTBRIDGE_HOME). Also backs telemetry later.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pruneDir, envNum, type PruneResult } from '../core/retention.js';

export interface RunEventItem {
  t: number;
  type: string;
  delta?: string;
  message?: string;
  name?: string;
  input?: string;
  output?: string;
  error?: string;
}

export interface SubagentEntry {
  id: string;
  name: string;
  parentId?: string | null;
  parentToolId?: string | null;
  task?: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: number;
  endedAt?: number | null;
  tokens?: { input?: number; output?: number };
}

export interface RunRecord {
  id: string;
  key: string | null;
  promptHash: string;
  root: string;
  pid: number;
  childPid: number | null;
  agent: string;
  model: string | null;
  cwd: string;
  state: 'running' | 'done' | 'error' | 'cancelled' | 'lost';
  startedAt: number;
  lastEventAt: number;
  endedAt: number | null;
  usage: any | null;
  sessionId: string | null;
  events: RunEventItem[];
  lastTool?: RunEventItem;
  result: any | null;
  error: string | null;
  keep?: boolean;
  cancelRequested?: boolean;
  subagents?: SubagentEntry[];
  phase?: 'waiting_quota';
  quotaWait?: {
    agent: string;
    message: string;
    threshold: number;
    remainingPercent?: number;
    resetAt?: number;
    nextCheckAt?: number;
    candidates?: Array<{ agent: string; threshold?: number; remainingPercent?: number; resetAt?: number }>;
  };
}

interface LiveRun {
  ac: AbortController;
  done: Promise<any>;
  rec: RunRecord;
  runsDir: string;
}

const live = new Map<string, LiveRun>(); // id -> { ac, done, rec }
export const home = (env: NodeJS.ProcessEnv = process.env): string => env.AGENTBRIDGE_HOME || path.join(homedir(), '.agentbridge');
export const runsDir = (env: NodeJS.ProcessEnv = process.env): string => path.join(home(env), 'runs');
const normalizedRunsDir = (env: NodeJS.ProcessEnv): string => {
  const dir = path.resolve(runsDir(env));
  return process.platform === 'win32' ? dir.toLowerCase() : dir;
};
const idemDir = (env: NodeJS.ProcessEnv): string => path.join(home(env), 'idem');
const ctl = (env: NodeJS.ProcessEnv, id: string, ext: string): string => path.join(runsDir(env), `${id}.${ext}`);
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sha = (s: unknown): string => createHash('sha256').update(String(s)).digest('hex');
const terminal = (s: string): boolean => s === 'done' || s === 'error' || s === 'cancelled' || s === 'lost';
const SNIPPET_MAX = 200;
const ansi = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
function snippet(value: unknown): string {
  let text: string;
  try {
    if (value instanceof Error) text = value.message;
    else if (typeof value === 'string') text = value;
    else if (value && typeof value === 'object') {
      const content = Array.isArray(value) ? value : Array.isArray((value as any).content) ? (value as any).content : null;
      const textBlocks = content?.filter((part: any) => part && part.type === 'text' && typeof part.text === 'string');
      if (textBlocks?.length) text = textBlocks.map((part: any) => part.text).join(' ');
      else {
        const seen = new WeakSet<object>();
        text = JSON.stringify(value, (_key, item) => {
          if (typeof item === 'string') return item.replace(ansi, '').replace(controls, ' ');
          if (item && typeof item === 'object') {
            if (seen.has(item)) return '[Circular]';
            seen.add(item);
          }
          return item;
        }) ?? String(value);
      }
    } else text = String(value ?? '');
  } catch { text = '[unavailable]'; }
  return text.replace(ansi, '').replace(controls, ' ').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX);
}
const rootOf = (env: NodeJS.ProcessEnv): string => env.AGENTBRIDGE_ROOT || 'local';
const rm = (f: string): void => { try { unlinkSync(f); } catch { /* ignore */ } };
const nap = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const clearQuotaWait = (rec: RunRecord): void => { delete rec.phase; delete rec.quotaWait; };

function save(rec: RunRecord, env: NodeJS.ProcessEnv): void {
  const d = runsDir(env);
  mkdirSync(d, { recursive: true });
  const f = path.join(d, `${rec.id}.json`), tmp = `${f}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const { keep, cancelRequested, ...persist } = rec; // control state lives in marker files, never in the record
  writeFileSync(tmp, JSON.stringify(persist, null, 1));
  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, f);
      break;
    } catch (e) {
      if (i > 40) throw e;
      nap(10);
    }
  } // Windows EPERM under contention
}

const read = (id: string, env: NodeJS.ProcessEnv): RunRecord | null => {
  for (let i = 0; i < 5; i++) {
    try {
      return JSON.parse(readFileSync(path.join(runsDir(env), `${id}.json`), 'utf8'));
    } catch (e: any) {
      if (e.code === 'ENOENT') return null;
      nap(10);
    }
  }
  return null;
};

function decorate(r: RunRecord, env: NodeJS.ProcessEnv): RunRecord;
function decorate(r: RunRecord | null, env: NodeJS.ProcessEnv): RunRecord | null;
function decorate(r: RunRecord | null, env: NodeJS.ProcessEnv): RunRecord | null {
  if (r) {
    r.keep = existsSync(ctl(env, r.id, 'keep'));
    r.cancelRequested = existsSync(ctl(env, r.id, 'cancel'));
  }
  return r;
}

export function loadRun(id: string, env: NodeJS.ProcessEnv = process.env): RunRecord | null {
  if (!/^[\w-]+$/.test(String(id))) return null;
  const r = read(id, env);
  if (r && r.state === 'running' && !live.has(r.id) && !alive(r.pid)) {
    r.state = 'lost';
    r.endedAt = Date.now();
    r.error = 'owner process died';
    try { save(r, env); } catch { /* ignore */ }
  }
  return decorate(r, env);
}

export function listRuns(env: NodeJS.ProcessEnv = process.env): RunRecord[] {
  let names: string[] = [];
  try { names = readdirSync(runsDir(env)).filter((n) => n.endsWith('.json')); } catch { /* none */ }
  return (names.map((n) => loadRun(n.slice(0, -5), env)).filter(Boolean) as RunRecord[]).sort((a, b) => b.startedAt - a.startedAt);
}

export interface StoreSweep {
  sessions: PruneResult;
  endpointSessions: PruneResult;
  inbox: PruneResult;
}

/** Age+count pruning of telemetry sessions, endpoint sessions and consumed inbox messages (env-tunable, never throws). */
export function pruneStores(env: NodeJS.ProcessEnv = process.env, now = Date.now()): StoreSweep {
  const day = 864e5;
  const json = (n: string) => n.endsWith('.json');
  const sessions = pruneDir(path.join(home(env), 'telemetry', 'sessions'), {
    match: json,
    maxAgeMs: envNum(env, 'AGENTBRIDGE_SESSION_MAX_AGE_MS', 30 * day),
    maxCount: envNum(env, 'AGENTBRIDGE_SESSION_MAX_COUNT', 500),
    now,
  });
  const endpointSessions = pruneDir(path.join(home(env), 'endpoint-sessions'), {
    match: json,
    maxAgeMs: envNum(env, 'AGENTBRIDGE_ENDPOINT_SESSION_MAX_AGE_MS', 30 * day),
    maxCount: envNum(env, 'AGENTBRIDGE_ENDPOINT_SESSION_MAX_COUNT', 500),
    now,
  });
  const inbox: PruneResult = { total: 0, removed: 0 };
  const inboxRoot = path.join(home(env), 'inbox');
  const readAge = envNum(env, 'AGENTBRIDGE_INBOX_READ_MAX_AGE_MS', day);
  try {
    for (const d of readdirSync(inboxRoot)) {
      const r = pruneDir(path.join(inboxRoot, d), { match: (n) => n.endsWith('.read'), maxAgeMs: readAge, maxCount: Infinity, now });
      inbox.total += r.total;
      inbox.removed += r.removed;
    }
  } catch { /* none */ }
  return { sessions, endpointSessions, inbox };
}

let retentionTimer: NodeJS.Timeout | undefined;
/**
 * Once per process: optionally prune stores shortly after start (delayMs >= 0), and always arm the unref'd daily sweep.
 * `full` makes the startup pass a run-record sweep too; otherwise it only prunes the stores.
 */
export function scheduleRetention(env: NodeJS.ProcessEnv = process.env, { full = false, delayMs = 1500 }: { full?: boolean; delayMs?: number } = {}): void {
  if (retentionTimer) return;
  const safe = (fn: () => unknown) => () => { try { fn(); } catch { /* ignore */ } };
  if (delayMs >= 0) setTimeout(safe(() => (full ? sweep(env) : pruneStores(env))), delayMs).unref?.();
  retentionTimer = setInterval(safe(() => sweep(env)), Number(env.AGENTBRIDGE_RETENTION_INTERVAL_MS) || 864e5);
  retentionTimer.unref?.();
}

export interface SweepOptions {
  maxAgeMs?: number;
  maxCount?: number;
}

/** Startup sweep: persist 'lost' for dead owners, GC old/excess terminal runs (unless retained), drop stale idempotency locks. */
export function sweep(env: NodeJS.ProcessEnv = process.env, { maxAgeMs = Number(env.AGENTBRIDGE_RUN_MAX_AGE_MS) || 7 * 864e5, maxCount = Number(env.AGENTBRIDGE_RUN_MAX_COUNT) || 500 }: SweepOptions = {}): { total: number; removed: number } & StoreSweep & { runs: PruneResult } {
  const all = listRuns(env);
  let removed = 0;
  const gone = new Set<string>();
  const drop = (r: RunRecord) => {
    rm(path.join(runsDir(env), `${r.id}.json`));
    rm(ctl(env, r.id, 'cancel'));
    rm(ctl(env, r.id, 'keep'));
    gone.add(r.id);
    removed++;
  };
  all.forEach((r, i) => {
    if (terminal(r.state) && !r.keep && ((Date.now() - (r.endedAt || r.startedAt)) > maxAgeMs || i >= maxCount)) drop(r);
  });
  try {
    for (const n of readdirSync(idemDir(env))) {
      const f = path.join(idemDir(env), n);
      try {
        const j = JSON.parse(readFileSync(f, 'utf8'));
        if (gone.has(j.runId) || !read(j.runId, env)) rm(f);
      } catch { /* ignore */ }
    }
  } catch { /* none */ }
  scheduleRetention(env, { delayMs: -1 });
  return { total: all.length, removed, runs: { total: all.length, removed }, ...pruneStores(env) };
}

/**
 * Atomic idempotency across processes (O_EXCL lock keyed by agent+key; holds runId + prompt hash).
 */
function claimKey(env: NodeJS.ProcessEnv, agent: string, key: string, promptHash: string, runId: string): { mine: boolean; runId?: string; promptHash?: string; run?: RunRecord } {
  mkdirSync(idemDir(env), { recursive: true });
  const f = path.join(idemDir(env), `${sha(`${agent}\0${key}`)}.json`);
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      writeFileSync(f, JSON.stringify({ runId, promptHash }), { flag: 'wx' });
      return { mine: true };
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
    }
    let j: any = null;
    for (let i = 0; i < 100 && !j; i++) {
      try { j = JSON.parse(readFileSync(f, 'utf8')); } catch (e: any) { if (e.code === 'ENOENT') break; nap(20); }
    }
    if (!j) continue; // vanished (retired by someone else) -> retry claim
    const ex = loadRun(j.runId, env);
    if (ex && !['error', 'cancelled', 'lost'].includes(ex.state)) return { mine: false, ...j, run: ex };
    if (j.promptHash !== promptHash && ex) return { mine: false, ...j, run: ex };
    const tomb = `${f}.retired.${process.pid}.${Math.random().toString(36).slice(2)}`;
    try { renameSync(f, tomb); } catch { continue; }
    try {
      const moved = JSON.parse(readFileSync(tomb, 'utf8'));
      if (moved.runId !== j.runId) {
        try { writeFileSync(f, JSON.stringify(moved), { flag: 'wx' }); } catch { /* lost race; fine */ }
      }
    } catch { /* ignore */ }
    rm(tomb);
  }
  throw new Error('idempotency lock contention');
}

export interface DispatchParams {
  agent: string;
  model?: string | null;
  cwd?: string | null;
  key?: string | null;
  prompt?: string;
  env?: NodeJS.ProcessEnv;
  exec: (ctx: { onEvent: (e: any) => void; signal: AbortSignal }) => Promise<any>;
}

export function dispatch({ agent, model, cwd, key, prompt = '', env = process.env, exec }: DispatchParams): { rec: RunRecord; deduped: boolean } {
  const promptHash = sha(prompt), id = randomUUID().slice(0, 12);
  const rec: RunRecord = {
    id,
    key: key || null,
    promptHash,
    root: rootOf(env),
    pid: process.pid,
    childPid: null,
    agent,
    model: model || null,
    cwd: cwd || process.cwd(),
    state: 'running',
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    endedAt: null,
    usage: null,
    sessionId: null,
    events: [],
    result: null,
    error: null,
  };
  const ac = new AbortController();
  save(rec, env); // record exists BEFORE the idempotency lock does, so a lock can never point at a not-yet-written run
  if (key) {
    let c: any;
    try { c = claimKey(env, agent, key, promptHash, id); } catch (e) { rm(path.join(runsDir(env), `${id}.json`)); throw e; }
    if (!c.mine) { // lost the race (or key already used): discard our never-started record
      rm(path.join(runsDir(env), `${id}.json`));
      if (c.promptHash !== promptHash) throw new Error(`idempotencyKey "${key}" was already used with a different prompt`);
      return { rec: c.run!, deduped: true };
    }
  }
  const onEvent = (e: any) => {
    rec.lastEventAt = Date.now();
    if (e.type === 'quota' && rec.state === 'running') {
      if (e.phase === 'waiting') {
        rec.phase = 'waiting_quota';
        rec.quotaWait = {
          agent: snippet(e.agent || 'all'),
          message: snippet(e.message),
          threshold: e.threshold,
          ...(Number.isFinite(e.remainingPercent) ? { remainingPercent: e.remainingPercent } : {}),
          ...(Number.isFinite(e.resetAt) ? { resetAt: e.resetAt } : {}),
          ...(Number.isFinite(e.nextCheckAt) ? { nextCheckAt: e.nextCheckAt } : {}),
          ...(Array.isArray(e.candidates) ? { candidates: e.candidates.slice(0, 8).map((candidate: any) => ({
            agent: snippet(candidate.agent),
            ...(Number.isFinite(candidate.threshold) ? { threshold: candidate.threshold } : {}),
            ...(Number.isFinite(candidate.remainingPercent) ? { remainingPercent: candidate.remainingPercent } : {}),
            ...(Number.isFinite(candidate.resetAt) ? { resetAt: candidate.resetAt } : {}),
          })) } : {}),
        };
      } else if (e.phase === 'ready') {
        clearQuotaWait(rec);
        if (typeof e.agent === 'string' && e.agent !== 'all' && e.agent !== rec.agent) {
          rec.model = null;
          rec.sessionId = null;
          rec.agent = e.agent;
        }
      }
    }
    if (e.type === 'session') rec.sessionId = e.id;
    else if (e.type === 'pid' && e.pid) rec.childPid = e.pid;
    else if (e.type === 'usage') {
      if (e.incremental) {
        rec.usage = {
          input: (rec.usage?.input || 0) + (e.input || 0),
          output: (rec.usage?.output || 0) + (e.output || 0),
          ...((typeof rec.usage?.cost === 'number' || typeof e.cost === 'number')
            ? { cost: (rec.usage?.cost || 0) + (e.cost || 0) }
            : {}),
        };
      } else {
        rec.usage = { input: e.input, output: e.output, ...(e.cost !== undefined ? { cost: e.cost } : {}) };
      }
    }
    if (e.type !== 'raw') {
      const event: RunEventItem = {
        t: rec.lastEventAt,
        type: e.type,
        ...(e.type === 'text' || e.type === 'thinking' ? { delta: snippet(e.delta) } : {}),
        ...(e.type === 'quota' ? { message: snippet(e.message) } : {}),
        ...(e.type === 'tool' ? {
          ...(e.name !== undefined ? { name: snippet(e.name) } : {}),
          ...((e.input ?? e.args ?? e.arguments) !== undefined ? { input: snippet(e.input ?? e.args ?? e.arguments) } : {}),
          ...((e.output ?? e.result) !== undefined ? { output: snippet(e.output ?? e.result) } : {}),
          ...(e.error !== undefined ? { error: snippet(e.error) } : {}),
        } : {}),
        ...(e.type === 'error' ? { error: snippet(e.error ?? e.message ?? e.delta ?? e) } : {}),
      };
      rec.events.push(event);
      if (e.type === 'tool') rec.lastTool = event;
      if (rec.events.length > 20) rec.events.shift();
    }
    save(rec, env);
  };
  // A cancel marker written by ANY process (control file, never clobbered by our saves) is picked up here.
  const poll = setInterval(() => {
    if (!ac.signal.aborted && existsSync(ctl(env, id, 'cancel'))) {
      rec.state = 'cancelled';
      clearQuotaWait(rec);
      try { save(rec, env); } catch { /* cancellation must still stop the worker */ }
      ac.abort();
    }
  }, 200);
  (poll as any).unref?.();
  const done = Promise.resolve().then(() => exec({ onEvent, signal: ac.signal })).then((r) => {
    if (rec.state === 'cancelled') return;
    clearQuotaWait(rec);
    rec.state = 'done'; rec.result = r; rec.agent = r.agent ?? rec.agent; rec.sessionId = r.sessionId ?? rec.sessionId; rec.usage = r.usage ?? rec.usage; rec.model = r.model ?? rec.model;
  }, (e: any) => {
    clearQuotaWait(rec);
    rec.state = ac.signal.aborted ? 'cancelled' : 'error'; rec.error = `${e.code ? e.code + ': ' : ''}${e.message}`;
  }).finally(() => { clearInterval(poll); rec.endedAt = Date.now(); save(rec, env); });
  live.set(id, { ac, done, rec, runsDir: normalizedRunsDir(env) });
  done.finally(() => setTimeout(() => live.delete(id), 0));
  // own the events array: the live rec keeps mutating (and shifting) it while this summary is read
  return { rec: decorate({ ...rec, events: [...rec.events] }, env), deduped: false };
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const objectReason = reason && typeof reason === 'object' ? reason as { code?: unknown; message?: unknown } : null;
  const messageValue = reason instanceof Error ? reason.message : objectReason?.message ?? reason;
  const message = messageValue === undefined ? 'wait aborted' : String(messageValue).slice(0, SNIPPET_MAX);
  const e = new Error(message) as Error & { code: string };
  const code = reason instanceof Error ? (reason as any).code : objectReason?.code;
  e.code = typeof code === 'string' && ['REQUEST_CANCELLED', 'ABORTED'].includes(code) ? code : 'ABORTED';
  return e;
}

function waitForLive(done: Promise<any>, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    let settled = false;
    const timer = setTimeout(() => finish(), ms);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const onAbort = () => { if (settled) return; settled = true; cleanup(); reject(abortError(signal!)); };
    signal?.addEventListener('abort', onAbort, { once: true });
    done.then(finish, finish);
  });
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(abortError(signal!)); };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function waitRun(id: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<RunRecord | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new RangeError('timeoutMs must be finite nonnegative milliseconds');
  if (signal?.aborted) throw abortError(signal);
  const end = Date.now() + timeoutMs;
  for (;;) {
    const l = live.get(id);
    if (l) {
      await waitForLive(l.done, Math.max(0, end - Date.now()), signal);
      return loadRun(id, env);
    }
    const r = loadRun(id, env); // owned by another bridge process: poll the registry
    if (!r || terminal(r.state) || Date.now() >= end) return r;
    await delay(Math.min(250, Math.max(0, end - Date.now())), signal);
  }
}

/** Only runs from the same root (launch tree) may be cancelled/retained. Returns {rec} or {error}. */
function authorize(id: string, env: NodeJS.ProcessEnv): { rec?: RunRecord; error?: string } {
  const r = loadRun(id, env);
  if (!r) return { error: `Unknown run id: ${id}` };
  if ((r.root || 'local') !== rootOf(env)) return { error: `Run ${id} belongs to a different launch root; refusing` };
  return { rec: r };
}

export function cancelRun(id: string, env: NodeJS.ProcessEnv = process.env): { rec?: RunRecord | null; error?: string } {
  const a = authorize(id, env);
  if (a.error || !a.rec) return a;
  const l = live.get(id);
  if (l) {
    if (l.rec.state !== 'running') return { rec: decorate({ ...l.rec }, env) }; // already finished: no state flip, no stray marker
    l.rec.state = 'cancelled';
    clearQuotaWait(l.rec);
    try {
      writeFileSync(ctl(env, id, 'cancel'), '');
      save(l.rec, env);
    } finally {
      l.ac.abort();
    }
    return { rec: decorate({ ...l.rec }, env) };
  }
  if (a.rec.state === 'running') writeFileSync(ctl(env, id, 'cancel'), ''); // owner (another process) polls this marker
  return { rec: decorate(a.rec, env) };
}

export function setKeep(id: string, keep: boolean, env: NodeJS.ProcessEnv = process.env): { rec?: RunRecord | null; error?: string } {
  const a = authorize(id, env);
  if (a.error || !a.rec) return a;
  if (keep) writeFileSync(ctl(env, id, 'keep'), '');
  else rm(ctl(env, id, 'keep'));
  return { rec: decorate(a.rec, env) };
}

/** Abort every locally-owned running run and wait (bounded) for them to settle. Called on stdin close / exit. */
export async function abortAll(env: NodeJS.ProcessEnv = process.env, waitMs = 4000): Promise<number> {
  const targetDir = normalizedRunsDir(env);
  const targetRoot = rootOf(env);
  const ls = [...live.values()].filter((l) => l.runsDir === targetDir && (l.rec.root || 'local') === targetRoot && l.rec.state === 'running');
  for (const l of ls) {
    l.rec.state = 'cancelled';
    clearQuotaWait(l.rec);
    l.rec.error = 'bridge shutting down';
    try { save(l.rec, env); } catch { /* shutdown must still stop the worker */ }
    l.ac.abort();
  }
  if (ls.length) {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all(ls.map((l) => l.done)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return ls.length;
}

export interface RunSummary {
  id: string;
  key: string | null;
  agent: string;
  model: string | null;
  state: string;
  elapsedMs: number;
  lastEventAgoMs: number;
  usage: any | null;
  sessionId: string | null;
  ownerPid: number;
  childPid: number | null;
  keep: boolean;
  lastEvents: RunEventItem[];
  lastTool: RunEventItem | null;
  error: string | null;
  subagents?: SubagentEntry[];
  phase?: 'waiting_quota';
  quotaWait?: RunRecord['quotaWait'];
}

export function summarize(r: RunRecord): RunSummary;
export function summarize(r: RunRecord | null): RunSummary | null;
export function summarize(r: RunRecord | null): RunSummary | null {
  if (!r) return null;
  const lastTool = r.lastTool || [...(r.events || [])].reverse().find((e) => e.type === 'tool');
  return {
    id: r.id,
    key: r.key,
    agent: r.agent,
    model: r.model,
    state: r.state,
    elapsedMs: (r.endedAt || Date.now()) - r.startedAt,
    lastEventAgoMs: Date.now() - r.lastEventAt,
    usage: r.usage,
    sessionId: r.sessionId,
    ownerPid: r.pid,
    childPid: r.childPid,
    keep: !!r.keep,
    lastEvents: (r.events || []).slice(-5),
    lastTool: lastTool ? { ...lastTool } : null,
    ...(r.phase ? { phase: r.phase } : {}),
    ...(r.quotaWait ? { quotaWait: { ...r.quotaWait } } : {}),
    error: r.error,
    subagents: r.subagents || [],
  };
}

export interface InboxMessage {
  id: string;
  t: number;
  to: string;
  fromClaimed: string;
  sender: { root: string; depth: number; pid: number };
  fromVerified: boolean;
  text: string;
}

// ---- inbox: one file per message => appends never race with reads; mark-read is an atomic rename ----
const inboxDir = (env: NodeJS.ProcessEnv, to: string) => path.join(home(env), 'inbox', String(to).replace(/[^\w.-]/g, '_'));

export function sendMessage(env: NodeJS.ProcessEnv, { to, from = 'anonymous', text }: { to: string; from?: string; text: string }): InboxMessage {
  const d = inboxDir(env, to);
  mkdirSync(d, { recursive: true });
  const m: InboxMessage = {
    id: `${String(Date.now()).padStart(15, '0')}-${randomUUID().slice(0, 8)}`,
    t: Date.now(),
    to,
    fromClaimed: String(from),
    sender: { root: rootOf(env), depth: Number(env.AGENTBRIDGE_DEPTH) || 0, pid: process.pid },
    fromVerified: false,
    text: String(text),
  };
  const f = path.join(d, `${m.id}.msg`), tmp = f + '.tmp';
  writeFileSync(tmp, JSON.stringify(m));
  renameSync(tmp, f);
  return m;
}

export function checkMessages(env: NodeJS.ProcessEnv, { for: who, markRead = true }: { for: string; markRead?: boolean }): InboxMessage[] {
  const d = inboxDir(env, who);
  let names: string[] = [];
  try { names = readdirSync(d).filter((n) => n.endsWith('.msg')).sort(); } catch { return []; }
  const out: InboxMessage[] = [];
  for (const n of names) {
    const f = path.join(d, n);
    try {
      const m = JSON.parse(readFileSync(f, 'utf8'));
      if (markRead) renameSync(f, f.replace(/\.msg$/, '.read')); // only one reader can win the rename
      out.push(m);
    } catch { /* claimed by a concurrent reader */ }
  }
  return out;
}
