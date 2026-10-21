// agentbridge compat proxy: OpenAI + Anthropic compatible HTTP API over the local agent CLIs
import http from 'node:http';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { listTrackedRuns } from '../telemetry/stats.js';
import { HttpError, sendJson, listModels, disposeProxyScratch, sessions } from './common.js';
import { DEFAULT_TTL_MS, parseDuration, removeLeftoverClaudeProjects } from './sessions.js';
import * as openai from './openai.js';
import * as anthropic from './anthropic.js';
import { createConfig, ConfigHolder, ProxyConfig } from './config.js';
import { handleAgentRoutes, disposeAgentRuns, createAgentStore, AgentStore } from './agent.js';
import { createStats } from './stats.js';
import { createPool, assertAccepted, TOS_WARNING, AccountPool } from './pool.js';
import type { QuotaPolicy } from '../types/index.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function authOk(req: http.IncomingMessage, token?: string): boolean {
  if (!token) return true;
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key'] || '';
  const a = Buffer.from(String(got)),
    b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface ProxyOptions {
  port?: number;
  host?: string;
  token?: string;
  allowNonLoopback?: boolean;
  cfg?: ConfigHolder;
  config?: Partial<ProxyConfig>;
  configFile?: string;
  agentRoot?: string;
  maxPermission?: any;
  accounts?: any;
  acceptTosRisk?: boolean;
  logFile?: string;
  adapters?: Record<string, any>;
  fallback?: any;
  timeoutMs?: number;
  quotaPolicy?: QuotaPolicy;
  agentStore?: AgentStore;
  sessionStore?: Map<string, { agent: string; id: string }>;
  /** Idle TTL of keyed (x-ab-session) sessions in ms; default 7 days, 0 = keep forever. */
  sessionTtlMs?: number;
  /** Persisted key->session map; default <AGENTBRIDGE_HOME>/proxy-sessions.json, false = in-memory only. */
  sessionsFile?: string | false;
  /** Max keyed sessions kept (default 500). */
  sessionCap?: number;
  /** At startup also remove leftover claude scratch project dirs (agentbridge-proxy-*) older than the TTL. */
  pruneLeftovers?: boolean;
}

export interface RunningProxy {
  server: http.Server;
  port: number;
  url: string;
  cfg: ConfigHolder;
  close: () => Promise<void>;
}

/**
 * startProxy({port=0, host='127.0.0.1', token, allowNonLoopback=false, timeoutMs, fallback}) -> {server, url, port, close()}
 */
export async function startProxy(o: ProxyOptions = {}): Promise<RunningProxy> {
  let quotaPolicy: QuotaPolicy | undefined;
  if (o.quotaPolicy !== undefined) {
    const raw = o.quotaPolicy as any;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('quotaPolicy must be an object');
    const unknownPolicyKeys = Object.keys(raw).filter((key) => !['minRemainingPercent', 'waitForReset', 'maxWaitMs'].includes(key));
    if (unknownPolicyKeys.length) throw new Error(`quotaPolicy has unknown field(s): ${unknownPolicyKeys.join(', ')}`);
    if (typeof raw.minRemainingPercent !== 'number' || !Number.isFinite(raw.minRemainingPercent) || raw.minRemainingPercent < 0 || raw.minRemainingPercent > 100) {
      throw new Error('quotaPolicy.minRemainingPercent must be a finite percentage in [0,100]');
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'waitForReset') && typeof raw.waitForReset !== 'boolean') {
      throw new Error('quotaPolicy.waitForReset must be a boolean');
    }
    if (Object.prototype.hasOwnProperty.call(raw, 'maxWaitMs') && (typeof raw.maxWaitMs !== 'number' || !Number.isFinite(raw.maxWaitMs) || raw.maxWaitMs <= 0)) {
      throw new Error('quotaPolicy.maxWaitMs must be a positive finite number');
    }
    quotaPolicy = {
      minRemainingPercent: raw.minRemainingPercent,
      ...(raw.waitForReset !== undefined ? { waitForReset: raw.waitForReset } : {}),
      ...(raw.maxWaitMs !== undefined ? { maxWaitMs: raw.maxWaitMs } : {}),
    };
  }
  const host = o.host || '127.0.0.1';
  if (!LOOPBACK.has(host) && !o.allowNonLoopback) {
    throw new Error(
      `Refusing to bind non-loopback host "${host}" (pass allowNonLoopback: true / --allow-non-loopback; this exposes your CLI logins to the network)`
    );
  }
  const cfg =
    o.cfg ||
    createConfig(
      {
        ...(o.config || {}),
        ...(o.agentRoot ? { agentRoot: o.agentRoot } : {}),
        ...(o.maxPermission ? { maxPermission: o.maxPermission } : {}),
      },
      { file: o.configFile }
    );
  if (o.configFile) cfg.watch((e) => console.error(`agentbridge: config reload failed, keeping the previous one: ${e.message}`));
  const rawAccounts = o.accounts ?? cfg.get().accounts;
  let pool: AccountPool | null = null;
  if (rawAccounts) {
    assertAccepted(o.acceptTosRisk);
    pool = createPool(rawAccounts);
    console.error(TOS_WARNING);
  }
  const ttlMs = o.sessionTtlMs ?? DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new Error('sessionTtlMs must be a non-negative number');
  sessions.attach({ file: o.sessionsFile, ttlMs, ...(o.sessionCap !== undefined ? { cap: o.sessionCap } : {}) });
  if (o.pruneLeftovers && ttlMs > 0) {
    try {
      removeLeftoverClaudeProjects(ttlMs);
    } catch {
      /* best-effort */
    }
  }
  const stats = createStats({ logFile: o.logFile });
  const agentStore = o.agentStore || createAgentStore();
  const sessionStore = o.sessionStore || new Map<string, { agent: string; id: string }>();
  const opts = {
    timeoutMs: o.timeoutMs || 300000,
    ...(quotaPolicy ? { quotaPolicy } : {}),
    stats,
    cfg,
    adapters: o.adapters,
    token: o.token,
    agentStore,
    sessionStore,
    ...(pool ? { pool } : {}),
    ...(o.fallback ? { fallback: o.fallback } : {}),
  };
  let port = o.port ?? 0;
  const hostOk = (h?: string) => {
    if (o.allowNonLoopback) return true;
    const m = /^(\[::1\]|[^:]+)(?::(\d+))?$/.exec(h || '');
    return !!m && LOOPBACK.has(m[1].replace(/^\[|\]$/g, '')) && (!m[2] || +m[2] === port);
  };
  const server = http.createServer(async (req, res) => {
    if (!hostOk(req.headers.host)) return sendJson(res, 403, { error: 'bad host' });
    let url = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    if (url.startsWith('/agent/v1/') || url === '/agent/v1') {
      (req as any).abMode = 'agent';
      url = url.slice('/agent'.length);
    }
    const anth = !!req.headers['anthropic-version'] || !!req.headers['x-api-key'];
    const errBody = (e: any) =>
      anth || url.startsWith('/v1/messages') ? anthropic.anthropicError(e) : openai.openaiError(e);
    try {
      if (!authOk(req, o.token))
        throw new HttpError(401, 'Invalid or missing API key', 'authentication_error', 'invalid_api_key');
      if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
        const ids = await listModels();
        if (anth) {
          return sendJson(res, 200, {
            data: ids.map((id) => ({
              type: 'model',
              id,
              display_name: id,
              created_at: '1970-01-01T00:00:00Z',
            })),
            has_more: false,
            first_id: ids[0] ?? null,
            last_id: ids.at(-1) ?? null,
          });
        }
        return openai.models(req, res);
      }
      if (req.method === 'GET' && url === '/admin/status') {
        if (!o.token && !LOOPBACK.has(host)) throw new HttpError(403, 'admin needs a token', 'permission_error', 'admin_needs_token');
        return sendJson(res, 200, { ok: true, pool: pool ? pool.status() : null });
      }
      if (req.method === 'GET' && url === '/admin/usage') {
        if (!o.token && !LOOPBACK.has(host)) throw new HttpError(403, 'admin needs a token', 'permission_error', 'admin_needs_token');
        return sendJson(res, 200, stats.summary());
      }
      if (await handleAgentRoutes(req, res, url, opts)) return;
      if (req.method === 'GET' && url === '/') return sendJson(res, 200, { ok: true, service: 'agentbridge-proxy' });
      if (await openai.handle(req, res, url, opts)) return;
      if (await anthropic.handle(req, res, url, opts)) return;
      throw new HttpError(404, `Unknown route ${req.method} ${url}`, 'invalid_request_error', 'not_found');
    } catch (e: any) {
      const he = e instanceof HttpError ? e : new HttpError(500, String(e?.message || e), 'api_error');
      if (!res.headersSent)
        sendJson(res, he.status, errBody(he), he.retryAfter != null ? { 'retry-after': String(he.retryAfter) } : {});
      else res.end();
    }
  });
  await new Promise<void>((ok, bad0) => {
    const bad = (e: Error) => {
      sessions.detach();
      bad0(e);
    };
    server.once('error', bad);
    // Per-request run records are only pruned when listed; trim them at startup so a proxy-only deployment cannot grow forever.
    try {
      listTrackedRuns(process.env, { limit: 0 });
    } catch {
      /* best-effort */
    }
    server.listen(o.port ?? 0, host, () => ok());
  });
  port = (server.address() as any).port;
  return {
    server,
    port,
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    cfg,
    close: () =>
      new Promise<void>((r) => {
        cfg.close();
        sessions.detach();
        disposeAgentRuns(agentStore);
        disposeProxyScratch();
        server.close(() => r());
        (server as any).closeAllConnections?.();
      }),
  };
}

const isServerEntry = () => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
};

if (isServerEntry()) {
  const a = process.argv.slice(2),
    get = (k: string) => {
      const i = a.indexOf(k);
      return i >= 0 ? a[i + 1] : undefined;
    };
  startProxy({
    port: Number(get('--port') ?? 8787),
    host: get('--host'),
    token: get('--token') || process.env.AGENTBRIDGE_TOKEN,
    allowNonLoopback: a.includes('--allow-non-loopback'),
    configFile: get('--config'),
    agentRoot: get('--agent-root'),
    maxPermission: get('--agent-max-permission'),
    accounts: get('--accounts') ? JSON.parse(readFileSync(get('--accounts')!, 'utf8')) : undefined,
    acceptTosRisk: a.includes('--accept-tos-risk'),
    logFile: get('--log'),
    ...(get('--session-ttl') !== undefined ? { sessionTtlMs: parseDuration(get('--session-ttl')!) } : {}),
    pruneLeftovers: true,
  }).then(
    (p) => console.log(`agentbridge proxy listening on ${p.url}`),
    (e) => {
      console.error(e.message);
      process.exit(1);
    }
  );
}
