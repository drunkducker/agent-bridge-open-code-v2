import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ProactiveQuotaHealth, QuotaQueryOptions } from './proactive.js';

const CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com/v1internal';
const DEFAULT_MODEL = 'gemini-3.5-flash';
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_THRESHOLD_PERCENT = 95;

interface GeminiBucket {
  modelId?: unknown;
  tokenType?: unknown;
  remainingFraction?: unknown;
  resetTime?: unknown;
}

function health(
  status: NonNullable<ProactiveQuotaHealth['status']>,
  error: string,
  options: QuotaQueryOptions,
  values: Partial<ProactiveQuotaHealth> = {},
): ProactiveQuotaHealth {
  return {
    agent: 'gemini',
    usedPercent: null,
    windowMinutes: 0,
    resetAt: null,
    okToProceed: false,
    measured: false,
    supported: true,
    source: 'live',
    status,
    error,
    ...values,
  };
}

function cliConfigDir(options: QuotaQueryOptions, env: NodeJS.ProcessEnv): string {
  if (options.profileDir) return options.profileDir;
  const cliHome = env.GEMINI_CLI_HOME;
  const home = cliHome || env.HOME || env.USERPROFILE || homedir();
  return path.join(home, '.gemini');
}

function readJson(filePath: string): any | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function hasExplicitNonOAuthIdentity(settings: any): boolean {
  const selected = settings?.security?.auth?.selectedType ?? settings?.selectedAuthType;
  const enforced = settings?.security?.auth?.enforcedType;
  const values = [selected, enforced].filter((v): v is string => typeof v === 'string' && v.length > 0);
  return values.some((v) => v !== 'oauth-personal');
}

function isVertexEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.GOOGLE_GENAI_USE_VERTEXAI;
  return typeof value === 'string' && /^(1|true|yes)$/i.test(value.trim());
}

function resetTime(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requestSignal(options: QuotaQueryOptions): AbortSignal {
  const requested = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? Math.min(MAX_TIMEOUT_MS, Math.ceil(requested))
    : DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

async function postJson(
  method: 'loadCodeAssist' | 'retrieveUserQuota',
  accessToken: string,
  body: Record<string, unknown>,
  options: QuotaQueryOptions,
  signal: AbortSignal,
): Promise<any> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${CODE_ASSIST_BASE}:${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch {
    throw new Error(signal.aborted ? 'Request was cancelled or timed out' : 'Google quota request failed');
  }
  if (!response.ok) throw new Error(`Google quota request failed (HTTP ${response.status})`);
  try {
    return await response.json();
  } catch {
    throw new Error('Google quota response was not valid JSON');
  }
}

/**
 * Read Gemini Code Assist OAuth quota for the exact model selected by the agent.
 * This endpoint and its quota response are internal Gemini CLI interfaces, not
 * a public Google API. Credential files are read-only; this reader never refreshes
 * tokens, invokes the CLI, or accesses an OS keychain.
 */
export async function queryGeminiQuota(options: QuotaQueryOptions = {}): Promise<ProactiveQuotaHealth> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };
  const threshold = options.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT;

  if (env.AGENTBRIDGE_OFFLINE === '1' || env.AGENTBRIDGE_PROACTIVE_MOCK === '1') {
    return health('offline', 'Quota lookup disabled in offline/mock mode', options, { source: 'offline' });
  }

  if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || isVertexEnabled(env)) {
    return health('unknown', 'Gemini API-key or Vertex AI quota is not measured by Code Assist', options);
  }

  const configDir = cliConfigDir(options, env);
  const settings = readJson(path.join(configDir, 'settings.json'));
  if (hasExplicitNonOAuthIdentity(settings)) {
    return health('unknown', 'Gemini is configured for API-key or Vertex AI authentication', options);
  }

  const credentials = readJson(path.join(configDir, 'oauth_creds.json'));
  const accessToken = typeof credentials?.access_token === 'string' ? credentials.access_token : '';
  if (!accessToken) {
    return health('unknown', 'Gemini OAuth file credentials are unavailable', options);
  }
  const expiryDate = Number(credentials?.expiry_date);
  if (!Number.isFinite(expiryDate) || expiryDate <= Date.now()) {
    return health('unknown', 'Gemini OAuth access token is expired or has no expiry', options);
  }

  const signal = requestSignal(options);
  try {
    const project = env.GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT_ID;
    const loadRequest: Record<string, unknown> = {
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      },
    };
    if (project) loadRequest.cloudaicompanionProject = project;
    const loaded = await postJson('loadCodeAssist', accessToken, loadRequest, options, signal);
    const resolvedProject = typeof loaded?.cloudaicompanionProject === 'string'
      ? loaded.cloudaicompanionProject
      : '';
    if (!resolvedProject) return health('unknown', 'Gemini Code Assist project is unavailable', options);

    const quota = await postJson('retrieveUserQuota', accessToken, { project: resolvedProject }, options, signal);
    const model = options.model || env.GEMINI_MODEL || DEFAULT_MODEL;
    const buckets: GeminiBucket[] = Array.isArray(quota?.buckets) ? quota.buckets : [];
    const requestBuckets = buckets.filter((bucket) => bucket?.modelId === model && bucket?.tokenType === 'REQUESTS');
    if (requestBuckets.length === 0) {
      return health('unknown', `Gemini quota is unavailable for model ${model}`, options);
    }
    if (requestBuckets.some((bucket) =>
      typeof bucket.remainingFraction !== 'number' || !Number.isFinite(bucket.remainingFraction) ||
      bucket.remainingFraction < 0 || bucket.remainingFraction > 1,
    )) {
      return health('unknown', `Gemini quota is invalid for model ${model}`, options);
    }

    // Multiple matching request buckets are treated conservatively: use the
    // lowest remaining fraction and the latest reset among applicable buckets.
    const remaining = Math.min(...requestBuckets.map((bucket) => bucket.remainingFraction as number));
    // Keep useful precision while removing only floating-point representation noise.
    const usedPercent = Number(((1 - remaining) * 100).toFixed(8));
    const resets = requestBuckets.map((bucket) => resetTime(bucket.resetTime)).filter((v): v is number => v !== null);
    const resetAt = resets.length ? Math.max(...resets) : null;
    const blocked = usedPercent >= threshold;
    return health('ok', '', options, {
      usedPercent,
      measured: true,
      resetAt,
      okToProceed: !blocked,
      status: 'ok',
      error: undefined,
      blockingWindow: blocked ? 'primary' : null,
    });
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith('Google quota')
      ? error.message
      : signal.aborted
        ? 'Request was cancelled or timed out'
        : 'Google quota request failed';
    return health('error', message, options);
  }
}
