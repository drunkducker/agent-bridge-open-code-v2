import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Direct proactive quota querying before hitting 429 errors (inspired by Orca).
// Queries provider usage APIs (Anthropic OAuth usage API, ChatGPT backend API)
// with threshold-based health status and fallback mock/fixture support.

export const ANTHROPIC_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

export interface AnthropicUsage {
  fiveHourPercent: number;
  sevenDayPercent: number;
  fiveHourResetsAt: number | null;
  sevenDayResetsAt: number | null;
  fiveHour?: { usedPercent: number; resetsAt: number | null };
  sevenDay?: { usedPercent: number; resetsAt: number | null };
  fiveHourMeasured?: boolean;
  sevenDayMeasured?: boolean;
  status?: 'ok' | 'error' | 'offline' | 'unknown';
  error?: string;
  raw?: any;
}

export interface CodexUsage {
  primaryPercent: number;
  resetsAt: number | null;
  secondaryPercent?: number;
  secondaryResetsAt?: number | null;
  primaryMeasured?: boolean;
  secondaryMeasured?: boolean;
  windowMinutes: number;
  status?: 'ok' | 'error' | 'offline' | 'unknown';
  error?: string;
  raw?: any;
}

export interface ProactiveQuotaHealth {
  agent: string;
  usedPercent: number | null;
  secondaryPercent?: number;
  secondaryResetAt?: number | null;
  measured?: boolean;
  supported?: boolean;
  source?: 'live' | 'fixture' | 'offline' | 'unmetered' | 'custom';
  windowMinutes: number;
  resetAt: number | null;
  okToProceed: boolean;
  status?: 'ok' | 'error' | 'offline' | 'unknown';
  error?: string;
  blockingWindow?: 'primary' | 'secondary' | null;
}

export interface QuotaQueryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  fixture?: any;
  thresholdPercent?: number;
  env?: NodeJS.ProcessEnv;
  profileDir?: string;
  /** The selected route model, when quota is model-specific. */
  model?: string;
}

const registeredFixtures = new Map<string, any>();

export const DEFAULT_MOCK_FIXTURES: Record<string, any> = {
  claude: {
    five_hour: { used_percentage: 15, resets_at: Date.now() + 300 * 60 * 1000 },
    seven_day: { used_percentage: 10, resets_at: Date.now() + 7 * 24 * 3600 * 1000 },
  },
  codex: {
    primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: Date.now() + 18000 * 1000 },
    secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: Date.now() + 604800 * 1000 },
  },
};

export function setQuotaFixture(agent: string, fixture: any): void {
  registeredFixtures.set(agent.toLowerCase(), fixture);
}

export function clearQuotaFixtures(): void {
  registeredFixtures.clear();
}

/** Whether an agent has a quota reader (or an explicit fixture) for percentage thresholds. */
export function supportsProactiveQuota(agent: string): boolean {
  const norm = agent.toLowerCase().trim();
  return ['claude', 'anthropic', 'codex', 'chatgpt', 'openai', 'agy', 'antigravity', 'gemini'].includes(norm) ||
    registeredFixtures.has(norm);
}

export function parseResetTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 1e11 ? Math.round(v) : Math.round(v * 1000);
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

function measuredPercent(v: unknown): number | undefined {
  if ((typeof v !== 'number' && typeof v !== 'string') || (typeof v === 'string' && !v.trim())) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
}

export function parseAnthropicUsage(data: any): AnthropicUsage {
  const fiveHour = data?.five_hour || data?.session;
  const sevenDay = data?.seven_day || data?.weekly;

  // The live OAuth usage endpoint reports `utilization`; the fixtures and older shapes use used_percentage.
  const fiveRaw = fiveHour?.utilization ?? fiveHour?.used_percentage ?? fiveHour?.used_percent;
  const sevenRaw = sevenDay?.utilization ?? sevenDay?.used_percentage ?? sevenDay?.used_percent;
  const fiveValue = measuredPercent(fiveRaw);
  const sevenValue = measuredPercent(sevenRaw);
  const fiveHourMeasured = fiveValue !== undefined;
  const sevenDayMeasured = sevenDay ? sevenValue !== undefined : undefined;
  const fiveHourPercent = fiveValue ?? 0;
  const sevenDayPercent = sevenValue ?? 0;
  const fiveHourResetsAt = parseResetTime(fiveHour?.resets_at || fiveHour?.reset_at);
  const sevenDayResetsAt = parseResetTime(sevenDay?.resets_at || sevenDay?.reset_at);

  return {
    fiveHourPercent,
    sevenDayPercent,
    fiveHourResetsAt,
    sevenDayResetsAt,
    fiveHour: fiveHour ? { usedPercent: fiveHourPercent, resetsAt: fiveHourResetsAt } : undefined,
    sevenDay: sevenDay ? { usedPercent: sevenDayPercent, resetsAt: sevenDayResetsAt } : undefined,
    fiveHourMeasured,
    sevenDayMeasured,
    status: fiveHourMeasured && sevenDayMeasured !== false ? undefined : 'unknown',
    raw: data,
  };
}

export function parseCodexUsage(data: any): CodexUsage {
  // The live ChatGPT usage endpoint nests the windows under rate_limit.
  const root = data?.rate_limit || data;
  const primary = root?.primary_window || data?.session || data?.rate_limits?.session;
  const secondary = root?.secondary_window || data?.weekly || data?.rate_limits?.weekly;

  const primaryRaw = primary?.used_percent ?? primary?.used_percentage;
  const secondaryRaw = secondary?.used_percent ?? secondary?.used_percentage;
  const primaryValue = measuredPercent(primaryRaw);
  const secondaryValue = measuredPercent(secondaryRaw);
  const primaryMeasured = primaryValue !== undefined;
  const secondaryMeasured = secondary ? secondaryValue !== undefined : undefined;
  const primaryPercent = primaryValue ?? 0;
  const secondaryPercent = secondaryMeasured ? secondaryValue : undefined;
  const resetsAt = parseResetTime(primary?.reset_at || primary?.resets_at);
  const secondaryResetsAt = parseResetTime(secondary?.reset_at || secondary?.resets_at);
  const windowMinutes = Math.round((primary?.limit_window_seconds || 18000) / 60);

  return {
    primaryPercent,
    resetsAt,
    secondaryPercent,
    secondaryResetsAt,
    primaryMeasured,
    secondaryMeasured,
    windowMinutes,
    status: primaryMeasured && secondaryMeasured !== false ? undefined : 'unknown',
    raw: data,
  };
}

function isMockOrOffline(agent: string, options?: QuotaQueryOptions): boolean {
  if (options?.fixture !== undefined) return true;
  if (registeredFixtures.has(agent.toLowerCase())) return true;
  if (options?.env?.AGENTBRIDGE_OFFLINE === '1' || options?.env?.AGENTBRIDGE_PROACTIVE_MOCK === '1' ||
      process.env.AGENTBRIDGE_OFFLINE === '1' || process.env.AGENTBRIDGE_PROACTIVE_MOCK === '1') return true;
  return false;
}

function readJsonFile(file: string): any {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Claude Code writes its login to <CLAUDE_CONFIG_DIR>/.credentials.json (default ~/.claude),
// with the token nested under claudeAiOauth. A profile dir (ab account add) is searched
// instead of the default home, so one account never reads another's login.
function claudeCredentialFiles(options: QuotaQueryOptions): string[] {
  const configDir =
    options.env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  const dir = options.profileDir || configDir;
  return [path.join(dir, '.credentials.json'), path.join(dir, 'credentials.json')];
}

// Codex writes its login to <CODEX_HOME>/auth.json (default ~/.codex), with the token under tokens.
function codexAuthFiles(options: QuotaQueryOptions): string[] {
  const codexHome = options.env?.CODEX_HOME || process.env.CODEX_HOME || path.join(homedir(), '.codex');
  const dir = options.profileDir || codexHome;
  return [path.join(dir, 'auth.json'), path.join(dir, '.auth')];
}

function claudeTokenFrom(c: any): string | undefined {
  return c?.claudeAiOauth?.accessToken || c?.accessToken || c?.token || c?.sessionToken || c?.apiKey || undefined;
}

function explicitToken(options: QuotaQueryOptions, direct: string | undefined, names: string[], allowProcessFallback = true): string | undefined {
  if (direct !== undefined) return direct || undefined;
  const env = options.env;
  if (env && names.some((name) => Object.prototype.hasOwnProperty.call(env, name))) {
    for (const name of names) if (env[name]) return env[name];
    return undefined;
  }
  if (allowProcessFallback) for (const name of names) if (process.env[name]) return process.env[name];
  return undefined;
}

function quotaSource(agent: string, options: QuotaQueryOptions): ProactiveQuotaHealth['source'] {
  const fixtureAliases = agent === 'claude' ? ['claude', 'anthropic'] : agent === 'codex' ? ['codex', 'chatgpt'] : [agent];
  if (options.fixture !== undefined || fixtureAliases.some((name) => registeredFixtures.has(name))) return 'fixture';
  if (options.env?.AGENTBRIDGE_OFFLINE === '1' || options.env?.AGENTBRIDGE_PROACTIVE_MOCK === '1' ||
      process.env.AGENTBRIDGE_OFFLINE === '1' || process.env.AGENTBRIDGE_PROACTIVE_MOCK === '1') return 'offline';
  return 'live';
}

export async function fetchAnthropicUsage(
  token: string,
  options: QuotaQueryOptions = {}
): Promise<AnthropicUsage> {
  if (options.fixture) {
    return parseAnthropicUsage(options.fixture);
  }

  const registered = registeredFixtures.get('claude') || registeredFixtures.get('anthropic');
  if (registered) {
    return parseAnthropicUsage(registered);
  }

  if (isMockOrOffline('claude', options)) {
    return parseAnthropicUsage(DEFAULT_MOCK_FIXTURES.claude);
  }

  const timeoutMs = options.timeoutMs ?? 8000;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const f = options.fetchImpl || globalThis.fetch;

  try {
    const res = await f(ANTHROPIC_OAUTH_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'agentbridge/0.2.0',
      },
      signal,
    });
    if (!res.ok) {
      if (options.fixture || registeredFixtures.has('claude')) {
        return parseAnthropicUsage(DEFAULT_MOCK_FIXTURES.claude);
      }
      return {
        fiveHourPercent: 0,
        sevenDayPercent: 0,
        fiveHourResetsAt: null,
        sevenDayResetsAt: null,
        status: 'error',
        error: `HTTP ${res.status}: ${res.statusText || 'request failed'}`,
        raw: null,
      };
    }
    const body = await res.json();
    const parsed = parseAnthropicUsage(body);
    parsed.status ||= 'ok';
    return parsed;
  } catch (e: any) {
    if (options.fixture || registeredFixtures.has('claude')) {
      return parseAnthropicUsage(DEFAULT_MOCK_FIXTURES.claude);
    }
    return {
      fiveHourPercent: 0,
      sevenDayPercent: 0,
      fiveHourResetsAt: null,
      sevenDayResetsAt: null,
      status: 'error',
      error: String(e?.message || e),
      raw: null,
    };
  }
}

export async function fetchCodexUsage(
  token: string,
  options: QuotaQueryOptions = {},
  accountId?: string
): Promise<CodexUsage> {
  if (options.fixture) {
    return parseCodexUsage(options.fixture);
  }

  const registered = registeredFixtures.get('codex') || registeredFixtures.get('chatgpt');
  if (registered) {
    return parseCodexUsage(registered);
  }

  if (isMockOrOffline('codex', options)) {
    return parseCodexUsage(DEFAULT_MOCK_FIXTURES.codex);
  }

  const timeoutMs = options.timeoutMs ?? 8000;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const f = options.fetchImpl || globalThis.fetch;

  try {
    const res = await f(CODEX_USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
        'User-Agent': 'agentbridge/0.2.0',
      },
      signal,
    });
    if (!res.ok) {
      if (options.fixture || registeredFixtures.has('codex')) {
        return parseCodexUsage(DEFAULT_MOCK_FIXTURES.codex);
      }
      return {
        primaryPercent: 0,
        resetsAt: null,
        windowMinutes: 300,
        status: 'error',
        error: `HTTP ${res.status}: ${res.statusText || 'request failed'}`,
        raw: null,
      };
    }
    const body = await res.json();
    const parsed = parseCodexUsage(body);
    parsed.status ||= 'ok';
    return parsed;
  } catch (e: any) {
    if (options.fixture || registeredFixtures.has('codex')) {
      return parseCodexUsage(DEFAULT_MOCK_FIXTURES.codex);
    }
    return {
      primaryPercent: 0,
      resetsAt: null,
      windowMinutes: 300,
      status: 'error',
      error: String(e?.message || e),
      raw: null,
    };
  }
}

export async function getProactiveQuotaStatus(
  agent: string,
  token?: string,
  options: QuotaQueryOptions = {}
): Promise<ProactiveQuotaHealth> {
  const norm = agent.toLowerCase().trim();
  const threshold = options.thresholdPercent ?? 95;

  if (norm === 'agy' || norm === 'antigravity') {
    const { queryAntigravityQuota } = await import('./antigravity.js');
    const fixture = options.fixture ?? registeredFixtures.get(norm) ?? registeredFixtures.get(norm === 'agy' ? 'antigravity' : 'agy');
    return queryAntigravityQuota({ ...options, fixture, thresholdPercent: threshold });
  }
  if (norm === 'gemini') {
    const { queryGeminiQuota } = await import('./gemini.js');
    const fixture = options.fixture ?? registeredFixtures.get(norm);
    return queryGeminiQuota({ ...options, fixture, thresholdPercent: threshold });
  }

  if (norm === 'claude' || norm === 'anthropic') {
    const profileSelected = !!options.profileDir || !!options.env?.CLAUDE_CONFIG_DIR;
    let effectiveToken = explicitToken(options, token, ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_TOKEN'], !profileSelected);
    if (!effectiveToken) {
      for (const file of claudeCredentialFiles(options)) {
        effectiveToken = claudeTokenFrom(readJsonFile(file));
        if (effectiveToken) break;
      }
    }
    if (!effectiveToken && !isMockOrOffline('claude', options)) {
      return {
        agent,
        usedPercent: null,
        windowMinutes: 300,
        resetAt: null,
        okToProceed: false,
        status: 'unknown',
        measured: false,
        supported: true,
        source: 'live',
        error: 'No credential or API token configured',
      };
    }
    const usage = await fetchAnthropicUsage(effectiveToken || 'dummy', options);
    const source = quotaSource('claude', options);
    const measured = usage.fiveHourMeasured === true && usage.sevenDayMeasured !== false && source !== 'offline';
    const usedPercent = measured ? usage.fiveHourPercent : null;
    const secondaryPercent = usage.sevenDayMeasured === true ? usage.sevenDayPercent : undefined;
    const windowMinutes = 300;
    const resetAt = usage.fiveHourResetsAt;
    const fiveHourBlocked = usedPercent != null && usedPercent >= threshold;
    const sevenDayBlocked = secondaryPercent != null && secondaryPercent >= 98;
    const status = source === 'offline' ? 'offline' : usage.status || (measured ? 'ok' : 'unknown');
    const hasError = status === 'error' || status === 'unknown' || status === 'offline';
    const okToProceed = !hasError && !fiveHourBlocked && !sevenDayBlocked;
    const blockingWindow = sevenDayBlocked ? 'secondary' : fiveHourBlocked ? 'primary' : null;

    return {
      agent,
      usedPercent,
      ...(secondaryPercent == null ? {} : { secondaryPercent }),
      secondaryResetAt: usage.sevenDayResetsAt,
      measured,
      supported: true,
      source,
      windowMinutes,
      resetAt,
      okToProceed,
      status,
      error: usage.error,
      blockingWindow,
    };
  }

  if (norm === 'codex' || norm === 'chatgpt' || norm === 'openai') {
    if (options.env?.CODEX_API_KEY || options.env?.OPENAI_API_KEY) {
      return {
        agent,
        usedPercent: null,
        windowMinutes: 300,
        resetAt: null,
        okToProceed: false,
        status: 'unknown',
        measured: false,
        supported: true,
        source: 'live',
        error: 'Subscription quota is unavailable for Codex API-key authentication',
      };
    }
    const profileSelected = !!options.profileDir || !!options.env?.CODEX_HOME;
    let effectiveToken = explicitToken(options, token, ['CODEX_TOKEN', 'OPENAI_API_KEY'], !profileSelected);
    let accountId: string | undefined;
    for (const file of codexAuthFiles(options)) {
      if (effectiveToken) break;
      const a = readJsonFile(file);
      effectiveToken = a?.tokens?.access_token || a?.accessToken || a?.token;
      accountId = a?.tokens?.account_id;
    }
    if (!effectiveToken && !isMockOrOffline('codex', options)) {
      return {
        agent,
        usedPercent: null,
        windowMinutes: 300,
        resetAt: null,
        okToProceed: false,
        status: 'unknown',
        measured: false,
        supported: true,
        source: 'live',
        error: 'No credential or API token configured',
      };
    }
    const usage = await fetchCodexUsage(effectiveToken || 'dummy', options, accountId);
    const source = quotaSource('codex', options);
    const measured = usage.primaryMeasured === true && usage.secondaryMeasured !== false && source !== 'offline';
    const usedPercent = measured ? usage.primaryPercent : null;
    const secondaryPercent = usage.secondaryMeasured === true ? usage.secondaryPercent : undefined;
    const windowMinutes = usage.windowMinutes || 300;
    const resetAt = usage.resetsAt;
    const primaryBlocked = usedPercent != null && usedPercent >= threshold;
    const secondaryBlocked = secondaryPercent != null && secondaryPercent >= threshold;
    const status = source === 'offline' ? 'offline' : usage.status || (measured ? 'ok' : 'unknown');
    const hasError = status === 'error' || status === 'unknown' || status === 'offline';
    const okToProceed = !hasError && !primaryBlocked && !secondaryBlocked;
    const blockingWindow = secondaryBlocked ? 'secondary' : primaryBlocked ? 'primary' : null;

    return {
      agent,
      usedPercent,
      ...(secondaryPercent == null ? {} : { secondaryPercent }),
      secondaryResetAt: usage.secondaryResetsAt,
      measured,
      supported: true,
      source,
      windowMinutes,
      resetAt,
      okToProceed,
      status,
      error: usage.error,
      blockingWindow,
    };
  }

  // Other agents or generic mock
  const customFixture = registeredFixtures.get(norm);
  if (customFixture) {
    const usedPercent = measuredPercent(customFixture.usedPercent ?? customFixture.used_percent);
    const windowMinutes = Number(customFixture.windowMinutes ?? 300);
    const resetAt = parseResetTime(customFixture.resetAt ?? customFixture.reset_at);
    const okToProceed = usedPercent != null && usedPercent < threshold;
    return {
      agent,
      usedPercent: usedPercent ?? null,
      windowMinutes,
      resetAt,
      okToProceed,
      status: usedPercent == null ? 'unknown' : 'ok',
      measured: usedPercent != null,
      supported: true,
      source: 'custom',
    };
  }

  return {
    agent,
    usedPercent: null,
    windowMinutes: 0,
    resetAt: null,
    okToProceed: true,
    status: 'ok',
    measured: false,
    supported: false,
    source: 'unmetered',
  };
}

export function formatQuotaStatus(status: ProactiveQuotaHealth): string {
  if (status.status === 'error') {
    return `[${status.agent}] ERROR: ${status.error || 'request failed'}`;
  }
  if (status.status === 'unknown') {
    return `[${status.agent}] UNKNOWN: ${status.error || 'no credentials'}`;
  }
  if (status.status === 'offline' || status.source === 'offline') {
    return `[${status.agent}] OFFLINE: quota measurement unavailable`;
  }
  if (status.supported === false) {
    return `[${status.agent}] UNMETERED: no quota measurement available`;
  }
  const state = status.okToProceed ? 'OK' : 'THROTTLED';
  const blockPart = status.blockingWindow ? ` (${status.blockingWindow} window blocked)` : '';
  const resetPart = status.resetAt ? `, reset: ${new Date(status.resetAt).toISOString()}` : '';
  const usedPart = status.usedPercent == null ? 'unknown' : `${status.usedPercent}% used`;
  const duration = status.windowMinutes > 0 ? `${status.windowMinutes}m window` : 'window duration unknown';
  return `[${status.agent}] ${usedPart} (${duration}${resetPart})${blockPart} - ${state}`;
}

export function formatQuotaForPrompt(status: ProactiveQuotaHealth): string {
  const resetStr = status.resetAt ? new Date(status.resetAt).toISOString() : 'none';
  return `[PROACTIVE QUOTA - ${status.agent.toUpperCase()}]\nUsed: ${status.usedPercent == null ? 'unknown' : `${status.usedPercent}%`}\nWindow: ${status.windowMinutes}m\nReset: ${resetStr}\nStatus: ${status.okToProceed ? 'OK' : 'THROTTLED'}`;
}

export async function cmdQuota(
  _: string[],
  flags: Record<string, any>,
  io: { out: (msg: any) => void; err?: (msg: any) => void }
): Promise<void> {
  const agent = _[0] || 'claude';
  const token = flags.token == null ? undefined : String(flags.token);
  const { getAccountEnv } = await import('../core/accounts.js');
  const accountEnv = getAccountEnv(agent, flags.account, flags.baseDir || process.env.AGENTBRIDGE_HOME);
  const env: NodeJS.ProcessEnv = { ...process.env, ...accountEnv };
  if (['codex', 'chatgpt', 'openai'].includes(agent.toLowerCase())) {
    // Codex CLI ignores an inherited OpenAI key unless it was explicitly supplied to the run.
    if (!Object.prototype.hasOwnProperty.call(accountEnv, 'OPENAI_API_KEY')) delete env.OPENAI_API_KEY;
    if (!Object.prototype.hasOwnProperty.call(accountEnv, 'CODEX_API_KEY')) delete env.CODEX_API_KEY;
  }
  const status = await getProactiveQuotaStatus(agent, token, {
    env,
    thresholdPercent: flags.threshold ? Number(flags.threshold) : undefined,
  });
  if (flags.json) {
    io.out(status);
  } else {
    io.out(formatQuotaStatus(status));
  }
}

