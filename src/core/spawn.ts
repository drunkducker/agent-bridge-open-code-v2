import { spawn as nodeSpawn, spawnSync, ChildProcess } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AgentError } from './errors.js';
import { createLineSplitter } from './events.js';
import { hintFor } from './hints.js';
import { Writable } from 'node:stream';

const isWin = process.platform === 'win32';

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolve a command to an absolute executable path (PATH + PATHEXT on Windows). Returns null if not found. */
export function resolveBinary(cmd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const envGet = (k: string) => env[k] ?? env[Object.keys(env).find((x) => x.toLowerCase() === k.toLowerCase()) || ''];
  const exts = isWin ? (envGet('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const hasDir = /[\\/]/.test(cmd);
  const dirs = hasDir ? [''] : (envGet('PATH') || '').split(path.delimiter).filter(Boolean);
  const hasExt = isWin && path.extname(cmd) !== '' && exts.some((e) => e.toLowerCase() === path.extname(cmd).toLowerCase());
  for (const d of dirs) {
    const base = hasDir ? path.resolve(cmd) : path.join(d.replace(/^"|"$/g, ''), cmd);
    const cands = isWin ? (hasExt ? [base] : [...exts.map((e) => base + e.toLowerCase()), ...exts.map((e) => base + e)]) : [base];
    for (const c of cands) if (isFile(c)) return c;
  }
  return null;
}

// Windows: node cannot spawn .cmd/.bat directly.
const SHIM_BOILERPLATE = /^(@?echo\s+off|@?(setlocal|endlocal)\b.*|@?set\s+["']?\w+=.*|if\s.*|\(.*|\).*|goto\s.*|call\s+:find_dp0|title\s.*|exit\s.*|:\w+)$/i;

function parseShim(txt: string): string | null {
  const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(@?rem(\s|$)|::)/i.test(l));
  let exec: string | null = null;
  for (const l of lines) {
    if (l.includes('%*')) {
      if (exec !== null) return null;
      exec = l;
      continue;
    }
    if (!SHIM_BOILERPLATE.test(l)) return null;
  }
  if (exec === null) return null;
  // One-line shims can quote BOTH the interpreter and the script (e.g. "%~dp0\node.exe" "%~dp0\pkg\bin\cli.js" %*):
  // the first quoted token is then the interpreter, so the target is the LAST quoted token that is a real path.
  const quoted = [...exec.matchAll(/"([^"]*)"/g)].map((mm) => mm[1]);
  if (quoted.length > 1) {
    const last = quoted[quoted.length - 1].replace(/^%(?:~dp0|dp0%)/i, '').replace(/^\\/, '');
    if (last && !last.includes('%')) return last;
  }
  const m = /"%(?:~dp0|dp0%)"?\\?([^"%\r\n]+?)"|"%dp0%\\([^"]+)"|%~dp0\\?([^\s"%]+)/i.exec(exec);
  return m ? (m[1] || m[2] || m[3]).replace(/^\\/, '') : null;
}

function resolveShim(file: string, args: string[]): { file: string; args: string[]; verbatim?: boolean } {
  const ext = path.extname(file).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return { file, args };
  try {
    const rel = parseShim(readFileSync(file, 'utf8'));
    if (rel) {
      const target = path.resolve(path.dirname(file), rel);
      const te = path.extname(target).toLowerCase();
      if (isFile(target)) {
        if (te === '.exe') return { file: target, args };
        if (['.js', '.mjs', '.cjs'].includes(te)) {
          const localNode = path.join(path.dirname(file), 'node.exe');
          return { file: isFile(localNode) ? localNode : process.execPath, args: [target, ...args] };
        }
      }
    }
  } catch {
    /* fall through to running the batch file itself */
  }
  return cmdExe(file, args);
}

function cmdExe(file: string, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  const bad = (m: string) => new AgentError('BAD_OPTION', m);
  const unsafe = /["%!\r\n\0]/;
  if (unsafe.test(file)) throw bad('Batch file path contains a character unsafe for cmd.exe');
  for (const a of args) {
    if (unsafe.test(a)) throw bad('Argument containing a double quote, %, !, newline or NUL cannot be passed safely to a .cmd/.bat file');
  }
  const q = (a: string) => '"' + String(a).replace(/(\\+)$/, '$1$1') + '"';
  const line = [q(file), ...args.map(q)].join(' ');
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', '"' + line + '"'], verbatim: true };
}

const live = new Set<ChildProcess>();
const SIGS: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGBREAK: 21 };
const sigHandlers = new Map<string, any>();
const killAll = () => {
  for (const c of live) {
    killTree(c);
    // Process exit cannot wait for killTree's delayed SIGKILL, so escalate now (POSIX group).
    if (!isWin && c.pid != null) {
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch {
        /* group gone */
      }
    }
  }
  live.clear();
};

/** Maximum agent processes alive at once in this Node process (override: AGENTBRIDGE_MAX_PROCS, 0 = unlimited). */
export const DEFAULT_MAX_PROCS = 24;
function maxProcs(): number {
  const raw = process.env.AGENTBRIDGE_MAX_PROCS;
  if (raw == null || raw === '') return DEFAULT_MAX_PROCS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_MAX_PROCS;
}

/** Reap anything the leader left running in its process group after it exited on its own. */
function sweepGroup(child: ChildProcess): void {
  if (isWin || child.pid == null) return;
  const pid = child.pid;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return; // group already empty
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* group gone */
    }
  }, 250).unref();
}

function acquire(): void {
  if (sigHandlers.size) return;
  process.on('exit', killAll);
  sigHandlers.set('exit', null);
  for (const [sig, n] of Object.entries(SIGS)) {
    const h = () => {
      if (process.listenerCount(sig) > 1) return; // host handles it; do not act on its behalf
      killAll();
      process.exit(128 + n);
    };
    try {
      process.on(sig as NodeJS.Signals, h);
      sigHandlers.set(sig, h);
    } catch {
      /* unsupported on this platform */
    }
  }
}

function release(): void {
  if (live.size || !sigHandlers.size) return;
  process.off('exit', killAll);
  for (const [sig, h] of sigHandlers) if (h) process.off(sig as NodeJS.Signals, h);
  sigHandlers.clear();
}

export const STDERR_TAIL_MAX_CHARS = 8192;

/** Kill a process tree. */
export function killTree(child?: ChildProcess | null): void {
  if (!child || child.pid == null || child.exitCode !== null || child.signalCode) return;
  const pid = child.pid;
  if (isWin) {
    let treeKilled = false;
    try {
      const res = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      treeKilled = !res.error && res.status === 0;
    } catch {
      /* ignore */
    }
    if (!treeKilled) {
      // taskkill missing/failed: degrade to killing the leader only.
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  } else {
    let group = false;
    try {
      process.kill(-pid, 'SIGTERM');
      group = true;
    } catch {
      /* no process group */
    }
    if (group) {
      // SIGTERM first: only escalate to SIGKILL once the 250ms grace has elapsed, group leader included.
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* group gone */
        }
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 250).unref();
    } else {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, any>;
  input?: string;
  keepStdinOpen?: boolean;
  timeoutMs?: number;
  maxBuffer?: number;
  maxLine?: number;
  maxStderr?: number;
  signal?: AbortSignal;
  agent?: string;
}

export interface ProcessWaitResult {
  exitCode: number | null;
  signal: string | null;
  killed: boolean;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  error?: any;
}

export interface ProcessHandle {
  pid?: number;
  child: ChildProcess;
  lines: AsyncIterable<string>;
  stdin: Writable;
  kill: () => void;
  wait: () => Promise<ProcessWaitResult>;
}

function validateOpts(cmd: string, args: (string | number)[], opts: Record<string, any>): void {
  const bad = (m: string) => new AgentError('BAD_OPTION', m);
  if (typeof cmd !== 'string' || !cmd || cmd.includes('\0')) throw bad('command must be a non-empty string');
  if (!Array.isArray(args)) throw bad('args must be an array');
  if (args.some((a) => (typeof a !== 'string' && typeof a !== 'number') || String(a).includes('\0'))) throw bad('args must be strings');
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) throw bad('opts must be an object');
  const pos = (k: string) => {
    if (opts[k] != null && !(typeof opts[k] === 'number' && Number.isFinite(opts[k]) && opts[k] > 0)) throw bad(k + ' must be a positive number');
  };
  pos('timeoutMs');
  pos('maxBuffer');
  pos('maxLine');
  if (opts.cwd != null && (typeof opts.cwd !== 'string' || !opts.cwd || opts.cwd.includes('\0'))) throw bad('cwd must be a string');
  if (opts.env != null && (typeof opts.env !== 'object' || Array.isArray(opts.env))) throw bad('env must be an object');
  if (opts.input != null && typeof opts.input !== 'string') throw bad('input must be a string');
  if (opts.agent != null && typeof opts.agent !== 'string') throw bad('agent must be a string');
  if (opts.keepStdinOpen != null && typeof opts.keepStdinOpen !== 'boolean') throw bad('keepStdinOpen must be a boolean');
  const sg = opts.signal;
  if (sg != null && !(typeof sg === 'object' && typeof sg.aborted === 'boolean' && typeof sg.addEventListener === 'function' && typeof sg.removeEventListener === 'function'))
    throw bad('signal must be an AbortSignal');
}

export function spawnProc(cmd: string, args: (string | number)[] = [], opts: SpawnOptions = {}): ProcessHandle {
  validateOpts(cmd, args, opts);
  if (opts.cwd != null) {
    let ok = false;
    try {
      ok = statSync(opts.cwd).isDirectory();
    } catch {
      /* not a dir */
    }
    if (!ok) throw new AgentError('BAD_OPTION', `cwd does not exist or is not a directory: ${opts.cwd}`, { agent: opts.agent });
  }
  const cap = maxProcs();
  if (cap > 0 && live.size >= cap) {
    throw new AgentError('RATE_LIMITED', `Too many concurrent agent processes (${live.size}/${cap}); retry shortly or raise AGENTBRIDGE_MAX_PROCS`, {
      agent: opts.agent,
      retryAfterMs: 2000,
      kind: 'overloaded',
    });
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(opts.env || {})) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = String(v);
  }
  const found = resolveBinary(cmd, env);
  if (!found) throw new AgentError('NOT_INSTALLED', `Executable not found on PATH: ${cmd}${hintFor(opts.agent || cmd, 'NOT_INSTALLED')}`, { agent: opts.agent, binary: cmd });
  const r = resolveShim(found, args.map(String));

  let child: ChildProcess;
  try {
    child = nodeSpawn(r.file, r.args, {
      cwd: opts.cwd,
      env,
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: !!r.verbatim,
      detached: !isWin, // own process group for tree kill on POSIX
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    throw new AgentError(e.code === 'ENOENT' ? 'NOT_INSTALLED' : 'AGENT_FAILED', `spawn ${cmd} failed: ${e.message}`, { agent: opts.agent });
  }

  const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
  const maxLine = opts.maxLine ?? 16 * 1024 * 1024;
  const maxStderr = opts.maxStderr ?? STDERR_TAIL_MAX_CHARS;
  let stderr = '';
  const errDec = new StringDecoder('utf8');
  child.stderr?.on('error', () => {});
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + errDec.write(d)).slice(-maxStderr);
  });
  child.stdin?.on('error', () => {});

  let timedOut = false, aborted = false, killed = false, spawnError: any = null;
  live.add(child);
  acquire();
  const kill = () => {
    if (child.exitCode === null && !child.signalCode) killed = true;
    killTree(child);
  };
  let timer: NodeJS.Timeout | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
  const onAbort = () => { aborted = true; kill(); };
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  const queue: string[] = [];
  let qBytes = 0, ended = false, streamErr: any = null, wake: (() => void) | null = null;
  const notify = () => { if (wake) { const w = wake; wake = null; w(); } };
  const dec = new StringDecoder('utf8');
  const sp = createLineSplitter({ maxLine });
  const fail = (e: any) => { if (streamErr) return; streamErr = e; kill(); notify(); };
  const enqueue = (ls: string[]) => {
    for (const l of ls) { queue.push(l); qBytes += l.length + 1; }
    if (qBytes > maxBuffer) fail(new AgentError('AGENT_FAILED', `Unconsumed output exceeded maxBuffer (${maxBuffer})`, { agent: opts.agent }));
    notify();
  };
  const forceEndStdout = () => {
    if (ended) return;
    try { enqueue(sp.push(dec.end())); enqueue(sp.flush()); } catch (e: any) { if (e.lines) enqueue(e.lines); }
    ended = true; notify();
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    if (streamErr) return;
    try { enqueue(sp.push(dec.write(chunk))); } catch (e: any) { if (e.lines) enqueue(e.lines); fail(e); }
  });
  child.stdout?.on('end', forceEndStdout);
  const releaseStdio = () => {
    child.stdout?.on('error', () => {});
    if (child.stdout && !child.stdout.destroyed) child.stdout.destroy();
    if (child.stderr && !child.stderr.destroyed) child.stderr.destroy();
  };

  const done = new Promise<ProcessWaitResult>((resolve) => {
    let closed = false, graceTimer: NodeJS.Timeout | null = null;
    const fin = (exitCode: number | null, signal: string | null) => {
      if (closed) return; closed = true;
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      if (timer) clearTimeout(timer);
      live.delete(child); release();
      sweepGroup(child);
      opts.signal?.removeEventListener('abort', onAbort);
      forceEndStdout();
      releaseStdio();
      resolve({ exitCode: killed ? null : (exitCode ?? -1), signal: signal ?? (killed ? 'SIGKILL' : null), killed, stderr: (stderr + errDec.end()).trim(), timedOut, aborted, error: spawnError });
    };
    child.on('error', (e) => { spawnError = e; fin(-1, null); });
    child.on('close', (code, sig) => fin(code, sig));
    child.on('exit', (code, sig) => {
      if (closed || graceTimer) return;
      graceTimer = setTimeout(() => fin(code, sig), 700);
    });
  });

  const lines = (async function* () {
    let finished = false;
    try {
      for (;;) {
        if (queue.length) { const l = queue.shift()!; qBytes -= l.length + 1; yield l; continue; }
        if (streamErr) { finished = true; throw streamErr; }
        if (ended) { finished = true; return; }
        await new Promise<void>((r) => { wake = r; });
      }
    } finally {
      if (!finished) kill();
    }
  })();

  if (opts.input != null) child.stdin?.end(String(opts.input));
  else if (!opts.keepStdinOpen) child.stdin?.end();

  return {
    pid: child.pid,
    child,
    lines,
    stdin: child.stdin!,
    kill,
    wait: () => done.then((res) => {
      if (streamErr) throw streamErr;
      if (res.error) {
        throw new AgentError(res.error.code === 'ENOENT' ? 'NOT_INSTALLED' : 'AGENT_FAILED', `spawn ${cmd} failed: ${res.error.message}`, { agent: opts.agent });
      }
      return res;
    }),
  };
}

export interface RunCollectResult extends ProcessWaitResult {
  stdout: string;
}

/** Convenience: run to completion, collect stdout. Resolves {stdout, stderr, exitCode, timedOut, aborted}.
 *  With maxBuffer, collected stdout keeps only the NEWEST lines that fit the cap (error-tail usage);
 *  the cap applies to the collected (consumed) output, not to spawnProc's streaming queue. */
export async function runCollect(cmd: string, args: (string | number)[] = [], opts: SpawnOptions = {}): Promise<RunCollectResult> {
  const { maxBuffer: cap, ...rest } = opts;
  const p = spawnProc(cmd, args, rest);
  const out: string[] = [];
  let outBytes = 0;
  for await (const l of p.lines) {
    out.push(l);
    outBytes += l.length + 1;
    while (cap != null && out.length && outBytes > cap) {
      outBytes -= out[0].length + 1;
      out.shift();
    }
  }
  const r = await p.wait();
  return { ...r, stdout: out.join('\n') };
}
