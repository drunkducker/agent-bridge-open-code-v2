// feat-budget: --max-cost / --max-tokens / --max-time per run and shared across a fanout. Aborts cleanly via AbortSignal.
import { run as coreRun } from '../index.js';

export interface BudgetLimits {
  maxCost?: number | null;
  maxTokens?: number | null;
  maxTimeMs?: number | null;
}

export interface BudgetSpent {
  tokens: number;
  cost: number;
  timeMs: number;
}

export class Budget {
  limits: BudgetLimits;
  ac: AbortController;
  exceeded: string | null;
  startedAt: number;
  per: Map<string, { tokens: number; cost: number }>;
  timer: NodeJS.Timeout | null;

  constructor({ maxCost, maxTokens, maxTimeMs }: BudgetLimits = {}) {
    for (const [k, v] of Object.entries({ maxCost, maxTokens, maxTimeMs })) {
      if (v != null && !(Number.isFinite(v) && v >= 0)) throw new TypeError(`${k} must be a non-negative number`);
    }
    this.limits = { maxCost: maxCost ?? null, maxTokens: maxTokens ?? null, maxTimeMs: maxTimeMs ?? null };
    this.ac = new AbortController();
    this.exceeded = null;
    this.startedAt = Date.now();
    this.per = new Map();
    this.timer = null;
    if (this.limits.maxTimeMs != null) {
      this.timer = setTimeout(() => this.trip('time'), this.limits.maxTimeMs);
      (this.timer as any).unref?.();
    }
  }

  get signal(): AbortSignal {
    return this.ac.signal;
  }

  get spent(): BudgetSpent {
    let tokens = 0,
      cost = 0;
    for (const u of this.per.values()) {
      tokens += u.tokens;
      cost += u.cost;
    }
    return { tokens, cost, timeMs: Date.now() - this.startedAt };
  }

  trip(what: string): void {
    if (!this.exceeded) {
      this.exceeded = what;
      this.ac.abort();
    }
  }

  track(key: string, e: any): void {
    if (e?.type !== 'usage') return;
    const tokens = (e.input || 0) + (e.output || 0);
    const cost = e.cost || 0;
    if (e.incremental) {
      const prev = this.per.get(key) || { tokens: 0, cost: 0 };
      this.per.set(key, { tokens: prev.tokens + tokens, cost: prev.cost + cost });
    } else {
      this.per.set(key, { tokens, cost });
    }
    this.check();
  }

  check(): string | null {
    const s = this.spent,
      l = this.limits;
    if (l.maxTokens != null && s.tokens > l.maxTokens) this.trip('tokens');
    else if (l.maxCost != null && s.cost > l.maxCost) this.trip('cost');
    else if (l.maxTimeMs != null && s.timeMs > l.maxTimeMs) this.trip('time');
    return this.exceeded;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  toJSON(): { exceeded: string | null; limits: BudgetLimits; spent: BudgetSpent } {
    return { exceeded: this.exceeded, limits: this.limits, spent: this.spent };
  }
}

let seq = 0;
const BUDGET_LIMIT_REACHED = Symbol('budget limit reached');

/** Iterate an event generator to its return value, forwarding events. If onEvent throws, the
 *  unwound-on-error return() below still drives the generator's own finally clauses, so adapter
 *  cleanup (child kill, lock release) cannot be skipped by a generator left suspended mid-yield. */
export async function drain(it: AsyncGenerator<any, any, any>, onEvent?: (e: any) => void): Promise<any> {
  try {
    for (;;) {
      const { value, done } = await it.next();
      if (done) return value;
      if (onEvent) onEvent(value);
    }
  } finally {
    // No-op once exhausted; on unwind it resumes the suspended generator through its finally.
    await it.return?.(undefined as any);
  }
}

export async function runBudgeted(
  agent: string | { name: string; [key: string]: any },
  opts: any,
  budget?: Budget | BudgetLimits,
  { gen = coreRun, onEvent }: { gen?: any; onEvent?: (e: any) => void } = {}
): Promise<any> {
  const own = !(budget instanceof Budget);
  const b = own ? new Budget(budget || {}) : budget;
  const key = `r${++seq}`;
  const name = typeof agent === 'string' ? agent : agent.name;
  if (b.exceeded)
    return {
      text: '',
      sessionId: null,
      usage: { input: 0, output: 0 },
      exitCode: null,
      model: opts.model ?? null,
      durationMs: 0,
      timedOut: false,
      skipped: true,
      aborted: true,
      agent: name,
      budget: b.toJSON(),
    };
  const signal = opts.signal ? (AbortSignal as any).any([opts.signal, b.signal]) : b.signal;
  const t0 = Date.now();
  let attempt = 0,
    activeKey = key;
  let text = '',
    sessionId: string | null = null,
    usage: any = { input: 0, output: 0 };
  const partialUsageByAttempt = new Map<string, { input: number; output: number; cost: number; hasCost: boolean }>();
  const partialUsage = () => {
    const total = { input: 0, output: 0, cost: 0, hasCost: false };
    for (const u of partialUsageByAttempt.values()) {
      total.input += u.input;
      total.output += u.output;
      total.cost += u.cost;
      total.hasCost ||= u.hasCost;
    }
    return { input: total.input, output: total.output, ...(total.hasCost ? { cost: total.cost } : {}) };
  };
  try {
    const r = await drain(gen(agent, { ...opts, signal }), (e: any) => {
      if (e.type === 'text') text += e.delta;
      else if (e.type === 'session') sessionId = e.id;
      else if (e.type === 'usage') {
        const prev = partialUsageByAttempt.get(activeKey) || { input: 0, output: 0, cost: 0, hasCost: false };
        const next = e.incremental
          ? {
              input: prev.input + (e.input || 0),
              output: prev.output + (e.output || 0),
              cost: prev.cost + (e.cost || 0),
              hasCost: prev.hasCost || typeof e.cost === 'number',
            }
          : {
              input: e.input || 0,
              output: e.output || 0,
              cost: e.cost || 0,
              hasCost: typeof e.cost === 'number',
            };
        partialUsageByAttempt.set(activeKey, next);
        usage = partialUsage();
      }
      b.track(activeKey, e);
      if (onEvent) onEvent(e);
      if (e.type === 'fallback') activeKey = `${key}/a${++attempt}`;
      if (b.exceeded) throw BUDGET_LIMIT_REACHED;
    });
    b.track(activeKey, { type: 'usage', ...r.usage });
    return { ...r, agent: name, budget: b.toJSON() };
  } catch (e) {
    if (b.exceeded && !opts.signal?.aborted)
      return {
        text,
        sessionId,
        usage,
        exitCode: null,
        model: opts.model ?? null,
        durationMs: Date.now() - t0,
        timedOut: false,
        aborted: true,
        agent: name,
        budget: b.toJSON(),
      };
    throw e;
  } finally {
    if (own) b.dispose();
  }
}
