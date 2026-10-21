// feat-worktree: run an agent in a throw-away git worktree (or, when cwd is not a git repo, a temp copy) and return the diff.
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, realpathSync, mkdirSync, lstatSync, readdirSync, readlinkSync, unlinkSync, symlinkSync, statSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBudgeted } from './budget.js';
import { seedProjectSkills } from '../core/shared-resources.js';

const G = [
  '-c',
  'user.name=agentbridge',
  '-c',
  'user.email=ab@localhost',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.safecrlf=false',
  '-c',
  'commit.gpgsign=false',
];

const git = (cwd: string, args: string[], o: any = {}): string =>
  execFileSync('git', [...G, ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...o });

/** Async git: never blocks the event loop. `input` is written to stdin. */
export function gitAsync(cwd: string, args: string[], o: any = {}): Promise<string> {
  const { input, noConfig, ...rest } = o;
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      noConfig ? args : [...G, ...args],
      { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...rest },
      (err: any, stdout: any, stderr: any) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
        } else resolve(String(stdout));
      }
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? '');
  });
}

const tryGitAsync = async (cwd: string, args: string[], o?: any): Promise<string | null> => {
  try {
    return await gitAsync(cwd, args, o);
  } catch {
    return null;
  }
};

const tryGit = (cwd: string, args: string[], o?: any): string | null => {
  try {
    return git(cwd, args, o);
  } catch {
    return null;
  }
};

export interface Sandbox {
  mode: 'git-worktree' | 'copy';
  dir: string;
  root: string;
  cwd: string;
  sub: string;
  cleanup: () => void;
  /** Non-blocking cleanup (same effect as cleanup()). */
  cleanupAsync: () => Promise<void>;
  diff: (isolatedIndex?: boolean) => { diff: string; files: string[] };
  /** Non-blocking diff; calls on one sandbox are serialized (they share one git index). */
  diffAsync: (isolatedIndex?: boolean) => Promise<{ diff: string; files: string[] }>;
}

/** Marker written into every sandbox dir so a later proxy start can tell its own leftovers from anything else. */
export const SANDBOX_MARKER = '.agentbridge-sandbox';
export const SANDBOX_PREFIX = 'ab-wt-';

function writeMarker(dir: string, origin: string, mode: string): void {
  try {
    writeFileSync(path.join(dir, SANDBOX_MARKER), JSON.stringify({ v: 1, pid: process.pid, origin, mode, created: Date.now() }));
  } catch {
    /* best effort: an unmarked dir is simply never auto-removed */
  }
}

function normalizePath(p: string): string {
  try {
    p = realpathSync.native(path.resolve(p));
  } catch {
    p = path.resolve(p);
  }
  if (process.platform === 'win32' && /^[a-z]:/i.test(p)) {
    p = p[0].toUpperCase() + p.slice(1);
  }
  return path.normalize(p);
}

/** Rebase an alias through ancestors of the trusted root. Keep every component
 * below root lexical so resolveContainedPath can inspect links. */
function resolveRootAlias(root: string, target: string): string {
  root = path.resolve(root);
  target = path.resolve(target);
  if (isWithin(root, target)) return target;
  const parsed = path.parse(target);
  const parts = path.relative(parsed.root, target).split(path.sep).filter(Boolean);
  let prefix = parsed.root;
  for (let i = 0; i < parts.length; i++) {
    prefix = path.join(prefix, parts[i]);
    // The final component can itself be a link. Only accept it when this is an
    // alias spelling of root itself; never canonicalize an in-root target leaf.
    try {
      const canonicalPrefix = realpathSync.native(prefix);
      if (isWithin(root, canonicalPrefix)) {
        if (i === parts.length - 1 && path.normalize(canonicalPrefix) !== path.normalize(root)) return target;
        return path.resolve(canonicalPrefix, ...parts.slice(i + 1));
      }
    } catch {
      // Missing target components remain lexical and are checked by the caller.
    }
    if (i === parts.length - 1) break;
  }
  return target;
}

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Resolve existing symlink components without ever following one outside root. Dangling paths inside root are safe. */
function resolveContainedPath(root: string, target: string, link: string, seen = new Set<string>()): string {
  root = path.resolve(root);
  target = path.resolve(target);
  if (!isWithin(root, target)) throw new Error(`Symlink "${link}" escapes sandbox/source root: ${target}`);
  const rel = path.relative(root, target);
  const parts = rel ? rel.split(path.sep).filter(Boolean) : [];
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (e: any) {
      if (e.code === 'ENOENT') return path.join(current, ...parts.slice(i + 1));
      throw new Error(`Cannot inspect symlink target for "${link}": ${e.message}`);
    }
    if (stat.isSymbolicLink()) {
      if (seen.has(current)) throw new Error(`Symlink loop while resolving "${link}"`);
      const raw = readlinkSync(current);
      const next = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(current), raw);
      return resolveContainedPath(root, path.join(next, ...parts.slice(i + 1)), link, new Set([...seen, current]));
    }
    if (i < parts.length - 1 && !stat.isDirectory())
      throw new Error(`Symlink "${link}" targets a non-directory path: ${current}`);
  }
  return current;
}

/** Validate one sandbox symlink and rebase absolute links that refer to the source tree. Returns true when rewritten. */
function fixLink(entry: string, root: string, sourceRoot: string): boolean {
  const raw = readlinkSync(entry);
  if (path.isAbsolute(raw)) {
    // Symlink text may use another spelling of the trusted root's parent
    // (macOS /var -> /private/var, or Windows 8.3 names). Resolve only
    // those parent aliases; keep all in-root components lexical for the
    // contained-link walk below.
    const absTarget = resolveRootAlias(sourceRoot, raw);
    if (isWithin(sourceRoot, absTarget)) {
      const sourceTarget = resolveContainedPath(sourceRoot, absTarget, entry);
      if (!existsSync(sourceTarget)) throw new Error(`Cannot remap dangling absolute symlink "${entry}"`);
      const mapped = path.resolve(root, path.relative(sourceRoot, sourceTarget));
      resolveContainedPath(root, mapped, entry);
      let dirTarget = false;
      try { dirTarget = statSync(sourceTarget).isDirectory(); } catch { /* dangling links were rejected above */ }
      unlinkSync(entry); // removes only this sandbox symlink, never its target
      symlinkSync(mapped, entry, process.platform === 'win32' ? (dirTarget ? 'junction' : 'file') : undefined);
      return true;
    }
    const sandboxTarget = resolveRootAlias(root, raw);
    if (isWithin(root, sandboxTarget)) {
      resolveContainedPath(root, sandboxTarget, entry);
    } else {
      throw new Error(`Symlink "${entry}" escapes sandbox/source root: ${absTarget}`);
    }
  } else {
    const target = path.resolve(path.dirname(entry), raw);
    resolveContainedPath(root, target, entry);
  }
  return false;
}

/** Validate sandbox links and rebase absolute links that refer to the source tree. */
function normalizeSandboxLinks(root: string, sourceRoot: string): boolean {
  root = normalizePath(root);
  sourceRoot = normalizePath(sourceRoot);
  let changed = false;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const entry = path.join(dir, name);
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink()) {
        if (fixLink(entry, root, sourceRoot)) changed = true;
        continue; // never recurse through a symlink or junction
      }
      if (stat.isDirectory()) walk(entry);
    }
  };
  walk(root);
  return changed;
}

/** Same as normalizeSandboxLinks, but the directory walk does not block the event loop. */
async function normalizeSandboxLinksAsync(root: string, sourceRoot: string): Promise<boolean> {
  root = normalizePath(root);
  sourceRoot = normalizePath(sourceRoot);
  let changed = false;
  const walk = async (dir: string): Promise<void> => {
    for (const name of await fsp.readdir(dir)) {
      const entry = path.join(dir, name);
      const stat = await fsp.lstat(entry);
      if (stat.isSymbolicLink()) {
        if (fixLink(entry, root, sourceRoot)) changed = true;
        continue;
      }
      if (stat.isDirectory()) await walk(entry);
    }
  };
  await walk(root);
  return changed;
}

export function createSandbox(cwd = process.cwd()): Sandbox {
  cwd = normalizePath(cwd);
  const dir = normalizePath(mkdtempSync(path.join(tmpdir(), SANDBOX_PREFIX)));
  writeMarker(dir, cwd, 'copy');
  const rawTop = tryGit(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  const top = rawTop ? normalizePath(rawTop) : null;
  const hasHead = top && tryGit(cwd, ['rev-parse', '--verify', 'HEAD']) != null;
  let mode: 'git-worktree' | 'copy',
    root = dir,
    sub = '';
  if (hasHead && top) {
    const wt = normalizePath(path.join(dir, 'wt'));
    writeMarker(dir, top, 'git-worktree');
    git(top, ['worktree', 'add', '--detach', wt, 'HEAD']);
    mode = 'git-worktree';
    root = wt;
    let rel = '';
    if (process.platform === 'win32') {
      rel = top.toLowerCase() === cwd.toLowerCase() ? '' : path.relative(top, cwd);
    } else {
      rel = top === cwd ? '' : path.relative(top, cwd);
    }
    sub = !rel || rel === '.' || rel.startsWith('..') ? '' : rel;
    const cleanup = () => {
      tryGit(top, ['worktree', 'remove', '--force', wt]);
      tryGit(top, ['worktree', 'prune']);
      // Best effort: a child process can still hold the sandbox as cwd (EBUSY/EPERM on Windows).
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    };
    try {
      // Build a reproducible patch; external diff/textconv are presentation hooks and may fail
      // or emit a format that `git apply` cannot consume. A failure must abort the snapshot.
      const patch = git(top, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--binary']);
      let dirty = false;
      if (patch && patch.trim()) {
        try {
          git(wt, ['apply', '--whitespace=nowarn', '-'], { input: patch });
          dirty = true;
        } catch (err: any) {
          throw new Error(`Failed to apply working tree modifications to sandbox worktree: ${err.stderr || err.message}`);
        }
      }
      // Use NUL-delimited Git paths: porcelain quotes whitespace and non-ASCII filenames.
      const untracked = git(top, ['ls-files', '--others', '--exclude-standard', '-z']);
      if (untracked) {
        for (const relPath of untracked.split('\0').filter(Boolean)) {
          const components = relPath.split(/[\\/]/);
          if (components.some((part) => part === '.git' || part === 'node_modules')) continue;
          const src = path.join(top, relPath);
          const dst = path.join(wt, relPath);
          try {
            mkdirSync(path.dirname(dst), { recursive: true });
            cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
            dirty = true;
          } catch (err: any) {
            throw new Error(`Failed to copy untracked path "${relPath}" into sandbox worktree: ${err.message}`);
          }
        }
      }
      if (seedProjectSkills(top, wt).length) dirty = true;
      // Seeded project skills may contain ignored symlinks, so validate the complete
      // sandbox tree after copying them and before recording the baseline commit.
      if (normalizeSandboxLinks(wt, top)) dirty = true;
      if (dirty) {
        try {
          git(wt, ['add', '-A']);
          git(wt, ['commit', '-q', '-m', 'ab-baseline']);
        } catch (err: any) {
          throw new Error(`Failed to commit sandbox baseline: ${err.stderr || err.message}`);
        }
      }
      return finish(mode, dir, root, sub, cleanup, async () => cleanup());
    } catch (err) {
      cleanup();
      throw err;
    }
  }
  mode = 'copy';
  root = path.join(dir, 'copy');
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };
  try {
    mkdirSync(root);
    cpSync(cwd, root, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: (s) => {
        const b = path.basename(s);
        return b !== 'node_modules' && b !== '.git';
      },
    });
    normalizeSandboxLinks(root, cwd);
    git(root, ['init', '-q']);
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'ab-baseline', '--allow-empty']);
    return finish(mode, dir, root, '', cleanup, async () => cleanup());
  } catch (err) {
    cleanup();
    throw err;
  }
}

/** Same sandbox as createSandbox (identical copy semantics) but never blocks the event loop. */
export async function createSandboxAsync(cwd = process.cwd()): Promise<Sandbox> {
  cwd = normalizePath(cwd);
  const dir = normalizePath(mkdtempSync(path.join(tmpdir(), SANDBOX_PREFIX)));
  writeMarker(dir, cwd, 'copy');
  const rm = async () => {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };
  try {
    const rawTop = (await tryGitAsync(cwd, ['rev-parse', '--show-toplevel']))?.trim();
    const top = rawTop ? normalizePath(rawTop) : null;
    const hasHead = top && (await tryGitAsync(cwd, ['rev-parse', '--verify', 'HEAD'])) != null;
    if (hasHead && top) {
      const wt = normalizePath(path.join(dir, 'wt'));
      writeMarker(dir, top, 'git-worktree');
      await gitAsync(top, ['worktree', 'add', '--detach', wt, 'HEAD']);
      let rel = '';
      if (process.platform === 'win32') {
        rel = top.toLowerCase() === cwd.toLowerCase() ? '' : path.relative(top, cwd);
      } else {
        rel = top === cwd ? '' : path.relative(top, cwd);
      }
      const sub = !rel || rel === '.' || rel.startsWith('..') ? '' : rel;
      const cleanupAsync = async () => {
        await tryGitAsync(top, ['worktree', 'remove', '--force', wt]);
        await tryGitAsync(top, ['worktree', 'prune']);
        await rm();
      };
      const cleanup = () => {
        tryGit(top, ['worktree', 'remove', '--force', wt]);
        tryGit(top, ['worktree', 'prune']);
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      };
      try {
        const patch = await gitAsync(top, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--binary']);
        let dirty = false;
        if (patch && patch.trim()) {
          try {
            await gitAsync(wt, ['apply', '--whitespace=nowarn', '-'], { input: patch });
            dirty = true;
          } catch (err: any) {
            throw new Error(`Failed to apply working tree modifications to sandbox worktree: ${err.stderr || err.message}`);
          }
        }
        const untracked = await gitAsync(top, ['ls-files', '--others', '--exclude-standard', '-z']);
        if (untracked) {
          for (const relPath of untracked.split('\0').filter(Boolean)) {
            const components = relPath.split(/[\\/]/);
            if (components.some((part) => part === '.git' || part === 'node_modules')) continue;
            const src = path.join(top, relPath);
            const dst = path.join(wt, relPath);
            try {
              await fsp.mkdir(path.dirname(dst), { recursive: true });
              await fsp.cp(src, dst, { recursive: true, verbatimSymlinks: true });
              dirty = true;
            } catch (err: any) {
              throw new Error(`Failed to copy untracked path "${relPath}" into sandbox worktree: ${err.message}`);
            }
          }
        }
        if (seedProjectSkills(top, wt).length) dirty = true;
        if (await normalizeSandboxLinksAsync(wt, top)) dirty = true;
        if (dirty) {
          try {
            await gitAsync(wt, ['add', '-A']);
            await gitAsync(wt, ['commit', '-q', '-m', 'ab-baseline']);
          } catch (err: any) {
            throw new Error(`Failed to commit sandbox baseline: ${err.stderr || err.message}`);
          }
        }
        return finish('git-worktree', dir, wt, sub, cleanup, cleanupAsync);
      } catch (err) {
        await cleanupAsync();
        throw err;
      }
    }
    const root = path.join(dir, 'copy');
    await fsp.mkdir(root);
    await fsp.cp(cwd, root, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: (s) => {
        const b = path.basename(s);
        return b !== 'node_modules' && b !== '.git';
      },
    });
    await normalizeSandboxLinksAsync(root, cwd);
    await gitAsync(root, ['init', '-q']);
    await gitAsync(root, ['add', '-A']);
    await gitAsync(root, ['commit', '-q', '-m', 'ab-baseline', '--allow-empty']);
    return finish('copy', dir, root, '', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }, rm);
  } catch (err) {
    await rm();
    throw err;
  }
}

/**
 * Remove sandboxes left behind by a proxy that was killed. Deliberately narrow: only directories that sit
 * directly in the temp dir, match `ab-wt-<6 chars>` exactly, are real (non-symlink) directories owned by this user,
 * carry a valid marker from this tool whose pid is dead and whose age exceeds ttlMs. Anything else is left alone.
 * For git-worktree sandboxes `git worktree prune` is then run in the recorded origin repo.
 */
export async function cleanupStaleSandboxes(o: { ttlMs: number; baseDir?: string; now?: number } = { ttlMs: 30 * 60_000 }): Promise<string[]> {
  const base = o.baseDir || tmpdir();
  const removed: string[] = [];
  let names: string[];
  try {
    names = await fsp.readdir(base);
  } catch {
    return removed;
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e?.code === 'EPERM';
    }
  };
  const prune = new Set<string>();
  for (const name of names) {
    if (!/^ab-wt-[A-Za-z0-9]{6}$/.test(name)) continue;
    try {
      const dir = path.join(base, name);
      const st = await fsp.lstat(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (uid != null && st.uid !== uid) continue;
      const mp = path.join(dir, SANDBOX_MARKER);
      const mst = await fsp.lstat(mp);
      if (!mst.isFile() || mst.size > 64 * 1024) continue;
      const m = JSON.parse(await fsp.readFile(mp, 'utf8'));
      if (!m || m.v !== 1 || !Number.isInteger(m.pid) || m.pid <= 0 || typeof m.origin !== 'string' || !Number.isFinite(m.created)) continue;
      if (m.pid === process.pid || alive(m.pid)) continue;
      if ((o.now ?? Date.now()) - m.created < o.ttlMs) continue;
      await fsp.rm(dir, { recursive: true, force: true });
      removed.push(dir);
      if (m.mode === 'git-worktree' && path.isAbsolute(m.origin)) prune.add(m.origin);
    } catch {
      /* unreadable or unexpected: leave it */
    }
  }
  for (const origin of prune) {
    try {
      if ((await fsp.stat(origin)).isDirectory()) await gitAsync(origin, ['worktree', 'prune']);
    } catch {
      /* repo gone or not a repo */
    }
  }
  return removed;
}

const diffArgsFor = (sub: string) => ({
  filesArgs: sub
    ? ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--', sub]
    : ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD'],
  diffArgs: sub
    ? ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--', sub]
    : ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'],
});
const relFiles = (raw: string[], sub: string) =>
  sub ? raw.map((f) => (path.isAbsolute(f) ? f : path.relative(sub, f))).map((f) => f.replace(/\\/g, '/')) : raw;

function finish(mode: 'git-worktree' | 'copy', dir: string, root: string, sub: string, cleanup: () => void, cleanupAsync: () => Promise<void>): Sandbox {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    mode,
    dir,
    root,
    sub,
    cwd: sub ? path.join(root, sub) : root,
    cleanup,
    cleanupAsync,
    diff(isolatedIndex = false) {
      const env = isolatedIndex ? { ...process.env, GIT_INDEX_FILE: path.join(dir, '.git-tmp-index') } : process.env;
      git(root, ['add', '-A'], { env });
      const { filesArgs, diffArgs } = diffArgsFor(sub);
      const rawFiles = git(root, filesArgs, { env }).split('\0').filter(Boolean);
      const files = relFiles(rawFiles, sub);
      const diff = git(root, diffArgs, { env });
      if (isolatedIndex) {
        try { rmSync(path.join(dir, '.git-tmp-index'), { force: true }); } catch {}
      }
      return { diff, files };
    },
    diffAsync(isolatedIndex = false) {
      const run = async () => {
        const env = isolatedIndex ? { ...process.env, GIT_INDEX_FILE: path.join(dir, '.git-tmp-index') } : process.env;
        await gitAsync(root, ['add', '-A'], { env });
        const { filesArgs, diffArgs } = diffArgsFor(sub);
        const rawFiles = (await gitAsync(root, filesArgs, { env })).split('\0').filter(Boolean);
        const files = relFiles(rawFiles, sub);
        const diff = await gitAsync(root, diffArgs, { env });
        if (isolatedIndex) await fsp.rm(path.join(dir, '.git-tmp-index'), { force: true }).catch(() => {});
        return { diff, files };
      };
      const p = chain.then(run, run);
      chain = p.catch(() => {});
      return p;
    },
  };
}

export async function withWorktree<T>(
  cwd: string,
  fn: (sandboxCwd: string, sandbox: Sandbox) => Promise<T>,
  { keep = false }: { keep?: boolean } = {}
): Promise<{ value: T; diff: string; files: string[]; mode: 'git-worktree' | 'copy'; path: string | null }> {
  const sb = await createSandboxAsync(cwd);
  try {
    const value = await fn(sb.cwd, sb);
    const d = await sb.diffAsync();
    return { value, ...d, mode: sb.mode, path: keep ? sb.root : null };
  } finally {
    if (!keep) sb.cleanup();
  }
}

export async function runInWorktree(agent: any, opts: any, { runOne, budget, gen, onEvent, keep }: any = {}): Promise<any> {
  const one = runOne || ((a: any, p: any) => runBudgeted(a, p, budget || {}, { gen, onEvent }));
  const { value, diff, files, mode, path: kept } = await withWorktree(
    opts.cwd || process.cwd(),
    (cwd) => one(agent, { ...opts, cwd }),
    { keep }
  );
  return { ...(value as any), worktree: { mode, diff, files, path: kept } };
}
