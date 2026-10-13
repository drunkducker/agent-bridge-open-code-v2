// Context policy + compaction + cross-agent handoff.
import { mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { AgentError } from '../core/errors.js';
import { home } from '../bridge/runs.js';
import { contextOf, listSessions, telemetryDir } from './stats.js';

export const LEVELS = ['ok', 'warn', 'compact', 'hard'] as const;
export type ContextLevel = (typeof LEVELS)[number];
const KEYS = ['warn', 'compact', 'hard', 'autoCompact', 'hardAction', 'handoffTo'] as const;

export interface PolicyLimits {
  warn?: number | null;
  compact?: number | null;
  hard?: number | null;
  autoCompact?: boolean;
  hardAction?: 'block' | 'handoff' | 'none';
  handoffTo?: string | null;
}

export const DEFAULT_POLICY: Required<PolicyLimits> = {
  warn: 0.7,
  compact: null,
  hard: null,
  autoCompact: false,
  hardAction: 'block',
  handoffTo: null,
};

const polFile = (env: NodeJS.ProcessEnv): string => path.join(telemetryDir(env), 'policy.json');

export function loadPolicies(env: NodeJS.ProcessEnv = process.env): any {
  try {
    return JSON.parse(readFileSync(polFile(env), 'utf8'));
  } catch {
    return {};
  }
}

function validateLimits(l: Record<string, any>): Record<string, any> {
  for (const k of Object.keys(l)) {
    if (!(KEYS as readonly string[]).includes(k)) throw new AgentError('BAD_OPTION', `Unknown policy key "${k}"`);
  }
  for (const k of ['warn', 'compact', 'hard']) {
    if (l[k] != null && !(Number.isFinite(l[k]) && l[k] > 0))
      throw new AgentError('BAD_OPTION', `policy.${k} must be a positive number (<=1 fraction, >1 tokens)`);
  }
  const w = l.warn,
    c = l.compact,
    h = l.hard;
  const ord = [w, c, h].filter((x) => x != null);
  if (ord.some((x, i) => i && (x <= 1) === (ord[i - 1] <= 1) && x < ord[i - 1]))
    throw new AgentError('BAD_OPTION', 'policy thresholds must satisfy warn <= compact <= hard');
  if (l.hardAction != null && !['block', 'handoff'].includes(l.hardAction))
    throw new AgentError('BAD_OPTION', 'hardAction must be block|handoff');
  return l;
}

export function setPolicy(
  scope: { agent?: string; session?: string } | null | undefined,
  limits: PolicyLimits,
  env: NodeJS.ProcessEnv = process.env
): any {
  validateLimits(limits);
  const all = loadPolicies(env);
  const bucket = scope?.session
    ? ((all.sessions ||= {})[scope.session] ||= {})
    : scope?.agent
    ? ((all.agents ||= {})[scope.agent] ||= {})
    : (all.default ||= {});
  Object.assign(bucket, limits);
  mkdirSync(path.dirname(polFile(env)), { recursive: true });
  const tmp = `${polFile(env)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 1));
  renameSync(tmp, polFile(env));
  return all;
}

export function resolvePolicy(
  agent: string,
  sessionId?: string | null,
  all: any = {},
  inline: PolicyLimits = {}
): Required<PolicyLimits> {
  return {
    ...DEFAULT_POLICY,
    ...(all.default || {}),
    ...(all.agents?.[agent] || {}),
    ...((sessionId && all.sessions?.[sessionId]) || {}),
    ...(inline || {}),
  };
}

export const getPolicy = (
  agent: string,
  sessionId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
  inline?: PolicyLimits
): Required<PolicyLimits> => resolvePolicy(agent, sessionId, loadPolicies(env), inline);

export function evaluate(
  { tokens, window }: { tokens: number; window: number },
  limits: PolicyLimits
): {
  level: ContextLevel;
  thresholds: { warn: number | null; compact: number | null; hard: number | null };
  tokens: number;
  window: number;
  pct: number | null;
} {
  const abs = (v?: number | null) => (v == null ? null : v <= 1 ? Math.round(v * window) : v);
  const th = { warn: abs(limits.warn), compact: abs(limits.compact), hard: abs(limits.hard) };
  let level: ContextLevel = 'ok';
  for (const k of ['warn', 'compact', 'hard'] as const) {
    if (th[k] != null && tokens >= th[k]!) level = k;
  }
  return { level, thresholds: th, tokens, window, pct: window ? +(tokens / window).toFixed(4) : null };
}

export const levelAtLeast = (a: ContextLevel, b: ContextLevel): boolean =>
  LEVELS.indexOf(a) >= LEVELS.indexOf(b);

export const HANDOFF_PROMPT = `Write a HANDOFF for another engineer (possibly another AI agent) who will continue this work with NO access to this conversation.
Use EXACTLY these markdown sections and be concrete (names, paths, values, decisions, exact identifiers/codes mentioned by the user):
## Summary
## Key facts and decisions
## Key files
## Open tasks
Do not use any tools. Do not add other sections.`;

export function parseSections(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  let cur: string | null = null;
  for (const line of String(md).split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      cur = m[1].toLowerCase();
      out[cur] = '';
    } else if (cur) out[cur] += line + '\n';
  }
  for (const k of Object.keys(out)) out[k] = out[k].trim();
  return out;
}

export function buildHandoffDoc({
  fromAgent,
  fromSession,
  toAgent,
  cwd,
  summaryMd,
  files = [],
  firstPrompt,
  lastText,
  degraded = false,
  viaContinue = false,
  at = new Date().toISOString(),
}: {
  fromAgent: string;
  fromSession: string;
  toAgent: string;
  cwd?: string;
  summaryMd?: string;
  files?: string[];
  firstPrompt?: string;
  lastText?: string;
  degraded?: boolean;
  viaContinue?: boolean;
  at?: string;
}): string {
  const sec = parseSections(summaryMd || '');
  const get = (k: string, alt?: string) => sec[k] || (alt ? sec[alt] : '') || '';
  const fileLines = [
    ...new Set([
      ...files,
      ...get('key files')
        .split('\n')
        .map((l) => l.replace(/^[-*]\s*/, '').trim())
        .filter(Boolean),
    ]),
  ].slice(0, 60);
  const openTasks = get('open tasks');
  return [
    `# HANDOFF`,
    ``,
    `- from: ${fromAgent} session ${fromSession}`,
    `- to: ${toAgent}`,
    `- cwd: ${cwd || '(unknown)'}`,
    `- created: ${at}`,
    degraded
      ? `- note: DEGRADED handoff (the source session could not be summarized; built from recorded telemetry only)`
      : `- note: summary written by the source agent from its own session${
          viaContinue ? ' (this agent cannot fork, so the summary request was appended to the source session)' : ''
        }`,
    ``,
    `## Summary`,
    get('summary') ||
      (degraded ? `Original request: ${firstPrompt || '(unknown)'}\n\nLast agent output:\n${lastText || '(none)'}` : '(none)'),
    ``,
    `## Key facts and decisions`,
    get('key facts and decisions', 'key facts') || '(none recorded)',
    ``,
    `## Key files`,
    fileLines.length ? fileLines.map((f) => `- ${f}`).join('\n') : '(none)',
    ``,
    `## Open tasks`,
    openTasks || '(none recorded)',
    ``,
    `---`,
    `You are continuing this work. Treat the facts above as authoritative context from the previous agent; verify files before editing.`,
    ``,
  ].join('\n');
}

export const seedPrompt = (doc: string): string =>
  `${doc}\n\nYou are taking over this work now. Acknowledge by replying with exactly one line: "READY: " followed by one sentence stating what you are continuing.`;

export const MAINTENANCE_POLICY: PolicyLimits = {
  warn: null,
  hard: null,
  autoCompact: false,
  hardAction: 'none',
};

const lazy = () => import('./track.js');

export async function handoff(sessionId: string, toAgent: string, opts: any = {}): Promise<any> {
  const env = opts.env || process.env;
  const { askWithTelemetry } = await lazy();
  const rec = listSessions(env).find((s) => s.sessionId === sessionId && (!opts.agent || s.agent === opts.agent));
  const ctx = contextOf(sessionId, { agent: opts.agent, env });
  const fromAgent = opts.agent || rec?.agent || ctx?.agent;
  if (!fromAgent) throw new AgentError('BAD_OPTION', `Unknown session "${sessionId}": pass opts.agent`);
  const cwd = opts.cwd || rec?.cwd || process.cwd();
  let summaryMd = '',
    degraded = false;
  const canFork = opts.summarizer
    ? true
    : (await ((await import('../index.js')) as any).agents.get(fromAgent).catch(() => ({}))).canFork !== false;
  try {
    summaryMd = opts.summarizer
      ? await opts.summarizer({ agent: fromAgent, sessionId, cwd })
      : (
          await askWithTelemetry(
            fromAgent,
            {
              prompt: HANDOFF_PROMPT,
              session: { mode: canFork ? 'fork' : 'continue', id: sessionId },
              cwd,
              model: opts.fromModel,
              permissions: 'read-only',
              timeoutMs: opts.timeoutMs || 240_000,
            },
            { env, hooks: {}, policy: MAINTENANCE_POLICY }
          )
        ).text;
    if (!parseSections(summaryMd).summary) throw new Error('summary has no "## Summary" section');
  } catch (e: any) {
    degraded = true;
    summaryMd = '';
    opts.onDegraded?.(e);
  }
  const doc = buildHandoffDoc({
    fromAgent,
    fromSession: sessionId,
    toAgent,
    cwd,
    summaryMd,
    files: rec?.files || [],
    firstPrompt: rec?.firstPrompt,
    lastText: rec?.lastText,
    degraded,
    viaContinue: !canFork && !degraded,
  });
  const dir = path.join(home(env), 'handoffs');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${fromAgent}-${String(sessionId).slice(0, 8)}-to-${toAgent}-${Date.now()}.md`);
  writeFileSync(file, doc);
  const out: any = {
    doc,
    path: file,
    fromAgent,
    toAgent,
    fromSession: sessionId,
    newSessionId: null,
    ack: null,
    seeded: false,
    degraded,
    sourceContext: ctx,
  };
  if (opts.seed !== false) {
    const r = await askWithTelemetry(
      toAgent,
      {
        prompt: seedPrompt(doc),
        cwd,
        model: opts.model,
        permissions: 'read-only',
        timeoutMs: opts.timeoutMs || 240_000,
        session: { mode: 'new' },
      },
      { env, hooks: {}, policy: MAINTENANCE_POLICY }
    );
    out.newSessionId = r.sessionId;
    out.ack = String(r.text || '').trim();
    out.seeded = true;
  }
  return out;
}

export async function compact(sessionId: string, opts: any = {}): Promise<any> {
  const env = opts.env || process.env;
  const before = contextOf(sessionId, { agent: opts.agent, env, refresh: true });
  const agent = opts.agent || before?.agent;
  if (!agent) throw new AgentError('BAD_OPTION', `Unknown session "${sessionId}": pass opts.agent`);
  const method = opts.method || 'auto';
  const { askWithTelemetry } = await lazy();
  const cwd = opts.cwd || listSessions(env).find((s) => s.sessionId === sessionId)?.cwd || process.cwd();
  if ((method === 'auto' || method === 'native') && agent === 'claude') {
    try {
      await askWithTelemetry(
        'claude',
        {
          prompt: '/compact',
          session: { mode: 'continue', id: sessionId },
          cwd,
          timeoutMs: opts.timeoutMs || 240_000,
          permissions: 'read-only',
          isolated: false,
        },
        { env, hooks: {}, policy: MAINTENANCE_POLICY }
      );
      const after = contextOf(sessionId, { agent, env, refresh: true });
      if (after?.source === 'claude-compact-summary-estimate') {
        let measured: any = null;
        if (opts.measure !== false) {
          try {
            await askWithTelemetry(
              'claude',
              {
                prompt: 'Reply with exactly: OK',
                session: { mode: 'continue', id: sessionId },
                cwd,
                timeoutMs: opts.timeoutMs || 240_000,
                permissions: 'read-only',
              },
              { env, hooks: {}, policy: MAINTENANCE_POLICY }
            );
            measured = contextOf(sessionId, { agent, env, refresh: true });
          } catch {
            /* keep estimate */
          }
        }
        const fin = measured?.exact ? measured : after;
        return {
          method: 'native',
          mechanism: 'claude /compact via --resume',
          sessionId,
          before,
          after: fin,
          afterMeasuredByFollowUp: !!measured?.exact,
          summaryOnlyEstimate: after,
        };
      }
    } catch (e) {
      if (method === 'native') throw e;
    }
  } else if (method === 'native')
    throw new AgentError('BAD_OPTION', `${agent} has no non-interactive native compact; use method:'summarize'`);
  const h = await handoff(sessionId, agent, { ...opts, agent, env, seed: true });
  return {
    method: 'summarize-new-session',
    mechanism: 'handoff doc from forked session seeds a new session',
    sessionId: h.newSessionId,
    previousSession: sessionId,
    handoffPath: h.path,
    degraded: h.degraded,
    before,
    after: h.newSessionId ? contextOf(h.newSessionId, { agent, env, refresh: true }) : null,
  };
}
