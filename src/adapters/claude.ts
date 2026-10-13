import { mkdtempSync, writeFileSync, rmSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { spawnProc, runCollect, ProcessHandle } from '../core/spawn.js';
import { AgentError } from '../core/errors.js';
import { ev, parseJsonLine } from '../core/events.js';
import { validateOptions } from '../index.js';
import { hintFor } from '../core/hints.js';
import { AgentAdapter, AgentEvent, RunResult } from '../types/index.js';

const READ_TOOLS = 'Read,Glob,Grep,WebFetch,WebSearch';
const OFFLINE_READ_TOOLS = 'Read,Glob,Grep';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const AUTH_RE =
  /not logged in|please run \/login|invalid (x-)?api key|authentication_error|invalid authentication|oauth token (has )?(expired|revoked)|failed to authenticate/i;
const ours = new Map<string, string[]>(); // normCwd(resolved cwd) -> ordered session ids started/used by THIS process
const busy = new Map<string, number>(); // session id -> number of in-flight continue runs
const locks = new Map<string, Promise<void>>(); // session id -> promise tail
// NTFS/Windows paths are case-insensitive: resolve then fold case (win32 only) so map keys match
const normCwd = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

async function lock(id: string): Promise<() => void> {
  const prev = locks.get(id) || Promise.resolve();
  let release: () => void;
  const mine = new Promise<void>((res) => {
    release = res;
  });
  const tail = prev.then(() => mine);
  locks.set(id, tail);
  await prev;
  return () => {
    release();
    if (locks.get(id) === tail) locks.delete(id);
  };
}
const bad = (m: string) => new AgentError('BAD_OPTION', m);

function latestSession(cwd: string, env?: NodeJS.ProcessEnv): string | undefined {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    /* keep */
  }
  const root = path.join(
    env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'),
    'projects',
    real.replace(/[^a-zA-Z0-9]/g, '-')
  );
  let best: { t: number; id: string } | undefined;
  try {
    for (const f of readdirSync(root)) {
      if (!f.endsWith('.jsonl') || !UUID.test(f.slice(0, -6))) continue;
      const t = statSync(path.join(root, f)).mtimeMs;
      if (!best || t > best.t) best = { t, id: f.slice(0, -6) };
    }
  } catch {
    /* none */
  }
  return best?.id;
}

const userMessageLine = (o: any) =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...o.images.map((i: any) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })),
        { type: 'text', text: o.prompt },
      ],
    },
  }) + '\n';

/** Claude CLI rejects --dangerously-skip-permissions as root unless IS_SANDBOX=1. */
function runningAsRoot(env?: Record<string, string | undefined>): boolean {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
  return (env?.IS_SANDBOX ?? process.env.IS_SANDBOX) !== '1';
}

function buildArgs(o: any, mcpFile?: string, resumeId?: string): string[] {
  const a = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (o.images?.length) a.push('--input-format', 'stream-json');
  if (o.model) a.push('--model', o.model);
  if (o.effort) a.push('--effort', o.effort);
  const isolated = o.isolated !== false;
  if (isolated) a.push('--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands');
  const ro = !o.permissions || o.permissions === 'read-only';
  const readTools = o.offline ? OFFLINE_READ_TOOLS : READ_TOOLS;
  const mcpTools = mcpFile ? Object.keys(o.mcpServers).map((n) => `mcp__${n.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`) : [];

  let allowedToolsStr: string | undefined;
  switch (o.permissions) {
    case 'edit':
      a.push('--permission-mode', 'acceptEdits');
      if (o.offline) a.push('--disallowed-tools', 'WebFetch,WebSearch');
      allowedToolsStr = [readTools, 'Edit,Write', ...mcpTools].join(',');
      break;
    case 'full':
      a.push('--permission-mode', 'bypassPermissions');
      if (o.dangerouslySkipPermissions === true) a.push('--dangerously-skip-permissions');
      if (o.offline) a.push('--disallowed-tools', 'WebFetch,WebSearch');
      if (mcpTools.length) allowedToolsStr = ['*', ...mcpTools].join(',');
      break;
    case 'plan':
      a.push('--permission-mode', 'plan', '--tools', readTools);
      allowedToolsStr = [readTools, ...mcpTools].join(',');
      break;
    default:
      a.push('--permission-mode', 'default', '--tools', readTools);
      allowedToolsStr = [readTools, ...mcpTools].join(',');
  }
  if (allowedToolsStr) {
    a.push('--allowedTools', allowedToolsStr);
  }
  if (o.systemPrompt) a.push('--system-prompt', o.systemPrompt);
  if (mcpFile) {
    a.push('--mcp-config', mcpFile, '--strict-mcp-config');
  } else if (isolated || ro || o.permissions === 'plan') {
    a.push('--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config');
  }
  if (o.jsonSchema) a.push('--json-schema', JSON.stringify(o.jsonSchema));
  const s = o.session || { mode: 'new' };
  if (s.mode === 'ephemeral') a.push('--no-session-persistence');
  else if (s.mode === 'continue') a.push('--resume', resumeId!);
  else if (s.mode === 'fork') a.push('--resume', resumeId!, '--fork-session');
  if (o.extraArgs) {
    if (!Array.isArray(o.extraArgs) || !o.extraArgs.every((x: any) => typeof x === 'string')) {
      throw bad('extraArgs must be string[]');
    }
    if (o.permissions !== 'full') {
      for (let i = 0; i < o.extraArgs.length; i++) {
        const arg = o.extraArgs[i].trim();
        const restrictiveEmptyTools = /^--tools$/i.test(arg) && o.extraArgs[i + 1] === '' || /^--tools=$/i.test(arg);
        if (!restrictiveEmptyTools && /^(--permission-mode|--tools(?:=|$)|--allowedTools|--allowed-tools|--dangerously-skip-permissions)/i.test(arg)) {
          throw bad(`extraArgs cannot override permissions or tools under "${o.permissions}" permissions`);
        }
      }
    }
    a.push(...o.extraArgs);
  }
  return a;
}

const adapter: AgentAdapter = {
  name: 'claude',
  efforts: [...EFFORTS],
  async models(): Promise<string[]> {
    const set = new Set(['haiku', 'sonnet', 'opus']);
    try {
      const r = await runCollect('claude', ['--help'], { timeoutMs: 15000 });
      const sec = r.stdout.match(/--model <model>[\s\S]*?(?=\n\s+--[a-z]|\n\s+-[a-z],)/i)?.[0] || '';
      for (const m of sec.matchAll(/'([a-z][a-z0-9.-]*)'/g)) set.add(m[1]);
    } catch {
      /* base aliases only */
    }
    return [...set];
  },
  async *run(opts: any): AsyncGenerator<AgentEvent, RunResult, void> {
    if (opts?.dangerouslySkipPermissions != null && typeof opts.dangerouslySkipPermissions !== 'boolean')
      throw bad('dangerouslySkipPermissions must be boolean');
    if (opts && opts.isolated != null && typeof opts.isolated !== 'boolean') throw bad('isolated must be boolean');
    if (opts?.effort != null && !(EFFORTS as readonly string[]).includes(opts.effort))
      throw bad(`effort must be one of ${EFFORTS.join('|')}`);
    const { isolated, effort, ...rest } = opts || {};
    const o = { ...validateOptions(rest), isolated, effort };
    if (o.dangerouslySkipPermissions && o.permissions !== 'full')
      throw bad('dangerouslySkipPermissions requires full permissions');
    if (
      (o.dangerouslySkipPermissions || o.extraArgs?.includes?.('--dangerously-skip-permissions')) &&
      runningAsRoot(o.env)
    )
      throw bad(
        'Claude refuses --dangerously-skip-permissions when running as root/sudo. Run AgentBridge as a non-root user, drop dangerouslySkipPermissions (permissions:"full" already maps to bypassPermissions), or set IS_SANDBOX=1 only inside a real sandbox.'
      );
    const sess = o.session;
    if (sess?.id != null && !UUID.test(sess.id)) throw bad('session.id must be a UUID');
    let resumeId: string | undefined;
    if (sess && (sess.mode === 'continue' || sess.mode === 'fork')) {
      if (sess.id) resumeId = sess.id;
      else {
        const mine = [...(ours.get(normCwd(path.resolve(o.cwd || process.cwd()))) || [])].reverse();
        if (sess.mode === 'continue') {
          resumeId = mine.find((id) => !busy.get(id));
          if (!resumeId && mine.length) throw bad('session busy (in use by another continue); pass an explicit session.id');
        } else resumeId = mine[0];
        if (!resumeId && sess.adoptForeign) resumeId = latestSession(o.cwd || process.cwd(), o.env);
      }
      if (!resumeId)
        throw bad(
          `session mode "${sess.mode}" without id: no session started by this process for cwd (set session.adoptForeign=true to adopt the newest on-disk session) ${
            o.cwd || process.cwd()
          }`
        );
    }
    const t0 = Date.now();
    let unlock: (() => void) | null = null,
      p: ProcessHandle | undefined,
      dir: string | undefined,
      mcpFile: string | undefined,
      claimed: string | null = null;
    if (sess?.mode === 'continue' && resumeId) {
      claimed = resumeId;
      busy.set(claimed, (busy.get(claimed) || 0) + 1);
    }
    try {
      unlock = claimed ? await lock(resumeId!) : null;
      if (o.mcpServers && Object.keys(o.mcpServers).length) {
        dir = mkdtempSync(path.join(tmpdir(), 'ab-claude-'));
        mcpFile = path.join(dir, 'mcp.json');
        writeFileSync(mcpFile, JSON.stringify({ mcpServers: o.mcpServers }));
      }
      const env: NodeJS.ProcessEnv = { ...process.env, ...(o.env || {}) };
      if (o.isolated !== false) {
        env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
        env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
      }
      if (o.env?.ANTHROPIC_API_KEY !== undefined) {
        env.ANTHROPIC_API_KEY = o.env.ANTHROPIC_API_KEY;
      } else {
        env.ANTHROPIC_API_KEY = '';
      }
      if (o.env?.ANTHROPIC_AUTH_TOKEN !== undefined) {
        env.ANTHROPIC_AUTH_TOKEN = o.env.ANTHROPIC_AUTH_TOKEN;
      } else if (env.ANTHROPIC_BASE_URL) {
        if (!env.ANTHROPIC_AUTH_TOKEN) env.ANTHROPIC_AUTH_TOKEN = 'ollama';
      } else {
        env.ANTHROPIC_AUTH_TOKEN = '';
      }
      p = spawnProc('claude', buildArgs(o, mcpFile, resumeId), {
        cwd: o.cwd,
        env,
        input: o.images?.length ? userMessageLine(o) : o.prompt,
        timeoutMs: o.timeoutMs,
        signal: o.signal,
        agent: 'claude',
      });
      let text = '',
        sessionId: string | undefined,
        model: string | undefined,
        final: any,
        stopReason: string | undefined,
        usage: any = { input: 0, output: 0 },
        sawSession = false;
      const toolNames = new Map<string, { name: string; input: any }>();
      for await (const line of p.lines) {
        const m = parseJsonLine(line);
        if (!m) continue;
        if (m.session_id && !sawSession) {
          sawSession = true;
          sessionId = m.session_id;
          if (sess?.mode !== 'ephemeral') {
            const k = normCwd(path.resolve(o.cwd || process.cwd()));
            const l = ours.get(k) || [];
            if (!l.includes(sessionId!)) l.push(sessionId!);
            ours.set(k, l);
          }
          yield ev.session(m.session_id) as any;
        }
        if (m.type === 'system' && m.subtype === 'init') {
          model = m.model || model;
        } else if (m.type === 'stream_event') {
          const e = m.event || {};
          if (e.type === 'message_start') {
            model = e.message?.model || model;
          } else if (e.type === 'message_delta') {
            if (e.delta?.stop_reason) stopReason = e.delta.stop_reason;
          } else if (e.type === 'content_block_delta') {
            if (e.delta?.type === 'text_delta' && e.delta.text) {
              text += e.delta.text;
              yield ev.text(e.delta.text) as any;
            } else if (e.delta?.type === 'thinking_delta' && e.delta.thinking) yield ev.thinking(e.delta.thinking) as any;
          }
        } else if (m.type === 'assistant') {
          for (const b of m.message?.content || []) {
            if (b.type === 'tool_use') {
              toolNames.set(b.id, { name: b.name, input: b.input });
              yield ev.tool(b.name, b.input) as any;
            }
          }
        } else if (m.type === 'user') {
          for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
            if (b.type === 'tool_result') {
              const out = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
              const t = toolNames.get(b.tool_use_id) || { name: 'tool', input: undefined };
              yield ev.tool(t.name, t.input, out) as any;
            }
          }
        } else if (m.type === 'result') {
          final = m;
          const u = m.usage || {};
          usage = {
            input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
            output: u.output_tokens || 0,
          };
          if (m.total_cost_usd != null) usage.cost = m.total_cost_usd;
          yield ev.usage(usage.input, usage.output, usage.cost) as any;
          if (m.modelUsage) model = Object.keys(m.modelUsage)[0] || model;
        }
        yield ev.raw(m) as any;
      }
      const r = await p.wait();
      if (r.aborted) throw new AgentError('ABORTED', 'Aborted', { agent: 'claude' });
      if (r.timedOut) throw new AgentError('TIMEOUT', `claude timed out after ${o.timeoutMs}ms`, { agent: 'claude' });
      if (!final || final.is_error || r.exitCode !== 0) {
        const msg = (final?.result || r.stderr || `claude exited ${r.exitCode}`).toString();
        const code = AUTH_RE.test(msg) ? 'NOT_LOGGED_IN' : 'AGENT_FAILED';
        yield ev.error(msg) as any;
        throw new AgentError(code, code === 'NOT_LOGGED_IN' ? msg + hintFor('claude', code) : msg, {
          agent: 'claude',
          exitCode: r.exitCode,
          stderr: r.stderr,
        });
      }
      let out = typeof final.result === 'string' ? final.result : text;
      if (final.structured_output !== undefined) out = JSON.stringify(final.structured_output);
      return {
        text: out,
        sessionId: sess?.mode === 'ephemeral' ? undefined : final.session_id || sessionId,
        usage,
        exitCode: r.exitCode,
        model,
        durationMs: Date.now() - t0,
        timedOut: false,
        ...(final.stop_reason || stopReason ? { stopReason: final.stop_reason || stopReason } : {}),
        ...(final.structured_output !== undefined ? { structured: final.structured_output } : {}),
      };
    } finally {
      p?.kill();
      unlock?.();
      if (claimed) {
        const n = (busy.get(claimed) || 1) - 1;
        if (n) busy.set(claimed, n);
        else busy.delete(claimed);
      }
      if (dir)
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
    }
  },
};

export default adapter;
