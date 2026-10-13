// feat-worktree: run an agent in a throw-away git worktree (or, when cwd is not a git repo, a temp copy) and return the diff.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, realpathSync, mkdirSync, lstatSync, readdirSync, readlinkSync, unlinkSync, symlinkSync, statSync, existsSync } from 'node:fs';
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
  diff: (isolatedIndex?: boolean) => { diff: string; files: string[] };
}

function normalizePath(p: string): string {
  try {
    p = realpathSync(path.resolve(p));
  } catch {
    p = path.resolve(p);
  }
  if (process.platform === 'win32' && /^[a-z]:/i.test(p)) {
    p = p[0].toUpperCase() + p.slice(1);
  }
  return path.normalize(p);
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
        const raw = readlinkSync(entry);
        if (path.isAbsolute(raw)) {
          const absTarget = path.resolve(raw);
          if (isWithin(sourceRoot, absTarget)) {
            const sourceTarget = resolveContainedPath(sourceRoot, absTarget, entry);
            if (!existsSync(sourceTarget)) throw new Error(`Cannot remap dangling absolute symlink "${entry}"`);
            const mapped = path.resolve(root, path.relative(sourceRoot, sourceTarget));
            resolveContainedPath(root, mapped, entry);
            let dirTarget = false;
            try { dirTarget = statSync(sourceTarget).isDirectory(); } catch { /* dangling links were rejected above */ }
            unlinkSync(entry); // removes only this sandbox symlink, never its target
            symlinkSync(mapped, entry, process.platform === 'win32' ? (dirTarget ? 'junction' : 'file') : undefined);
            changed = true;
          } else if (isWithin(root, absTarget)) {
            resolveContainedPath(root, absTarget, entry);
          } else {
            throw new Error(`Symlink "${entry}" escapes sandbox/source root: ${absTarget}`);
          }
        } else {
          const target = path.resolve(path.dirname(entry), raw);
          resolveContainedPath(root, target, entry);
        }
        continue; // never recurse through a symlink or junction
      }
      if (stat.isDirectory()) walk(entry);
    }
  };
  walk(root);
  return changed;
}

export function createSandbox(cwd = process.cwd()): Sandbox {
  cwd = normalizePath(cwd);
  const dir = normalizePath(mkdtempSync(path.join(tmpdir(), 'ab-wt-')));
  const rawTop = tryGit(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  const top = rawTop ? normalizePath(rawTop) : null;
  const hasHead = top && tryGit(cwd, ['rev-parse', '--verify', 'HEAD']) != null;
  let mode: 'git-worktree' | 'copy',
    root = dir,
    sub = '';
  if (hasHead && top) {
    const wt = normalizePath(path.join(dir, 'wt'));
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
      return finish(mode, dir, root, sub, cleanup);
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
    return finish(mode, dir, root, '', cleanup);
  } catch (err) {
    cleanup();
    throw err;
  }
}

function finish(mode: 'git-worktree' | 'copy', dir: string, root: string, sub: string, cleanup: () => void): Sandbox {
  return {
    mode,
    dir,
    root,
    sub,
    cwd: sub ? path.join(root, sub) : root,
    cleanup,
    diff(isolatedIndex = false) {
      const env = isolatedIndex ? { ...process.env, GIT_INDEX_FILE: path.join(dir, '.git-tmp-index') } : process.env;
      git(root, ['add', '-A'], { env });
      const filesArgs = sub
        ? ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD', '--', sub]
        : ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--name-only', '-z', 'HEAD'];
      const diffArgs = sub
        ? ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--', sub]
        : ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'];
      const rawFiles = git(root, filesArgs, { env }).split('\0').filter(Boolean);
      const files = sub
        ? rawFiles.map((f) => (path.isAbsolute(f) ? f : path.relative(sub, f))).map((f) => f.replace(/\\/g, '/'))
        : rawFiles;
      const diff = git(root, diffArgs, { env });
      if (isolatedIndex) {
        try { rmSync(path.join(dir, '.git-tmp-index'), { force: true }); } catch {}
      }
      return { diff, files };
    },
  };
}

export async function withWorktree<T>(
  cwd: string,
  fn: (sandboxCwd: string, sandbox: Sandbox) => Promise<T>,
  { keep = false }: { keep?: boolean } = {}
): Promise<{ value: T; diff: string; files: string[]; mode: 'git-worktree' | 'copy'; path: string | null }> {
  const sb = createSandbox(cwd);
  try {
    const value = await fn(sb.cwd, sb);
    const d = sb.diff();
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
