// Shared helpers for the OpenAI/Anthropic compat proxy
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { runTracked, agents, endpointNames, AgentError } from '../index.js';
import { globMatch, ConfigHolder } from './config.js';
import { callId } from './tools/emulate.js';
import { isInstalled } from '../core/readiness.js';
import { RunOptions } from '../types/index.js';
import { getProactiveQuotaStatus } from '../quota/proactive.js';
import { withTimeout } from '../extras/doctor.js';

const run = (agent: any, opts: any) => runTracked(agent, opts, { origin: 'proxy' });

export class HttpError extends Error {
  status: number;
  type: string;
  code: string | null;
  retryAfter: number | null;

  constructor(status: number, message: string, type = 'invalid_request_error', code: string | null = null, retryAfter: number | null = null) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export const rid = (p: string): string => p + randomBytes(12).toString('hex');
export const now = (): number => Math.floor(Date.now() / 1000);

// ---------- model routing ----------
const CLAUDE_ALIASES = new Set(['sonnet', 'haiku', 'opus', 'opusplan', 'best']);
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface ResolvedModel {
  agent: any;
  model?: string;
  id: string;
  canonical: string;
  mode: 'api' | 'agent';
  effort?: string;
}

export function resolveModel(
  name: string,
  ctx: { cfg?: ConfigHolder; adapters?: Record<string, any> } = {},
  depth = 0
): ResolvedModel {
  if (typeof name !== 'string' || !name) throw new HttpError(400, 'model is required', 'invalid_request_error', 'missing_model');
  let m = name.trim();
  const alias = ctx.cfg?.get().aliases;
  if (alias && depth < 3) {
    const hit = Object.keys(alias).find((k) => k.toLowerCase() === m.toLowerCase());
    if (hit) return { ...resolveModel(alias[hit], ctx, depth + 1), id: name.trim() };
  }
  let mode: 'api' | 'agent' = 'api';
  if (/^agent\//i.test(m)) {
    mode = 'agent';
    m = m.slice(6);
  }
  let effort: string | undefined;
  const sfx = /^(.*)\(([a-z0-9]+)\)$/i.exec(m);
  if (sfx) {
    const v = sfx[2].toLowerCase();
    if (EFFORTS.includes(v as any) || v === 'minimal' || v === 'none') effort = effortFrom(v);
    else if (/^\d+$/.test(v)) effort = effortFromBudget({ type: 'enabled', budget_tokens: Number(v) });
    else throw new HttpError(400, `Invalid effort suffix "(${sfx[2]})" in model "${name}"`, 'invalid_request_error', 'invalid_value');
    m = sfx[1];
  }
  const done = (t: { agent: any; model?: string }): ResolvedModel => ({
    ...t,
    id: name.trim(),
    canonical: name.trim(),
    mode,
    ...(effort ? { effort } : {}),
  });
  let mm: RegExpExecArray | null;
  const ad = ctx.adapters;
  if (ad && (mm = /^([a-z][a-z0-9_]*)\/(.+)$/.exec(m)) && ad[mm[1]]) return done({ agent: ad[mm[1]], model: mm[2] });
  if ((mm = /^claude\/(.+)$/i.exec(m))) return done({ agent: 'claude', model: mm[1] });
  if ((mm = /^codex\/(.+)$/i.exec(m))) return done({ agent: 'codex', model: mm[1] });
  if ((mm = /^agy\/(.+)$/i.exec(m))) return done({ agent: 'agy', model: mm[1] });
  if ((mm = /^pi\/(.+)$/i.exec(m))) return done({ agent: 'pi', model: mm[1] });
  if ((mm = /^opencode\/(.+)$/i.exec(m))) return done({ agent: 'opencode', model: mm[1].includes('/') ? mm[1] : m });
  const l = m.toLowerCase();
  if ((mm = /^([a-z][a-z0-9_]*)\/(.+)$/.exec(l)) && endpointNames().includes(mm[1]))
    return done({ agent: mm[1], model: m.slice(mm[1].length + 1) });
  if (CLAUDE_ALIASES.has(l) || /^claude-/.test(l)) return done({ agent: 'claude', model: m });
  if (/^(gpt-|codex|o[134](-|$)|chatgpt)/.test(l)) return done({ agent: 'codex', model: l === 'codex' ? undefined : m });
  if (m.includes('/')) return done({ agent: 'opencode', model: m });
  if (endpointNames().includes('ollama') && (/:(cloud|latest|\d+b)/i.test(m) || /^glm-|^qwen|^llama|^deepseek/i.test(m))) {
    return done({ agent: 'ollama', model: m });
  }
  throw new HttpError(
    404,
    `The model \`${name}\` does not exist. Use claude/<model>, codex/<model>, agy/<model>, pi/<provider>/<model>, opencode/<provider>/<model> or an alias (sonnet, haiku, opus, gpt-5-codex). Prefix with agent/ for agent mode; add (low|medium|high|max) to set the effort.`,
    'invalid_request_error',
    'model_not_found'
  );
}

export function pickTarget(model: string, opts: any, req?: any): ResolvedModel {
  const t = resolveModel(model, opts);
  if (req?.abMode === 'agent') t.mode = 'agent';
  return t;
}

export function applyPayloadRules(cfg: ConfigHolder | undefined, id: string, o: any): any {
  const out = { ...o };
  for (const r of cfg?.get().payload || []) {
    if (!globMatch(r.match, id)) continue;
    for (const [k, v] of Object.entries(r.defaults || {})) if (out[k] == null) out[k] = v;
    for (const [k, v] of Object.entries(r.override || {})) out[k] = v;
  }
  return out;
}

let modelCache = { at: 0, list: null as string[] | null };
export async function listModels(): Promise<string[]> {
  if (modelCache.list && Date.now() - modelCache.at < 60000) return modelCache.list;
  const out: string[] = [];
  const add = (id: string) => {
    if (!out.includes(id)) out.push(id);
  };
  await Promise.all(
    agents.names.map(async (n) => {
      if (!isInstalled(n)) return;
      try {
        const ms = await withTimeout(agents.models(n), 20000);
        for (const x of ms) add(n === 'opencode' ? (x.startsWith('opencode/') ? x : 'opencode/' + x) : `${n}/${x}`);
      } catch {
        /* best-effort */
      }
    })
  );
  if (isInstalled('claude')) {
    for (const a of ['claude/haiku', 'claude/sonnet', 'claude/opus']) add(a);
  }
  out.sort();
  modelCache = { at: Date.now(), list: out };
  return out;
}

// ---------- effort ----------
export function effortFrom(v: any): string | undefined {
  if (v == null || v === 'none') return undefined;
  if (v === 'minimal') return 'low';
  if (typeof v === 'string' && EFFORTS.includes(v as any)) return v;
  throw new HttpError(400, `Invalid reasoning effort "${v}"`, 'invalid_request_error', 'invalid_value');
}

export function effortFromBudget(t: any): string | undefined {
  if (!t || t.type === 'disabled' || !Number.isFinite(t.budget_tokens)) return undefined;
  const b = t.budget_tokens;
  return b <= 2048 ? 'low' : b <= 8192 ? 'medium' : b <= 24576 ? 'high' : 'max';
}

export function sessionKeyOf(req?: any, opts?: any): string | undefined {
  const h = req?.headers?.['x-ab-session'];
  if (typeof h !== 'string' || !h.trim()) return undefined;
  const who = createHash('sha256')
    .update(String(req.headers.authorization || req.headers['x-api-key'] || ''))
    .digest('hex')
    .slice(0, 12);
  return who + ':' + h.trim().slice(0, 128);
}

// ---------- request parameters ----------
const IGNORED = [
  'temperature',
  'top_p',
  'top_k',
  'seed',
  'presence_penalty',
  'frequency_penalty',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'metadata',
  'service_tier',
  'store',
  'parallel_tool_calls',
  'prompt_cache_key',
  'safety_identifier',
];

export interface RequestParams {
  maxTokens?: number;
  stop: string[];
  ignored: string[];
}

export function readParams(body: any): RequestParams {
  const mt = body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens;
  if (mt !== undefined && mt !== null) {
    if (typeof mt !== 'number' || !Number.isInteger(mt) || mt <= 0) {
      throw new HttpError(
        400,
        '`max_tokens` must be a positive integer',
        'invalid_request_error',
        'invalid_max_tokens'
      );
    }
  }
  const maxTokens = mt !== undefined && mt !== null ? mt : undefined;
  const st = body.stop ?? body.stop_sequences;
  const stop = (Array.isArray(st) ? st : st == null ? [] : [st])
    .filter((s) => typeof s === 'string' && s.length > 0)
    .slice(0, 8);
  const ignored = IGNORED.filter(
    (k) => body[k] != null && !(k === 'parallel_tool_calls' || k === 'store') && !(k === 'logprobs' && body[k] === false)
  );
  return { maxTokens, stop, ignored };
}

export const warnHeaders = (w?: any): Record<string, string> =>
  w ? { 'x-agentbridge-warning': String(w).replace(/[^ -~]/g, ' ').slice(0, 300) } : {};
export const ignoredHeaders = (ignored?: string[]): Record<string, string> =>
  ignored?.length ? { 'x-agentbridge-ignored': ignored.join(',') } : {};

export interface TextLimiter {
  push: (d: string) => { out: string; done?: { reason: string; stopSequence?: string } | null };
  flush: () => { out: string; done?: { reason: string; stopSequence?: string } | null };
}

/** Streaming text limiter */
export function createLimiter({ maxTokens, stop = [] }: { maxTokens?: number; stop?: string[] } = {}): TextLimiter {
  const maxChars = maxTokens ? maxTokens * 4 : Infinity;
  const hold = stop.length ? Math.max(...stop.map((s) => s.length)) - 1 : 0;
  let emitted = 0,
    pending = '';
  const cap = (out: string, reason?: string, stopSequence?: string) => {
    const room = maxChars - emitted;
    if (out.length > room) {
      out = out.slice(0, Math.max(0, room));
      emitted += out.length;
      return { out, done: { reason: 'length' } };
    }
    emitted += out.length;
    return { out, done: reason ? { reason, stopSequence } : null };
  };
  return {
    push(d: string) {
      const buf = pending + d;
      pending = '';
      let hit = -1,
        hs: string | undefined;
      for (const s of stop) {
        const i = buf.indexOf(s);
        if (i >= 0 && (hit < 0 || i < hit)) {
          hit = i;
          hs = s;
        }
      }
      if (hit >= 0) return cap(buf.slice(0, hit), 'stop', hs);
      if (hold) {
        pending = buf.slice(Math.max(0, buf.length - hold));
        return cap(buf.slice(0, Math.max(0, buf.length - hold)));
      }
      return cap(buf);
    },
    flush() {
      const p = pending;
      pending = '';
      return cap(p);
    },
  };
}

// ---------- prompt building ----------
const NO_TOOLS =
  'You are a plain text-completion backend behind an API. Do NOT use any tools, read files, run commands or browse; answer directly from the conversation.';

export function buildPrompt(turns: { role: string; text: string }[], budgetTokens = 0): string {
  const last = turns[turns.length - 1];
  if (turns.length === 1 && last.role === 'user') return last.text;
  const lab: Record<string, string> = { user: 'User', assistant: 'Assistant', tool: 'Tool result' };
  let use = turns,
    dropped = 0;
  if (budgetTokens > 0) {
    let used = est(last.text),
      from = turns.length - 1;
    while (from > 0 && used + est(turns[from - 1].text) <= budgetTokens) {
      from--;
      used += est(turns[from].text);
    }
    dropped = from;
    use = turns.slice(from);
  }
  const head = dropped
    ? `Conversation so far (${dropped} earlier message${dropped > 1 ? 's' : ''} omitted):\n\n`
    : 'Conversation so far:\n\n';
  return head + use.map((t) => `${lab[t.role] || t.role}: ${t.text}`).join('\n\n') + "\n\nWrite the assistant's next reply.";
}

export function incrementalPrompt(turns: { role: string; text: string }[]): string {
  let i = turns.length;
  while (i > 0 && turns[i - 1].role !== 'assistant') i--;
  const tail = turns.slice(i);
  return tail.length ? buildPrompt(tail) : buildPrompt(turns.slice(-1));
}

export function joinSystem(parts: string[], extra: string[] = [], mode = 'api'): string {
  return [mode === 'agent' ? '' : NO_TOOLS, ...parts, ...extra].filter(Boolean).join('\n\n');
}

export async function drive(
  o: any,
  { onStart, onDelta }: { onStart: () => void; onDelta: (delta: string) => void }
): Promise<any> {
  const it = runAgent(o);
  let started = false;
  for (;;) {
    const x = await it.next();
    if (x.done) {
      if (!started) {
        started = true;
        onStart();
      }
      return x.value;
    }
    if (!started) {
      started = true;
      onStart();
    }
    onDelta(x.value.delta);
  }
}

// ---------- running ----------
let cwd: string | undefined;
/** Best-effort removal of the shared API-mode scratch dir; called when a proxy shuts down. */
export function disposeProxyScratch(): void {
  const dir = cwd;
  cwd = undefined;
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}
const SESSIONS_CAP = 500;
class SessionMap extends Map<string, { agent: string; id: string }> {
  // Evict-oldest cap: rewriting an existing key moves it to the newest position.
  set(key: string, v: { agent: string; id: string }): this {
    super.delete(key);
    const out = super.set(key, v);
    while (this.size > SESSIONS_CAP) {
      const oldest = this.keys().next();
      if (oldest.done) break;
      super.delete(oldest.value);
    }
    return out;
  }
}
export const sessions = new SessionMap();
export const est = (s?: string): number => Math.ceil((s || '').length / 4);
const HOLD = Symbol('hold');
const FINISH: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  stop: 'stop',
  max_tokens: 'length',
  length: 'length',
  tool_use: 'tool_calls',
  tool_calls: 'tool_calls',
  refusal: 'content_filter',
};

export async function* runAgent(o: any): AsyncGenerator<{ type: string; delta: string }, any, void> {
  const isAgent = o.mode === 'agent';
  if (!isAgent) cwd ||= mkdtempSync(path.join(tmpdir(), 'agentbridge-proxy-'));
  const { agent, model } = o.target;
  const aname = typeof agent === 'string' ? agent : agent.name;
  const t0 = Date.now();
  const tried = new Set<string>();
  let acct = o.pool?.pick(aname, o.sessionKey, tried) ?? null;
  if (o.pool?.has(aname) && !acct) {
    throw new AgentError('RATE_LIMITED', `every ${aname} account is cooling down`, {
      retryAfterMs: o.pool.retryAfterMs(aname),
    });
  }
  if (o.pool && acct) {
    getProactiveQuotaStatus(aname, undefined, { env: acct.env }).then((q) => {
      if (q && q.status === 'ok') {
        const measuredSession = q.measured === true && q.source !== 'unmetered' &&
          typeof q.usedPercent === 'number' && Number.isFinite(q.usedPercent);
        const measuredWeekly = q.measured === true && q.source !== 'unmetered' &&
          typeof q.secondaryPercent === 'number' && Number.isFinite(q.secondaryPercent);
        o.pool.updateQuota(aname, acct.name, {
          ...(measuredSession ? { sessionPercent: q.usedPercent! } : {}),
          ...(measuredWeekly ? { weeklyPercent: q.secondaryPercent! } : {}),
          ...(typeof q.resetAt === 'number' && Number.isFinite(q.resetAt) ? { resetsAt: q.resetAt } : {}),
          ...(measuredSession ? { isThrottled: !q.okToProceed } : {}),
        });
      }
    }).catch(() => {});
  }
  const keyOf = (name = aname) => (o.sessionKey ? `${name}:${acct ? acct.name + ':' : ''}${o.sessionKey}` : null);
  let key = keyOf(),
    known = key ? sessions.get(key) : undefined;
  if (!known && o.sessionKey) {
    for (const [k, v] of sessions.entries()) {
      if (k.endsWith(`:${o.sessionKey}`) && v?.id) {
        known = v;
        key = k;
        break;
      }
    }
  }
  const dispatchAgent = known?.agent && known.agent !== aname ? (agents.get(known.agent) || known.agent) : agent;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (o.signal?.aborted) ac.abort();
  else o.signal?.addEventListener('abort', onAbort, { once: true });
  const base: any = {
    systemPrompt: isAgent ? o.systemPrompt : [o.systemPrompt, NO_TOOLS].filter(Boolean).join('\n\n'),
    cwd: isAgent ? o.cwd : cwd,
    permissions: isAgent ? o.permissions || 'full' : 'read-only',
    signal: ac.signal,
    timeoutMs: o.timeoutMs || 300000,
  };
  if (model) base.model = model;
  if (isAgent && o.mcpServers) base.mcpServers = o.mcpServers;
  if (o.images?.length) base.images = o.images;
  if (o.jsonSchema) base.jsonSchema = o.jsonSchema;
  if (!isAgent) {
    if (aname === 'claude') base.extraArgs = ['--tools', ''];
    else if (aname === 'pi') base.extraArgs = ['-ne', '-np', '-ns'];
  }
  const holdMs = o.holdMs ?? (o.fallback?.length ? 1500 : 0),
    holdChars = o.holdChars ?? 160;
  let effort = o.effort,
    emptyRetried = false;
  try {
    for (;;) {
      const more = acct ? o.pool.available(aname, new Set([...tried, acct.name])) > 0 : 0;
      const env = o.env || acct ? { ...o.env, ...acct?.env } : null;
      const opts: RunOptions = {
        ...base,
        prompt: known && o.incremental ? o.incremental : o.prompt,
        session: key ? (known ? { mode: 'continue', id: known.id } : { mode: 'new' }) : { mode: 'ephemeral' },
        ...(env ? { env } : {}),
        ...(o.quotaPolicy ? { quotaPolicy: o.quotaPolicy } : {}),
        ...(o.fallback?.length && !more ? { fallback: o.fallback } : {}),
        ...(effort ? { effort } : {}),
      };
      const lim = createLimiter({ maxTokens: o.maxTokens, stop: o.stop });
      const toolCalls: any[] = [];
      let raw = '',
        sent = '',
        held = '',
        holding = holdMs > 0,
        holdSince = 0,
        sid: string | undefined,
        r: any,
        started = false,
        limited: any = null,
        nextP: Promise<any> | null = null;
      const out: string[] = [];
      const give = (t: string) => {
        if (t) {
          sent += t;
          out.push(t);
        }
      };
      const release = () => {
        if (holding) {
          holding = false;
          if (held) {
            started = true;
            give(held);
            held = '';
          }
        }
      };
      const route = (d: string) => {
        const x = lim.push(d);
        if (holding) {
          held += x.out;
          if (!holdSince) holdSince = Date.now();
          if (held.length >= holdChars) release();
        } else {
          if (x.out) started = true;
          give(x.out);
        }
        if (x.done) {
          limited = x.done;
          release();
          return true;
        }
        return false;
      };
      const it = run(dispatchAgent, opts);
      try {
        for (;;) {
          let x: any;
          if (!nextP) nextP = it.next();
          if (holding && held && holdSince) {
            let timer: NodeJS.Timeout | undefined;
            const wait = new Promise((res) => {
              timer = setTimeout(() => res(HOLD), Math.max(0, holdMs - (Date.now() - holdSince)));
            });
            const v = await Promise.race([nextP, wait]);
            clearTimeout(timer);
            if (v === HOLD) {
              release();
              for (const t of out.splice(0)) yield { type: 'text', delta: t };
              continue;
            }
            x = v;
          } else {
            x = await nextP;
          }
          nextP = null;
          if (x.done) {
            r = x.value;
            break;
          }
          const e = x.value;
          if (e.type === 'session') sid = e.id;
          else if (e.type === 'text') {
            raw += e.delta;
            const stopNow = route(e.delta);
            for (const t of out.splice(0)) yield { type: 'text', delta: t };
            if (stopNow) break;
          } else if (e.type === 'tool' && o.toolBridge) {
            if (e.output !== undefined) {
              if (toolCalls.length) {
                limited = { reason: 'tool_calls' };
                release();
                for (const t of out.splice(0)) yield { type: 'text', delta: t };
                break;
              }
            } else if (e.name?.startsWith(o.toolBridge.prefix)) {
              const safe = e.name.slice(o.toolBridge.prefix.length);
              toolCalls.push({
                id: callId(),
                name: o.toolBridge.names.get(safe) || safe,
                arguments: e.input && typeof e.input === 'object' ? e.input : {},
              });
            }
          } else if (e.type === 'fallback') {
            if (e.code === 'RATE_LIMITED' && acct && e.from === aname) o.pool.fail(aname, acct.name, e);
            if (started) throw new AgentError('RATE_LIMITED', `${e.from} failed mid-stream (${e.code}): ${e.message}`);
            raw = '';
            held = '';
            holdSince = 0;
          }
        }
      } catch (err: any) {
        if (acct && !started && err?.code === 'RATE_LIMITED' && !o.signal?.aborted) {
          o.pool.fail(aname, acct.name, err);
          tried.add(acct.name);
          const next = o.pool.pick(aname, o.sessionKey, tried);
          if (next) {
            acct = next;
            key = keyOf();
            known = key ? sessions.get(key) : undefined;
            continue;
          }
        }
        if (!started && effort && err?.code === 'BAD_OPTION' && /effort|variant/i.test(err.message)) {
          effort = undefined;
          continue;
        }
        if (
          !started &&
          !emptyRetried &&
          err?.code === 'AGENT_FAILED' &&
          /empty response/i.test(err.message) &&
          !o.signal?.aborted
        ) {
          emptyRetried = true;
          continue;
        }
        throw err;
      } finally {
        if (limited) ac.abort();
        if (limited || !r) (it as any).return?.()?.catch?.(() => {});
      }
      if (!limited) {
        if (r?.text && r.text.length > raw.length) {
          const tail = r.text.slice(raw.length);
          raw = r.text;
          route(tail);
        }
        if (!limited) {
          const f = lim.flush();
          release();
          if (f.out) {
            started = true;
            give(f.out);
          }
          if (f.done) limited = f.done;
        }
        for (const t of out.splice(0)) yield { type: 'text', delta: t };
      }
      sid = r?.sessionId || sid;
      const effectiveAgent = r?.fallback?.used || known?.agent || aname;
      if (acct) o.pool.ok(aname, acct.name);
      if (key && sid) sessions.set(key, { agent: effectiveAgent, id: sid });
      if (o.sessionKey && sid && effectiveAgent !== aname) {
        sessions.set(`${effectiveAgent}:${acct ? acct.name + ':' : ''}${o.sessionKey}`, { agent: effectiveAgent, id: sid });
      }
      const u = !limited && r?.usage ? r.usage : {};
      const finishReason = toolCalls.length
        ? 'tool_calls'
        : limited
        ? limited.reason === 'length'
          ? 'length'
          : 'stop'
        : FINISH[r?.stopReason] || 'stop';
      const usage = { input: u.input ?? est(o.prompt), output: u.output ?? est(sent) };
      o.stats?.record({
        agent: effectiveAgent,
        requestedAgent: aname,
        model: r?.model || model || null,
        account: acct?.name ?? null,
        mode: isAgent ? 'agent' : 'api',
        finish: finishReason,
        ms: Date.now() - t0,
        ...usage,
      });
      return {
        text: sent,
        usage,
        sessionId: sid,
        model: r?.model,
        finishReason,
        fallback: r?.fallback || null,
        effectiveAgent,
        ...(limited?.stopSequence ? { stopSequence: limited.stopSequence } : {}),
        ...(r?.stopReason ? { stopReason: r.stopReason } : {}),
        ...(toolCalls.length ? { toolCalls } : {}),
      };
    }
  } finally {
    o.signal?.removeEventListener?.('abort', onAbort);
  }
}

export async function runToEnd(o: any): Promise<any> {
  const it = runAgent(o);
  for (;;) {
    const x = await it.next();
    if (x.done) return x.value;
  }
}

export function mapError(e: any): HttpError {
  if (e instanceof HttpError) return e;
  const c = e?.code;
  const m = String(e?.message || e);
  if (c === 'BAD_OPTION') return new HttpError(400, m, 'invalid_request_error', 'bad_option');
  if (c === 'NOT_LOGGED_IN') return new HttpError(401, m, 'authentication_error', 'agent_not_logged_in');
  if (c === 'NOT_INSTALLED') return new HttpError(503, m, 'api_error', 'agent_not_installed');
  if (c === 'RATE_LIMITED')
    return new HttpError(
      429,
      m,
      'rate_limit_error',
      'rate_limited',
      e?.retryAfterMs != null ? Math.max(1, Math.ceil(e.retryAfterMs / 1000)) : null
    );
  if (c === 'TIMEOUT') return new HttpError(504, m, 'api_error', 'timeout');
  if (c === 'ABORTED') return new HttpError(499, m, 'api_error', 'aborted');
  return new HttpError(502, m, 'api_error', 'agent_failed');
}

// ---------- http helpers ----------
export async function readJson(req: any, limit = 20 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(c);
  }
  if (!n) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export function sendJson(res: any, status: number, body: any, headers: Record<string, string> = {}): void {
  const b = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(b),
    ...headers,
  });
  res.end(b);
}

export function sseStart(res: any, headers: Record<string, string> = {}): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...headers,
  });
  res.flushHeaders?.();
}

export const sseData = (res: any, obj: any, event?: string): void =>
  res.write((event ? `event: ${event}\n` : '') + `data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`);

/** AbortSignal that fires when the client goes away before we finish. */
export function clientAbort(res: any): AbortSignal {
  const ac = new AbortController();
  const cleanup = () => {
    res.removeListener?.('close', onClose);
    res.removeListener?.('finish', cleanup);
    ac.signal.removeEventListener('abort', cleanup);
  };
  const onClose = () => {
    cleanup();
    if (!res.writableFinished) ac.abort();
  };
  if (res.destroyed && !res.writableFinished) ac.abort();
  else {
    res.once('close', onClose);
    res.once('finish', cleanup);
    ac.signal.addEventListener('abort', cleanup, { once: true });
  }
  return ac.signal;
}

export function assertClientActive(signal: AbortSignal): void {
  if (signal.aborted) throw new HttpError(499, 'Client disconnected', 'api_error', 'aborted');
}

export function contentText(c: any): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c))
    return c
      .map((p) =>
        typeof p === 'string'
          ? p
          : p.type === 'text' || p.type === 'input_text' || p.type === 'output_text'
          ? p.text
          : p.type === 'image_url' || p.type === 'image' || p.type === 'input_image'
          ? '[image]'
          : ''
      )
      .filter(Boolean)
      .join('\n');
  return String(c.text ?? '');
}
