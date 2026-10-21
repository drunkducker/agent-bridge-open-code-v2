// feat-parallel: fanout (same prompt to many agents/models, collect all) and race (first good answer wins, the rest are cancelled).
import { Budget, runBudgeted, BudgetLimits } from './budget.js';
import { askWithSchema } from './schema.js';
import { runInWorktree } from './worktree.js';
import { FallbackTarget } from '../types/index.js';

/** "claude:haiku" | "codex" | "opencode:opencode-go/glm" | {agent, model} -> {agent, model} */
export function parseTarget(t: string | FallbackTarget): FallbackTarget {
  if (t && typeof t === 'object') return { agent: t.agent, model: t.model };
  const s = String(t).trim(),
    i = s.indexOf(':');
  return i < 0 ? { agent: s, model: undefined } : { agent: s.slice(0, i), model: s.slice(i + 1) || undefined };
}

/** Run one target with all extras (budget, schema, worktree). Returns a Result. */
export function execOne(agent: string | any, opts: any, { budget, schema, retries, worktree, gen, onEvent }: any = {}): Promise<any> {
  const runOne = (a: any, p: any) => runBudgeted(a, p, budget || {}, { gen, onEvent });
  const inner = (a: any, p: any) => (worktree ? runInWorktree(a, p, { runOne }) : runOne(a, p));
  return schema ? askWithSchema(agent, opts, { schema, retries, runOne: inner }) : inner(agent, opts);
}

const entry = (t: FallbackTarget, r: any, e: any, t0: number) => ({
  agent: t.agent,
  model: t.model ?? r?.model ?? null,
  ok: !!r && !e && !r.aborted && r.exitCode === 0 && !(r.schema && !r.schema.valid),
  skipped: !!r?.skipped,
  aborted: !!r?.aborted,
  text: r?.text ?? '',
  result: r || null,
  error: e ? { code: e.code || 'ERROR', message: e.message } : null,
  durationMs: Date.now() - t0,
});

/** Default fanout width: below the process cap (AGENTBRIDGE_MAX_PROCS) so a large target list queues instead of failing with RATE_LIMITED. */
export const DEFAULT_FANOUT_CONCURRENCY = 8;

export interface FanoutOptions {
  budget?: Budget | BudgetLimits;
  concurrency?: number;
  schema?: any;
  retries?: number;
  worktree?: boolean;
  gen?: any;
  onEvent?: (e: any, target: FallbackTarget, index: number) => void;
  exec?: typeof execOne;
}

export async function fanout(targets: (string | FallbackTarget)[], opts: any, o: FanoutOptions = {}): Promise<{ results: any[]; budget: any }> {
  const ts = targets.map(parseTarget);
  if (!ts.length) throw new TypeError('fanout needs at least one target');
  const shared = o.budget instanceof Budget ? o.budget : new Budget(o.budget || {});
  const limit = Math.max(1, o.concurrency || Math.min(ts.length, DEFAULT_FANOUT_CONCURRENCY)),
    out = new Array(ts.length);
  let next = 0;
  const exec = o.exec || execOne;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= ts.length) return;
      const t = ts[i],
        t0 = Date.now();
      try {
        out[i] = entry(
          t,
          await exec(
            t.agent,
            { ...opts, ...(t.model ? { model: t.model } : {}) },
            { ...o, budget: shared, onEvent: o.onEvent && ((e: any) => o.onEvent!(e, t, i)) }
          ),
          null,
          t0
        );
      } catch (e) {
        out[i] = entry(t, null, e, t0);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(limit, ts.length) }, worker));
  } finally {
    if (!(o.budget instanceof Budget)) shared.dispose();
  }
  return { results: out, budget: shared.toJSON() };
}

export interface RaceOptions {
  accept?: (entry: any) => boolean;
  budget?: Budget | BudgetLimits;
  schema?: any;
  worktree?: boolean;
  gen?: any;
  exec?: typeof execOne;
}

export async function race(
  targets: (string | FallbackTarget)[],
  opts: any,
  o: RaceOptions = {}
): Promise<{ winner: any; losers: any[]; results: any[]; budget: any }> {
  const ts = targets.map(parseTarget);
  const ac = new AbortController();
  const signal = opts.signal ? (AbortSignal as any).any([opts.signal, ac.signal]) : ac.signal;
  const accept = o.accept || ((e: any) => e.text.trim().length > 0);
  const shared = o.budget instanceof Budget ? o.budget : new Budget(o.budget || {});
  const exec = o.exec || execOne;
  let winner: any = null;
  const out = new Array(ts.length);
  await Promise.all(
    ts.map(async (t, i) => {
      const t0 = Date.now();
      let e: any;
      try {
        e = entry(t, await exec(t.agent, { ...opts, ...(t.model ? { model: t.model } : {}), signal }, { ...o, budget: shared }), null, t0);
      } catch (err) {
        e = entry(t, null, err, t0);
      }
      if (!winner && e.ok && accept(e)) {
        winner = e;
        e.winner = true;
        ac.abort();
      } else if (winner && winner !== e) {
        e.ok = false;
        e.cancelled = true;
      }
      out[i] = e;
    })
  );
  if (!(o.budget instanceof Budget)) shared.dispose();
  return { winner, losers: out.filter((e) => e !== winner), results: out, budget: shared.toJSON() };
}
