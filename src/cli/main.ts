#!/usr/bin/env node
// agentbridge CLI (`ab` / `agentbridge`). Plain Node ESM, zero deps.
import { fileURLToPath } from 'node:url';
import { realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { parseArgs, UsageError, num, readStdin } from './args.js';
import {
  runTracked,
  agents,
  AgentError,
  stats,
  contextOf,
  handoff,
  wait,
  fanout,
  race,
  doctor,
  loadConfig,
  parseFallbackTarget,
  supportsProactiveQuota,
} from '../index.js';
import { runBudgeted, Budget } from '../extras/budget.js';
import { runInWorktree, withWorktree } from '../extras/worktree.js';
import { listRuns, summarize, cancelRun, sweep } from '../bridge/runs.js';
import { listSessions } from '../telemetry/stats.js';
import { AgentEvent, RunOptions, FallbackErrorCode } from '../types/index.js';
import { projectSkillDirs } from '../core/shared-resources.js';

const out = (o: any) =>
  process.stdout.write(typeof o === 'string' ? o + (o.endsWith('\n') ? '' : '\n') : JSON.stringify(o, null, 2) + '\n');
const err = (s: any) => process.stderr.write(String(s).endsWith('\n') ? s : s + '\n');
const AGENT_NAMES = new Set(agents.names);

function warnAboutStaleSkillCopies(cmd: string, json: boolean | undefined) {
  if (!process.stdin.isTTY || !process.stderr.isTTY || json || cmd === 'bridge' || cmd === 'setup' || cmd === 'wizard') return;
  try {
    const bundled = readFileSync(fileURLToPath(new URL('../../skills/agentbridge-delegate/SKILL.md', import.meta.url)));
    const roots = [
      path.join(homedir(), '.agents', 'skills'),
      path.join(homedir(), '.claude', 'skills'),
      path.join(homedir(), '.codex', 'skills'),
      path.join(homedir(), '.pi', 'agent', 'skills'),
      path.join(homedir(), '.gemini', 'config', 'skills'),
      ...projectSkillDirs(process.cwd()),
    ];
    const stale = roots.some((root) => {
      try {
        return !readFileSync(path.join(root, 'agentbridge-delegate', 'SKILL.md')).equals(bundled);
      } catch {
        return false;
      }
    });
    if (stale) err('An installed agentbridge-delegate skill differs from AgentBridge’s bundled version. Run `ab setup` and choose the skill install option to refresh it.');
  } catch {
    // The bundled skill may not be present in development or a partial install; keep CLI startup quiet.
  }
}

function checkAgent(a: string) {
  if (!AGENT_NAMES.has(a)) throw new UsageError(`Unknown agent "${a}". Expected one of: ${agents.names.join(', ')}`);
}

async function promptFrom(_: string[], flags: Record<string, any>): Promise<string> {
  if (_[1] === '-' || (flags.stdinPrompt && _.length < 2)) return readStdin();
  if (_.length >= 2) return _.slice(1).join(' ');
  if (!process.stdin.isTTY) {
    const s = await readStdin();
    if (s.trim()) return s;
  }
  throw new UsageError('missing prompt (pass it as an argument, or pipe it on stdin with `-`)');
}

const cliGen = (agent: any, opts: any) => runTracked(agent, opts, { origin: 'cli' });

function fallbackTargetsFromFlags(flags: Record<string, any>): RunOptions['fallback'] {
  if (flags.fallback == null) return undefined;
  const values = String(flags.fallback).split(',').map((x) => x.trim()).filter(Boolean);
  if (values.length > 5) throw new UsageError('--fallback accepts at most 5 agents');
  return values.map((entry) => {
    let target: any;
    try {
      target = parseFallbackTarget(entry);
    } catch (e: any) {
      if (e?.code === 'BAD_OPTION') throw new UsageError(e.message);
      throw e;
    }
    checkAgent(target.agent);
    if (target.minRemainingPercent !== undefined && !supportsProactiveQuota(target.agent))
      throw new UsageError(`Quota thresholds are unavailable for fallback agent "${target.agent}"`);
    return target;
  });
}

function quotaPolicyFromFlags(flags: Record<string, any>, fallback: RunOptions['fallback'] = []): RunOptions['quotaPolicy'] {
  const quotaNumber = (key: string) => {
    if (typeof flags[key] !== 'string' || !flags[key].trim())
      throw new UsageError(`--${key} must be a non-empty number`);
    return num(flags, key, { min: 0 });
  };
  const hasThreshold = flags['min-remaining-percent'] != null;
  const waitForQuota = flags['wait-for-quota'] === true;
  const hasRouteThreshold = (fallback || []).some((target: any) => target?.minRemainingPercent !== undefined);
  if (!hasThreshold && !waitForQuota && !hasRouteThreshold) {
    if (flags['max-quota-wait'] != null)
      throw new UsageError('--max-quota-wait requires --wait-for-quota, --min-remaining-percent, or a fallback threshold such as --fallback codex@15');
    return undefined;
  }
  const threshold = hasThreshold ? quotaNumber('min-remaining-percent') : 20;
  if (threshold > 100) throw new UsageError('--min-remaining-percent must be between 0 and 100');
  const maxWaitSeconds = flags['max-quota-wait'] != null ? quotaNumber('max-quota-wait') : undefined;
  if (maxWaitSeconds === 0 || (maxWaitSeconds !== undefined && !Number.isFinite(maxWaitSeconds * 1000)))
    throw new UsageError('--max-quota-wait must be a positive finite number of seconds');
  return {
    minRemainingPercent: threshold,
    ...(waitForQuota ? { waitForReset: true } : {}),
    ...(maxWaitSeconds !== undefined ? { maxWaitMs: maxWaitSeconds * 1000 } : {}),
  };
}

function baseOpts(flags: Record<string, any>, prompt: string, fallbackTargets?: RunOptions['fallback']): RunOptions {
  const o: RunOptions = { prompt };
  if (flags.model) o.model = flags.model;
  if (flags.effort) o.effort = flags.effort;
  if (flags.permissions) o.permissions = flags.permissions;
  if (flags.harness) o.harness = flags.harness;
  if (flags.offline !== undefined) o.offline = Boolean(flags.offline);
  if (flags.isolated !== undefined) o.isolated = Boolean(flags.isolated);
  if (flags.transport) o.transport = flags.transport;
  if (flags['app-server'] || flags.appServer) o.appServer = true;
  if (flags.yolo) o.yolo = true;
  if (flags.cwd) o.cwd = flags.cwd;
  if (flags.timeout != null) o.timeoutMs = num(flags, 'timeout', { min: 0 }) * 1000;
  if (flags.system) o.systemPrompt = flags.system;
  const parsedFallback = fallbackTargets ?? fallbackTargetsFromFlags(flags);
  if (parsedFallback) o.fallback = parsedFallback;
  if (flags['fallback-on'])
    o.fallbackOn = String(flags['fallback-on']).split(',').map((x) => x.trim().toUpperCase()).filter(Boolean) as FallbackErrorCode[];
  if (flags['json-schema']) {
    try {
      o.jsonSchema = JSON.parse(flags['json-schema']);
    } catch {
      throw new UsageError('--json-schema must be valid JSON');
    }
  }
  o.quotaPolicy = quotaPolicyFromFlags(flags, parsedFallback);
  if (flags.session) {
    const mode = flags.session;
    if (!['new', 'ephemeral', 'continue', 'fork'].includes(mode))
      throw new UsageError('--session must be new|ephemeral|continue|fork');
    o.session = { mode, ...(flags['session-id'] ? { id: flags['session-id'] } : {}) };
  } else if (flags['session-id']) {
    o.session = { mode: 'continue', id: flags['session-id'] };
  }
  return o;
}

function budgetOf(flags: Record<string, any>) {
  const b: any = {};
  if (flags['max-cost'] != null) b.maxCost = num(flags, 'max-cost', { min: 0 });
  if (flags['max-tokens'] != null) b.maxTokens = num(flags, 'max-tokens', { min: 0, int: true });
  if (flags['max-time'] != null) b.maxTimeMs = num(flags, 'max-time', { min: 0 }) * 1000;
  return b;
}

function printEvent(e: AgentEvent, json?: boolean) {
  if (e.type === 'quota') {
    const time = (n?: number) => {
      if (!Number.isFinite(n)) return undefined;
      const d = new Date(n!);
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    };
    const routes = e.candidates?.map((c) => `${c.agent}${c.threshold == null ? '' : ` needs >=${c.threshold}%`}${c.remainingPercent == null ? ' (quota unknown)' : ` (currently ${c.remainingPercent}%)`}`)
      ?? (e.remainingPercent == null ? [] : [`${e.agent} ${e.remainingPercent}% remaining`]);
    const details = [
      `default threshold ${e.threshold}%`,
      ...(routes?.length ? [`routes: ${routes.join(', ')}`] : []),
      ...(time(e.resetAt) ? [`reset ${time(e.resetAt)}`] : []),
      ...(time(e.nextCheckAt) ? [`next check ${time(e.nextCheckAt)}`] : []),
    ];
    err(`[quota ${e.phase}] ${e.message} (${details.join('; ')})`);
    if (json) out(JSON.stringify({ event: e }));
    return;
  }
  if (json) return out(JSON.stringify({ event: e }));
  if (e.type === 'session') err(`[session ${e.id}]`);
  else if (e.type === 'text') process.stdout.write(e.delta);
  else if (e.type === 'thinking') err(e.delta);
  else if (e.type === 'tool') err(`[tool ${e.name}]`);
  else if (e.type === 'usage') err(`[usage in=${e.input} out=${e.output}${e.cost != null ? ` cost=$${e.cost}` : ''}]`);
  else if (e.type === 'error') err(`[error] ${e.message}`);
  else if (e.type === 'fallback') err(`[fallback] ${e.from} failed (${e.code}); trying ${e.to}`);
}

function fail(e: any, json?: boolean) {
  const code = e instanceof AgentError ? e.code : e.code === 'USAGE' ? 'USAGE' : 'ERROR';
  if (json) out({ error: { code, message: e.message } });
  else err(`error (${code}): ${e.message}`);
  process.exitCode = code === 'USAGE' || code === 'BAD_OPTION' ? 2 : 1;
}

// ---------- commands ----------

async function cmdRun(_: string[], flags: Record<string, any>, { askOnly = false }: { askOnly?: boolean } = {}) {
  const cfg = loadConfig(flags.cwd || process.cwd());
  let agent = _[0];
  let promptArgs = _;
  if (!agent) {
    if (cfg.defaultAgent && AGENT_NAMES.has(cfg.defaultAgent)) {
      agent = cfg.defaultAgent;
    } else {
      throw new UsageError('usage: ab run <agent> [prompt|-] [flags]');
    }
  } else if (!AGENT_NAMES.has(agent) && cfg.defaultAgent && AGENT_NAMES.has(cfg.defaultAgent)) {
    agent = cfg.defaultAgent;
    promptArgs = [agent, ..._];
  }
  checkAgent(agent);
  const fallbackTargets = fallbackTargetsFromFlags(flags);
  if (flags.yolo) {
    if (agent !== 'codex') throw new UsageError('--yolo is only available with the Codex agent');
    if (flags.permissions !== 'full') throw new UsageError('--yolo requires explicit --permissions full');
  }
  if (flags['dangerously-skip-permissions']) {
    if (agent !== 'claude') throw new UsageError('--dangerously-skip-permissions is only available with the Claude agent');
    if (flags.permissions !== 'full') throw new UsageError('--dangerously-skip-permissions requires explicit --permissions full');
  }
  const prompt = await promptFrom(promptArgs, flags);
  let opts = baseOpts(flags, prompt, fallbackTargets);
  if (flags['dangerously-skip-permissions']) opts.dangerouslySkipPermissions = true;
  const { getAccountEnv } = await import('../core/accounts.js');
  const accEnv = getAccountEnv(agent, flags.account);
  if (Object.keys(accEnv).length) {
    opts.env = { ...accEnv, ...(opts.env || {}) };
  }
  const b = budgetOf(flags);
  const useWorktree = !!flags.worktree;
  const onEvent = (e: AgentEvent) => { if (e.type === 'quota') printEvent(e); };
  const runOne = (a: any, p: any) => runBudgeted(a, p, b, { gen: cliGen, onEvent });
  const exec = (a: any, p: any) => (useWorktree ? runInWorktree(a, p, { runOne }) : runOne(a, p));

  if (flags.stream && !askOnly) {
    let sawEvent = false;
    const ownBudget = !(b instanceof Budget);
    const budgetObj = ownBudget ? new Budget(b) : b;
    const effectiveSignal = opts.signal
      ? (AbortSignal as any).any([opts.signal, budgetObj.signal])
      : budgetObj.signal;
    const runOpts = { ...opts, signal: effectiveSignal };

    const runStreamingTarget = async (targetCwd: string) => {
      const it = cliGen(agent, { ...runOpts, cwd: targetCwd });
      try {
        for await (const e of it) {
          sawEvent = true;
          budgetObj.track('cli', e);
          printEvent(e, flags.json);
          if (budgetObj.exceeded) {
            break;
          }
        }
      } finally {
        await (it as any).return?.();
      }
    };

    let wtResult: any = null;
    try {
      if (useWorktree) {
        wtResult = await withWorktree(opts.cwd || process.cwd(), async (sbCwd) => {
          await runStreamingTarget(sbCwd);
        });
      } else {
        await runStreamingTarget(opts.cwd || process.cwd());
      }
    } finally {
      if (ownBudget) budgetObj.dispose();
    }

    if (!sawEvent && !budgetObj.exceeded) throw new Error('adapter produced no events');
    if (budgetObj.exceeded) {
      err(`[budget exceeded: ${budgetObj.exceeded}]`);
    }
    if (wtResult) {
      err(`[worktree: ${wtResult.mode}, ${wtResult.files.length} file(s) changed]`);
      if (wtResult.diff) out(wtResult.diff);
    }
    return;
  }
  const r: any = await exec(agent, opts);
  if (flags.json) return out(r);
  if (r.aborted) {
    err(`[budget exceeded: ${r.budget?.exceeded}]`);
  }
  if (r.fallback) {
    err(
      `[fallback: ${r.fallback.attempts
        .map(
          (a: any) =>
            `${a.agent} ${a.code}${a.retryAfterMs != null ? ` (retry in ${Math.round(a.retryAfterMs / 1000)}s)` : ''}`
        )
        .join(' -> ')} -> answered by ${r.fallback.used}${
        r.fallback.contextLost ? '; session context was NOT carried over' : ''
      }]`
    );
  }
  if (r.worktree) err(`[worktree: ${r.worktree.mode}, ${r.worktree.files.length} file(s) changed]`);
  out(askOnly ? r.text : r.text || '');
  if (!askOnly) {
    err(
      `[${r.model || opts.model || agent} session=${r.sessionId || '-'} exit=${r.exitCode} ${r.durationMs}ms in=${
        r.usage?.input ?? '-'
      } out=${r.usage?.output ?? '-'}${r.usage?.cost != null ? ` cost=$${r.usage.cost}` : ''}]`
    );
  }
  if (r.worktree?.diff) out(r.worktree.diff);
  if (r.exitCode && r.exitCode !== 0) process.exitCode = 1;
}

function targetsFrom(_: string[], flags: Record<string, any>) {
  const ts = (flags.agents ? flags.agents.split(',') : _.slice(1)).map((s: string) => s.trim()).filter(Boolean);
  if (!ts.length)
    throw new UsageError('usage: ab fanout|race "<prompt>" agent[:model] [agent[:model] ...] (or --agents a,b)');
  return ts;
}

async function cmdFanoutRace(mode: 'fanout' | 'race', _: string[], flags: Record<string, any>) {
  if (flags.yolo) throw new UsageError('--yolo is only available for a single Codex run');
  const prompt = _[0];
  if (!prompt) throw new UsageError('usage: ab fanout|race "<prompt>" agent[:model] ...');
  const targets = targetsFrom(_, flags);
  for (const t of targets) checkAgent(String(t).split(':')[0]);
  const { prompt: _p, ...restOpts } = baseOpts(flags, prompt);
  const runOpts = { prompt, ...restOpts };
  const o = {
    gen: cliGen,
    budget: budgetOf(flags),
    worktree: !!flags.worktree,
    concurrency: flags.concurrency ? num(flags, 'concurrency', { min: 1, int: true }) : undefined,
  };
  const res: any = mode === 'race' ? await race(targets, runOpts, o) : await fanout(targets, runOpts, o);
  if (flags.json) return out(res);
  if (mode === 'race') {
    if (res.winner) {
      out(res.winner.text);
      err(`[winner: ${res.winner.agent}${res.winner.model ? ':' + res.winner.model : ''} ${res.winner.durationMs}ms]`);
    } else {
      err('[no winner: every target failed or was rejected]');
    }
    for (const l of res.losers) {
      err(
        `  loser ${l.agent}${l.model ? ':' + l.model : ''}: ${
          l.cancelled ? 'cancelled' : l.error ? l.error.message : l.skipped ? 'skipped (budget)' : 'not accepted'
        }`
      );
    }
    if (!res.winner) process.exitCode = 1;
  } else {
    for (const r of res.results) {
      err(`=== ${r.agent}${r.model ? ':' + r.model : ''} ${r.ok ? 'ok' : 'FAILED'} ${r.durationMs}ms ===`);
      out(r.ok ? r.text : `(${r.error ? r.error.message : r.aborted ? 'aborted/budget' : 'no output'})`);
    }
    if (res.results.some((r: any) => !r.ok)) process.exitCode = 1;
  }
}

async function cmdSessions(_: string[], flags: Record<string, any>) {
  const rows = listSessions().sort((a: any, b: any) => (b.lastAt || 0) - (a.lastAt || 0));
  if (flags.json) return out(rows);
  if (!rows.length) return out('(no sessions)');
  for (const s of rows) {
    out(`${s.sessionId}  ${s.agent}/${s.model || '?'}  runs=${s.runCount || 0}  ${new Date(s.lastAt || 0).toISOString()}`);
  }
}

async function cmdPs(_: string[], flags: Record<string, any>) {
  const rows = listRuns().filter((r) => r.state === 'running').map((r) => summarize(r));
  if (flags.json) return out(rows);
  if (!rows.length) return out('(no active runs)');
  for (const r of rows) out(`${r.id}  ${r.agent}${r.model ? '/' + r.model : ''}  ${(r.elapsedMs / 1000).toFixed(0)}s  ${r.sessionId || '-'}`);
}

async function cmdTop(_: string[], flags: Record<string, any>) {
  const once = flags.once || !process.stdout.isTTY;
  const render = () => {
    const s = stats();
    const lines = [
      `agentbridge top — ${new Date().toISOString()}  global maxPct=${
        s.global.maxPct != null ? (s.global.maxPct * 100).toFixed(0) + '%' : '-'
      } active=${s.global.activeRuns} idle=${s.global.idleRuns}`,
      '',
    ];
    for (const a of Object.keys(s.agents)) {
      const g = s.agents[a];
      lines.push(
        `${a.padEnd(10)} sessions=${g.sessions} active=${g.active} tokens=${g.contextTokens} pct=${
          g.pct != null ? (g.pct * 100).toFixed(0) + '%' : '-'
        } cost=${g.cost != null ? '$' + g.cost.toFixed(4) : '-'}`
      );
    }
    lines.push('', 'running:');
    for (const r of listRuns().filter((r) => r.state === 'running')) {
      lines.push(`  ${r.id} ${r.agent} ${(((r.lastEventAt || Date.now()) - r.startedAt) / 1000).toFixed(0)}s`);
    }
    if (once) return out(lines.join('\n'));
    process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
  };
  render();
  if (!once) {
    const iv = setInterval(render, 2000);
    iv.unref?.();
    await new Promise<void>((res) =>
      process.on('SIGINT', () => {
        clearInterval(iv);
        res();
      })
    );
  }
}

async function cmdStats(_: string[], flags: Record<string, any>) {
  out(flags.json ? stats() : summarizeStats(stats()));
}
function summarizeStats(s: any) {
  const lines = [
    `sessions=${s.global.sessions} activeRuns=${s.global.activeRuns} idleRuns=${s.global.idleRuns} maxPct=${
      s.global.maxPct != null ? (s.global.maxPct * 100).toFixed(0) + '%' : '-'
    } cost=${s.global.cost != null ? '$' + s.global.cost.toFixed(4) : '-'}`,
  ];
  for (const [a, g] of Object.entries(s.agents) as any) {
    lines.push(`  ${a}: sessions=${g.sessions} tokens=${g.contextTokens} pct=${g.pct != null ? (g.pct * 100).toFixed(0) + '%' : '-'}`);
  }
  return lines.join('\n');
}

async function cmdContext(_: string[], flags: Record<string, any>) {
  const sid = _[0];
  if (!sid) throw new UsageError('usage: ab context <session> [--agent a]');
  const c = contextOf(sid, { agent: flags.agent });
  if (!c) {
    process.exitCode = 1;
    if (flags.json) return out({ error: 'unknown session' });
    err('unknown session');
    return;
  }
  out(
    flags.json
      ? c
      : `${c.agent}/${c.sessionId} tokens=${c.tokens}/${c.window} (${
          c.pct != null ? (c.pct * 100).toFixed(1) + '%' : '-'
        }) source=${c.source} exact=${c.exact}`
  );
}

async function cmdHandoff(_: string[], flags: Record<string, any>) {
  const sid = _[0];
  if (!sid || !flags.to) throw new UsageError('usage: ab handoff <session> --to <agent> [--agent source-agent]');
  checkAgent(flags.to);
  const h: any = await handoff(sid, flags.to, { agent: flags.agent, cwd: flags.cwd, seed: flags.seed !== false });
  out(
    flags.json
      ? h
      : `handed off ${sid} -> ${flags.to} new session ${h.newSessionId || '-'} (doc: ${h.path || h.docPath || '-'})`
  );
}

async function cmdWatch(_: string[], flags: Record<string, any>, waitMode: boolean) {
  const id = _[0];
  if (!id) throw new UsageError(`usage: ab ${waitMode ? 'wait' : 'watch'} <run|session>`);
  const r: any = await wait(id, { timeoutMs: flags.timeout ? num(flags, 'timeout', { min: 0 }) * 1000 : 600000 });
  out(flags.json ? r : `${id}: ${r.notFound ? 'not found' : r.waitTimedOut ? 'timed out' : r.status}`);
  if (r.notFound || r.status === 'error') process.exitCode = 1;
}

async function cmdDoctor(_: string[], flags: Record<string, any>) {
  const ports = flags.port ? [num(flags, 'port', { min: 0, int: true })] : undefined;
  const d = await doctor({ live: !!flags.live, models: flags['no-models'] !== true, ...(ports ? { ports } : {}) });
  if (flags.json) {
    out(d);
    if (!d.ok) process.exitCode = 1;
    return;
  }
  for (const c of d.checks) out(`[${c.status === 'ok' ? ' ok ' : c.status === 'warn' ? 'WARN' : 'FAIL'}] ${c.name}: ${c.detail}`);
  if (!d.ok) process.exitCode = 1;
}

async function cmdCancel(_: string[], flags: Record<string, any>) {
  const id = _[0];
  if (!id) throw new UsageError('usage: ab cancel <run>');
  const r = cancelRun(id);
  out(flags.json ? r : (r.error || `cancelled ${id} (state=${r.rec?.state})`));
  if (r.error) process.exitCode = 1;
}

async function cmdServe(_: string[], flags: Record<string, any>) {
  if (flags.yolo) throw new UsageError('--yolo is only available for a single Codex run');
  const { startProxy } = await import('../server/index.js');
  const p = await startProxy({
    port: flags.port ? num(flags, 'port', { min: 0, int: true }) : 8787,
    host: flags.host,
    token: flags.token || process.env.AGENTBRIDGE_TOKEN,
    allowNonLoopback: !!flags['allow-non-loopback'],
    configFile: flags.config,
    agentRoot: flags['agent-root'],
    agentMaxRuns: flags['agent-max-runs'] != null ? num(flags, 'agent-max-runs', { min: 0, int: true }) : undefined,
    agentRunTtlMinutes: flags['agent-run-ttl'] != null ? num(flags, 'agent-run-ttl', { min: 1 }) : undefined,
    maxPermission: flags['agent-max-permission'],
    accounts: flags.accounts ? JSON.parse((await import('node:fs')).readFileSync(flags.accounts, 'utf8')) : undefined,
    acceptTosRisk: !!flags['accept-tos-risk'],
    logFile: flags.log,
    quotaPolicy: quotaPolicyFromFlags(flags, fallbackTargetsFromFlags(flags)),
    ...(flags.fallback ? { fallback: fallbackTargetsFromFlags(flags) } : {}),
  });
  err(`agentbridge proxy listening on ${p.url}`);
  const { readinessReport, installedAgents } = await import('../core/readiness.js');
  err(['agents on this machine (run `ab doctor` to check logins):', ...readinessReport()].join(String.fromCharCode(10)));
  if (!installedAgents().length)
    err('WARNING: no agent CLI is installed, so every request will fail with agent_not_installed.');
  await new Promise<void>((res) => {
    for (const sg of ['SIGINT', 'SIGTERM'] as const) process.on(sg, () => p.close().then(() => res()));
  });
}

async function cmdUi(_: string[], flags: Record<string, any>) {
  const { startUi } = await import('../ui/server.js');
  const u = await startUi({
    port: flags.port != null ? num(flags, 'port', { min: 0, int: true }) : 8788,
    host: flags.host,
    token: flags.token || process.env.AGENTBRIDGE_TOKEN,
    allowNonLoopback: !!flags['allow-non-loopback'],
  });
  const link =
    u.url +
    (flags.token || process.env.AGENTBRIDGE_TOKEN
      ? `/?token=${encodeURIComponent(flags.token || process.env.AGENTBRIDGE_TOKEN)}`
      : '');
  err(`agentbridge dashboard: ${link}  (read-only, Ctrl+C to stop)`);
  if (flags.open) {
    const { spawn } = await import('node:child_process');
    const [c, a] =
      process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', link]]
        : process.platform === 'darwin'
        ? ['open', [link]]
        : ['xdg-open', [link]];
    spawn(c, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
  await new Promise<void>((res) => {
    for (const sg of ['SIGINT', 'SIGTERM'] as const) process.on(sg, () => u.close().then(() => res()));
  });
}

async function cmdBridge() {
  const { serve } = await import('../bridge/mcp.js');
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (...a: any[]) => (process.stderr.write as any)(...a);
  for (const k of ['log', 'info', 'debug'] as const) (console as any)[k] = (...a: any[]) => console.error(...a);
  const { shutdown } = serve({ output: { write: (d: any) => realWrite(d) } as any, exitOnEnd: true });
  for (const sg of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sg, () => shutdown().finally(() => process.exit(0)));
  }
  await new Promise(() => {});
}

async function cmdCheckpoint(_: string[], flags: Record<string, any>) {
  const { createCheckpoint, listCheckpoints, rollbackCheckpoint, diffCheckpoint } = await import('../extras/checkpoint.js');
  const sub = _[0] || 'list';
  const cwd = flags.cwd || process.cwd();
  if (sub === 'create') {
    const msg = _.slice(1).join(' ') || flags.message || 'checkpoint';
    const cp = createCheckpoint(cwd, { message: msg, sessionId: flags['session-id'] });
    if (flags.json) out(cp);
    else out(`Created checkpoint: ${cp.id}\n  Ref: ${cp.ref}\n  Message: ${cp.message}`);
  } else if (sub === 'list') {
    const list = listCheckpoints(cwd, flags['session-id']);
    if (flags.json) out(list);
    else if (!list.length) out('No checkpoints found.');
    else {
      for (const c of list) {
        out(`${c.id.padEnd(24)} ${new Date(c.createdAt).toISOString()} [${c.sessionId || 'default'}] ${c.message}`);
      }
    }
  } else if (sub === 'rollback') {
    const id = _[1];
    if (!id) throw new UsageError('Usage: ab checkpoint rollback <checkpoint-id>');
    const res = rollbackCheckpoint(cwd, id);
    if (flags.json) out(res);
    else out(`Restored workspace to checkpoint ${id} (${res.restoredOid.slice(0, 8)})`);
  } else if (sub === 'diff') {
    const id = _[1];
    if (!id) throw new UsageError('Usage: ab checkpoint diff <checkpoint-id>');
    const d = diffCheckpoint(cwd, id);
    out(d || '(no differences)');
  } else {
    throw new UsageError(`Unknown checkpoint action "${sub}". Expected create|list|rollback|diff`);
  }
}

const HELP = `agentbridge (ab) — drive local claude/codex/opencode/agy/pi/cursor/grok/gemini/devin/acp CLIs and HTTP endpoints.

  ab run <agent> [prompt|-] [--model][--effort][--permissions][--harness auto|claude|pi|none][--cwd][--timeout s]
                             [--session new|ephemeral|continue|fork][--session-id id]
                             [--system '<prompt>'][--json-schema '<json>'][--stream][--json]
                             [--fallback agent[@N][:model],...][--fallback-on RATE_LIMITED,TIMEOUT,...]
                             [--min-remaining-percent 20][--wait-for-quota][--max-quota-wait seconds]
                             [--dangerously-skip-permissions]  # Claude only; requires --permissions full
                             [--yolo]  # Codex only; requires --permissions full
                             [--worktree][--max-cost][--max-tokens][--max-time s]
  ab ask <agent> [prompt|-] [same flags]           # prints only the result text
  ab fanout "<prompt>" agent[:model] ...           # run all, collect all
  ab race   "<prompt>" agent[:model] ...           # first accepted wins, rest cancelled
  ab fix <agent> "<test-cmd>" [--prompt p] [--max-attempts 3]  # TDD auto-repair loop with rollback
  ab review <coder> <reviewer> "<task>" [--max-turns 3]        # Multi-agent review loop with diffs
  ab ensemble "<task>" <a1> <a2> ... [--judge j]               # Multi-agent consensus voting & synthesis
  ab pipeline <pipeline.json> [--checkpoint-each]              # DAG task orchestrator with waves & rollback
  ab quota [agent] [--threshold %]                             # Proactive quota checking
  ab account list [agent] | add <agent> <name> [--copy-current][--login] | use <agent> <name> | remove <agent> <name> | quota
  ab config [list] | get <key> | set <key> <val> [--global] | reset [key]   # manage default permissions & ceilings
  ab checkpoint create [message] | list | rollback <id> | diff <id>   # git hidden-ref snapshots
  ab memory add "<rule>" | decision "<topic>" "<decision>" [--agent a] | list [--json] | clear
  ab sessions | ab ps | ab top [--once] | ab stats
  ab context <session> [--agent a]
  ab handoff <session> --to <agent>
  ab watch <run> | ab wait <run> | ab cancel <run>
  ab serve [--port][--host][--token][--allow-non-loopback][--fallback a,b:model][--min-remaining-percent N][--wait-for-quota][--max-quota-wait seconds][--config file.json][--agent-root DIR][--agent-max-permission edit|full][--agent-max-runs N][--agent-run-ttl minutes][--accounts file.json --accept-tos-risk][--log file.jsonl]
  ab ui [--port 8788][--open][--token t]            # live dashboard: runs, tokens, context, checkpoints, fallbacks
  ab bridge                                        # stdio MCP server
  ab doctor [--live][--json]
  ab setup | ab wizard [--yes]                     # modern interactive terminal setup wizard
  ab install <claude|codex|opencode|agy|pi|cursor|vscode|zed|windsurf|claude-desktop|all> [--scope project|user] [--force]
  ab endpoint [list] | add <name> <baseUrl> [--type openai|anthropic] [--model m] [--api-key-env VAR] | remove <name>
`;

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  let _: string[], flags: Record<string, any>;
  try {
    ({ _, flags } = parseArgs(argv.slice(1)));
  } catch (e) {
    fail(e, false);
    return;
  }
  if (cmd) warnAboutStaleSkillCopies(cmd, flags?.json);
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help' || flags?.help) {
    out(HELP);
    return;
  }
  try {
    switch (cmd) {
      case 'run':
        await cmdRun(_, flags);
        break;
      case 'ask':
        await cmdRun(_, flags, { askOnly: true });
        break;
      case 'fanout':
        await cmdFanoutRace('fanout', _, flags);
        break;
      case 'race':
        await cmdFanoutRace('race', _, flags);
        break;
      case 'sessions':
        await cmdSessions(_, flags);
        break;
      case 'ps':
        await cmdPs(_, flags);
        break;
      case 'top':
        await cmdTop(_, flags);
        break;
      case 'stats':
        await cmdStats(_, flags);
        break;
      case 'context':
        await cmdContext(_, flags);
        break;
      case 'handoff':
        await cmdHandoff(_, flags);
        break;
      case 'watch':
        await cmdWatch(_, flags, false);
        break;
      case 'wait':
        await cmdWatch(_, flags, true);
        break;
      case 'cancel':
        await cmdCancel(_, flags);
        break;
      case 'sweep':
        out(sweep());
        break;
      case 'serve':
        await cmdServe(_, flags);
        break;
      case 'ui':
        await cmdUi(_, flags);
        break;
      case 'bridge':
        await cmdBridge();
        break;
      case 'doctor':
        await cmdDoctor(_, flags);
        break;
      case 'setup':
      case 'wizard':
        await (await import('./setup.js')).cmdSetup(_, flags, { out, err });
        break;
      case 'install':
        await (await import('./install.js')).cmdInstall(_, flags, { out, err });
        break;
      case 'endpoint':
        await (await import('./install.js')).cmdEndpoint(_, flags, { out, err });
        break;
      case 'checkpoint':
        await cmdCheckpoint(_, flags);
        break;
      case 'memory':
        await (await import('../telemetry/memory.js')).cmdMemory(_, flags, { out, err });
        break;
      case 'fix':
        await (await import('../extras/repair.js')).cmdFix(_, flags, { out, err });
        break;
      case 'review':
        await (await import('../extras/consensus.js')).cmdReview(_, flags, { out, err });
        break;
      case 'ensemble':
        await (await import('../extras/consensus.js')).cmdEnsemble(_, flags, { out, err });
        break;
      case 'pipeline':
        await (await import('../extras/pipeline.js')).cmdPipeline(_, flags, { out, err });
        break;
      case 'quota':
        await (await import('../quota/proactive.js')).cmdQuota(_, flags, { out, err });
        break;
      case 'account':
      case 'accounts':
        await (await import('./accounts.js')).cmdAccount(_, flags, { out, err });
        break;
      case 'config':
        await (await import('./config.js')).cmdConfig(_, flags, { out, err });
        break;
      default:
        throw new UsageError(`unknown command "${cmd}". Run "ab --help".`);
    }
  } catch (e) {
    fail(e, !!flags?.json);
  }
}

// `ab` is usually a symlink (npm link / global install): argv[1] is the link path, so compare real paths.
const invoked =
  process.argv[1] &&
  (() => {
    try {
      return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
      return /(main|ab|agentbridge)(\.(mjs|js|ts))?$/i.test(process.argv[1].replace(/\\/g, '/'));
    }
  })();

if (invoked) main();
