// HTTP "endpoint" agents: any OpenAI-compatible (chat/completions) or Anthropic-compatible (messages) base URL
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentError, retryAfterMs, retryHeaderMs } from '../core/errors.js';
import { resolveBinary } from '../core/spawn.js';
import { ev } from '../core/events.js';
import { validateOptions } from '../index.js';
import { home, scheduleRetention } from '../bridge/runs.js';
import { extractJson } from '../extras/schema.js';
import { AgentAdapter, AgentEvent, RunResult } from '../types/index.js';

export const BUILTIN = [
  'claude',
  'codex',
  'opencode',
  'agy',
  'pi',
  'cursor',
  'grok',
  'gemini',
  'devin',
  'acp',
] as const;
const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPENAI_EFFORT: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };
const busy = new Set<string>();

export const endpointsFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(home(env), 'endpoints.json');

function ollamaBase(env: NodeJS.ProcessEnv): string {
  const h = env.OLLAMA_HOST;
  if (!h) return 'http://127.0.0.1:11434/v1';
  const u = /^https?:\/\//i.test(h) ? h : `http://${h}`;
  return `${u.replace(/\/+$/, '')}/v1`;
}

export interface EndpointConfig {
  name: string;
  type: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  headers?: Record<string, string>;
  defaultModel?: string;
}

function normalize(name: string, c: any): EndpointConfig {
  const bad = (m: string) => new AgentError('BAD_OPTION', `endpoints.json "${name}": ${m}`);
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw bad('must be an object');
  const type = c.type ?? 'openai';
  if (!['openai', 'anthropic'].includes(type)) throw bad('type must be "openai" or "anthropic"');
  if (typeof c.baseUrl !== 'string' || !/^https?:\/\//i.test(c.baseUrl)) throw bad('baseUrl must be an http(s) URL');
  if (c.headers != null && (typeof c.headers !== 'object' || Array.isArray(c.headers))) throw bad('headers must be an object');
  for (const k of ['apiKey', 'apiKeyEnv', 'defaultModel']) {
    if (c[k] != null && typeof c[k] !== 'string') throw bad(`${k} must be a string`);
  }
  return {
    name,
    type,
    baseUrl: c.baseUrl.replace(/\/+$/, ''),
    apiKey: c.apiKey,
    apiKeyEnv: c.apiKeyEnv,
    headers: c.headers || {},
    defaultModel: c.defaultModel,
  };
}

export function loadEndpoints(env: NodeJS.ProcessEnv = process.env): Record<string, EndpointConfig> {
  let raw: any = {};
  try {
    raw = JSON.parse(readFileSync(endpointsFile(env), 'utf8'));
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw new AgentError('BAD_OPTION', `Cannot read ${endpointsFile(env)}: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new AgentError('BAD_OPTION', `${endpointsFile(env)} must be a JSON object {name: {baseUrl,...}}`);
  const out: Record<string, EndpointConfig> = {};
  if (!raw.ollama) out.ollama = normalize('ollama', { baseUrl: ollamaBase(env), defaultModel: env.OLLAMA_MODEL || undefined });
  for (const [n, c] of Object.entries(raw)) {
    if (!NAME_RE.test(n))
      throw new AgentError('BAD_OPTION', `Invalid endpoint name "${n}": use lowercase letters, digits and underscore, starting with a letter`);
    if ((BUILTIN as readonly string[]).includes(n)) throw new AgentError('BAD_OPTION', `Endpoint name "${n}" is reserved for a built-in agent`);
    out[n] = normalize(n, c);
  }
  return out;
}

export function endpointNames(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    return Object.keys(loadEndpoints(env));
  } catch {
    return ['ollama'];
  }
}

export function saveEndpoint(name: string, cfg: any, env: NodeJS.ProcessEnv = process.env): any {
  if (!NAME_RE.test(name) || (BUILTIN as readonly string[]).includes(name))
    throw new AgentError('BAD_OPTION', `Invalid or reserved endpoint name "${name}"`);
  normalize(name, cfg);
  let raw: Record<string, any> = {};
  try {
    raw = JSON.parse(readFileSync(endpointsFile(env), 'utf8'));
  } catch {
    /* new file */
  }
  raw[name] = cfg;
  const f = endpointsFile(env);
  mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(raw, null, 2));
  renameSync(tmp, f);
  return raw;
}

const sessDir = (env: NodeJS.ProcessEnv) => path.join(home(env), 'endpoint-sessions');
function readSession(id: string, env: NodeJS.ProcessEnv): any {
  try {
    return JSON.parse(readFileSync(path.join(sessDir(env), `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}
function writeSession(rec: any, env: NodeJS.ProcessEnv): void {
  scheduleRetention(env, { delayMs: 1500 });
  mkdirSync(sessDir(env), { recursive: true });
  const f = path.join(sessDir(env), `${rec.id}.json`),
    tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec));
  renameSync(tmp, f);
}

// Windows paths are case-insensitive: fold case (win32 only) when comparing recorded session cwds
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

function latestSession(endpoint: string, cwd: string, env: NodeJS.ProcessEnv): any {
  // Stat first (cheap), then read newest-first and stop at the first match instead of parsing every history file.
  const cands: { id: string; m: number }[] = [];
  try {
    for (const f of readdirSync(sessDir(env))) {
      if (!f.endsWith('.json') || !UUID.test(f.slice(0, -5))) continue;
      try {
        cands.push({ id: f.slice(0, -5), m: statSync(path.join(sessDir(env), f)).mtimeMs });
      } catch {
        /* raced */
      }
    }
  } catch {
    /* none */
  }
  cands.sort((a, b) => b.m - a.m);
  for (const c of cands.slice(0, 200)) {
    if (busy.has(c.id)) continue;
    const r = readSession(c.id, env);
    if (r && r.endpoint === endpoint && r.cwd && norm(r.cwd) === norm(cwd)) return r;
  }
  return undefined;
}

const headersFor = (cfg: EndpointConfig, env: NodeJS.ProcessEnv): Record<string, string> => {
  const key = cfg.apiKey || (cfg.apiKeyEnv ? env[cfg.apiKeyEnv] : undefined);
  const h: Record<string, string> = { 'content-type': 'application/json', ...(cfg.headers || {}) };
  if (key) {
    if (cfg.type === 'anthropic') h['x-api-key'] = key;
    else h.authorization = `Bearer ${key}`;
  }
  if (cfg.type === 'anthropic') h['anthropic-version'] = '2023-06-01';
  return h;
};

export const SSE_MAX_LINE = 16 * 1024 * 1024;

export async function* sse(res: Response, maxLine = SSE_MAX_LINE): AsyncGenerator<string, void, unknown> {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as any) {
    buf += dec.decode(chunk, { stream: true });
    if (buf.length > maxLine && buf.indexOf('\n') < 0)
      throw new AgentError('AGENT_FAILED', `SSE event exceeds ${maxLine} bytes without a newline; aborting stream`);
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  if (buf.startsWith('data:')) yield buf.slice(5).trim();
}

async function* runWithHarness(
  cfg: EndpointConfig,
  o: any,
  model: string | undefined,
  env: NodeJS.ProcessEnv,
  harness: string
): AsyncGenerator<AgentEvent, RunResult, void> {
  const A = cfg.name;
  const isAnthropicCompatible =
    cfg.type === 'anthropic' ||
    cfg.name === 'ollama' ||
    cfg.name === 'openrouter' ||
    /ollama|openrouter/i.test(cfg.baseUrl);

  const claudeBin = resolveBinary('claude', env);
  const piBin = resolveBinary('pi', env);

  if (harness === 'claude' && !claudeBin) {
    throw new AgentError('NOT_INSTALLED', `Harness "claude" requested for ${A}, but Claude Code CLI is not installed (npm i -g @anthropic-ai/claude-code)`, { agent: A });
  }
  if (harness === 'pi' && !piBin) {
    throw new AgentError('NOT_INSTALLED', `Harness "pi" requested for ${A}, but pi CLI is not installed (npm i -g @earendil-works/pi-coding-agent)`, { agent: A });
  }

  const useClaude = harness === 'claude' || (harness === 'auto' && isAnthropicCompatible && Boolean(claudeBin));
  const usePi = harness === 'pi' || (harness === 'auto' && !useClaude && Boolean(piBin));

  const { harness: _h, ...forwardOpts } = o;

  if (useClaude) {
    const claudeAdapter = (await import('./claude.js')).default;
    const anthropicBase = cfg.baseUrl.replace(/\/v1\/?$/, '');
    const authToken = cfg.apiKey || (cfg.apiKeyEnv ? env[cfg.apiKeyEnv] : undefined) || 'ollama';
    let targetModel = model || cfg.defaultModel;
    if (cfg.name === 'ollama' && targetModel?.startsWith('ollama/')) {
      targetModel = targetModel.slice('ollama/'.length);
    }
    const harnessEnv: NodeJS.ProcessEnv = {
      ...env,
      ...(o.env || {}),
      ANTHROPIC_BASE_URL: anthropicBase,
      ANTHROPIC_AUTH_TOKEN: authToken,
      ANTHROPIC_API_KEY: '',
      ...(targetModel ? { ANTHROPIC_MODEL: targetModel } : {}),
      ...(cfg.apiKey || cfg.apiKeyEnv ? { OPENROUTER_API_KEY: authToken } : {}),
    };
    const isolated = forwardOpts.isolated !== false;
    return yield* claudeAdapter.run({
      ...forwardOpts,
      isolated,
      ...(targetModel ? { model: targetModel } : {}),
      env: harnessEnv,
    });
  }

  if (usePi) {
    const piAdapter = (await import('./pi.js')).default;
    const apiKey = cfg.apiKey || (cfg.apiKeyEnv ? env[cfg.apiKeyEnv] : undefined);
    const piEnv: NodeJS.ProcessEnv = {
      ...env,
      ...(o.env || {}),
      ...(apiKey ? { OPENROUTER_API_KEY: apiKey } : {}),
    };
    let piModel = model || cfg.defaultModel;
    if (piModel) {
      if (cfg.name === 'ollama' && !piModel.startsWith('ollama/')) {
        piModel = `ollama/${piModel}`;
      } else if ((cfg.name === 'openrouter' || /openrouter/i.test(cfg.baseUrl)) && !piModel.startsWith('openrouter/')) {
        piModel = `openrouter/${piModel}`;
      }
    }
    return yield* piAdapter.run({
      ...forwardOpts,
      ...(piModel ? { model: piModel } : {}),
      env: piEnv,
    });
  }

  throw new AgentError(
    'NOT_INSTALLED',
    `Running ${A} with permissions "${o.permissions || 'edit'}" (or harness "${harness}") requires an agent execution harness. Please install Claude Code (npm i -g @anthropic-ai/claude-code) or pi (npm i -g @earendil-works/pi-coding-agent) so AgentBridge can execute filesystem and tool operations with ${A} models.`,
    { agent: A }
  );
}

export function makeEndpointAdapter(cfg: EndpointConfig): AgentAdapter {
  const A = cfg.name;
  const bad = (m: string) => new AgentError('BAD_OPTION', m, { agent: A });
  const adapter: AgentAdapter = {
    name: A,
    efforts: cfg.type === 'openai' ? Object.keys(OPENAI_EFFORT) : [],
    config: cfg,
    async models(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
      try {
        const r = await fetch(`${cfg.baseUrl}/models`, { headers: headersFor(cfg, env), signal: AbortSignal.timeout(8000) });
        if (!r.ok) return cfg.defaultModel ? [cfg.defaultModel] : [];
        const j = await r.json();
        const l = (j.data || j.models || []).map((m: any) => m.id || m.name).filter(Boolean);
        return l.length ? l : cfg.defaultModel ? [cfg.defaultModel] : [];
      } catch {
        return cfg.defaultModel ? [cfg.defaultModel] : [];
      }
    },
    async *run(opts: any): AsyncGenerator<AgentEvent, RunResult, void> {
      const o = validateOptions(opts);
      const env = { ...process.env, ...(o.env || {}) };
      const model = o.model || cfg.defaultModel || (await adapter.models!(env))[0];

      const selectedHarness = o.harness ?? 'auto';
      const wantsHarness =
        o.harness !== 'none' &&
        (Boolean(o.harness) ||
          (o.permissions !== 'read-only' && o.permissions !== 'plan') ||
          Boolean(o.mcpServers && Object.keys(o.mcpServers).length));

      if (wantsHarness) {
        return yield* runWithHarness(cfg, o, model, env, selectedHarness);
      }

      if (o.mcpServers && Object.keys(o.mcpServers).length) throw bad(`${A} is a plain chat endpoint: mcpServers is not supported`);
      if (o.extraArgs?.length) throw bad(`${A} is an HTTP endpoint: extraArgs is not supported in plain chat mode`);
      if (o.effort != null && cfg.type !== 'openai') throw bad(`${A} (anthropic-type endpoint) does not support effort`);
      if (o.jsonSchema && cfg.type !== 'openai') throw bad(`${A} (anthropic-type endpoint) does not support jsonSchema`);
      if (!model)
        throw bad(
          `${A}: no model given, no defaultModel configured and the endpoint lists none (set "model", or "defaultModel" in ${endpointsFile()})`
        );
      const cwd = path.resolve(o.cwd || process.cwd());
      const sess = o.session || { mode: 'new' };

      let prior: any[] = [],
        sid: string | undefined,
        srcId: string | undefined,
        claimed: string | null = null;
      if (sess.mode === 'continue' || sess.mode === 'fork') {
        if (sess.id && !UUID.test(sess.id)) throw bad('session.id must be a UUID');
        const rec = sess.id ? readSession(sess.id, env) : latestSession(A, cwd, env);
        if (!rec || rec.endpoint !== A)
          throw bad(sess.id ? `Unknown ${A} session "${sess.id}"` : `session mode "${sess.mode}" without id: no ${A} session for cwd ${cwd}`);
        prior = rec.messages;
        srcId = rec.id;
        if (sess.mode === 'continue') {
          if (busy.has(rec.id)) throw bad('session busy (in use by another continue)');
          sid = rec.id;
          claimed = rec.id;
          busy.add(rec.id);
        } else sid = randomUUID();
      } else if (sess.mode === 'new') sid = randomUUID();

      const t0 = Date.now(),
        ac = new AbortController();
      let timedOut = false,
        userAbort = false;
      const timer = o.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            ac.abort();
          }, o.timeoutMs)
        : null;
      const onAbort = () => {
        userAbort = true;
        ac.abort();
      };
      o.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        if (sid) yield ev.session(sid) as any;
        const userMsg = { role: 'user', content: o.prompt };
        const msgs = [...prior, userMsg];
        const chatModel = cfg.name === 'ollama' && model?.startsWith('ollama/') ? model.slice('ollama/'.length) : model;
        const body =
          cfg.type === 'openai'
            ? {
                model: chatModel,
                stream: true,
                stream_options: { include_usage: true },
                messages: [...(o.systemPrompt ? [{ role: 'system', content: o.systemPrompt }] : []), ...msgs],
                ...(o.effort ? { reasoning_effort: OPENAI_EFFORT[o.effort] } : {}),
                ...(o.jsonSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'output', schema: o.jsonSchema } } } : {}),
              }
            : { model: chatModel, stream: true, max_tokens: 8192, messages: msgs, ...(o.systemPrompt ? { system: o.systemPrompt } : {}) };
        const url =
          cfg.type === 'openai'
            ? `${cfg.baseUrl}/chat/completions`
            : cfg.baseUrl.endsWith('/v1')
            ? `${cfg.baseUrl}/messages`
            : `${cfg.baseUrl}/v1/messages`;
        let res: Response;
        try {
          res = await fetch(url, { method: 'POST', headers: headersFor(cfg, env), body: JSON.stringify(body), signal: ac.signal });
        } catch (e: any) {
          if (timedOut) throw new AgentError('TIMEOUT', `${A} timed out after ${o.timeoutMs}ms`, { agent: A });
          if (userAbort || o.signal?.aborted) throw new AgentError('ABORTED', 'Aborted', { agent: A });
          throw new AgentError(
            'AGENT_FAILED',
            `Cannot reach ${A} at ${cfg.baseUrl}: ${e.cause?.code || e.message}${A === 'ollama' ? ' (is `ollama serve` running?)' : ''}`,
            { agent: A }
          );
        }
        if (!res.ok) {
          const t = (await res.text().catch(() => '')).slice(0, 500);
          const msg = `${A} HTTP ${res.status}: ${t}`;
          yield ev.error(msg) as any;
          const code =
            res.status === 429 || res.status === 529
              ? 'RATE_LIMITED'
              : res.status === 401 || res.status === 403
              ? 'NOT_LOGGED_IN'
              : (res.status === 404 || res.status === 400) && /model/i.test(t)
              ? 'BAD_OPTION'
              : 'AGENT_FAILED';
          throw new AgentError(code, msg, {
            agent: A,
            status: res.status,
            ...(code === 'RATE_LIMITED'
              ? { retryAfterMs: retryHeaderMs(res.headers.get('retry-after')) ?? retryAfterMs(t) }
              : {}),
          });
        }
        let text = '',
          usedModel = model,
          usage: any = null,
          inTok = 0,
          outTok = 0;
        try {
          for await (const data of sse(res)) {
            if (data === '[DONE]') break;
            let j: any;
            try {
              j = JSON.parse(data);
            } catch {
              continue;
            }
            if (j.error) {
              const m = typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error);
              yield ev.error(m) as any;
              throw new AgentError('AGENT_FAILED', `${A}: ${m}`, { agent: A });
            }
            if (cfg.type === 'openai') {
              if (j.model) usedModel = j.model;
              const d = j.choices?.[0]?.delta;
              const th = d?.reasoning_content ?? d?.reasoning;
              if (th) yield ev.thinking(th) as any;
              if (d?.content) {
                text += d.content;
                yield ev.text(d.content) as any;
              }
              if (j.usage) usage = { input: j.usage.prompt_tokens || 0, output: j.usage.completion_tokens || 0 };
            } else {
              if (j.type === 'message_start') {
                usedModel = j.message?.model || usedModel;
                inTok = j.message?.usage?.input_tokens || 0;
              } else if (j.type === 'content_block_delta') {
                if (j.delta?.type === 'text_delta' && j.delta.text) {
                  text += j.delta.text;
                  yield ev.text(j.delta.text) as any;
                } else if (j.delta?.type === 'thinking_delta' && j.delta.thinking) yield ev.thinking(j.delta.thinking) as any;
              } else if (j.type === 'message_delta') outTok = j.usage?.output_tokens ?? outTok;
              else if (j.type === 'error') {
                const m = j.error?.message || 'stream error';
                yield ev.error(m) as any;
                throw new AgentError('AGENT_FAILED', `${A}: ${m}`, { agent: A });
              }
            }
          }
        } catch (e) {
          if (e instanceof AgentError) throw e;
          if (timedOut) throw new AgentError('TIMEOUT', `${A} timed out after ${o.timeoutMs}ms`, { agent: A });
          if (userAbort || o.signal?.aborted) throw new AgentError('ABORTED', 'Aborted', { agent: A });
          throw new AgentError('AGENT_FAILED', `${A} stream failed: ${(e as any).message}`, { agent: A });
        }
        if (cfg.type === 'anthropic') usage = { input: inTok, output: outTok };
        if (!usage)
          usage = {
            input: Math.ceil((o.prompt.length + prior.reduce((n, m) => n + m.content.length, 0)) / 4),
            output: Math.ceil(text.length / 4),
            estimated: true,
          };
        yield ev.usage(usage.input, usage.output) as any;
        if (sid && sess.mode !== 'ephemeral') {
          writeSession(
            {
              id: sid,
              endpoint: A,
              model: usedModel,
              cwd,
              updatedAt: Date.now(),
              messages: [...msgs, { role: 'assistant', content: text }],
              ...(srcId && sess.mode === 'fork' ? { forkedFrom: srcId } : {}),
            },
            env
          );
        }
        let structured: any;
        if (o.jsonSchema) {
          const x = extractJson(text);
          if (x.ok) structured = x.value;
        }
        return {
          text,
          sessionId: sess.mode === 'ephemeral' ? undefined : sid,
          usage,
          exitCode: 0,
          model: usedModel,
          durationMs: Date.now() - t0,
          timedOut: false,
          ...(structured !== undefined ? { structured } : {}),
        };
      } finally {
        if (timer) clearTimeout(timer);
        o.signal?.removeEventListener('abort', onAbort);
        ac.abort();
        if (claimed) busy.delete(claimed);
      }
    },
  };
  return adapter;
}
