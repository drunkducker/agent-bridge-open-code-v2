import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { resolveBinary, runCollect } from '../core/spawn.js';
import type { ProactiveQuotaHealth, QuotaQueryOptions } from './proactive.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 30_000;
const MIN_READ_ONLY_USAGE_VERSION = [1, 1, 11] as const;
const MAX_OUTPUT_BYTES = 1024 * 1024;

type WindowUsage = { usedPercent: number; resetAt: number | null };

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function executable(env: NodeJS.ProcessEnv): string | null {
  // An explicit override is authoritative, including an invalid override. Never silently
  // query a different account's `agy` when AGY_BIN was deliberately selected.
  if (Object.prototype.hasOwnProperty.call(env, 'AGY_BIN')) {
    const explicit = env.AGY_BIN?.trim();
    if (!explicit) return null;
    if (/[\\/]/.test(explicit) || path.isAbsolute(explicit)) return isFile(explicit) ? path.resolve(explicit) : null;
    return resolveBinary(explicit, env);
  }

  const found = resolveBinary('agy', env);
  if (found) return found;
  const localAppData = env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(localAppData, 'agy', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'),
    path.join(homedir(), '.local', 'bin', 'agy'),
    path.join(homedir(), '.gemini', 'antigravity-cli', 'bin', 'agy'),
  ];
  return candidates.find(isFile) || null;
}

function resetAt(value: unknown): number | null {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e11 ? Math.round(value) : Math.round(value * 1000);
  }
  return null;
}

function familyForModel(model: string | undefined): 'gemini' | 'claude-gpt' | null {
  const normalized = (model || 'gemini-3.8-flash-low').trim().toLowerCase();
  if (/^(gemini(?:[-\s]|$))/.test(normalized)) return 'gemini';
  if (/^(claude(?:[-\s]|$)|gpt(?:[-\s]|$))/.test(normalized)) return 'claude-gpt';
  return null;
}

function exactGroup(groups: any[], family: 'gemini' | 'claude-gpt'): any | undefined {
  const expected = family === 'gemini' ? 'gemini models' : 'claude and gpt models';
  return groups.find((group) => typeof group?.name === 'string' && group.name.trim().toLowerCase() === expected);
}

function readWindow(group: any, wanted: '5h' | 'weekly'): WindowUsage | null {
  if (!Array.isArray(group?.buckets)) return null;
  const bucket = group.buckets.find((item: any) => typeof item?.window === 'string' && item.window.trim().toLowerCase() === wanted);
  const fraction = bucket?.remaining_fraction;
  if (typeof fraction !== 'number' || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
  // Keep fractional percentages for threshold checks; round only tiny IEEE representation noise.
  const usedPercent = Number(((1 - fraction) * 100).toFixed(8));
  return { usedPercent, resetAt: resetAt(bucket.reset_time) };
}

function health(options: QuotaQueryOptions, fields: Partial<ProactiveQuotaHealth> = {}): ProactiveQuotaHealth {
  const offline = options.env?.AGENTBRIDGE_OFFLINE === '1' || options.env?.AGENTBRIDGE_PROACTIVE_MOCK === '1' ||
    process.env.AGENTBRIDGE_OFFLINE === '1' || process.env.AGENTBRIDGE_PROACTIVE_MOCK === '1';
  return {
    agent: 'agy',
    usedPercent: null,
    windowMinutes: 300,
    resetAt: null,
    okToProceed: false,
    status: offline ? 'offline' : 'unknown',
    measured: false,
    supported: true,
    source: offline ? 'offline' : 'live',
    ...fields,
  };
}

function parseVersion(stdout: string): number[] | null {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?(?:\s|$)/i.exec(stdout.trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

function versionAtLeast(version: number[], minimum: readonly number[]): boolean {
  for (let i = 0; i < minimum.length; i++) {
    if ((version[i] || 0) > minimum[i]) return true;
    if ((version[i] || 0) < minimum[i]) return false;
  }
  return true;
}

function usageEnvelope(value: any): any {
  if (value && typeof value === 'object' && ('status' in value || 'command' in value)) return value;
  // Fixtures may provide the command payload directly for parser-only coverage.
  return { status: 'SUCCESS', num_turns: 0, command: { name: 'usage', data: value } };
}

function parseUsage(value: any, options: QuotaQueryOptions): ProactiveQuotaHealth {
  const result = usageEnvelope(value);
  if (!result || result.status !== 'SUCCESS' || !result.command || typeof result.command !== 'object') {
    return health(options, { error: 'AGY quota command failed or returned an invalid response' });
  }
  if (result.num_turns !== undefined && result.num_turns !== 0) {
    return health(options, { error: 'AGY quota command unexpectedly started an agent turn' });
  }
  const commandName = result.command.name;
  if (commandName !== undefined && !/^(?:\/?usage|\/?quota)$/i.test(String(commandName))) {
    return health(options, { error: 'AGY returned an unexpected command response' });
  }
  const groups = result.command.data?.groups;
  const family = familyForModel(options.model);
  if (!family) return health(options, { error: 'Quota is not exposed for this AGY model' });
  if (!Array.isArray(groups)) return health(options, { error: 'AGY quota response is missing model groups' });
  const group = exactGroup(groups, family);
  if (!group) return health(options, { error: 'AGY quota response is missing the selected model family' });
  const primary = readWindow(group, '5h');
  const secondary = readWindow(group, 'weekly');
  if (!primary || !secondary) return health(options, { error: 'AGY quota response is missing a valid 5h or weekly bucket' });

  const threshold = Number.isFinite(options.thresholdPercent) ? options.thresholdPercent! : 95;
  const primaryBlocked = primary.usedPercent >= threshold;
  const secondaryBlocked = secondary.usedPercent >= threshold;
  const blockingWindow = secondaryBlocked ? 'secondary' : primaryBlocked ? 'primary' : null;
  return health(options, {
    usedPercent: primary.usedPercent,
    secondaryPercent: secondary.usedPercent,
    secondaryResetAt: secondary.resetAt,
    resetAt: primary.resetAt,
    measured: true,
    source: 'fixture',
    status: 'ok',
    okToProceed: !primaryBlocked && !secondaryBlocked,
    blockingWindow,
  });
}

function versionCommandSupported(stdout: string): boolean {
  const version = parseVersion(stdout);
  return version !== null && versionAtLeast(version, MIN_READ_ONLY_USAGE_VERSION);
}

/**
 * Query AGY's read-only `/usage` CLI command before dispatching an agent turn.
 * This command is only supported as a no-turn command on AGY 1.1.11 and newer.
 */
export async function queryAntigravityQuota(options: QuotaQueryOptions = {}): Promise<ProactiveQuotaHealth> {
  if (options.fixture !== undefined) return parseUsage(options.fixture, options);
  if (options.profileDir) return health(options, { error: 'AGY account-specific profile quota lookup is unsupported' });
  if (options.env?.AGENTBRIDGE_OFFLINE === '1' || options.env?.AGENTBRIDGE_PROACTIVE_MOCK === '1' ||
      process.env.AGENTBRIDGE_OFFLINE === '1' || process.env.AGENTBRIDGE_PROACTIVE_MOCK === '1') {
    return health(options, { error: 'Quota measurement unavailable in offline mode' });
  }

  const env: NodeJS.ProcessEnv = { ...process.env, ...(options.env || {}) };
  const bin = executable(env);
  if (!bin) return health(options, { error: 'Antigravity CLI (agy) is not installed or could not be resolved' });

  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0
    ? Math.min(options.timeoutMs!, MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();
  const run = async (args: string[]) => {
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) return null;
    try {
      return await runCollect(bin, args, {
        env,
        signal: options.signal,
        timeoutMs: remaining,
        maxBuffer: MAX_OUTPUT_BYTES,
        agent: 'agy',
      });
    } catch {
      return null;
    }
  };

  if (options.signal?.aborted) return health(options, { error: 'AGY quota query was cancelled' });
  const version = await run(['--version']);
  if (!version || version.aborted || options.signal?.aborted) return health(options, { error: 'AGY quota query was cancelled or failed' });
  if (version.timedOut || Date.now() - startedAt >= timeoutMs) return health(options, { error: 'AGY quota query timed out' });
  if (version.exitCode !== 0 || !versionCommandSupported(version.stdout)) {
    return health(options, { error: 'Installed AGY version is unsupported for safe read-only quota queries' });
  }

  const usage = await run(['-p', '/usage', '--output-format', 'json']);
  if (!usage || usage.aborted || options.signal?.aborted) return health(options, { error: 'AGY quota query was cancelled or failed' });
  if (usage.timedOut || Date.now() - startedAt >= timeoutMs) return health(options, { error: 'AGY quota query timed out' });
  if (usage.exitCode !== 0) return health(options, { error: 'AGY read-only quota command failed' });

  let parsed: any;
  try {
    parsed = JSON.parse(usage.stdout);
  } catch {
    return health(options, { error: 'AGY quota command returned invalid JSON' });
  }
  if (parsed?.num_turns !== undefined && parsed.num_turns !== 0) {
    return health(options, { error: 'AGY quota command unexpectedly started an agent turn' });
  }
  const result = parseUsage(parsed, options);
  if (result.status === 'ok') result.source = 'live';
  return result;
}
