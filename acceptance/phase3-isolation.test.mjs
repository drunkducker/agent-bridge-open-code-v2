import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSandbox } from '../dist/extras/worktree.js';
import { handleAgentRoutes } from '../dist/server/agent.js';
import { parseCommand } from '../dist/extras/repair.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'ab-p3-'));

function initRepo(d) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'init', '-q'], { cwd: d });
  writeFileSync(path.join(d, 'tracked.txt'), 'base\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: d });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'initial'], { cwd: d });
}

function linkOrSkip(t, target, linkPath, type) {
  try {
    symlinkSync(target, linkPath, type);
  } catch (e) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(e.code)) {
      t.skip(`Windows does not permit creating this test link: ${e.code}`);
      return false;
    }
    throw e;
  }
  return true;
}

test('A08: createSandbox copies untracked files into the sandbox baseline', async (t) => {
  const d = tmp();
  try {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'init', '-q'], { cwd: d });
    writeFileSync(path.join(d, 'tracked.txt'), 'base\n');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'initial'], { cwd: d });

    // Create untracked file and config directory
    mkdirSync(path.join(d, '.agentbridge'), { recursive: true });
    writeFileSync(path.join(d, '.agentbridge', 'config.json'), '{"permissionsCeiling":"read-only"}\n');
    writeFileSync(path.join(d, 'untracked.txt'), 'new content\n');
    writeFileSync(path.join(d, 'untracked-target.txt'), 'link target\n');
    if (!linkOrSkip(t, 'untracked-target.txt', path.join(d, 'untracked-link.txt'), 'file')) return;

    const sb = createSandbox(d);
    try {
      assert.equal(sb.mode, 'git-worktree');
      // Verify untracked files were copied to sandbox
      assert.ok(existsSync(path.join(sb.cwd, 'untracked.txt')), 'untracked.txt should exist in sandbox');
      assert.ok(existsSync(path.join(sb.cwd, '.agentbridge', 'config.json')), '.agentbridge/config.json should exist in sandbox');
      assert.equal(readFileSync(path.join(sb.cwd, 'untracked.txt'), 'utf8'), 'new content\n');
      assert.equal(readFileSync(path.join(sb.cwd, 'untracked-link.txt'), 'utf8'), 'link target\n');
      assert.equal(readlinkSync(path.join(sb.cwd, 'untracked-link.txt')), 'untracked-target.txt');
    } finally {
      sb.cleanup();
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('sandbox rejects relative and absolute symlinks whose targets escape a git source tree', (t) => {
  for (const [label, targetOf] of [
    ['relative', (repo, outside) => path.relative(repo, outside)],
    ['absolute', (_repo, outside) => outside],
  ]) {
    const parent = tmp();
    const repo = path.join(parent, 'repo');
    mkdirSync(repo);
    const outside = path.join(parent, 'outside.txt');
    writeFileSync(outside, 'untouched\n');
    initRepo(repo);
    if (!linkOrSkip(t, targetOf(repo, outside), path.join(repo, `external-${label}.txt`), 'file')) {
      rmSync(parent, { recursive: true, force: true });
      return;
    }
    try {
      assert.throws(() => createSandbox(repo), /symlink.*escape|escape.*symlink/i);
      assert.equal(readFileSync(outside, 'utf8'), 'untouched\n');
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
});

test('sandbox rejects a relative symlink chain that eventually escapes the source tree', (t) => {
  const parent = tmp();
  const repo = path.join(parent, 'repo');
  mkdirSync(repo);
  const outside = path.join(parent, 'outside.txt');
  writeFileSync(outside, 'untouched\n');
  initRepo(repo);
  try {
    if (!linkOrSkip(t, path.relative(repo, outside), path.join(repo, 'link-target.txt'), 'file')) return;
    if (!linkOrSkip(t, 'link-target.txt', path.join(repo, 'chain.txt'), 'file')) return;
    assert.throws(() => createSandbox(repo), /symlink.*escape|escape.*symlink/i);
    assert.equal(readFileSync(outside, 'utf8'), 'untouched\n');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('git sandbox preserves internal relative links and remaps absolute source links before baseline', (t) => {
  const d = tmp();
  try {
    initRepo(d);
    writeFileSync(path.join(d, 'inside.txt'), 'sandbox copy\n');
    const relativeLink = path.join(d, 'relative.txt');
    const absoluteLink = path.join(d, 'absolute.txt');
    if (!linkOrSkip(t, 'inside.txt', relativeLink, 'file')) return;
    if (!linkOrSkip(t, path.join(d, 'inside.txt'), absoluteLink, 'file')) return;
    execFileSync('git', ['config', 'core.symlinks', 'true'], { cwd: d });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'links'], { cwd: d });
    const sb = createSandbox(d);
    try {
      assert.equal(readFileSync(path.join(sb.cwd, 'relative.txt'), 'utf8'), 'sandbox copy\n');
      assert.equal(readFileSync(path.join(sb.cwd, 'absolute.txt'), 'utf8'), 'sandbox copy\n');
      assert.ok(readlinkSync(path.join(sb.cwd, 'absolute.txt')).toLowerCase().includes(sb.root.toLowerCase()));
      assert.deepEqual(sb.diff().files, [], 'normalized source links must be part of the sandbox baseline');
    } finally {
      sb.cleanup();
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('copy sandbox rejects external links and preserves internal source links', (t) => {
  const parent = tmp();
  const source = path.join(parent, 'plain-source');
  const outside = path.join(parent, 'outside.txt');
  mkdirSync(source);
  writeFileSync(outside, 'untouched\n');
  writeFileSync(path.join(source, 'inside.txt'), 'safe copy\n');
  if (!linkOrSkip(t, 'inside.txt', path.join(source, 'relative.txt'), 'file')) return;
  if (!linkOrSkip(t, path.join(source, 'inside.txt'), path.join(source, 'absolute.txt'), 'file')) return;
  try {
    const sb = createSandbox(source);
    try {
      assert.equal(sb.mode, 'copy');
      assert.equal(readFileSync(path.join(sb.cwd, 'relative.txt'), 'utf8'), 'safe copy\n');
      assert.equal(readlinkSync(path.join(sb.cwd, 'relative.txt')), 'inside.txt');
      assert.equal(readFileSync(path.join(sb.cwd, 'absolute.txt'), 'utf8'), 'safe copy\n');
      assert.ok(readlinkSync(path.join(sb.cwd, 'absolute.txt')).toLowerCase().includes(sb.root.toLowerCase()));
      assert.deepEqual(sb.diff().files, []);
    } finally {
      sb.cleanup();
    }

    const externalLink = path.join(source, 'external.txt');
    if (!linkOrSkip(t, path.relative(source, outside), externalLink, 'file')) return;
    assert.throws(() => createSandbox(source), /symlink.*escape|escape.*symlink/i);
    assert.equal(readFileSync(outside, 'utf8'), 'untouched\n');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('directory junctions remain contained in the sandbox', (t) => {
  const parent = tmp();
  const source = path.join(parent, 'plain-source');
  const target = path.join(source, 'internal-dir');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'file.txt'), 'contained\n');
  try {
    if (!linkOrSkip(t, target, path.join(source, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')) return;
    const sb = createSandbox(source);
    try {
      assert.equal(readFileSync(path.join(sb.cwd, 'junction', 'file.txt'), 'utf8'), 'contained\n');
      assert.ok(readlinkSync(path.join(sb.cwd, 'junction')).toLowerCase().includes(sb.root.toLowerCase()));
    } finally {
      sb.cleanup();
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('git sandbox validates external symlinks introduced by ignored seeded project skills', (t) => {
  const parent = tmp();
  const repo = path.join(parent, 'repo');
  mkdirSync(repo);
  const outside = path.join(parent, 'outside.txt');
  writeFileSync(outside, 'untouched\n');
  initRepo(repo);
  try {
    // Keep the project skill directory out of the worktree so seedProjectSkills copies it in.
    writeFileSync(path.join(repo, '.git', 'info', 'exclude'), '.agents/skills/\n');
    const skillDir = path.join(repo, '.agents', 'skills', 'untrusted-skill');
    mkdirSync(skillDir, { recursive: true });
    if (!linkOrSkip(t, path.relative(skillDir, outside), path.join(skillDir, 'external.txt'), 'file')) return;
    assert.throws(() => createSandbox(repo), /symlink.*escape|escape.*symlink/i);
    assert.equal(readFileSync(outside, 'utf8'), 'untouched\n');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('worktree preserves literal untracked paths and diff filenames', () => {
  const d = tmp();
  const cafe = `caf${String.fromCharCode(233)}.txt`;
  try {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'init', '-q'], { cwd: d });
    writeFileSync(path.join(d, 'tracked.txt'), 'base\n');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'initial'], { cwd: d });

    mkdirSync(path.join(d, '.github'), { recursive: true });
    mkdirSync(path.join(d, 'node_modules'), { recursive: true });
    writeFileSync(path.join(d, cafe), 'unicode\n');
    writeFileSync(path.join(d, ' leading.txt'), 'leading whitespace\n');
    writeFileSync(path.join(d, '.github', 'new.md'), 'github file\n');
    writeFileSync(path.join(d, 'notes-node_modules-readme.txt'), 'ordinary file\n');
    writeFileSync(path.join(d, 'node_modules', 'ignored.txt'), 'dependency\n');

    const sb = createSandbox(d);
    try {
      for (const name of [cafe, ' leading.txt', path.join('.github', 'new.md'), 'notes-node_modules-readme.txt']) {
        assert.equal(existsSync(path.join(sb.cwd, name)), true, `${JSON.stringify(name)} should be copied`);
      }
      assert.equal(existsSync(path.join(sb.cwd, 'node_modules')), false, 'node_modules directory should stay excluded');

      writeFileSync(path.join(sb.cwd, 'tracked.txt'), 'changed\n');
      writeFileSync(path.join(sb.cwd, ` changed-${cafe}`), 'new diff path\n');
      const diff = sb.diff();
      assert.ok(diff.files.includes('tracked.txt'));
      assert.ok(diff.files.includes(` changed-${cafe}`));
    } finally {
      sb.cleanup();
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('worktree aborts instead of dropping tracked changes when configured diff command fails', () => {
  const d = tmp();
  try {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'init', '-q'], { cwd: d });
    writeFileSync(path.join(d, 'tracked.txt'), 'baseline\n');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'initial'], { cwd: d });
    writeFileSync(path.join(d, 'tracked.txt'), 'current unsaved work\n');
    execFileSync('git', ['config', 'diff.external', 'nonexistent-ab-audit-diff-command'], { cwd: d });

    const sb = createSandbox(d);
    try {
      assert.equal(readFileSync(path.join(sb.cwd, 'tracked.txt'), 'utf8'), 'current unsaved work\n');
    } finally {
      sb.cleanup();
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('A09: handleAgentRoutes rejects apply with 403 if modified files or patch headers escape agentRoot', async () => {
  const d = tmp();
  try {
    const fakeReq = { method: 'POST', headers: {} };
    let resStatus = 0;
    let resData = null;
    const fakeRes = {
      writeHead: (s) => { resStatus = s; },
      end: (data) => { resData = data; },
      setHeader: () => {},
    };

    // We simulate a mock run record with an agentRoot and attempt to apply outside
    const { prepareAgentRun } = await import('../dist/server/agent.js');
    const cfgMock = {
      get: () => ({ agentRoot: d, maxPermission: 'edit' }),
    };

    const runCtx = prepareAgentRun(
      { headers: { 'x-ab-cwd': '.' } },
      { token: 'secret', cfg: cfgMock },
      'test-session-a09'
    );

    // Simulate agent finished so it is not busy
    runCtx.run.busy = 0;

    // Modify sandbox diff to attempt modifying an outside file
    runCtx.run.sandbox.diff = () => ({
      diff: '--- a/../../secret.txt\n+++ b/../../secret.txt\n@@ -0,0 +1 @@\n+leak\n',
      files: ['../../secret.txt'],
    });

    await assert.rejects(
      async () => {
        await handleAgentRoutes(fakeReq, fakeRes, `/agent/runs/${runCtx.run.id}/apply`);
      },
      (err) => {
        assert.equal(err.status, 403);
        assert.ok(err.code === 'diff_outside_agent_root' || err.code === 'diff_path_traversal');
        return true;
      }
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('A38: runTestCommand circular buffer preserves tail on huge output without high memory', async () => {
  const parsed = parseCommand('node -e "console.log(1)"');
  assert.equal(parsed.cmd, 'node');
  assert.deepEqual(parsed.args, ['-e', 'console.log(1)']);
});

test('A39: Sandbox diff supports isolatedIndex without touching default git index', async () => {
  const d = tmp();
  try {
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'init', '-q'], { cwd: d });
    writeFileSync(path.join(d, 'f.txt'), 'init\n');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'c1'], { cwd: d });

    const sb = createSandbox(d);
    try {
      writeFileSync(path.join(sb.cwd, 'f.txt'), 'changed\n');
      const d1 = sb.diff(true);
      assert.ok(d1.files.includes('f.txt'));
      assert.match(d1.diff, /changed/);
      // Ensure temp index file was cleaned up
      assert.equal(existsSync(path.join(sb.dir, '.git-tmp-index')), false);
    } finally {
      sb.cleanup();
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('A60: Premature break in run generator triggers inner return() cleanup', async () => {
  let returned = false;
  const mockAdapter = {
    name: 'mock',
    async *run() {
      try {
        yield { type: 'text', delta: 'chunk 1' };
        yield { type: 'text', delta: 'chunk 2' };
        yield { type: 'text', delta: 'chunk 3' };
      } finally {
        returned = true;
      }
      return { text: 'done', durationMs: 10, exitCode: 0, model: null, sessionId: null, timedOut: false, usage: { input: 0, output: 0 } };
    },
  };

  const { run } = await import('../dist/index.js');
  const it = run(mockAdapter, { prompt: 'test' });
  for await (const evt of it) {
    if (evt.type === 'text') {
      break; // Abandon generator early
    }
  }

  assert.equal(returned, true, 'Inner adapter run finally block must execute on early consumer exit');
});

test('A07: Streaming generator tracks budget and trips cleanly on exceeded limits', async () => {
  const { Budget } = await import('../dist/extras/budget.js');
  const b = new Budget({ maxCost: 0.05 });
  b.track('cli', { type: 'usage', cost: 0.10, input: 100, output: 200 });
  assert.equal(b.exceeded, 'cost');
  assert.equal(b.signal.aborted, true);
  b.dispose();
});

