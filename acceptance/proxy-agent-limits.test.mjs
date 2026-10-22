// Agent mode limits: sandbox cap (429), per-session single flight, non-blocking creation, orphan cleanup. Offline (fake adapter).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Private temp dir: every sandbox of this file lives here, so the cleanup tests never look at the real /tmp.
const T = realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-limits-test-')));
process.env.TMPDIR = T;
process.env.TEMP = T;
process.env.TMP = T;

const { startProxy } = await import('../dist/server/index.js');
const { createAgentStore, sweep } = await import('../dist/server/agent.js');
const { createSandboxAsync, cleanupStaleSandboxes, SANDBOX_MARKER } = await import('../dist/extras/worktree.js');
const { ev } = await import('../dist/core/events.js');

after(() => rmSync(T, { recursive: true, force: true }));

let delayMs = 0;
const writer = {
  name: 'fake',
  async *run(opts) {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    writeFileSync(path.join(opts.cwd, `out-${Math.random().toString(36).slice(2)}.txt`), 'made by the agent\n');
    yield ev.text('done');
    return { text: 'done', usage: { input: 1, output: 1 } };
  },
};

async function agentProxy(extra = {}, files = 1) {
  const root = mkdtempSync(path.join(T, 'root-'));
  mkdirSync(path.join(root, 'proj'));
  for (let i = 0; i < files; i++) writeFileSync(path.join(root, 'proj', `f${i}.txt`), `original ${i}\n`);
  const p = await startProxy({ port: 0, adapters: { fake: writer }, token: 'tok', agentRoot: root, ...extra });
  const call = (url, body, headers = {}, method = 'POST') =>
    fetch(p.url + url, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer tok', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { p, root, call, done: async () => { await p.close(); } };
}
const body = { model: 'agent/fake/m1', messages: [{ role: 'user', content: 'go' }] };
const chat = (t, headers) => t.call('/v1/chat/completions', body, headers);

test('cap: full proxy answers 429 agent_runs_limit with retry-after; DELETE and apply free slots; session reuse is not new', async () => {
  const t = await agentProxy({ agentMaxRuns: 2 });
  try {
    const a = await chat(t, { 'x-ab-session': 'sa' });
    const b = await chat(t);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const idA = a.headers.get('x-agentbridge-run'), idB = b.headers.get('x-agentbridge-run');

    const full = await chat(t);
    assert.equal(full.status, 429);
    assert.ok(Number(full.headers.get('retry-after')) > 0, 'retry-after header');
    assert.equal((await full.json()).error.code, 'agent_runs_limit');
    assert.equal(((await (await t.call('/agent/runs', null, {}, 'GET')).json()).runs).length, 2, 'rejected request created nothing');

    // an existing x-ab-session run is reused even when the cap is reached
    const again = await chat(t, { 'x-ab-session': 'sa' });
    assert.equal(again.status, 200); assert.equal(again.headers.get('x-agentbridge-run'), idA);

    // runs with an unapplied diff are never evicted
    assert.equal((await chat(t)).status, 429);

    // DELETE frees a slot
    assert.equal((await t.call(`/agent/runs/${idB}`, null, {}, 'DELETE')).status, 200);
    const c = await chat(t);
    assert.equal(c.status, 200);
    const idC = c.headers.get('x-agentbridge-run');
    assert.equal((await chat(t)).status, 429);

    // apply frees a slot too
    const ap = await t.call(`/agent/runs/${idC}/apply`);
    assert.equal(ap.status, 200); assert.equal((await ap.json()).applied, true);
    assert.equal((await chat(t)).status, 200);
  } finally { await t.done(); }
});

test('cap 0 means unlimited', async () => {
  const t = await agentProxy({ agentMaxRuns: 0 });
  try {
    for (let i = 0; i < 4; i++) assert.equal((await chat(t)).status, 200);
  } finally { await t.done(); }
});

test('same x-ab-session requests in flight share one sandbox', async () => {
  const t = await agentProxy({ agentMaxRuns: 3 });
  delayMs = 100;
  try {
    const rs = await Promise.all([1, 2, 3, 4].map(() => chat(t, { 'x-ab-session': 'same' })));
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(new Set(rs.map((r) => r.headers.get('x-agentbridge-run'))).size, 1);
    const runs = (await (await t.call('/agent/runs', null, {}, 'GET')).json()).runs;
    assert.equal(runs.length, 1);
    assert.equal(readdirSync(T).filter((n) => n.startsWith('ab-wt-')).length >= 1, true);
  } finally { delayMs = 0; await t.done(); }
});

test('the event loop stays responsive while a large non-git folder is copied', async () => {
  const t = await agentProxy({ agentMaxRuns: 0 }, 3000);
  try {
    let last = Date.now(), maxGap = 0;
    const timer = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 10);
    const r = await chat(t);
    clearInterval(timer);
    assert.equal(r.status, 200);
    assert.ok(maxGap < 400, `event loop stalled for ${maxGap} ms`);
  } finally { await t.done(); }
});

test('applied runs are dropped sooner than the TTL, only when idle', () => {
  const store = createAgentStore();
  const mk = (id, extra) => store.runs.set(id, { id, sandbox: { cleanup() {}, cleanupAsync: async () => {}, mode: 'copy' }, origin: '/x', created: Date.now(), last: Date.now(), applied: true, ...extra });
  mk('fresh', { appliedAt: Date.now() });
  mk('old', { appliedAt: Date.now() - 5 * 60_000, last: Date.now() - 5 * 60_000 });
  mk('busy', { appliedAt: Date.now() - 5 * 60_000, last: Date.now() - 5 * 60_000, busy: 1 });
  mk('unapplied', { applied: false, last: Date.now() - 5 * 60_000 });
  sweep(store, 30 * 60_000);
  assert.deepEqual([...store.runs.keys()].sort(), ['busy', 'fresh', 'unapplied']);
});

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;
function fakeSandbox(name, marker, { raw } = {}) {
  const d = path.join(T, name);
  mkdirSync(d);
  writeFileSync(path.join(d, 'keep.txt'), 'x');
  if (marker) writeFileSync(path.join(d, SANDBOX_MARKER), raw ?? JSON.stringify({ v: 1, origin: '/nowhere', mode: 'copy', created: Date.now() - 3 * 3600_000, ...marker }));
  return d;
}

test('stale cleanup removes only marked, old, dead-pid ab-wt-* dirs directly in tmpdir', async () => {
  const dead = deadPid();
  const gone = fakeSandbox('ab-wt-AAAAAA', { pid: dead });
  const alive = fakeSandbox('ab-wt-BBBBBB', { pid: process.ppid || 1 }); // a live process
  const unmarked = fakeSandbox('ab-wt-CCCCCC', null);
  const recent = fakeSandbox('ab-wt-DDDDDD', { pid: dead, created: Date.now() });
  const otherName = fakeSandbox('xx-wt-EEEEEE', { pid: dead });
  const badJson = fakeSandbox('ab-wt-GGGGGG', { pid: dead }, { raw: '{nope' });
  const longName = fakeSandbox('ab-wt-HHHHHHH', { pid: dead });
  const self = fakeSandbox('ab-wt-IIIIII', { pid: process.pid });
  const outside = mkdtempSync(path.join(T, 'outside-'));
  writeFileSync(path.join(outside, SANDBOX_MARKER), JSON.stringify({ v: 1, pid: dead, origin: '/x', mode: 'copy', created: 1 }));
  writeFileSync(path.join(outside, 'precious.txt'), 'x');
  symlinkSync(outside, path.join(T, 'ab-wt-FFFFFF'), 'dir');

  const removed = await cleanupStaleSandboxes({ ttlMs: 30 * 60_000 });
  assert.deepEqual(removed, [gone]);
  assert.equal(existsSync(gone), false);
  for (const d of [alive, unmarked, recent, otherName, badJson, longName, self, outside, path.join(outside, 'precious.txt')]) assert.ok(existsSync(d), `${d} must survive`);
  assert.ok(existsSync(path.join(T, 'ab-wt-FFFFFF')));
});

test('stale cleanup prunes the worktree registration in the origin repo', { skip: process.platform === 'win32' && 'POSIX path and pid assumptions' }, async () => {
  const repo = mkdtempSync(path.join(T, 'repo-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
  g('init', '-q'); writeFileSync(path.join(repo, 'a.txt'), 'a\n'); g('add', '-A'); g('commit', '-q', '-m', 'init');
  const sb = await createSandboxAsync(repo);
  assert.equal(sb.mode, 'git-worktree');
  assert.match(g('worktree', 'list'), /ab-wt-/);
  // simulate a SIGKILLed proxy: marker of a dead pid, old
  writeFileSync(path.join(sb.dir, SANDBOX_MARKER), JSON.stringify({ v: 1, pid: deadPid(), origin: realpathSync(repo), mode: 'git-worktree', created: Date.now() - 3 * 3600_000 }));
  const removed = await cleanupStaleSandboxes({ ttlMs: 30 * 60_000 });
  assert.ok(removed.includes(sb.dir));
  assert.equal(existsSync(sb.dir), false);
  assert.doesNotMatch(g('worktree', 'list'), /ab-wt-/);
});

test('x-ab-sandbox: none edits the real folder in place, with no run record', async () => {
  const { p, root, call, done } = await agentProxy();
  try {
    const r = await call('/v1/chat/completions', { model: 'agent/fake/m1', messages: [{ role: 'user', content: 'go' }] }, { 'x-ab-cwd': 'proj', 'x-ab-sandbox': 'none' });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-agentbridge-sandbox'), 'none');
    assert.ok(readdirSync(path.join(root, 'proj')).some((f) => f.startsWith('out-')), 'file written in the real folder');
    const runs = await (await call('/agent/runs', null, {}, 'GET')).json();
    assert.equal(runs.runs.length, 0);
    const bad = await call('/v1/chat/completions', { model: 'agent/fake/m1', messages: [{ role: 'user', content: 'go' }] }, { 'x-ab-cwd': 'proj', 'x-ab-sandbox': 'x' });
    assert.equal(bad.status, 400);
  } finally {
    await done();
  }
});
