import { AgentError } from '../core/errors.js';
import { ev, EventQuota } from '../core/events.js';
import { QuotaPolicy, QuotaRouteCandidate, QuotaRouteSelection } from '../types/index.js';
import { getProactiveQuotaStatus, ProactiveQuotaHealth, supportsProactiveQuota } from './proactive.js';

const RECHECK_MS = 30_000;

export interface SelectQuotaRouteOptions {
  candidates: QuotaRouteCandidate[];
  quotaPolicy: QuotaPolicy;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  exclude?: Set<string>;
  cooldowns?: Map<string, number>;
  waitState?: QuotaWaitState;
}

export interface QuotaWaitState {
  remainingMs?: number;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentError('ABORTED', 'Quota selection was cancelled');
}

function waitUntil(time: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    // Node clamps larger delays to 1ms; cap safely and re-check on the next pass.
    const ms = Math.min(2_147_483_647, Math.max(0, time - Date.now()));
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new AgentError('ABORTED', 'Quota wait was cancelled'));
    };
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function resetTime(value: number | null | undefined, now: number): { checkAt: number; resetAt?: number } {
  if (typeof value === 'number' && Number.isFinite(value) && value > now) return { checkAt: value, resetAt: value };
  return { checkAt: now + RECHECK_MS };
}

function mergeEnv(...envs: Array<NodeJS.ProcessEnv | undefined>): NodeJS.ProcessEnv {
  return Object.assign({}, ...envs.filter(Boolean));
}

function effectiveQueryEnv(agent: string, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = Object.assign({}, process.env, overrides);
  if (['codex', 'chatgpt', 'openai'].includes(agent.toLowerCase())) {
    // Codex CLI strips inherited API keys unless the caller explicitly supplied them.
    if (!Object.prototype.hasOwnProperty.call(overrides, 'OPENAI_API_KEY')) delete env.OPENAI_API_KEY;
    if (!Object.prototype.hasOwnProperty.call(overrides, 'CODEX_API_KEY')) delete env.CODEX_API_KEY;
  }
  return env;
}

function selection(candidate: QuotaRouteCandidate, index: number, env: NodeJS.ProcessEnv, health?: ProactiveQuotaHealth): QuotaRouteSelection {
  return { ...candidate, index, env, health };
}

function unavailable(): AgentError {
  return new AgentError('AGENT_FAILED', 'Quota routing could not measure any configured provider', {
    reason: 'QUOTA_UNAVAILABLE',
  });
}

function blockedError(retryAfterMs?: number): AgentError {
  return new AgentError('RATE_LIMITED', 'No configured route currently meets its quota threshold', {
    kind: 'quota',
    ...(retryAfterMs == null ? {} : { retryAfterMs: Math.max(0, retryAfterMs) }),
  });
}

/** Query candidates in order, wait cancelably for the earliest eligibility, and return the selected route. */
export async function* selectQuotaRoute(
  options: SelectQuotaRouteOptions
): AsyncGenerator<EventQuota, QuotaRouteSelection, void> {
  const { candidates, quotaPolicy } = options;
  if (!Array.isArray(candidates) || !candidates.length) throw new AgentError('BAD_OPTION', 'quota routing requires at least one candidate');
  if (!quotaPolicy || !Number.isFinite(quotaPolicy.minRemainingPercent) || quotaPolicy.minRemainingPercent < 0 || quotaPolicy.minRemainingPercent > 100) {
    throw new AgentError('BAD_OPTION', 'quotaPolicy.minRemainingPercent must be a finite percentage in [0,100]');
  }
  for (const key of Object.keys(quotaPolicy)) {
    if (!['minRemainingPercent', 'waitForReset', 'maxWaitMs'].includes(key)) {
      throw new AgentError('BAD_OPTION', `Unknown quotaPolicy option "${key}"`);
    }
  }
  if (quotaPolicy.waitForReset != null && typeof quotaPolicy.waitForReset !== 'boolean') {
    throw new AgentError('BAD_OPTION', 'quotaPolicy.waitForReset must be a boolean');
  }
  if (quotaPolicy.maxWaitMs != null && (!Number.isFinite(quotaPolicy.maxWaitMs) || quotaPolicy.maxWaitMs <= 0)) {
    throw new AgentError('BAD_OPTION', 'quotaPolicy.maxWaitMs must be a positive finite number');
  }
  const waitState = options.waitState || { remainingMs: quotaPolicy.maxWaitMs };
  if (waitState.remainingMs == null && quotaPolicy.maxWaitMs != null) waitState.remainingMs = quotaPolicy.maxWaitMs;
  let hasUsableMeasurement = false;
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || typeof candidate.agent !== 'string' || !candidate.agent) {
      throw new AgentError('BAD_OPTION', 'quota candidates need a unique id and agent name');
    }
    if (candidate.minRemainingPercent !== undefined &&
      (typeof candidate.minRemainingPercent !== 'number' || !Number.isFinite(candidate.minRemainingPercent) || candidate.minRemainingPercent < 0 || candidate.minRemainingPercent > 100)) {
      throw new AgentError('BAD_OPTION', `quota candidate ${candidate.id} minRemainingPercent must be a finite percentage in [0,100]`);
    }
    if (ids.has(candidate.id)) throw new AgentError('BAD_OPTION', `duplicate quota candidate id "${candidate.id}"`);
    ids.add(candidate.id);
    if (candidate.minRemainingPercent !== undefined && !supportsProactiveQuota(candidate.agent)) {
      throw new AgentError('BAD_OPTION', `quota threshold override is not supported for unmetered route ${candidate.agent}`);
    }
  }

  for (;;) {
    throwIfAborted(options.signal);
    const blocked: Array<{ agent: string; threshold: number; remainingPercent?: number; resetAt?: number; eligibleAt: number }> = [];
    let earliest = Number.POSITIVE_INFINITY;

    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (!candidate || typeof candidate.id !== 'string' || !candidate.id || typeof candidate.agent !== 'string' || !candidate.agent) {
        throw new AgentError('BAD_OPTION', 'quota candidates need a unique id and agent name');
      }
      if (options.exclude?.has(candidate.id)) continue;
      const threshold = candidate.minRemainingPercent ?? quotaPolicy.minRemainingPercent;
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
        throw new AgentError('BAD_OPTION', `quota candidate ${candidate.id} minRemainingPercent must be a finite percentage in [0,100]`);
      }

      const env = mergeEnv(options.env, candidate.env);
      const cooldownUntil = options.cooldowns?.get(candidate.id) || 0;
      const health = await getProactiveQuotaStatus(candidate.agent, undefined, {
        env: effectiveQueryEnv(candidate.agent, env), signal: options.signal, model: candidate.model,
      });
      throwIfAborted(options.signal);
      const candidateNow = Date.now();

      if (health.supported === false) {
        if (candidate.minRemainingPercent !== undefined) {
          throw new AgentError('BAD_OPTION', `quota threshold override is not supported for unmetered route ${candidate.agent}`);
        }
        if (index === candidates.length - 1 && cooldownUntil <= candidateNow) {
          yield ev.quota({ phase: 'ready', agent: candidate.agent, message: `Using final unmetered route ${candidate.agent}`, threshold });
          return selection(candidate, index, env);
        }
        if (index !== candidates.length - 1) {
          yield ev.quota({ phase: 'skipped', agent: candidate.agent, message: `Skipping unmetered route ${candidate.agent} until metered candidates are exhausted`, threshold });
          continue;
        }
        earliest = Math.min(earliest, cooldownUntil);
        blocked.push({ agent: candidate.agent, threshold, eligibleAt: cooldownUntil });
        continue;
      }

      if (!health.measured || typeof health.usedPercent !== 'number' || (health.status !== 'ok' && health.status !== 'offline')) {
        yield ev.quota({ phase: 'skipped', agent: candidate.agent, message: `Quota for ${candidate.agent} is unavailable`, threshold });
        continue;
      }
      // Generated offline defaults are not a real measurement and cannot authorize a metered route.
      if (health.source === 'offline') {
        yield ev.quota({ phase: 'skipped', agent: candidate.agent, message: `Quota for ${candidate.agent} is not measured while offline`, threshold });
        continue;
      }

      hasUsableMeasurement = true;
      const remaining = Math.max(0, 100 - health.usedPercent);
      const waits: number[] = [];
      const knownResets: number[] = [];
      let isBlocked = false;
      if (remaining < threshold) {
        const reset = resetTime(health.resetAt, candidateNow);
        waits.push(reset.checkAt);
        if (reset.resetAt != null) knownResets.push(reset.resetAt);
        isBlocked = true;
      }
      if (health.secondaryPercent != null && health.secondaryPercent >= 100) {
        const reset = resetTime(health.secondaryResetAt, candidateNow);
        waits.push(reset.checkAt);
        if (reset.resetAt != null) knownResets.push(reset.resetAt);
        isBlocked = true;
      }
      if (cooldownUntil > candidateNow) {
        waits.push(cooldownUntil);
        isBlocked = true;
      }
      if (!isBlocked) {
        yield ev.quota({
          phase: 'ready', agent: candidate.agent,
          message: `Quota ready for ${candidate.agent}: ${remaining}% remaining`,
          threshold, remainingPercent: remaining,
        });
        return selection(candidate, index, env, health);
      }

      const candidateEligibleAt = Math.max(...waits);
      earliest = Math.min(earliest, candidateEligibleAt);
      blocked.push({ agent: candidate.agent, threshold, remainingPercent: remaining, ...(knownResets.length ? { resetAt: Math.max(...knownResets) } : {}), eligibleAt: candidateEligibleAt });
    }

    if (!hasUsableMeasurement && !blocked.length) throw unavailable();
    if (!blocked.length) throw unavailable();
    if (!quotaPolicy.waitForReset) throw blockedError(Math.max(0, earliest - Date.now()));

    const nowBeforeWait = Date.now();
    const recheck = earliest <= nowBeforeWait;
    const nextEligibleAt = recheck ? nowBeforeWait + RECHECK_MS : earliest;
    if (waitState.remainingMs != null && waitState.remainingMs <= 0) throw new AgentError('TIMEOUT', 'Maximum quota wait time exceeded');
    const waitFor = Math.max(0, nextEligibleAt - nowBeforeWait);
    const actualWait = waitState.remainingMs == null ? waitFor : Math.min(waitFor, waitState.remainingMs);
    const nextCheckAt = nowBeforeWait + actualWait;
    const resetTimes = blocked.map((b) => b.resetAt).filter((at): at is number => at != null && at > nowBeforeWait);
    yield ev.quota({
      phase: 'waiting', agent: 'all',
      message: 'Waiting for a configured quota route to become eligible',
      threshold: quotaPolicy.minRemainingPercent,
      ...(resetTimes.length ? { resetAt: Math.min(...resetTimes) } : {}),
      nextCheckAt,
      candidates: blocked.slice(0, 8).map(({ eligibleAt: _eligibleAt, resetAt, ...candidate }) => ({
        ...candidate,
        ...(resetAt != null && resetAt > nowBeforeWait ? { resetAt } : {}),
      })),
    });
    const waitStartedAt = Date.now();
    await waitUntil(nextCheckAt, options.signal);
    const elapsed = Math.max(0, Date.now() - waitStartedAt);
    if (waitState.remainingMs != null) {
      waitState.remainingMs = Math.max(0, waitState.remainingMs - elapsed);
      if (waitState.remainingMs === 0) throw new AgentError('TIMEOUT', 'Maximum quota wait time exceeded');
    }
  }
}
