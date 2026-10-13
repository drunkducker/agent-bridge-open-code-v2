// Antigravity CLI (`agy`) adapter.
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  existsSync,
  statSync,
  renameSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { spawnProc, runCollect, resolveBinary, ProcessHandle } from '../core/spawn.js';
import { AgentError } from '../core/errors.js';
import { ev, parseJsonLine } from '../core/events.js';
import { validateOptions } from '../index.js';
import { home } from '../bridge/runs.js';
import { AgentAdapter, AgentEvent, RunResult } from '../types/index.js';

const NAME = 'agy';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHARED = ['conversations', 'brain', 'annotations'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const FALLBACK_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.1-pro',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'gpt-oss-120b',
];
const AUTH_RE =
  /authentication required|not (logged|signed) in|please (log|sign) in|unauthenticated|auth(entication)? (failed|error)|credentials? (expired|invalid)/i;
const OPTION_RE =
  /invalid model selection|not recognized as a known model|conflicts with --effort|invalid --effort|unknown (flag|option)|flag provided but not defined/i;
const busy = new Set<string>();
const bad = (m: string) => new AgentError('BAD_OPTION', m, { agent: NAME });

export function findBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  // Honor an explicit binary override as an account/runtime selection. If it is invalid,
  // fail closed rather than silently running a different agy found on PATH or in defaults.
  if (Object.prototype.hasOwnProperty.call(env, 'AGY_BIN')) {
    const explicit = env.AGY_BIN?.trim();
    return explicit ? resolveBinary(explicit, env) : null;
  }
  const local = env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
  const cands = [
    path.join(local, 'agy', 'bin', 'agy.exe'),
    path.join(homedir(), '.local', 'bin', 'agy'),
    path.join(homedir(), '.gemini', 'antigravity-cli', 'bin', 'agy'),
  ].filter(Boolean) as string[];
  return (
    resolveBinary(NAME, env) ||
    cands.find((c) => {
      try {
        return statSync(c).isFile();
      } catch {
        return false;
      }
    }) ||
    null
  );
}

export const storeDir = (env: NodeJS.ProcessEnv = process.env): string => path.join(home(env), 'agy-store');
const metaFile = (env: NodeJS.ProcessEnv, id: string): string => path.join(storeDir(env), 'meta', `${id}.json`);

function writeJson(f: string, o: any): void {
  mkdirSync(path.dirname(f), { recursive: true });
  const t = `${f}.${process.pid}.tmp`;
  writeFileSync(t, JSON.stringify(o));
  renameSync(t, f);
}

function recordSession(env: NodeJS.ProcessEnv, id: string, cwd: string): void {
  try {
    writeJson(metaFile(env, id), { id, cwd, ts: Date.now() });
  } catch {
    /* best effort */
  }
}

function sessionExists(env: NodeJS.ProcessEnv, id: string): boolean {
  return existsSync(path.join(storeDir(env), 'conversations', `${id}.db`));
}

function latestSessionFor(env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  let best: any;
  try {
    for (const f of readdirSync(path.join(storeDir(env), 'meta'))) {
      let m: any;
      try {
        m = JSON.parse(readFileSync(path.join(storeDir(env), 'meta', f), 'utf8'));
      } catch {
        continue;
      }
      if (norm(m.cwd) === norm(cwd) && UUID.test(m.id) && !busy.has(m.id) && sessionExists(env, m.id) && (!best || m.ts > best.ts))
        best = m;
    }
  } catch {
    /* none */
  }
  return best?.id;
}

export function settingsFor(permissions: string, mcpNames: string[] = [], offline = false): any {
  const allow = mcpNames.map((n) => `mcp(${n}/*)`);
  const deny =
    permissions === 'full' && !offline
      ? []
      : [
          'command(*)',
          'unsandboxed(*)',
          ...(offline ? ['execute_url(*)'] : []),
          ...(permissions === 'edit' ? ['write_file(.agents/)'] : permissions === 'full' ? [] : ['write_file(*)']),
        ];
  return { permissions: { ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}) } };
}

export interface HomeEnv {
  dir: string;
  cli: string;
  links: string[];
}

export function makeHome({
  env,
  settings,
  mcpServers,
  shared,
  rules,
}: {
  env: NodeJS.ProcessEnv;
  settings: any;
  mcpServers?: Record<string, any>;
  shared?: boolean;
  rules?: string;
}): HomeEnv {
  const h = mkdtempSync(path.join(tmpdir(), 'ab-agy-'));
  const cli = path.join(h, '.gemini', 'antigravity-cli');
  const links: string[] = [];
  try {
    mkdirSync(cli, { recursive: true });
    if (shared)
      for (const d of SHARED) {
        const target = path.join(storeDir(env), d);
        mkdirSync(target, { recursive: true });
        const l = path.join(cli, d);
        symlinkSync(target, l, process.platform === 'win32' ? 'junction' : 'dir');
        links.push(l);
      }
    writeFileSync(path.join(cli, 'settings.json'), JSON.stringify(settings));
    if (rules) writeFileSync(path.join(h, '.gemini', 'GEMINI.md'), rules);
    if (mcpServers && Object.keys(mcpServers).length) {
      mkdirSync(path.join(h, '.gemini', 'config'), { recursive: true });
      const servers: Record<string, any> = {};
      for (const [n, s] of Object.entries(mcpServers))
        servers[n] = {
          command: s.command,
          args: s.args || [],
          env: s.env || {},
          disabled: false,
          ...(s.timeout != null ? { timeout: s.timeout } : {}),
        };
      writeFileSync(path.join(h, '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: servers }));
    }
  } catch (e) {
    destroyHome({ dir: h, cli, links });
    throw e;
  }
  return { dir: h, cli, links };
}

const HAZARDS = ['mcp_config.json', 'hooks.json'];
export function workspaceHazards(cwd: string): string[] {
  return HAZARDS.map((f) => path.join('.agents', f)).filter((f) => existsSync(path.join(cwd, f)));
}
const ROOT_FLAGS = /^--?(dangerously-skip-permissions|mode|add-dir|agent|project|new-project|remote-control)(=|$)/;
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

export function destroyHome(hm?: HomeEnv | null): void {
  if (!hm) return;
  let safe = true;
  for (const l of hm.links) {
    try {
      rmdirSync(l);
    } catch (e: any) {
      if (e.code !== 'ENOENT') safe = false;
    }
  }
  if (safe) {
    try {
      rmSync(hm.dir, { recursive: true, force: true });
    } catch {
      /* temp dir */
    }
  }
}

function usageOf(u: any) {
  return {
    input: u?.input_tokens || 0,
    output: u?.output_tokens || 0,
    cachedInput: u?.cache_read_tokens || 0,
    reasoning: u?.thinking_tokens || 0,
  };
}

const adapter: AgentAdapter = {
  name: NAME,
  efforts: [...EFFORTS],
  canFork: false,
  async models(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    const bin = findBinary(env);
    if (!bin) return FALLBACK_MODELS;
    try {
      const r = await runCollect(bin, ['models'], { timeoutMs: 30000, env: { ...env } });
      const base = new Set<string>(),
        all: string[] = [];
      for (const line of r.stdout.split('\n')) {
        const slug = line.split('\t')[0].trim();
        if (!/^[a-z][a-z0-9.-]*$/.test(slug) || slug === 'fetching') continue;
        all.push(slug);
        const b = slug.replace(/-(low|medium|high)$/, '');
        if (b !== slug) base.add(b);
      }
      return all.length ? [...new Set([...base, ...all])] : FALLBACK_MODELS;
    } catch {
      return FALLBACK_MODELS;
    }
  },
  async *run(opts: any): AsyncGenerator<AgentEvent, RunResult, void> {
    const o = validateOptions(opts);
    if (o.isolated === false)
      throw bad('agy always runs in an isolated home (that is how permissions are enforced); isolated:false is not supported');
    if (o.effort != null && !(EFFORTS as readonly string[]).includes(o.effort))
      throw bad(`effort must be one of ${EFFORTS.join('|')}`);
    const perms = o.permissions || 'read-only';
    const sess = o.session || { mode: 'new' };
    if (sess.mode === 'fork')
      throw bad(
        'agy cannot fork a conversation (verified: a copied conversation is rejected as "trajectory not found"); use mode "new" with a handoff, or "continue"'
      );
    if (o.model && o.effort && /-(low|medium|high)$/.test(o.model))
      throw bad(
        `model "${o.model}" already encodes its effort; pass the base model "${o.model.replace(/-(low|medium|high)$/, '')}" together with effort, or drop effort`
      );
    if (perms !== 'full' && (o.extraArgs || []).some((a: string) => ROOT_FLAGS.test(a)))
      throw bad(`extraArgs may not change the permission mode, workspace roots, agent or project when permissions is "${perms}"`);
    if (o.jsonSchema != null && (typeof o.jsonSchema !== 'object' || Array.isArray(o.jsonSchema)))
      throw bad('jsonSchema must be a JSON Schema object');

    const env = { ...process.env, ...(o.env || {}) };
    const bin = findBinary(env);
    if (!bin)
      throw new AgentError(
        'NOT_INSTALLED',
        'Antigravity CLI (agy) not found on PATH (also looked in %LOCALAPPDATA%\\agy\\bin and ~/.local/bin). Install it, log in once with `agy`, or set AGY_BIN.',
        { agent: NAME, binary: NAME }
      );
    const cwd = path.resolve(o.cwd || process.cwd());
    if (perms !== 'full') {
      const hz = workspaceHazards(cwd);
      if (hz.length)
        throw bad(
          `cwd contains ${hz.join(
            ', '
          )}: agy executes that at startup regardless of permissions, which would defeat "${perms}". Remove it, use another cwd, or run with permissions "full".`
        );
    }

    let resumeId: string | undefined,
      claimed: string | null = null;
    if (sess.mode === 'continue') {
      if (sess.id != null && !UUID.test(sess.id)) throw bad('session.id must be a UUID');
      resumeId = sess.id || latestSessionFor(env, cwd);
      if (!resumeId) throw bad(`session mode "continue" without id: no agy session recorded for cwd ${cwd}`);
      if (!sessionExists(env, resumeId)) throw bad(`Unknown agy conversation "${resumeId}"`);
      if (busy.has(resumeId)) throw bad('session busy (in use by another continue)');
      busy.add(resumeId);
      claimed = resumeId;
    }

    const t0 = Date.now();
    let hm: HomeEnv | undefined, p: ProcessHandle | undefined, schemaFile: string | undefined;
    try {
      const mcpNames = Object.keys(o.mcpServers || {});
      const realHome = Object.fromEntries(['USERPROFILE', 'HOME'].filter((k) => env[k]).map((k) => [k, env[k]]));
      const mcpServers = Object.fromEntries(
        Object.entries(o.mcpServers || {}).map(([n, s]: [string, any]) => [n, { ...s, env: { ...realHome, ...(s.env || {}) } }])
      );
      hm = makeHome({
        env,
        settings: settingsFor(perms, mcpNames, !!o.offline),
        mcpServers,
        shared: sess.mode !== 'ephemeral',
        rules: o.systemPrompt,
      });
      const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands'];
      if (o.model) args.push('--model', o.model);
      if (o.effort) args.push('--effort', o.effort);
      if (perms === 'plan') args.push('--mode', 'plan');
      if (perms === 'full') args.push('--dangerously-skip-permissions');
      if (resumeId) args.push('--conversation', resumeId);
      if (o.jsonSchema) {
        schemaFile = path.join(hm.dir, 'schema.json');
        writeFileSync(schemaFile, JSON.stringify(o.jsonSchema));
        args.push('--json-schema', schemaFile);
      }
      if (o.extraArgs) args.push(...o.extraArgs);
      p = spawnProc(bin, args, {
        cwd,
        input: JSON.stringify({ event: 'user', message: { content: o.prompt } }) + '\n',
        timeoutMs: o.timeoutMs,
        signal: o.signal,
        agent: NAME,
        env: { ...(o.env || {}), USERPROFILE: hm.dir, HOME: hm.dir },
      });

      let init: any,
        res: any,
        streamed = '';
      const sum: Record<string, number> = { input: 0, output: 0, cachedInput: 0, reasoning: 0 };
      let usageSeen = false;
      const tools = new Map<number, boolean>();
      for await (const line of p.lines) {
        const m = parseJsonLine(line);
        if (!m) continue;
        if (m.event === 'init') {
          init = m;
          if (m.conversation_id) yield ev.session(m.conversation_id) as any;
        } else if (m.event === 'step_update') {
          const u = m.step_update || {};
          if (u.step_type === 'agent_response') {
            if (u.text_delta) {
              streamed += u.text_delta;
              yield ev.text(u.text_delta) as any;
            }
            if (u.state === 'DONE' && u.usage) {
              const x: any = usageOf(u.usage);
              usageSeen = true;
              for (const k of Object.keys(sum)) sum[k] += x[k];
              yield ev.usage(x.input, x.output, undefined, true) as any;
            }
          } else if (u.step_type === 'tool') {
            const info = u.tool_info || {};
            let name = u.tool_name || info.name || 'tool',
              input = info.parameters;
            if (name === 'call_mcp_tool' && input?.ToolName) {
              name = `mcp__${input.ServerName}__${input.ToolName}`;
              input = input.Arguments;
            }
            if (!tools.has(u.step_index)) {
              tools.set(u.step_index, true);
              yield ev.tool(name, input) as any;
            }
            if (u.state === 'DONE') yield ev.tool(name, input, info.output ?? '') as any;
            else if (u.state === 'ERROR') yield ev.tool(name, input, `ERROR: ${info.error?.message || 'tool failed'}`) as any;
          }
        } else if (m.event === 'result') res = m.result;
        yield ev.raw(m) as any;
      }
      const r = await p.wait();
      if (r.aborted) throw new AgentError('ABORTED', 'Aborted', { agent: NAME });
      if (r.timedOut) throw new AgentError('TIMEOUT', `agy timed out after ${o.timeoutMs}ms`, { agent: NAME });
      const errText = (res?.error || r.stderr || '').toString().trim();
      if (!res || res.status !== 'SUCCESS' || r.exitCode !== 0) {
        const msg = errText || `agy exited ${r.exitCode}${res?.status ? ` (status ${res.status})` : ''}`;
        yield ev.error(msg) as any;
        const code = AUTH_RE.test(msg) ? 'NOT_LOGGED_IN' : OPTION_RE.test(msg) ? 'BAD_OPTION' : 'AGENT_FAILED';
        throw new AgentError(code, msg.slice(0, 1500), { agent: NAME, exitCode: r.exitCode, stderr: r.stderr });
      }
      const sessionId = res.conversation_id || init?.conversation_id;
      if (resumeId && sessionId !== resumeId)
        throw new AgentError('AGENT_FAILED', `agy did not resume conversation ${resumeId} (it started ${sessionId || 'none'})`, {
          agent: NAME,
        });
      const structured = res.structured_output;
      const text = (
        structured !== undefined ? JSON.stringify(structured) : typeof res.response === 'string' ? res.response : streamed
      ).trimEnd();
      if (!text.trim() && !streamed.trim()) {
        const notice = /jetski: no output produced[^\n]*/.exec(r.stderr || '')?.[0];
        const msg = notice
          ? `agy produced no output: ${notice.replace(/^jetski: no output produced\s*[-—]?\s*/, '')} (permissions: ${perms})`
          : 'agy returned an empty response';
        yield ev.error(msg) as any;
        throw new AgentError('AGENT_FAILED', msg, { agent: NAME, stderr: r.stderr });
      }
      const usage = usageSeen
        ? {
            input: sum.input,
            output: sum.output,
            ...(sum.cachedInput ? { cachedInput: sum.cachedInput } : {}),
            ...(sum.reasoning ? { reasoning: sum.reasoning } : {}),
          }
        : { input: res.usage?.input_tokens || 0, output: res.usage?.output_tokens || 0 };
      if (sess.mode !== 'ephemeral' && sessionId) recordSession(env, sessionId, cwd);
      return {
        text,
        sessionId: sess.mode === 'ephemeral' ? undefined : sessionId,
        usage,
        exitCode: r.exitCode,
        model: o.model || init?.init?.model || 'default',
        durationMs: Date.now() - t0,
        timedOut: false,
        ...(structured !== undefined ? { structured } : {}),
      };
    } finally {
      p?.kill();
      destroyHome(hm);
      if (claimed) busy.delete(claimed);
    }
  },
};

export default adapter;
