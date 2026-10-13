// opencode adapter.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { AgentError } from '../core/errors.js';
import { ev } from '../core/events.js';
import { hintFor } from '../core/hints.js';
import { spawnProc, runCollect, resolveBinary, killTree, ProcessHandle } from '../core/spawn.js';
import { extractJson, schemaSuffix, validate } from '../extras/schema.js';
import { AgentAdapter, AgentEvent, RunOptions, RunResult, Usage } from '../types/index.js';

const BIN = 'opencode';
const bad = (m: string) => new AgentError('BAD_OPTION', m, { agent: 'opencode' });
const fail = (m: string, x: Record<string, any> = {}) => new AgentError('AGENT_FAILED', m, { agent: 'opencode', ...x });
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const stripAnsi = (x: any) => String(x).replace(ANSI, '');
const fwd = (p: string) => p.split('\\').join('/');

const dataDir = (env?: NodeJS.ProcessEnv) =>
  env?.OPENCODE_DATA_DIR ||
  path.join(env?.XDG_DATA_HOME || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode');
const authFile = (env?: NodeJS.ProcessEnv) => path.join(dataDir(env), 'auth.json');

function assertInstalled(env: NodeJS.ProcessEnv): void {
  if (!resolveBinary(BIN, env)) {
    throw new AgentError('NOT_INSTALLED', 'opencode executable not found on PATH' + hintFor('opencode', 'NOT_INSTALLED'), {
      agent: 'opencode',
      binary: BIN,
    });
  }
}

function hasAuth(env?: NodeJS.ProcessEnv): boolean {
  try {
    const j = JSON.parse(readFileSync(authFile(env), 'utf8'));
    return j && Object.keys(j).length > 0;
  } catch {
    return false;
  }
}

// Minimal env allowlist
const ENV_ALLOW = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'USERPROFILE',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'ALLUSERSPROFILE',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USER',
  'USERNAME',
  'LOGNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'OS',
  'LANG',
  'LC_ALL',
  'TERM',
  'SHELL',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
];

function minimalEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const out: Record<string, string | undefined> = {};
  const allow = new Set(ENV_ALLOW);
  for (const [k, v] of Object.entries(process.env)) {
    if (allow.has(k.toUpperCase())) out[k] = v;
  }
  return { ...out, ...extra };
}

export interface Redactor {
  str: (t: string) => string;
  deep: <T>(v: T) => T;
}

// Redaction
export function makeRedactor(): Redactor {
  const secrets = new Set<string>();
  const walk = (v: any) => {
    if (typeof v === 'string') {
      if (v.length >= 8) secrets.add(v);
    } else if (v && typeof v === 'object') {
      Object.values(v).forEach(walk);
    }
  };
  try {
    walk(JSON.parse(readFileSync(authFile(), 'utf8')));
  } catch {
    /* none */
  }
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const variants = new Set<string>();
  for (const s of secrets) {
    const rev = [...s].reverse().join('');
    for (const b of [s, rev]) {
      variants.add(b);
      variants.add(Buffer.from(b).toString('hex'));
      variants.add(Buffer.from(b).toString('hex').toUpperCase());
      for (let pad = 0; pad < 3; pad++) {
        const enc = Buffer.from('\0'.repeat(pad) + b)
          .toString('base64')
          .replace(/=+$/, '');
        const skip = Math.ceil((pad * 4) / 3) + (pad ? 1 : 0);
        const core = enc.slice(skip, Math.max(skip + 8, enc.length - 2));
        if (core.length >= 12) {
          variants.add(core);
          variants.add(core.replace(/\+/g, '-').replace(/\//g, '_'));
        }
      }
    }
  }
  const list = [...variants].filter((x) => x.length >= 8).sort((a, b) => b.length - a.length);
  const sepRes = [...secrets]
    .flatMap((s) => [s, [...s].reverse().join('')])
    .filter((s) => s.length >= 12)
    .map((s) => new RegExp([...s].map(esc).join('[\\s\\-_.,:;|/\\\\]{0,3}'), 'g'));
  const pat = /\b(?:oc_sk_|sk-|ghp_|gho_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_\-]{8,}/g;
  const str = (t: string): string => {
    let r = t;
    for (const x of list) if (r.includes(x)) r = r.split(x).join('[REDACTED]');
    for (const re of sepRes) r = r.replace(re, '[REDACTED]');
    return r.replace(pat, '[REDACTED]');
  };
  const deep = <T>(v: T): T =>
    (typeof v === 'string'
      ? str(v)
      : Array.isArray(v)
      ? v.map(deep)
      : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as any).map(([k, x]) => [k, deep(x)]))
      : v) as T;
  return { str, deep };
}

// Sessions started by this process: id -> { cwd, seq }
const owned = new Map<string, { cwd: string; seq: number }>();
let seq = 0;
const norm = (d: string) => {
  try {
    return realpathSync(d).toLowerCase();
  } catch {
    return path.resolve(d).toLowerCase();
  }
};
const touch = (id: string, cwd?: string) => owned.set(id, { cwd: norm(cwd || process.cwd()), seq: ++seq });

// Session exclusivity
const busy = new Map<string, number>();
const locks = new Map<string, Promise<void>>();
async function lockSession(id: string): Promise<() => void> {
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

// Servers: kill on parent exit
const live = new Set<ProcessHandle>();
process.on('exit', () => {
  for (const p of live) killTree(p.child);
});

let modelInfoCache: Record<string, string[]> | undefined;
async function modelInfo(): Promise<Record<string, string[]>> {
  if (modelInfoCache) return modelInfoCache;
  const r = await runCollect(BIN, ['models', '--verbose'], { env: minimalEnv(), agent: 'opencode', timeoutMs: 60000 });
  const map: Record<string, string[]> = {};
  const re = /^(\S+\/\S+)\r?\n(\{[\s\S]*?\r?\n\})/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(r.stdout))) {
    try {
      map[m[1]] = Object.keys(JSON.parse(m[2]).variants || {});
    } catch {
      /* skip */
    }
  }
  return (modelInfoCache = map);
}

async function resolveVariant(effort: string, model?: string): Promise<string> {
  const want = effort === 'max' ? ['max', 'xhigh'] : [effort];
  if (!model) throw bad('effort requires an explicit model (variants are model-specific)');
  const vs = (await modelInfo())[model];
  if (!vs) throw bad(`Unknown model "${model}" (see models())`);
  const hit = want.find((w) => vs.includes(w));
  if (!hit) throw bad(`effort "${effort}" is not supported by ${model} (variants: ${vs.join(', ') || 'none'})`);
  return hit;
}

function permissionBlock(p?: string, offline = false) {
  const full = p === 'full';
  const secretsDeny = {
    '*': 'allow',
    '**/auth.json': 'deny',
    '*auth.json': 'deny',
    '**/opencode/**': 'deny',
    '*/opencode/*': 'deny',
    '**/.local/share/opencode/**': 'deny',
  };
  const guard: Record<string, any> = {};
  if (!full) {
    guard.read = secretsDeny;
    guard.grep = secretsDeny;
    guard.glob = secretsDeny;
    guard.list = secretsDeny;
    guard.external_directory = { '*': 'deny' };
  }
  const web = offline ? 'deny' : 'allow';
  switch (p) {
    case 'full':
      return { edit: 'allow', bash: 'allow', webfetch: web, websearch: web, external_directory: 'allow' };
    case 'edit':
      return { ...guard, edit: 'allow', bash: 'deny', webfetch: web, websearch: web };
    default:
      return { ...guard, edit: 'deny', bash: 'deny', webfetch: web, websearch: web };
  }
}

function buildConfig(o: RunOptions): Record<string, any> {
  const cfg: Record<string, any> = {
    permission: permissionBlock(o.permissions, !!o.offline),
    autoupdate: false,
    share: 'disabled',
  };
  if (o.mcpServers) {
    cfg.mcp = {};
    for (const [n, s] of Object.entries(o.mcpServers)) {
      cfg.mcp[n] = {
        type: 'local',
        command: [s.command, ...(s.args || [])],
        enabled: true,
        ...(s.env ? { environment: s.env } : {}),
        ...(s.timeout != null ? { timeout: s.timeout } : {}),
      };
    }
  }
  return cfg;
}

// Thin value-first adapter over the canonical schema validator (src/extras/schema.ts), so jsonSchema
// runs here carry the same semantics as pi/endpoint ($ref, allOf/anyOf/oneOf/not, numeric bounds,
// string constraints) instead of the weaker copy this adapter used to carry locally.
export function validateSchema(v: any, s: any): string[] {
  return validate(s, v);
}

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address() as any;
      s.close(() => res(addr.port));
    });
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sseQueue(resp: Response, onEnd?: () => void) {
  const q: any[] = [];
  let waiter: (() => void) | null = null;
  let ended: Error | null = null;
  const wake = () => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w();
    }
  };
  (async () => {
    try {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of resp.body as any) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
          const data = frame
            .split(/\r?\n/)
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          try {
            q.push(JSON.parse(data));
            wake();
          } catch {
            /* ignore */
          }
        }
      }
      ended = new Error('event stream closed');
    } catch (e: any) {
      ended = e;
    }
    wake();
    onEnd?.();
  })();
  return {
    async next(ms?: number) {
      for (;;) {
        if (q.length) return q.shift();
        if (ended) throw ended;
        const timed = await new Promise((r) => {
          const t = ms != null ? setTimeout(() => { waiter = null; r(true); }, ms) : null;
          waiter = () => { clearTimeout(t as any); r(false); };
        });
        if (timed && !q.length) return null;
      }
    },
  };
}

const errText = (e: any) =>
  stripAnsi(e?.data?.message || e?.message || e?.name || (typeof e === 'string' ? e : JSON.stringify(e ?? '')));

const adapter: AgentAdapter & { _run: (o: RunOptions) => AsyncGenerator<AgentEvent, RunResult, void> } = {
  name: 'opencode',

  async models(): Promise<string[]> {
    assertInstalled(process.env);
    const r = await runCollect(BIN, ['models'], { env: minimalEnv(), agent: 'opencode', timeoutMs: 60000 });
    if (r.exitCode !== 0) throw fail(`opencode models failed: ${stripAnsi(r.stderr)}`, { exitCode: r.exitCode });
    return r.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => /^[^\s/]+\/\S+$/.test(s));
  },

  async *run(o: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
    const R = makeRedactor();
    let toolCount = 0;
    const it = this._run(o);
    try {
      for (;;) {
        const n = await it.next();
        if (n.done) {
          const r = R.deep(n.value);
          if (r.sessionId) touch(r.sessionId, o.cwd);
          return r;
        }
        const e = R.deep(n.value);
        if (e.type === 'session') touch(e.id, o.cwd);
        if (e.type === 'tool') toolCount++;
        yield e;
      }
    } catch (e: any) {
      if (e instanceof AgentError) {
        e.message = R.str(stripAnsi(e.message));
        for (const k of ['stderr', 'partial', 'lastEvents']) {
          if (typeof (e as any)[k] === 'string') (e as any)[k] = R.str(stripAnsi((e as any)[k]));
        }
      }
      throw e;
    } finally {
      // A consumer breaking out of the stream must still reach _run's finally (session-lock
      // release, serve-process kill, live.delete); without return() the suspended generator
      // would leak the opencode serve child tree and its session locks. No-op once exhausted.
      await it.return?.(undefined as any);
    }
  },

  async *_run(o: RunOptions): AsyncGenerator<AgentEvent, RunResult, void> {
    const started = Date.now();
    assertInstalled(o.env || process.env);
    if (!hasAuth(o.env)) {
      throw new AgentError('NOT_LOGGED_IN', `No opencode credentials at ${authFile(o.env)} (run \`opencode auth login\`)`, {
        agent: 'opencode',
      });
    }
    if (o.model && !/^[^\s/]+\/[^\s]+$/.test(o.model)) throw bad('model must be "provider/model"');
    if (o.cwd && !existsSync(o.cwd)) throw bad(`cwd does not exist: ${o.cwd}`);
    const variant = o.effort ? await resolveVariant(o.effort, o.model) : undefined;
    const [providerID, ...rest] = (o.model || '').split('/');
    const modelID = rest.join('/');
    const cwd = path.resolve(o.cwd || process.cwd());
    const mode = o.session?.mode || 'new';

    if (
      (mode === 'continue' || mode === 'fork') &&
      !o.session?.id &&
      !o.session?.adoptForeign &&
      ![...owned.values()].some((v) => v.cwd === norm(cwd))
    ) {
      throw bad(
        `session.mode "${mode}" without id: no session started by this process in ${cwd} (pass session.id, or session.adoptForeign=true to take the newest session on disk)`
      );
    }

    let preClaimedId: string | undefined;
    if (mode === 'continue' && !o.session?.id) {
      const mine = [...owned].filter(([, v]) => v.cwd === norm(cwd)).sort((a, b) => b[1].seq - a[1].seq);
      const free = mine.find(([sid]) => !busy.get(sid));
      if (free) {
        preClaimedId = free[0];
        busy.set(preClaimedId, (busy.get(preClaimedId) || 0) + 1);
      } else if (mine.length) {
        throw bad('session busy (in use by another continue); pass an explicit session.id');
      }
    }

    const port = await freePort();
    const password = randomBytes(24).toString('hex');
    const userCfg = (() => {
      try {
        return JSON.parse(o.env?.OPENCODE_CONFIG_CONTENT || '{}');
      } catch {
        return {};
      }
    })();
    const cfg = buildConfig(o);
    const config = {
      ...userCfg,
      ...cfg,
      permission: { ...(userCfg.permission || {}), ...cfg.permission },
      mcp: { ...(userCfg.mcp || {}), ...(cfg.mcp || {}) },
    };
    const env = minimalEnv({
      ...(o.env || {}),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_SERVER_USERNAME: 'opencode',
    });
    const proc = spawnProc(
      BIN,
      ['serve', '--port', String(port), '--hostname', '127.0.0.1', ...(o.extraArgs || [])],
      { cwd, env, timeoutMs: o.timeoutMs, signal: o.signal, agent: 'opencode' }
    );
    live.add(proc);
    const tail: string[] = [];
    (async () => {
      for await (const l of proc.lines) {
        tail.push(l);
        if (tail.length > 30) tail.shift();
      }
    })().catch(() => {});
    let exited: any = null;
    const done = proc.wait().then(
      (r) => {
        exited = r;
        return r;
      },
      (e) => {
        exited = { error: e, exitCode: -1 };
        return exited;
      }
    );
    const fetchAc = new AbortController();
    done.then(() => fetchAc.abort());
    const base = `http://127.0.0.1:${port}`;
    const auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
    const dq = `directory=${encodeURIComponent(fwd(cwd))}`;
    const lastEvents: string[] = [];
    const recent = (e: any) => {
      lastEvents.push(JSON.stringify(e).slice(0, 300));
      if (lastEvents.length > 8) lastEvents.shift();
    };
    const diag = () =>
      `${
        exited?.stderr
          ? `stderr: ${stripAnsi(exited.stderr).split('\n').slice(-6).join(' | ')}; `
          : ''
      }${tail.length ? `server: ${stripAnsi(tail.slice(-4).join(' | '))}; ` : ''}${
        lastEvents.length ? `last events: ${lastEvents.join(' ; ')}` : ''
      }`;
    const stopped = () => {
      if (exited?.timedOut)
        return new AgentError('TIMEOUT', `opencode timed out after ${o.timeoutMs}ms. ${diag()}`, { agent: 'opencode' });
      if (exited?.aborted || o.signal?.aborted) return new AgentError('ABORTED', 'Aborted', { agent: 'opencode' });
      return null;
    };
    const http = async (method: string, p: string, body?: any, timeoutMs?: number) => {
      let r: Response;
      try {
        r = await fetch(`${base}${p}${p.includes('?') ? '&' : '?'}${dq}`, {
          method,
          headers: { authorization: auth, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: timeoutMs
            ? AbortSignal.any([fetchAc.signal, AbortSignal.timeout(timeoutMs)])
            : fetchAc.signal,
        });
      } catch (e: any) {
        throw stopped() || fail(`opencode server request failed: ${errText(e)}. ${diag()}`, { exitCode: exited?.exitCode });
      }
      const txt = await r.text();
      let j: any;
      try {
        j = txt ? JSON.parse(txt) : undefined;
      } catch {
        j = txt;
      }
      return { status: r.status, body: j };
    };

    let sessionId: string | undefined;
    const toDelete = new Set<string>();
    let text = '';
    let json: any;
    const usage: Usage = { input: 0, output: 0 };
    let claimedId: string | undefined;
    let unlockSession: (() => void) | undefined;
    try {
      for (let i = 0; ; i++) {
        if (exited) {
          throw (
            stopped() ||
            fail(`opencode serve exited before becoming ready (code ${exited.exitCode}). ${diag()}`, {
              exitCode: exited.exitCode,
              stderr: exited.stderr,
            })
          );
        }
        try {
          const r = await fetch(`${base}/global/health`, {
            headers: { authorization: auth },
            signal: AbortSignal.any([fetchAc.signal, AbortSignal.timeout(3000)]),
          });
          if (r.ok) break;
        } catch {
          /* not yet */
        }
        if (i > 200) throw fail(`opencode serve did not become ready. ${diag()}`);
        await sleep(150);
      }

      for (const p of ['/config/providers', '/agent']) {
        try {
          await http('GET', p, undefined, 20000);
        } catch (e) {
          if (stopped() || exited) throw e;
          await http('GET', p, undefined, 20000);
        }
      }

      if (o.mcpServers && Object.keys(o.mcpServers).length) {
        const names = Object.keys(o.mcpServers);
        for (let i = 0; ; i++) {
          const m = await http('GET', '/mcp');
          const st = m.body && typeof m.body === 'object' ? m.body : {};
          if (names.every((n) => st[n] && st[n].status !== 'connecting')) break;
          if (i > 100) {
            throw fail(`MCP server(s) did not finish connecting within 20s: ${JSON.stringify(st)}. ${diag()}`, {
              sessionId,
            });
          }
          await sleep(200);
        }
      }

      if (mode === 'continue' || mode === 'fork') {
        let id = o.session?.id ?? preClaimedId;
        if (!id) {
          const mine = [...owned].filter(([, v]) => v.cwd === norm(cwd)).sort((a, b) => b[1].seq - a[1].seq);
          if (mode === 'continue') {
            const free = mine.find(([sid]) => !busy.get(sid));
            if (free) id = free[0];
            else if (mine.length) throw bad('session busy (in use by another continue); pass an explicit session.id');
          } else if (mine.length) {
            id = mine[0][0];
          }
          if (!id && o.session?.adoptForeign) {
            const l = await http('GET', '/session');
            const arr = (Array.isArray(l.body) ? l.body : []).filter(
              (x) => x.directory && norm(x.directory) === norm(cwd)
            );
            arr.sort((a, b) => (b.time?.updated ?? b.updated ?? 0) - (a.time?.updated ?? a.updated ?? 0));
            id = arr[0]?.id;
          }
          if (!id) {
            throw bad(
              `session.mode "${mode}" without id: no session started by this process in ${cwd} (pass session.id, or session.adoptForeign=true to take the newest session on disk)`
            );
          }
        }
        if (mode === 'continue') {
          claimedId = id;
          if (id !== preClaimedId) busy.set(claimedId, (busy.get(claimedId) || 0) + 1);
        }
        unlockSession = claimedId ? await lockSession(claimedId) : undefined;
        const g = await http('GET', `/session/${encodeURIComponent(id)}`);
        if (g.status !== 200) throw bad(`session not found: ${id}`);
        if (mode === 'fork') {
          const f = await http('POST', `/session/${encodeURIComponent(id)}/fork`, {});
          if (f.status !== 200 || !f.body?.id) throw fail(`fork failed (${f.status}): ${errText(f.body)}. ${diag()}`);
          sessionId = f.body.id;
        } else {
          sessionId = id;
        }
      } else {
        const c = await http('POST', '/session', {}, 30000);
        if (c.status !== 200 || !c.body?.id) {
          throw fail(`session create failed (${c.status}): ${errText(c.body)}. ${diag()}`);
        }
        sessionId = c.body.id;
      }
      if (mode === 'ephemeral' && sessionId) toDelete.add(sessionId);
      yield ev.session(sessionId!);

      const sr = await fetch(`${base}/event?${dq}`, {
        headers: { authorization: auth, accept: 'text/event-stream' },
        signal: fetchAc.signal,
      }).catch((e) => {
        throw stopped() || fail(`event stream failed: ${errText(e)}. ${diag()}`);
      });
      if (!sr.ok) throw fail(`event stream HTTP ${sr.status}`);
      const q = sseQueue(sr);
      for (;;) {
        const e = await q.next(3000);
        if (!e || e.type === 'server.connected') break;
      }

      const agent = o.permissions === 'plan' ? 'plan' : undefined;
      const roles = new Map<string, string>(),
        ptypes = new Map<string, string>(),
        emitted = new Map<string, number>(),
        toolSeen = new Map<string, any>();
      let lastTool: { name: string; output: string } | undefined;

      const turn = async function* (prompt: string): AsyncGenerator<AgentEvent, string, void> {
        const body: Record<string, any> = {
          parts: [
            { type: 'text', text: prompt },
            ...(o.images || []).map((im, n) => ({
              type: 'file',
              mime: im.mediaType,
              filename: `image-${n}.${im.mediaType.split('/')[1]}`,
              url: `data:${im.mediaType};base64,${im.data}`,
            })),
          ],
        };
        if (o.model) body.model = { providerID, modelID };
        if (variant) body.variant = variant;
        if (agent) body.agent = agent;
        if (o.systemPrompt) body.system = o.systemPrompt;
        const listMsgs = async () => {
          const m = await http('GET', `/session/${encodeURIComponent(sessionId!)}/message`);
          return Array.isArray(m.body) ? m.body : [];
        };
        const preIds = new Set((await listMsgs()).map((m) => m.info?.id));
        const pr = await http('POST', `/session/${encodeURIComponent(sessionId!)}/prompt_async`, body);
        if (pr.status >= 300) throw fail(`prompt rejected (${pr.status}): ${errText(pr.body)}. ${diag()}`);
        let out = '',
          err: string | undefined,
          idleAt = 0,
          sawBusy = false,
          lastOwn = Date.now(),
          lastPoll = 0,
          reposted = 0;
        const synth: any[] = [];
        for (;;) {
          let e = synth.shift();
          if (!e && !idleAt && Date.now() - lastOwn > 6000 && Date.now() - lastPoll > 6000) {
            lastPoll = Date.now();
            const msgs = (await listMsgs()).filter((m) => !preIds.has(m.info?.id));
            if (process.env.AGENTBRIDGE_DEBUG) {
              console.error(
                '[oc] poll',
                msgs.length,
                JSON.stringify((await http('GET', '/session/status')).body),
                msgs
                  .map(
                    (m) =>
                      m.info?.role +
                      ':' +
                      (m.parts || []).map((p: any) => p.type + '/' + (p.state?.status || '')).join(',')
                  )
                  .join(' | ')
              );
            }
            for (const m of msgs) {
              synth.push({ type: 'message.updated', properties: { sessionID: sessionId, info: m.info } });
              for (const pt of m.parts || []) {
                synth.push({ type: 'message.part.updated', properties: { sessionID: sessionId, part: pt } });
              }
            }
            if (!msgs.length && reposted < 2) {
              reposted++;
              await http('POST', `/session/${encodeURIComponent(sessionId!)}/prompt_async`, body);
            }
            const last = [...msgs].reverse().find((m) => m.info?.role === 'assistant');
            const running = (last?.parts || []).some(
              (pt: any) => pt.type === 'tool' && !['completed', 'error'].includes(pt.state?.status)
            );
            if (last?.info?.time?.completed && !running) {
              synth.push({ type: 'session.idle', properties: { sessionID: sessionId } });
            }
            const stallMs = (o.session as any)?.stallMs ?? 45000;
            if (!running && Date.now() - lastOwn > stallMs) {
              await http('POST', `/session/${encodeURIComponent(sessionId!)}/abort`, {}).catch(() => {});
              throw fail(
                `upstream model stalled: no output for ${Math.round(
                  (Date.now() - lastOwn) / 1000
                )}s while the session was busy (provider/model hang; the turn was aborted). Retry, or choose another model. ${diag()}`,
                { sessionId, stalled: true }
              );
            }
            e = synth.shift();
          }
          if (!e) {
            try {
              e = await q.next(idleAt ? 300 : 2000);
            } catch (x: any) {
              throw stopped() || fail(`event stream ended: ${errText(x)}. ${diag()}`, { exitCode: exited?.exitCode });
            }
          }
          if (e === null) {
            if (idleAt) break;
            const s = stopped();
            if (s) throw s;
            continue;
          }
          const pr2 = e.properties || {};
          if (pr2.sessionID && pr2.sessionID !== sessionId) continue;
          if (
            [
              'message.part.updated',
              'message.part.delta',
              'message.updated',
              'session.idle',
              'session.error',
              'permission.asked',
              'question.asked',
            ].includes(e.type)
          ) {
            lastOwn = Date.now();
          }
          recent({ t: e.type, ...(e.type.startsWith('message.part') ? {} : pr2) });
          if (process.env.AGENTBRIDGE_DEBUG) {
            console.error('[oc]', e.type, JSON.stringify(pr2.status || pr2.error || '').slice(0, 300));
          }
          switch (e.type) {
            case 'message.updated': {
              const info = pr2.info || {};
              if (info.id) roles.set(info.id, info.role);
              if (info.role === 'assistant' && info.error) err = errText(info.error);
              break;
            }
            case 'message.part.updated': {
              const part = pr2.part || {};
              if (roles.get(part.messageID) === 'user') break;
              if (part.type === 'text' || part.type === 'reasoning') {
                ptypes.set(part.id, part.type);
                const have = emitted.get(part.id) || 0;
                if (
                  typeof part.text === 'string' &&
                  part.text.length > have &&
                  roles.get(part.messageID) !== 'user' &&
                  roles.has(part.messageID)
                ) {
                  const d = part.text.slice(have);
                  emitted.set(part.id, part.text.length);
                  if (part.type === 'text') {
                    out += d;
                    yield ev.text(d);
                  } else {
                    yield ev.thinking(d);
                  }
                }
              } else if (part.type === 'tool') {
                const st = part.state || {};
                const prev = toolSeen.get(part.callID);
                if (st.status === 'running' || st.status === 'pending') {
                  if (!prev) {
                    toolSeen.set(part.callID, 'run');
                    yield ev.tool(part.tool, st.input ?? {});
                  }
                } else if ((st.status === 'completed' || st.status === 'error') && prev !== 'done') {
                  toolSeen.set(part.callID, 'done');
                  const outp =
                    st.status === 'error'
                      ? `ERROR: ${st.error ?? ''}`
                      : typeof st.output === 'string'
                      ? st.output
                      : JSON.stringify(st.output ?? '');
                  lastTool = { name: part.tool, output: outp };
                  yield ev.tool(part.tool, st.input ?? {}, outp);
                }
              } else if (part.type === 'step-finish' && !toolSeen.has('sf:' + part.id)) {
                toolSeen.set('sf:' + part.id, 1);
                const t = part.tokens || {};
                const i = (t.input || 0) + (t.cache?.read || 0) + (t.cache?.write || 0),
                  c = (t.output || 0) + (t.reasoning || 0);
                usage.input += i;
                usage.output += c;
                if (typeof part.cost === 'number') usage.cost = (usage.cost || 0) + part.cost;
                yield ev.usage(i, c, part.cost, true);
              }
              break;
            }
            case 'message.part.delta': {
              if (pr2.field !== 'text' || roles.get(pr2.messageID) === 'user') break;
              const pt = ptypes.get(pr2.partID) || 'text';
              if (!roles.has(pr2.messageID)) break;
              emitted.set(pr2.partID, (emitted.get(pr2.partID) || 0) + pr2.delta.length);
              if (pt === 'text') {
                out += pr2.delta;
                yield ev.text(pr2.delta);
              } else {
                yield ev.thinking(pr2.delta);
              }
              break;
            }
            case 'permission.asked': {
              yield ev.raw({ permissionAsked: pr2 });
              await http('POST', `/permission/${encodeURIComponent(pr2.id || pr2.requestID)}/reply`, {
                reply: o.permissions === 'full' ? 'once' : 'reject',
              });
              break;
            }
            case 'question.asked': {
              yield ev.raw({ questionAsked: pr2 });
              await http('POST', `/question/${encodeURIComponent(pr2.id || pr2.requestID)}/reject`, {});
              break;
            }
            case 'session.status':
              if (pr2.status?.type === 'busy') sawBusy = true;
              else if (pr2.status?.type === 'idle' && sawBusy && !idleAt) idleAt = Date.now();
              break;
            case 'session.idle':
              if (!idleAt) idleAt = Date.now();
              break;
            case 'session.error':
              err = errText(pr2.error);
              yield ev.error(err);
              break;
            default:
              break;
          }
        }
        if (err) {
          if (/not logged in|unauthori[sz]ed|invalid api key|missing api key|\b401\b/i.test(err)) {
            throw new AgentError('NOT_LOGGED_IN', err, { agent: 'opencode', sessionId });
          }
          throw fail(err, { sessionId, partial: out });
        }
        return out;
      };

      const runTurn = async function* (p: string) {
        text = yield* turn(p);
      };

      yield* runTurn(o.jsonSchema ? o.prompt + schemaSuffix(o.jsonSchema) : o.prompt);
      if (!text.trim() && (o.session as any)?.retryEmpty) {
        yield* runTurn('Your last reply was empty. Please answer the previous request now, in text.');
      }
      if (o.jsonSchema) {
        for (let attempt = 0; ; attempt++) {
          const x = extractJson(text);
          const errs = x.ok ? validateSchema(x.value, o.jsonSchema) : ['reply is not valid JSON'];
          if (!errs.length) {
            json = x.value;
            text = JSON.stringify(x.value);
            break;
          }
          if (attempt >= 1) {
            throw fail(`jsonSchema validation failed: ${errs.slice(0, 5).join('; ')}`, { partial: text });
          }
          yield* runTurn(`Your previous reply was invalid (${errs.slice(0, 5).join('; ')}). Reply again with ONLY the corrected JSON value.`);
        }
      }
      if (!text.trim()) {
        if (lastTool) {
          text = `[no assistant text; last tool "${lastTool.name}" output: ${String(lastTool.output).slice(0, 500)}]`;
        } else {
          throw fail(
            'opencode returned an empty response (model produced no text and no tool calls). Retry, pick another model, or set session.retryEmpty=true.',
            { sessionId, lastEvents: lastEvents.join(' ; ') }
          );
        }
      }
    } catch (e: any) {
      if (e instanceof AgentError) {
        e.sessionId ??= sessionId;
      } else {
        const s = stopped();
        if (s) throw s;
        throw fail(`${errText(e)}. ${diag()}`, { sessionId });
      }
      const s = e.code === 'AGENT_FAILED' || e.code === 'TIMEOUT' || e.code === 'ABORTED' ? stopped() : null;
      throw s || e;
    } finally {
      unlockSession?.();
      if (claimedId) {
        const n = (busy.get(claimedId) || 1) - 1;
        if (n > 0) busy.set(claimedId, n);
        else busy.delete(claimedId);
      } else if (preClaimedId) {
        const n = (busy.get(preClaimedId) || 1) - 1;
        if (n > 0) busy.set(preClaimedId, n);
        else busy.delete(preClaimedId);
      }
      if (toDelete.size && !exited) {
        for (const id of toDelete) {
          try {
            await http('DELETE', `/session/${encodeURIComponent(id)}`);
          } catch {
            /* best effort */
          }
        }
      }
      proc.kill();
      live.delete(proc);
      await Promise.race([done, sleep(3000)]);
    }
    return {
      text,
      sessionId,
      usage,
      exitCode: 0,
      model: o.model || 'default',
      durationMs: Date.now() - started,
      timedOut: false,
      ...(json !== undefined ? { json } : {}),
    };
  },
};

export default adapter;
