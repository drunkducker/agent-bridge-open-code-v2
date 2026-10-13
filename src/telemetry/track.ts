// Thin wrapper around run(): tracks the run (telemetry), fires hooks, applies the context policy.
import { AgentError } from '../core/errors.js';
import { createTracker, contextOf } from './stats.js';
import { fire, summaryOf, mergeHooks, loadGlobalHooks } from './hooks.js';
import { getPolicy, evaluate, levelAtLeast, compact, handoff, PolicyLimits } from './context.js';
import { AgentEvent, RunResult, AgentAdapter } from '../types/index.js';

export interface TelemetryOptions {
  env?: NodeJS.ProcessEnv;
  hooks?: Record<string, any>;
  hookTimeoutMs?: number;
  noGlobalHooks?: boolean;
  policy?: PolicyLimits;
  windows?: any;
}

export async function* runWithTelemetry(
  agent: string | AgentAdapter,
  opts: any,
  tele: TelemetryOptions = {}
): AsyncGenerator<AgentEvent, RunResult & { telemetry: any }, void> {
  const env = tele.env || process.env;
  const { run, validateOptions } = await import('../index.js');
  const o = validateOptions(opts); // BAD_OPTION before anything is tracked
  const name = (typeof agent === 'string' ? agent : agent.name) || 'agent';
  const hooks = mergeHooks(tele.noGlobalHooks ? {} : loadGlobalHooks(env), tele.hooks || {});
  const hookOpts = { timeoutMs: tele.hookTimeoutMs || 10_000 };
  const pending: Promise<any>[] = [];
  const hookResults: any[] = [];
  const emit = (event: string, s: any) => {
    const p = fire(event, s, hooks, hookOpts).then((r) => {
      hookResults.push(...r);
    });
    pending.push(p);
    return p;
  };
  const policyOf = (sid: string) => {
    if (tele.policy?.hardAction === 'none' && tele.policy?.hard === null) {
      return { warn: null, hard: null, autoCompact: false, hardAction: 'none' as const };
    }
    return getPolicy(name, sid, env, tele.policy);
  };

  // hard limit: refuse to grow a session already over its limit
  const startSid = o.session?.mode === 'continue' || o.session?.mode === 'fork' ? o.session.id : null;
  if (startSid) {
    const pol = policyOf(startSid);
    if (pol.hard != null && pol.hardAction !== 'none') {
      const c = contextOf(startSid, { agent: name, env, windows: tele.windows, refresh: true });
      if (c && evaluate(c, pol).level === 'hard') {
        if (pol.hardAction === 'handoff' && pol.handoffTo) {
          const h = await handoff(startSid, pol.handoffTo, { agent: name, env, cwd: o.cwd });
          throw new AgentError(
            'AGENT_FAILED',
            `context hard limit reached (${c.tokens}/${c.window} tokens): session handed off to ${pol.handoffTo} session ${h.newSessionId}`,
            { reason: 'CONTEXT_HARD_LIMIT', handoff: h }
          );
        }
        throw new AgentError(
          'AGENT_FAILED',
          `context hard limit reached (${c.tokens}/${c.window} tokens, ${c.exact ? 'exact' : 'estimate'}); compact or handoff first`,
          { reason: 'CONTEXT_HARD_LIMIT', context: c }
        );
      }
    }
  }

  const tr = createTracker({ agent: name, opts: o, env });
  emit('start', summaryOf(tr.rec, 'start'));
  let finished = false,
    result: any;
  try {
    const it = run(agent, o);
    try {
      for (;;) {
        const { value, done } = await it.next();
        if (done) {
          result = value;
          break;
        }
        tr.onEvent(value);
        yield value;
      }
    } finally {
      await (it as any).return?.();
    }
    const rec = tr.finish({ result });
    finished = true;
    await emit(rec.state === 'timeout' ? 'timeout' : 'finish', summaryOf(rec, rec.state === 'timeout' ? 'timeout' : 'finish'));
  } catch (e: any) {
    if (!finished) {
      const rec = tr.finish({ error: e });
      finished = true;
      await emit(rec.state === 'timeout' ? 'timeout' : 'error', summaryOf(rec, rec.state === 'timeout' ? 'timeout' : 'error'));
    }
    await Promise.allSettled(pending);
    throw e;
  } finally {
    if (!finished) {
      // consumer abandoned the generator
      const rec = tr.finish({ error: new AgentError('ABORTED', 'consumer stopped iterating') });
      emit('error', summaryOf(rec, 'error'));
      await Promise.allSettled(pending);
    }
  }

  // context policy (after the run, so the session file is up to date)
  const tel: any = { runId: tr.rec.id, context: null, level: 'ok', compaction: null, hooks: hookResults };
  try {
    const who = result.fallback?.used || name; // a fallback answered: the session (and its context window) belongs to that agent
    const sid = result.sessionId || tr.rec.sessionId;
    const c = sid && o.session?.mode !== 'ephemeral' ? contextOf(sid, { agent: who, env, windows: tele.windows, refresh: true }) : null;
    if (c) {
      tel.context = c;
      const pol = getPolicy(who, sid, env, tele.policy);
      const ev = evaluate(c, pol);
      tel.level = ev.level;
      if (ev.level !== 'ok') {
        const info = {
          abTelemetry: ev.level === 'hard' ? 'context-hard' : 'context-warning',
          level: ev.level,
          sessionId: sid,
          agent: who,
          tokens: c.tokens,
          exact: c.exact,
          window: c.window,
          pct: c.pct,
          thresholds: ev.thresholds,
        };
        yield { type: 'raw', data: info } as any;
        await emit('context-threshold', summaryOf(tr.rec, 'context-threshold', { context: info }));
        if (levelAtLeast(ev.level, 'compact') && pol.autoCompact) {
          const cr = await compact(sid, { agent: who, env, cwd: o.cwd });
          tel.compaction = { method: cr.method, sessionId: cr.sessionId, before: cr.before?.tokens, after: cr.after?.tokens };
          yield { type: 'raw', data: { abTelemetry: 'context-compact', ...tel.compaction, previousSession: sid } } as any;
        }
      }
    }
  } catch (e: any) {
    tel.policyError = String(e?.message || e);
  }
  await Promise.allSettled(pending);
  return { ...result, telemetry: tel };
}

export async function* runTracked(
  agent: string | AgentAdapter,
  opts: any,
  { env = process.env, origin = 'tracker' }: { env?: NodeJS.ProcessEnv; origin?: string } = {}
): AsyncGenerator<AgentEvent, RunResult, void> {
  const { run } = await import('../index.js');
  const name = (typeof agent === 'string' ? agent : agent.name) || 'agent';
  const tr = createTracker({ agent: name, opts: { ...opts, prompt: String(opts?.prompt ?? '') }, env, origin });
  let finished = false;
  try {
    const it = run(agent, opts);
    try {
      for (;;) {
        const { value, done } = await it.next();
        if (done) {
          tr.finish({ result: value });
          finished = true;
          return value;
        }
        tr.onEvent(value);
        yield value;
      }
    } finally {
      await (it as any).return?.();
    }
  } catch (e) {
    if (!finished) {
      tr.finish({ error: e });
      finished = true;
    }
    throw e;
  } finally {
    if (!finished) tr.finish({ error: new AgentError('ABORTED', 'consumer stopped iterating') });
  }
}

export async function askWithTelemetry(agent: string | any, opts: any, tele?: TelemetryOptions): Promise<any> {
  const it = runWithTelemetry(agent, opts, tele);
  for (;;) {
    const { value, done } = await it.next();
    if (done) return value;
  }
}
