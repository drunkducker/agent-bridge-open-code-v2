// pi (https://pi.dev, `@earendil-works/pi-coding-agent`) adapter.
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  statSync,
  renameSync,
  copyFileSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { spawnProc, runCollect, resolveBinary, ProcessHandle } from '../core/spawn.js';
import { AgentError, looksRateLimited, retryAfterMs } from '../core/errors.js';
import { ev, parseJsonLine } from '../core/events.js';
import { validateOptions } from '../index.js';
import { home } from '../bridge/runs.js';
import { extractJson, schemaSuffix, validate as validateSchema } from '../extras/schema.js';
import { linkResource, unlinkResource } from '../core/shared-resources.js';
import { AgentAdapter, AgentEvent, RunOptions, RunResult, Usage } from '../types/index.js';

const NAME = 'pi';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const AUTH_RE =
  /no api key found|\/login|^\s*(401|403)\b|invalid[_ ]api[_ ]key|unauthori[sz]ed|not (logged|signed) in|authentication (failed|error|required)|credentials? (expired|invalid)/i;
const MODEL_RE = /^\s*404\b.*model|model .{0,80}not found|unknown model|no such model|invalid model/i;
const OPTION_RE =
  /unknown option|unknown argument|no session found|invalid (value|option)|requires (a )?(value|argument)|is not a valid/i;
const busy = new Set<string>();
const bad = (m: string) => new AgentError('BAD_OPTION', m, { agent: NAME });

// Flags the adapter owns and flags that would widen permissions.
const OWNED_FLAGS =
  /^(--mode|--print|-p|--session-dir|--session|--session-id|--continue|-c|--resume|-r|--fork|--no-session|--approve|-a|--no-approve|-na)(=|$)/;
const PERM_FLAGS =
  /^(--tools|-t|--no-tools|-nt|--no-builtin-tools|-nbt|--exclude-tools|-xt|--extension|-e|--skill|--prompt-template|--theme|--api-key|--provider)(=|$)/;
// Tools denied per permission level.
const DENY: Record<string, string[]> = {
  'read-only': ['bash', 'powershell', 'edit', 'write', 'codemode'],
  plan: ['bash', 'powershell', 'edit', 'write', 'codemode'],
  edit: ['bash', 'powershell', 'codemode'],
  full: [],
};
// Resource lists in the user's settings would load extensions/packages into a run that is supposed to be shaped by us.
const STRIP_SETTINGS = [
  'packages',
  'extensions',
  'skills',
  'prompts',
  'themes',
  'defaultTools',
  'shellCommandPrefix',
  'enableSkillCommands',
];

export const agentDirOf = (env: NodeJS.ProcessEnv = process.env): string =>
  env.PI_CODING_AGENT_DIR || path.join(homedir(), '.pi', 'agent');
export const storeDir = (env: NodeJS.ProcessEnv = process.env): string => path.join(home(env), 'pi-store');
export const sessionsDir = (env: NodeJS.ProcessEnv = process.env): string => path.join(storeDir(env), 'sessions');

export function findBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const npm = env.APPDATA ? path.join(env.APPDATA, 'npm') : null;
  const cands = [
    env.PI_BIN,
    npm && path.join(npm, 'pi.cmd'),
    npm && path.join(npm, 'pi'),
    path.join(homedir(), '.local', 'bin', 'pi'),
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

const readJson = (f: string): any => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

function headerOf(f: string): any {
  let fd: number | undefined;
  try {
    fd = openSync(f, 'r');
    const b = Buffer.alloc(4096);
    const n = readSync(fd, b, 0, 4096, 0);
    return parseJsonLine(b.subarray(0, n).toString('utf8').split('\n')[0]);
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

const norm = (p: string) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));

export interface PiSession {
  id: string;
  cwd?: string;
  file: string;
  mtime: number;
}

/** [{id, cwd, file, mtime}] for the sessions in `dir`, newest first. */
export function listSessions(dir: string): PiSession[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: PiSession[] = [];
  for (const n of names) {
    const f = path.join(dir, n);
    const h = headerOf(f);
    if (h?.type === 'session' && UUID.test(h.id || '')) {
      let mtime = 0;
      try {
        mtime = statSync(f).mtimeMs;
      } catch {
        /* gone */
      }
      out.push({ id: h.id, cwd: h.cwd, file: f, mtime });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export interface AgentDirOptions {
  src: string;
  mcpServers?: Record<string, any>;
  extraSettings?: Record<string, any>;
  appendSystem?: string;
  passEnv?: string[];
  /** Link the user's `skills/` into the per-run dir so Pi can discover them (the dir is otherwise empty). */
  shareSkills?: boolean;
}

export interface AgentDirResult {
  dir: string;
  src: string;
  authBefore?: string | null;
  /** Links into the user's real dir; they are removed (never followed) before the per-run dir is deleted. */
  links?: string[];
}

/** Per-run agent dir. `src` is the user's real agent dir; only the files pi needs to authenticate and pick models are carried over. */
export function makeAgentDir({
  src,
  mcpServers,
  extraSettings = {},
  appendSystem,
  passEnv = [],
  shareSkills = false,
}: AgentDirOptions): AgentDirResult {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-pi-'));
  const links: string[] = [];
  try {
    for (const f of ['models.json', 'auth.json']) {
      if (existsSync(path.join(src, f))) {
        copyFileSync(path.join(src, f), path.join(dir, f));
      }
    }
    if (shareSkills) {
      const r = linkResource(path.join(src, 'skills'), path.join(dir, 'skills'));
      if (r === 'linked') links.push(path.join(dir, 'skills'));
    }
    const settings = readJson(path.join(src, 'settings.json')) || {};
    for (const k of STRIP_SETTINGS) delete settings[k];
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ ...settings, ...extraSettings }));
    if (mcpServers && Object.keys(mcpServers).length) {
      const servers: Record<string, any> = {};
      for (const [n, s] of Object.entries(mcpServers)) {
        const env = { ...(s.env || {}) };
        for (const k of passEnv) env[k] ??= '${' + k + '}';
        servers[n] = {
          ...s,
          command: s.command,
          args: s.args || [],
          env,
          exposure: s.exposure || 'direct',
          ...(s.timeout != null ? { timeout: s.timeout } : {}),
        };
      }
      writeFileSync(path.join(dir, 'mcp.json'), JSON.stringify({ mcpServers: servers, autoEnableCodemode: false }));
    }
    if (appendSystem) writeFileSync(path.join(dir, 'APPEND_SYSTEM.md'), appendSystem);
  } catch (e) {
    destroyAgentDir({ dir, src, links });
    throw e;
  }
  return { dir, src, links };
}

/** Delete the per-run dir; first carry a refreshed OAuth token back so a login that expired during the run is not lost. */
export function destroyAgentDir(d?: { dir?: string; src?: string; authBefore?: string | null; links?: string[] }): void {
  if (!d?.dir) return;
  try {
    if (d.src) {
      const mine = path.join(d.dir, 'auth.json');
      const real = path.join(d.src, 'auth.json');
      if (existsSync(mine) && existsSync(real) && d.authBefore != null) {
        const now = readFileSync(mine, 'utf8');
        if (now !== d.authBefore && readFileSync(real, 'utf8') === d.authBefore) {
          const t = `${real}.${process.pid}.tmp`;
          writeFileSync(t, now, { mode: 0o600 });
          renameSync(t, real);
        }
      }
    }
  } catch {
    /* best effort */
  }
  // Never let the recursive delete reach through a link into the user's real skills.
  let safe = true;
  for (const l of d.links || []) if (!unlinkResource(l)) safe = false;
  if (!safe) return;
  try {
    rmSync(d.dir, { recursive: true, force: true });
  } catch {
    /* temp dir */
  }
}

const textOf = (m: any): string =>
  Array.isArray(m?.content)
    ? m.content
        .filter((c: any) => c?.type === 'text')
        .map((c: any) => c.text)
        .join('')
    : typeof m?.content === 'string'
    ? m.content
    : '';
const outputOf = (r: any): string =>
  Array.isArray(r?.content)
    ? r.content
        .filter((c: any) => c?.type === 'text')
        .map((c: any) => c.text)
        .join('')
    : typeof r === 'string'
    ? r
    : JSON.stringify(r ?? '');

function classify(msg: string) {
  if (looksRateLimited(msg) && !/^\s*40[13]\b/.test(msg)) return 'RATE_LIMITED';
  if (AUTH_RE.test(msg)) return 'NOT_LOGGED_IN';
  if (MODEL_RE.test(msg) || OPTION_RE.test(msg)) return 'BAD_OPTION';
  return 'AGENT_FAILED';
}

/**
 * Resolves model name for Pi. If model doesn't contain a provider prefix (e.g. "glm-5.3-flash:cloud"),
 * inspects ~/.pi/agent/models.json (and PI_CODING_AGENT_DIR/models.json) to see if it belongs to
 * a custom provider like "ollama". If found, prefixes as "ollama/glm-5.3-flash:cloud".
 * Also supports heuristic fallback for known Ollama/local model naming conventions.
 */
export function resolvePiModel(model?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!model) return undefined;
  if (model.includes('/')) return model;

  const agentDir = agentDirOf(env);
  const candidateDirs = [agentDir, path.join(homedir(), '.pi', 'agent')];

  for (const dir of candidateDirs) {
    const mf = path.join(dir, 'models.json');
    if (existsSync(mf)) {
      try {
        const data = JSON.parse(readFileSync(mf, 'utf8'));
        if (data?.providers && typeof data.providers === 'object') {
          for (const [providerKey, providerCfg] of Object.entries<any>(data.providers)) {
            const models = providerCfg?.models;
            if (Array.isArray(models)) {
              if (models.some((m: any) => m?.id === model || m?.name === model)) {
                return `${providerKey}/${model}`;
              }
            }
          }
        }
      } catch {
        /* ignore parse errors */
      }
    }
  }

  // Heuristic fallback: if it looks like an Ollama model (e.g. contains ':cloud', ':latest',
  // or starts with common Ollama model names like glm, qwen, llama, deepseek, mistral, phi, gemma)
  const isOllamaLike =
    /:cloud\b|:latest\b|:\d+b\b/i.test(model) ||
    /^(glm|qwen|llama|deepseek|mistral|phi|gemma|codellama|vicuna|starcoder)[-_:]/i.test(model);

  if (isOllamaLike) {
    return `ollama/${model}`;
  }

  return model;
}

const adapter: AgentAdapter = {
  name: NAME,
  efforts: [...EFFORTS],
  canFork: true,
  async models(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
    const list: string[] = [];
    const agentDir = agentDirOf(env);
    const candidateDirs = [agentDir, path.join(homedir(), '.pi', 'agent')];
    for (const dir of candidateDirs) {
      const mf = path.join(dir, 'models.json');
      if (existsSync(mf)) {
        try {
          const data = JSON.parse(readFileSync(mf, 'utf8'));
          if (data?.providers && typeof data.providers === 'object') {
            for (const [providerKey, providerCfg] of Object.entries<any>(data.providers)) {
              if (Array.isArray(providerCfg?.models)) {
                for (const m of providerCfg.models) {
                  const id = m?.id || m?.name;
                  if (id) list.push(`${providerKey}/${id}`);
                }
              }
            }
          }
        } catch {}
      }
    }

    const bin = findBinary(env);
    if (bin) {
      try {
        const r = await runCollect(bin, ['--list-models'], {
          timeoutMs: 30000,
          env: { ...env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' },
        });
        const cliModels = (r.stdout + '\n' + r.stderr)
          .split('\n')
          .map((l) => l.trim().split(/\s+/))
          .filter((c) => c.length >= 2 && c[0] !== 'provider' && /^[\w.-]+$/.test(c[0]) && /\S/.test(c[1]))
          .map((c) => `${c[0]}/${c[1]}`);
        list.push(...cliModels);
      } catch {}
    }
    return [...new Set(list)];
  },
  async *run(opts: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
    const o = validateOptions(opts);
    if (o.isolated === false) {
      throw bad(
        'pi always runs with its own agent dir (that is how MCP servers and permissions are applied); isolated:false is not supported'
      );
    }
    if (o.effort != null && !EFFORTS.includes(o.effort as any)) {
      throw bad(`effort must be one of ${EFFORTS.join('|')}`);
    }
    const perms = (o as any).defaultPermissions ? 'read-only' : o.permissions || 'read-only';
    const sess = o.session || { mode: 'new' };
    for (const a of o.extraArgs || []) {
      if (OWNED_FLAGS.test(a)) {
        throw bad(`extraArgs may not contain ${a}: the adapter owns the output mode, session handling and project trust`);
      }
      if (perms !== 'full' && PERM_FLAGS.test(a)) {
        throw bad(
          `extraArgs may not contain ${a} when permissions is "${perms}" (it would change the tool set, extensions or provider)`
        );
      }
    }
    const env = { ...process.env, ...(o.env || {}) };
    const bin = findBinary(env);
    if (!bin) {
      throw new AgentError(
        'NOT_INSTALLED',
        'pi not found on PATH (npm i -g @earendil-works/pi-coding-agent). Log in once with `pi` (/login) or configure a provider in ~/.pi/agent/models.json, or set PI_BIN.',
        { agent: NAME, binary: NAME }
      );
    }
    const cwd = path.resolve(o.cwd || process.cwd());

    // ---- session resolution
    const sdir = sessionsDir(env);
    let resume: string | undefined;
    let claimed: string | null = null;
    if (sess.mode === 'continue' || sess.mode === 'fork') {
      if (sess.id != null && !UUID.test(sess.id)) throw bad('session.id must be a UUID');
      const all = listSessions(sdir);
      const hit = sess.id
        ? all.find((s) => s.id.toLowerCase() === sess.id!.toLowerCase())
        : all.find((s) => norm(s.cwd || '') === norm(cwd) && !busy.has(s.id));
      if (!hit) {
        throw bad(
          sess.id
            ? `Unknown pi session "${sess.id}"`
            : `session mode "${sess.mode}" without id: no pi session recorded for cwd ${cwd}`
        );
      }
      if (sess.mode === 'continue') {
        if (busy.has(hit.id)) throw bad('session busy (in use by another continue)');
        busy.add(hit.id);
        claimed = hit.id;
      }
      resume = hit.id;
    }
    const ephemeral = sess.mode === 'ephemeral';

    const t0 = Date.now();
    let ad: AgentDirResult | undefined;
    let p: ProcessHandle | undefined;
    let tmpSessions: string | undefined;
    try {
      const mcpNames = Object.keys(o.mcpServers || {});
      const skillsOn = o.skills === true || env.AGENTBRIDGE_ENABLE_SKILLS === '1' || env.AGENTBRIDGE_ENABLE_SKILLS === 'true';
      ad = makeAgentDir({
        src: agentDirOf(env),
        mcpServers: o.mcpServers,
        appendSystem: o.systemPrompt,
        shareSkills: skillsOn,
        passEnv: ['AGENTBRIDGE_ATTEST_KEY'].filter((k) => o.env?.[k] != null),
        extraSettings: {
          retry: { enabled: true, maxRetries: 1, baseDelayMs: 1000, maxAgentDelayMs: 5000 },
          enableInstallTelemetry: false,
        },
      });
      try {
        ad.authBefore = existsSync(path.join(ad.dir, 'auth.json'))
          ? readFileSync(path.join(ad.dir, 'auth.json'), 'utf8')
          : null;
      } catch {
        ad.authBefore = null;
      }
      if (ephemeral && o.jsonSchema) {
        tmpSessions = mkdtempSync(path.join(tmpdir(), 'ab-pi-sess-'));
      }
      mkdirSync(sdir, { recursive: true });

      const spawnTurn = (prompt: string, sessionArgs: string[]) => {
        const args = [
          '--mode',
          'json',
          '--no-approve',
          ...(skillsOn ? [] : ['-ns']),
          '-np',
          '-ne',
          ...(mcpNames.length ? ['-e', 'builtin:mcp'] : []),
        ];
        if (o.model) {
          const resolved = resolvePiModel(o.model, env);
          if (resolved) args.push('--model', resolved);
        }
        if (o.effort) args.push('--thinking', o.effort);
        if (DENY[perms]?.length) args.push('--exclude-tools', DENY[perms].join(','));
        args.push(...sessionArgs);
        if (o.extraArgs) args.push(...o.extraArgs);
        return spawnProc(bin, args, {
          cwd,
          input: prompt,
          timeoutMs: o.timeoutMs,
          signal: o.signal,
          agent: NAME,
          env: {
            ...(o.env || {}),
            PI_CODING_AGENT_DIR: ad!.dir,
            ...(o.offline || o.env?.PI_OFFLINE != null ? { PI_OFFLINE: o.offline ? '1' : o.env!.PI_OFFLINE } : {}),
            PI_SKIP_VERSION_CHECK: '1',
            PI_TELEMETRY: '0',
          },
        });
      };

      let sessionId: string | undefined;
      let text = '';
      let structured: any;
      const sum = { input: 0, output: 0, cachedInput: 0, reasoning: 0, cost: 0 };
      let usageSeen = false;
      const tools = new Map<string, any>();

      const turn = async function* (prompt: string, sessionArgs: string[]): AsyncGenerator<AgentEvent, string, void> {
        p = spawnTurn(prompt, sessionArgs);
        let streamed = '';
        let last: any;
        let lastErr: string | undefined;
        for await (const line of p.lines) {
          const m = parseJsonLine(line);
          if (!m) continue;
          switch (m.type) {
            case 'session':
              if (!sessionId) sessionId = m.id;
              yield ev.session(m.id);
              break;
            case 'message_update': {
              const a = m.assistantMessageEvent || {};
              if (a.type === 'text_delta' && a.delta) {
                streamed += a.delta;
                yield ev.text(a.delta);
              } else if (a.type === 'thinking_delta' && a.delta) {
                yield ev.thinking(a.delta);
              }
              break;
            }
            case 'message_end':
              if (m.message?.role === 'assistant') {
                last = m.message;
                const u = m.message.usage;
                if (u) {
                  usageSeen = true;
                  sum.input += (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
                  sum.output += u.output || 0;
                  sum.cachedInput += u.cacheRead || 0;
                  sum.reasoning += u.reasoning || 0;
                  sum.cost += u.cost?.total || 0;
                  yield ev.usage((u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0), u.output || 0, u.cost?.total || undefined, true);
                }
                if (m.message.stopReason === 'error' || m.message.errorMessage) {
                  lastErr = m.message.errorMessage || 'provider error';
                }
              }
              break;
            case 'tool_execution_start':
              tools.set(m.toolCallId, m.args);
              yield ev.tool(m.toolName, m.args);
              break;
            case 'tool_execution_end':
              yield ev.tool(m.toolName, tools.get(m.toolCallId), (m.isError ? 'ERROR: ' : '') + outputOf(m.result));
              break;
            case 'auto_retry_start':
              yield ev.error(`pi is retrying after: ${m.errorMessage}`);
              break;
            default:
              break;
          }
          if (!(m.type === 'message_start' || m.type === 'message_end') || m.message?.role !== 'system') {
            yield ev.raw(m);
          }
        }
        const r = await p.wait();
        if (r.aborted) throw new AgentError('ABORTED', 'Aborted', { agent: NAME });
        if (r.timedOut) throw new AgentError('TIMEOUT', `pi timed out after ${o.timeoutMs}ms`, { agent: NAME });
        const stderr = (r.stderr || '')
          .replace(/^Warning: Model .* not found for provider .* Using custom model id\.\s*$/gm, '')
          .trim();
        const fail = (msg: string) => {
          const code = classify(msg);
          return new AgentError(code, msg.slice(0, 1500), {
            agent: NAME,
            exitCode: r.exitCode,
            stderr: r.stderr,
            sessionId,
            ...(code === 'RATE_LIMITED' ? { retryAfterMs: retryAfterMs(msg) } : {}),
          });
        };
        if (r.exitCode !== 0 && !last) {
          const msg = stderr || `pi exited ${r.exitCode}`;
          throw fail(msg);
        }
        if (lastErr && (!textOf(last).trim() || last.stopReason === 'error')) throw fail(lastErr);
        if (r.exitCode !== 0) throw fail(stderr || `pi exited ${r.exitCode}`);
        return (textOf(last) || streamed).trimEnd();
      };

      const first = ephemeral
        ? tmpSessions
          ? ['--session-dir', tmpSessions]
          : ['--no-session']
        : [
            '--session-dir',
            sdir,
            ...(sess.mode === 'continue' ? ['--session', resume!] : sess.mode === 'fork' ? ['--fork', resume!] : []),
          ];
      text = yield* turn(o.jsonSchema ? o.prompt + schemaSuffix(o.jsonSchema) : o.prompt, first);
      if (o.jsonSchema) {
        const again = () => ['--session-dir', tmpSessions || sdir, '--session', sessionId!];
        for (let attempt = 0; ; attempt++) {
          const x = extractJson(text);
          const errs = x.ok ? validateSchema(o.jsonSchema, x.value) : ['reply is not valid JSON'];
          if (!errs.length) {
            structured = x.value;
            text = JSON.stringify(x.value);
            break;
          }
          if (attempt >= 1) {
            throw new AgentError('AGENT_FAILED', `jsonSchema validation failed: ${errs.slice(0, 5).join('; ')}`, {
              agent: NAME,
              sessionId,
              partial: text,
            });
          }
          text = yield* turn(
            `Your previous reply was invalid (${errs.slice(0, 5).join('; ')}). Reply again with ONLY the corrected JSON value.`,
            again()
          );
        }
      }
      if (!text.trim()) {
        const msg = 'pi returned an empty response (the model produced no text)';
        yield ev.error(msg);
        throw new AgentError('AGENT_FAILED', msg, { agent: NAME, sessionId });
      }
      const usage: Usage = usageSeen
        ? {
            input: sum.input,
            output: sum.output,
            ...(sum.cachedInput ? { cachedInput: sum.cachedInput } : {}),
            ...(sum.reasoning ? { reasoning: sum.reasoning } : {}),
            ...(sum.cost ? { cost: sum.cost } : {}),
          }
        : { input: 0, output: 0 };
      return {
        text,
        sessionId: ephemeral ? undefined : sessionId,
        usage,
        exitCode: 0,
        model: o.model || 'default',
        durationMs: Date.now() - t0,
        timedOut: false,
        ...(structured !== undefined ? { structured } : {}),
      };
    } finally {
      p?.kill();
      destroyAgentDir(ad);
      if (tmpSessions) {
        try {
          rmSync(tmpSessions, { recursive: true, force: true });
        } catch {
          /* temp */
        }
      }
      if (claimed) busy.delete(claimed);
    }
  },
};

export default adapter;
