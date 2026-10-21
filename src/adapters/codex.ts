// Codex adapter: drives the installed `codex` CLI (`codex exec --json`) using the local ChatGPT login.
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { spawnProc } from '../core/spawn.js';
import { AgentError } from '../core/errors.js';
import { ev, parseJsonLine } from '../core/events.js';
import { validateOptions } from '../index.js';
import { AgentAdapter, AgentEvent, RunResult } from '../types/index.js';
import { LruMap } from '../core/lru.js';
import { codexDaemonPool } from './codex-daemon.js';

export { codexDaemonPool };

const codexHome = (env?: NodeJS.ProcessEnv): string => env?.CODEX_HOME || process.env.CODEX_HOME || path.join(homedir(), '.codex');
const toml = (v: any): string => JSON.stringify(v);
const EFFORT: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', max: 'xhigh' };
const SANDBOX: Record<string, string> = { 'read-only': 'read-only', plan: 'read-only', edit: 'workspace-write', full: 'danger-full-access' };
const PLAN_NOTE = 'PLAN MODE: do not modify any files or run state-changing commands. Only analyze and reply with a plan.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (m: string) => new AgentError('BAD_OPTION', m);

function widensSandbox(extraArgs: string[]): boolean {
  const protectedConfig = (value: string | undefined) =>
    !!value && /^(?:\s*(?:sandbox_mode|windows\.sandbox|sandbox_workspace_write(?:\.[A-Za-z0-9_-]+)*|sandbox_permissions(?:\.[A-Za-z0-9_-]+)*)\s*=|\s*windows\s*=\s*\{[^}]*\bsandbox\s*=)/i.test(value);
  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i].trim();
    if (/^(?:--dangerously-bypass-approvals-and-sandbox|--yolo)(?:=|$)/i.test(arg)) return true;
    if (/^(?:--full-auto|--add-dir)(?:=|$)/i.test(arg)) return true;
    if (/^(?:--sandbox|-s)(?:=|$)/i.test(arg) || /^-s(?:read-only|workspace-write|danger-full-access)$/i.test(arg)) return true;
    if (arg === '-c' || arg === '--config') {
      if (protectedConfig(extraArgs[i + 1]?.trim())) return true;
      continue;
    }
    if (arg.startsWith('--config=')) {
      if (protectedConfig(arg.slice('--config='.length))) return true;
      continue;
    }
    if (arg.startsWith('-c=')) {
      if (protectedConfig(arg.slice(3))) return true;
      continue;
    }
    // Codex accepts both `-c key=value` and attached short-option values such as `-ckey=value`.
    if (/^-c.+/s.test(arg) && protectedConfig(arg.slice(2))) return true;
    if (arg.startsWith('--sandbox=')) return true;
  }
  return false;
}

function conflictsWithYolo(extraArgs: string[]): boolean {
  const option = /^(?:--sandbox(?:=|$)|-s\S*|--ask-for-approval(?:=|$)|-a\S*|--full-auto(?:=|$))/i;
  const config = /(?:^|\s)(?:sandbox_mode|windows\.sandbox|sandbox_workspace_write(?:\.[A-Za-z0-9_-]+)*|sandbox_permissions(?:\.[A-Za-z0-9_-]+)*|approval_policy)\s*=/i;
  for (let i = 0; i < extraArgs.length; i++) {
    const arg = extraArgs[i].trim();
    if (option.test(arg)) return true;
    const configValues = [arg];
    if (arg === '-c' || arg === '--config') configValues.push(extraArgs[i + 1]?.trim() || '');
    else if (arg.startsWith('--config=')) configValues.push(arg.slice('--config='.length));
    else if (arg.startsWith('-c=')) configValues.push(arg.slice(3));
    else if (/^-c.+/s.test(arg)) configValues.push(arg.slice(2));
    if (configValues.some((value) => config.test(value))) return true;
  }
  return false;
}

function rolloutExists(id: string, env?: NodeJS.ProcessEnv): boolean {
  const root = path.join(codexHome(env), 'sessions');
  let found = false;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (found) return;
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.startsWith('rollout-') && e.name.endsWith(id + '.jsonl')) found = true;
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

const OWN = new LruMap<string, string>(1000);

function newestRollout(cwd: string, adoptForeign: boolean, scope = '', env?: NodeJS.ProcessEnv): string | undefined {
  const root = path.join(codexHome(env), 'sessions');
  let best: { m: number; id: string } | null = null;
  const want = path.resolve(cwd).toLowerCase();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        const m = statSync(p).mtimeMs;
        if (best && m <= best.m) continue;
        try {
          const first = parseJsonLine(readFileSync(p, 'utf8').split('\n', 1)[0]);
          const c = first?.payload?.cwd;
          if (c && (adoptForeign || OWN.get(first.payload.id) === scope) && path.resolve(c).toLowerCase() === want)
            best = { m, id: first.payload.id };
        } catch {
          /* ignore */
        }
      }
    }
  };
  if (existsSync(root)) walk(root);
  return (best as { m: number; id: string } | null)?.id;
}

function sandboxInfo(o: any) {
  const win = process.platform === 'win32' && !(o.extraArgs || []).some((x: string) => /windows.sandbox/.test(x));
  const mode = SANDBOX[o.permissions];
  const cwd = path.resolve(o.cwd || process.cwd());
  const writeRoots = mode === 'read-only' ? [] : mode === 'workspace-write' ? [cwd, ...(o.writableRoots || []).map((r: string) => path.resolve(r))] : ['*'];
  const notes: string[] = [];
  if (win && mode !== 'danger-full-access')
    notes.push(
      'Injected -c windows.sandbox="unelevated" (default elevated sandbox fails on this class of host). Writes are restricted; reads are NOT restricted (any file the user can read).'
    );
  if (mode === 'workspace-write') notes.push('TEMP/tmp excluded from writable roots.');
  if (o.permissions === 'plan') notes.push('plan = read-only sandbox + prompt instruction.');
  return { mode, readScope: 'unrestricted', writeRoots, note: notes.join(' ') };
}

const BUSY = new Map<string, number>();
const release = (claim: { id?: string }) => {
  if (!claim.id) return;
  const n = (BUSY.get(claim.id) || 1) - 1;
  if (n <= 0) BUSY.delete(claim.id);
  else BUSY.set(claim.id, n);
  claim.id = undefined;
};

function buildArgs(o: any, schemaFile?: string, claim: { id?: string } = {}, imageFiles: string[] = []): string[] {
  const s = o.session || { mode: 'new' };
  const mode = s.mode || 'new';
  if (!['new', 'ephemeral', 'continue', 'fork'].includes(mode)) throw new AgentError('BAD_OPTION', `Unknown session mode ${mode}`);
  if (s.id != null && !(typeof s.id === 'string' && UUID.test(s.id))) throw bad('session.id must be a session UUID');
  const fresh = mode === 'new' || mode === 'ephemeral';
  const sub = mode === 'continue' ? ['resume'] : mode === 'fork' ? ['fork'] : [];
  const a = ['exec', ...sub, ...imageFiles.flatMap((f) => ['-i', f]), '--json', '--skip-git-repo-check'];
  if (o.yolo) a.push('--yolo');
  if (!o.yolo && process.platform === 'win32' && !(o.extraArgs || []).some((x: string) => /windows.sandbox/.test(x)))
    a.push('-c', 'windows.sandbox="unelevated"');
  if (mode === 'ephemeral') a.push('--ephemeral');
  if (o.model) a.push('-m', o.model);
  if (o.effort) a.push('-c', `model_reasoning_effort=${toml(EFFORT[o.effort])}`);
  const sb = SANDBOX[o.permissions];
  if (o.yolo) {
    if (fresh) a.push('-C', path.resolve(o.cwd || process.cwd()));
  } else if (fresh) a.push('--sandbox', sb, '-C', path.resolve(o.cwd || process.cwd()));
  else a.push('-c', `sandbox_mode=${toml(sb)}`);
  if (!o.yolo && sb === 'workspace-write') {
    const roots = (o.writableRoots || []).map((r: string) => path.resolve(r));
    if (roots.length) a.push('-c', `sandbox_workspace_write.writable_roots=[${roots.map(toml).join(',')}]`);
    a.push('-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', '-c', 'sandbox_workspace_write.exclude_slash_tmp=true');
  }
  if (o.systemPrompt) a.push('-c', `developer_instructions=${toml(o.systemPrompt)}`);
  for (const [name, m] of Object.entries(o.mcpServers || {})) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new AgentError('BAD_OPTION', `Invalid mcp server name "${name}"`);
    const k = `mcp_servers.${name}`;
    const srv = m as any;
    a.push('-c', `${k}.command=${toml(srv.command)}`, '-c', `${k}.default_tools_approval_mode="approve"`);
    if (srv.args?.length) a.push('-c', `${k}.args=[${srv.args.map(toml).join(',')}]`);
    if (srv.env && Object.keys(srv.env).length)
      a.push('-c', `${k}.env={${Object.entries(srv.env).map(([x, y]) => `${toml(x)}=${toml(String(y))}`).join(',')}}`);
    if (srv.timeout != null) {
      const toSec = srv.timeout >= 1000 ? Math.round(srv.timeout / 1000) : Math.round(srv.timeout);
      a.push('-c', `${k}.tool_timeout_sec=${toSec}`);
    }
  }
  if (schemaFile) a.push('--output-schema', schemaFile);
  if (o.extraArgs != null) {
    if (!Array.isArray(o.extraArgs) || !o.extraArgs.every((x: any) => typeof x === 'string')) {
      throw bad('extraArgs must be string[]');
    }
    if (o.permissions !== 'full') {
      if (widensSandbox(o.extraArgs)) throw bad(`extraArgs cannot override sandbox configuration under "${o.permissions}" permissions`);
    }
    if (o.yolo && conflictsWithYolo(o.extraArgs)) throw bad('extraArgs cannot set sandbox or approval policy when Codex yolo is enabled');
    if (o.extraArgs.length) a.push(...o.extraArgs.map(String));
  }
  if (sub.length) {
    let id = s.id;
    if (!id) {
      id = newestRollout(o.cwd || process.cwd(), s.adoptForeign === true, s.scope ?? '', o.env);
      if (!id)
        throw bad(
          `No codex session started by this process found in cwd to ${mode} (pass session.id, or session.adoptForeign=true to adopt the newest session in cwd)`
        );
    } else if (!rolloutExists(id, o.env)) {
      throw bad(`Session ${id} not found (cannot ${mode})`);
    }
    if (!s.id && (BUSY.get(id) || 0) > 0) throw bad('session busy; pass explicit id');
    BUSY.set(id, (BUSY.get(id) || 0) + 1);
    claim.id = id;
    a.push(id);
  }
  a.push('-'); // prompt on stdin
  return a;
}

function listModels(): string[] {
  try {
    const j = JSON.parse(readFileSync(path.join(codexHome(), 'models_cache.json'), 'utf8'));
    return (j.models || []).filter((m: any) => m.visibility !== 'hide' && m.visibility !== 'hidden').map((m: any) => m.slug);
  } catch {
    return [];
  }
}

const adapter: AgentAdapter = {
  name: 'codex',
  async models(): Promise<string[]> {
    return listModels();
  },
  async *run(opts: any): AsyncGenerator<AgentEvent, RunResult, void> {
    const { writableRoots, ...base } = opts || {};
    if (writableRoots != null && !(Array.isArray(writableRoots) && writableRoots.every((x: any) => typeof x === 'string')))
      throw bad('writableRoots must be string[]');
    const o = validateOptions(base);
    (o as any).writableRoots = writableRoots;
    const t0 = Date.now();
    if (opts?.transport === 'app-server' || opts?.appServer === true) {
      const daemon = codexDaemonPool.get(o.cwd || process.cwd(), o.env);
      return yield* daemon.runTurn(o, t0);
    }
    let prompt = o.prompt;
    if (o.permissions === 'plan') prompt = `${PLAN_NOTE}\n\n${prompt}`;
    let dir: string | undefined, schemaFile: string | undefined;
    if (o.jsonSchema != null && !(typeof o.jsonSchema === 'object' && !Array.isArray(o.jsonSchema) && o.jsonSchema.type === 'object'))
      throw bad('jsonSchema must be a JSON Schema object with type "object"');
    const imageFiles: string[] = [];
    const claim: { id?: string } = {};
    try {
      // The temp dir and everything written into it stay inside the try so the finally below cleans up on any fs error.
      if (o.jsonSchema || o.images?.length) dir = mkdtempSync(path.join(tmpdir(), 'ab-codex-'));
      if (o.jsonSchema) {
        schemaFile = path.join(dir!, 'schema.json');
        writeFileSync(schemaFile, JSON.stringify(o.jsonSchema));
      }
      for (const [n, im] of (o.images || []).entries()) {
        const f = path.join(dir!, `image-${n}.${im.mediaType.split('/')[1].replace('jpeg', 'jpg')}`);
        writeFileSync(f, Buffer.from(im.data, 'base64'));
        imageFiles.push(f);
      }
      const args = buildArgs(o, schemaFile, claim, imageFiles);
      const env: NodeJS.ProcessEnv = { ...process.env, ...(o.env || {}) };
      if (!o.env?.OPENAI_API_KEY) delete env.OPENAI_API_KEY;
      if (!o.env?.CODEX_API_KEY) delete env.CODEX_API_KEY;
      const p = spawnProc('codex', args, {
        cwd: o.cwd,
        env,
        input: prompt,
        timeoutMs: o.timeoutMs,
        signal: o.signal,
        agent: 'codex',
      });
      const sandbox = sandboxInfo(o);
      yield ev.raw({ type: 'sandbox', ...sandbox }) as any;
      if (sandbox.note && o.permissions !== 'full') yield ev.raw({ type: 'warning', message: sandbox.note }) as any;
      let modelBad = false;
      const MODEL_RE = /(model.{0,80}(not supported|does not exist|not found|unknown|invalid)|(not supported|unknown|invalid).{0,80}model)/is;
      let text = '',
        sessionId = o.session?.mode === 'continue' ? o.session.id : undefined;
      const seenErr = new Set<string>();
      const errEv = (m?: string) => (m && !seenErr.has(m) ? (seenErr.add(m), [ev.error(m)]) : []);
      let usage: any = { input: 0, output: 0, cost: null, cachedInput: 0, reasoning: 0 },
        errMsg: string | undefined;
      for await (const line of p.lines) {
        const j = parseJsonLine(line);
        if (!j) continue;
        yield ev.raw(j) as any;
        if (j.type === 'thread.started') {
          if (o.session?.mode === 'ephemeral') continue;
          sessionId = j.thread_id;
          OWN.set(sessionId!, o.session?.scope ?? '');
          yield ev.session(sessionId!) as any;
        } else if (j.type === 'turn.completed') {
          const u = j.usage || {};
          usage = {
            input: usage.input + (u.input_tokens || 0),
            output: usage.output + (u.output_tokens || 0),
            cost: null,
            cachedInput: usage.cachedInput + (u.cached_input_tokens || 0),
            reasoning: usage.reasoning + (u.reasoning_output_tokens || 0),
          };
          yield {
            ...ev.usage(u.input_tokens || 0, u.output_tokens || 0, undefined, true),
            cost: null,
            cachedInput: u.cached_input_tokens || 0,
            reasoning: u.reasoning_output_tokens || 0,
          } as any;
        } else if (j.type === 'error' || j.type === 'turn.failed') {
          errMsg = j.message || j.error?.message || errMsg;
          for (const x of errEv(errMsg)) yield x as any;
          if (o.model && errMsg && MODEL_RE.test(errMsg)) {
            modelBad = true;
            p.kill();
          }
        } else if (j.type === 'item.started') {
          // Tool start visible only via raw
        } else if (j.type === 'item.completed' && j.item) {
          const it = j.item;
          if (it.type === 'agent_message') {
            text = it.text || '';
            yield ev.text(text) as any;
          } else if (it.type === 'reasoning') yield ev.thinking(it.text || '') as any;
          else if (it.type === 'command_execution')
            yield { ...ev.tool('shell', { command: it.command }, it.aggregated_output), id: it.id, exitCode: it.exit_code } as any;
          else if (it.type === 'mcp_tool_call')
            yield { ...ev.tool(`${it.server}.${it.tool}`, it.arguments, it.result ?? it.error), id: it.id } as any;
          else if (it.type === 'file_change')
            yield { ...ev.tool('file_change', { changes: it.changes }, it.status), id: it.id } as any;
          else if (it.type === 'error') {
            errMsg = errMsg || it.message;
            for (const x of errEv(it.message)) yield x as any;
          }
        }
      }
      const r = await p.wait();
      if (r.aborted) throw new AgentError('ABORTED', 'codex run aborted', { agent: 'codex' });
      if (r.timedOut) throw new AgentError('TIMEOUT', `codex timed out after ${o.timeoutMs}ms`, { agent: 'codex', timedOut: true });
      const blob = `${errMsg || ''}\n${r.stderr}`;
      if (o.permissions !== 'full' && /deny-read ACLs|Failed to create unified exec process/i.test(blob)) {
        const msg =
          'codex sandbox could not start (' +
          o.permissions +
          '); on Windows try extraArgs [-c, windows.sandbox="unelevated"] or permissions "full"';
        yield ev.error(msg) as any;
        throw new AgentError('AGENT_FAILED', msg, { agent: 'codex', stderr: r.stderr });
      }
      if (/unexpected argument|unrecognized (option|arguments?)/i.test(blob))
        throw bad(`codex rejected extraArgs: ${blob.trim().slice(0, 200)}`);
      if (o.model && !text && (modelBad || MODEL_RE.test(blob)))
        throw bad(`Invalid model "${o.model}": ${blob.trim().slice(0, 200)}`);
      if (r.exitCode !== 0 || (errMsg && !text)) {
        if (!text && /not logged in|codex login|401|unauthorized/i.test(blob))
          throw new AgentError('NOT_LOGGED_IN', `codex is not logged in (run "codex login"): ${blob.trim().slice(0, 300)}`, {
            agent: 'codex',
          });
        throw new AgentError('AGENT_FAILED', `codex exited ${r.exitCode}: ${blob.trim().slice(0, 500)}`, {
          agent: 'codex',
          exitCode: r.exitCode,
          stderr: r.stderr,
        });
      }
      return {
        text,
        sessionId,
        usage,
        exitCode: r.exitCode,
        model: o.model || 'default',
        durationMs: Date.now() - t0,
        timedOut: false,
        sandbox,
      };
    } finally {
      release(claim);
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  },
};

export default adapter;
