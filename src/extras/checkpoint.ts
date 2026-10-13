// Git Hidden-Ref Checkpointing inspired by T3 Code.
// Captures instant snapshots of the workspace using isolated GIT_INDEX_FILE plumbing,
// storing commits under refs/agentbridge/checkpoints/<session>/<id> without polluting the
// user's active branch, git log, or staging index.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, existsSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentError } from '../core/errors.js';

const G = [
  '-c', 'user.name=agentbridge',
  '-c', 'user.email=ab@localhost',
  '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false',
  '-c', 'commit.gpgsign=false',
];

function git(cwd: string, args: string[], options: { env?: NodeJS.ProcessEnv; input?: string; raw?: boolean } = {}): string {
  try {
    const output = execFileSync('git', [...G, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, ...(options.env || {}) },
      input: options.input,
    });
    return options.raw ? output : output.trim();
  } catch (e: any) {
    const err = e.stderr ? String(e.stderr).trim() : e.message;
    throw new AgentError('AGENT_FAILED', `git ${args.join(' ')} failed: ${err}`);
  }
}

function findRepoRoot(cwd: string): string {
  try {
    return git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new AgentError('BAD_OPTION', `Directory is not a git repository: ${cwd}`);
  }
}

function removeTrackedPathSafely(root: string, file: string): void {
  const realRoot = realpathSync(root);
  const fullPath = path.resolve(realRoot, file);
  const relPath = path.relative(realRoot, fullPath);
  if (relPath === '..' || relPath.startsWith(`..${path.sep}`) || path.isAbsolute(relPath)) {
    throw new AgentError('AGENT_FAILED', `Refusing to remove checkpoint path outside repository: ${file}`);
  }

  // Check the resolved parent so a symlink/junction inside the repo cannot redirect unlinking
  // outside it. The final component is removed with unlink semantics, which never follows links.
  try {
    const parent = realpathSync(path.dirname(fullPath));
    const parentRel = path.relative(realRoot, parent);
    if (parentRel === '..' || parentRel.startsWith(`..${path.sep}`) || path.isAbsolute(parentRel)) {
      throw new AgentError('AGENT_FAILED', `Refusing to remove checkpoint path through an external link: ${file}`);
    }
  } catch (err: any) {
    if (err instanceof AgentError) throw err;
    if (err.code !== 'ENOENT') throw err;
  }

  try {
    const stat = lstatSync(fullPath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new AgentError('AGENT_FAILED', `Refusing to recursively remove unexpected directory: ${file}`);
    }
    unlinkSync(fullPath);
  } catch (err: any) {
    if (err instanceof AgentError) throw err;
    if (err.code !== 'ENOENT') throw err;
  }
}

export interface CheckpointInfo {
  id: string;
  ref: string;
  commitOid: string;
  treeOid: string;
  createdAt: number;
  message: string;
  sessionId?: string;
}

export interface CheckpointOptions {
  message?: string;
  sessionId?: string;
}

export function createCheckpoint(cwd: string = process.cwd(), options: CheckpointOptions = {}): CheckpointInfo {
  const root = findRepoRoot(cwd);
  const sessionId = options.sessionId || 'default';
  const checkpointId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const ref = `refs/agentbridge/checkpoints/${sessionId}/${checkpointId}`;
  const message = options.message || `checkpoint ${checkpointId}`;

  // Isolated index file to ensure the developer's .git/index is NEVER touched
  const tempIndexFile = path.join(tmpdir(), `ab-cp-index-${checkpointId}.tmp`);
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tempIndexFile };

  try {
    // Check if HEAD exists
    let hasHead = false;
    let headOid = '';
    try {
      headOid = git(root, ['rev-parse', 'HEAD']);
      hasHead = true;
    } catch {
      hasHead = false;
    }

    if (hasHead) {
      // Seed the isolated index with the current HEAD tree
      git(root, ['read-tree', headOid], { env });
    }

    // Add current working tree changes into the isolated index
    git(root, ['add', '-A'], { env });

    // Write tree from isolated index
    const treeOid = git(root, ['write-tree'], { env });

    // Commit the tree without advancing any branch
    const commitArgs = ['commit-tree', treeOid, '-m', `agentbridge checkpoint: ${message}`];
    if (hasHead) {
      commitArgs.push('-p', headOid);
    }
    const commitOid = git(root, commitArgs);

    // Update hidden ref
    git(root, ['update-ref', ref, commitOid]);

    return {
      id: checkpointId,
      ref,
      commitOid,
      treeOid,
      createdAt: Date.now(),
      message,
      sessionId,
    };
  } finally {
    try {
      if (existsSync(tempIndexFile)) rmSync(tempIndexFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export function listCheckpoints(cwd: string = process.cwd(), sessionId?: string): CheckpointInfo[] {
  const root = findRepoRoot(cwd);
  const pattern = sessionId
    ? `refs/agentbridge/checkpoints/${sessionId}/`
    : 'refs/agentbridge/checkpoints/';

  let raw = '';
  try {
    raw = git(root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(subject)', pattern], { raw: true });
  } catch {
    return [];
  }

  if (!raw) return [];

  const list: CheckpointInfo[] = [];
  const prefix = 'refs/agentbridge/checkpoints/';
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [ref, commitOid, subject] = line.split('\0');
    if (!ref?.startsWith(prefix) || !commitOid || subject == null) continue;
    const relative = ref.slice(prefix.length);
    const lastSlash = relative.lastIndexOf('/');
    if (lastSlash < 0) continue;
    const id = relative.slice(lastSlash + 1);
    const sess = relative.slice(0, lastSlash);
    if (sessionId && sess !== sessionId) continue;
    list.push({
      id,
      ref,
      commitOid,
      treeOid: '',
      createdAt: Number(id.split('-')[0]) || Date.now(),
      message: (subject || '').replace(/^agentbridge checkpoint:\s*/, ''),
      sessionId: sess,
    });
  }

  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export function rollbackCheckpoint(cwd: string = process.cwd(), checkpointId: string): { restoredOid: string; removedFiles: string[] } {
  const root = findRepoRoot(cwd);
  const all = listCheckpoints(root);
  const target = all.find((c) => c.id === checkpointId || c.ref.endsWith(`/${checkpointId}`));
  if (!target) {
    throw new AgentError('BAD_OPTION', `Checkpoint not found: ${checkpointId}`);
  }

  // 1. Identify files currently in the index that did not exist in the checkpoint
  const targetFiles = new Set(
    git(root, ['ls-tree', '-r', '--name-only', '-z', target.commitOid], { raw: true }).split('\0').filter(Boolean)
  );

  const currentTracked = git(root, ['ls-files', '-z'], { raw: true }).split('\0').filter(Boolean);

  const removedFiles: string[] = [];
  for (const file of currentTracked) {
    if (!targetFiles.has(file)) {
      try {
        git(root, ['rm', '-f', '--', file]);
        removedFiles.push(file);
      } catch {
        try {
          removeTrackedPathSafely(root, file);
          git(root, ['update-index', '--force-remove', '--', file]);
          removedFiles.push(file);
        } catch (err: any) {
          throw new AgentError('AGENT_FAILED', `Failed to remove checkpoint path "${file}": ${err.message}`);
        }
      }
    }
  }

  // 2. Restore working tree and index files directly from the checkpoint commit
  git(root, ['checkout', target.commitOid, '--', '.']);

  // 3. Clean untracked files that didn't exist in the checkpoint
  git(root, ['clean', '-fd']);

  return { restoredOid: target.commitOid, removedFiles };
}

export function diffCheckpoint(cwd: string = process.cwd(), checkpointId: string): string {
  const root = findRepoRoot(cwd);
  const all = listCheckpoints(root);
  const target = all.find((c) => c.id === checkpointId || c.ref.endsWith(`/${checkpointId}`));
  if (!target) {
    throw new AgentError('BAD_OPTION', `Checkpoint not found: ${checkpointId}`);
  }

  const tempIndexFile = path.join(tmpdir(), `ab-cp-diff-${randomBytes(4).toString('hex')}.tmp`);
  const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: tempIndexFile };
  try {
    try {
      const head = git(root, ['rev-parse', 'HEAD']);
      git(root, ['read-tree', head], { env });
    } catch {
      /* ignore */
    }
    git(root, ['add', '-A'], { env });
    const currentTree = git(root, ['write-tree'], { env });
    return git(root, ['diff', '--no-ext-diff', '--no-textconv', target.commitOid, currentTree]);
  } finally {
    try {
      if (existsSync(tempIndexFile)) rmSync(tempIndexFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

export function deleteCheckpoint(cwd: string = process.cwd(), checkpointId: string): boolean {
  const root = findRepoRoot(cwd);
  const all = listCheckpoints(root);
  const target = all.find((c) => c.id === checkpointId || c.ref.endsWith(`/${checkpointId}`));
  if (!target) return false;

  git(root, ['update-ref', '-d', target.ref]);
  return true;
}
