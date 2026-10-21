// Resource bounds: retention pruning, LRU caps, daemon pool eviction, input line caps, non-blocking dashboard stats.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, utimesSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

const { sweep, pruneStores } = await import('../dist/bridge/runs.js');
const { LruMap } = await import('../dist/core/lru.js');
const { DaemonPool } = await import('../dist/adapters/codex-daemon.js');
const { sse } = await import('../dist/adapters/endpoint.js');
const { serve } = await import('../dist/bridge/mcp.js');
const { startUi } = await import('../dist/ui/server.js');

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const DAY = 864e5;
const age = (f, days) => {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(f, t, t);
};
function fill(dir, n, ext, ageDays = 0, tag = 'f') {
  mkdirSync(dir, { recursive: true });
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = path.join(dir, `${tag}${String(i).padStart(4, '0')}.${ext}`);
    writeFileSync(f, '{}');
    if (ageDays) age(f, ageDays);
    out.push(f);
  }
  return out;
}

test('retention: age and count pruning per category, sweep keeps {total, removed}', () => {
  const home = tmp('ab-ret-');
  const env = { ...process.env, AGENTBRIDGE_HOME: home, AGENTBRIDGE_SESSION_MAX_COUNT: '5', AGENTBRIDGE_ENDPOINT_SESSION_MAX_COUNT: '3' };
  fill(path.join(home, 'telemetry', 'sessions'), 4, 'json', 40, 'old'); // too old
  fill(path.join(home, 'telemetry', 'sessions'), 8, 'json').forEach((f, i) => age(f, i / 100)); // 8 fresh -> keep 5
  const ep = path.join(home, 'endpoint-sessions');
  fill(ep, 6, 'json');
  const ib = path.join(home, 'inbox', 'agent-a');
  fill(ib, 2, 'read', 2, 'stale'); // stale read
  fill(ib, 2, 'read'); // fresh read
  fill(ib, 1, 'msg', 5); // unread messages are never pruned
  const r = sweep(env);
  assert.equal(typeof r.total, 'number');
  assert.equal(typeof r.removed, 'number');
  assert.equal(readdirSync(path.join(home, 'telemetry', 'sessions')).length, 5);
  assert.equal(r.sessions.removed, 4 + 3);
  assert.equal(readdirSync(ep).length, 3);
  assert.equal(r.endpointSessions.removed, 3);
  assert.deepEqual(readdirSync(ib).filter((n) => n.endsWith('.read')).length, 2);
  assert.ok(readdirSync(ib).some((n) => n.endsWith('.msg')));
  assert.equal(r.inbox.removed, 2);
  const again = pruneStores(env);
  assert.equal(again.sessions.removed + again.endpointSessions.removed + again.inbox.removed, 0);
  // age env override
  const env2 = { ...env, AGENTBRIDGE_INBOX_READ_MAX_AGE_MS: '1' };
  await_sleep(20);
  assert.equal(pruneStores(env2).inbox.removed, 2);
  rmSync(home, { recursive: true, force: true });
});
function await_sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

test('LruMap caps size and evicts least recently used', () => {
  const m = new LruMap(3);
  m.set('a', 1).set('b', 2).set('c', 3);
  m.get('a');
  m.set('d', 4);
  assert.deepEqual([...m.keys()], ['c', 'a', 'd']);
  assert.equal(m.has('b'), false);
  assert.equal(m.size, 3);
});

test('DaemonPool: LRU cap evicts idle daemons and close() drops the entry', () => {
  const pool = new DaemonPool(2);
  const dirs = [tmp('ab-d1-'), tmp('ab-d2-'), tmp('ab-d3-')];
  const d1 = pool.get(dirs[0]);
  const d2 = pool.get(dirs[1]);
  assert.equal(pool.get(dirs[0]), d1); // refresh d1 -> d2 is now LRU
  pool.get(dirs[2]);
  assert.equal(pool.size, 2);
  assert.notEqual(pool.get(dirs[1]), d2, 'LRU daemon was evicted');
  assert.equal(pool.size, 2);
  const d3 = pool.get(dirs[2]);
  d3.close();
  assert.equal(pool.size, 1);
  // busy daemons are never evicted
  const p2 = new DaemonPool(1);
  const a = p2.get(dirs[0]);
  a.pendingTurns = 1;
  p2.get(dirs[1]);
  assert.equal(p2.size, 2);
  p2.shutdownAll();
  assert.equal(p2.size, 0);
  pool.shutdownAll();
});

test('MCP stdio: oversized line without newline fails with an error and recovers', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.setEncoding('utf8');
  output.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean).map((l) => JSON.parse(l))));
  const home = tmp('ab-mcp-');
  serve({ input, output, env: { ...process.env, AGENTBRIDGE_HOME: home, AGENTBRIDGE_MCP_MAX_LINE_BYTES: '1000' } });
  input.write('x'.repeat(600));
  input.write('x'.repeat(600)); // exceeds cap with no newline
  input.write('x'.repeat(50) + '\n'); // tail of the dropped line
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(lines.some((l) => l.error && /exceeds 1000 bytes/.test(l.error.message)), JSON.stringify(lines));
  assert.ok(lines.some((l) => l.id === 7), 'next well-formed request still handled');
  input.end();
  rmSync(home, { recursive: true, force: true });
});

test('SSE reader: oversized event without newline throws instead of growing', async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: ' + 'x'.repeat(500)));
      c.enqueue(new TextEncoder().encode('y'.repeat(500)));
      c.close();
    },
  });
  await assert.rejects(async () => {
    for await (const _ of sse({ body }, 800)) void _;
  }, /exceeds 800 bytes/);
  const ok = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: hi\n\ndata: there\n'));
      c.close();
    },
  });
  const got = [];
  for await (const d of sse({ body: ok }, 800)) got.push(d);
  assert.deepEqual(got, ['hi', 'there']);
});

test('/api/stats keeps the event loop responsive with a slow opencode and caches the response', { timeout: 60000 }, async () => {
  if (process.platform === 'win32') return;
  const home = tmp('ab-ui-slow-');
  const bin = tmp('ab-fakebin-');
  const fake = path.join(bin, 'opencode');
  writeFileSync(
    fake,
    `#!/bin/sh\nsleep 2\necho '{"messages":[{"info":{"role":"assistant","modelID":"m","providerID":"p","tokens":{"input":100,"output":5,"cache":{"read":0,"write":0}}}}]}'\n`
  );
  chmodSync(fake, 0o755);
  const sdir = path.join(home, 'telemetry', 'sessions');
  mkdirSync(sdir, { recursive: true });
  for (let i = 0; i < 9; i++) {
    writeFileSync(
      path.join(sdir, `opencode__s${i}.json`),
      JSON.stringify({ agent: 'opencode', sessionId: `s${i}`, model: 'p/m', cwd: home, lastAt: Date.now(), runCount: 1, toolCalls: 0, runningMs: 1, ctx: { tokens: 1, exact: false, source: 'x' }, runIds: [], files: [] })
    );
  }
  const env = { ...process.env, AGENTBRIDGE_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const ui = await startUi({ port: 0, env });
  let maxGap = 0,
    last = Date.now();
  const iv = setInterval(() => {
    const n = Date.now();
    maxGap = Math.max(maxGap, n - last);
    last = n;
  }, 25);
  try {
    const t0 = Date.now();
    const [a, b] = await Promise.all([fetch(`${ui.url}/api/stats`).then((r) => r.json()), fetch(`${ui.url}/api/stats`).then((r) => r.json())]);
    assert.equal(a.sessions.length, 9);
    assert.equal(a.generatedAt, b.generatedAt, 'concurrent requests share one computation');
    assert.ok(Date.now() - t0 < 5000);
    assert.ok(maxGap < 200, `event loop stalled for ${maxGap}ms`);
    const c = await fetch(`${ui.url}/api/stats`).then((r) => r.json());
    assert.equal(c.generatedAt, a.generatedAt, 'cached within TTL');
  } finally {
    clearInterval(iv);
    await ui.close();
    rmSync(home, { recursive: true, force: true });
  }
});
