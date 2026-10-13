import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rpc, init, MCP } from './_rpc.mjs';
import { runAsSubagent } from '../dist/bridge/subagent.js';

const T = { timeout: 300000 };
const tmp = (name = 'ab-br-') => realpathSync(mkdtempSync(path.join(tmpdir(), name)));
const text = (r) => r.result.content[0].text;

test('stdout guard: stray console.log / stdout writes cannot corrupt the protocol', { timeout: 30000 }, async () => {
  const pre = path.join(tmp(), 'stray.mjs');
  writeFileSync(pre, "setTimeout(()=>{console.log('STRAY-LOG');process.stdout.write('STRAY-RAW\\n');},300);");
  const c = rpc({}, { nodeArgs: ['--import', pathToFileURL(pre).href] });
  try {
    await init(c);
    await new Promise((r) => setTimeout(r, 800));
    const l = await c.call('tools/list', {});
    assert.ok(l.result.tools.length);
    assert.deepEqual(c.bad, [], 'stdout must contain only JSON-RPC lines');
  } finally { c.close(); }
});

test('large payload (3MB) + unicode + malformed line + batch', { timeout: 30000 }, async () => {
  const c = rpc({ AGENTBRIDGE_PERMS: 'read-only' });
  try {
    await init(c);
    const big = 'x'.repeat(3 * 1024 * 1024) + 'ção✓';
    const t0 = Date.now();
    const r = await c.tool('ask_claude', { prompt: big, permissions: 'full' });
    assert.equal(r.result.isError, true);
    assert.equal(r.result.structuredContent.error.code, 'BAD_OPTION');
    assert.match(r.result.structuredContent.error.message, /configured permission ceiling "read-only"/);
    assert.ok(Date.now() - t0 < 5000, 'parsing 3MB must be fast');
    c.proc.stdin.write('{not json\n');
    assert.ok(await c.call('ping', {}));
    assert.deepEqual(c.bad, []);
  } finally { c.close(); }
});

test('server runs from a path with spaces (Windows)', { timeout: 30000 }, async () => {
  const d = path.join(tmp(), 'dir with spaces');
  cpSync(fileURLToPath(new URL('../dist', import.meta.url)), path.join(d, 'dist'), { recursive: true });
  const c = rpc({}, { script: path.join(d, 'dist', 'bridge', 'mcp.js') });
  try { await init(c); assert.ok((await c.call('tools/list', {})).result.tools.length >= 10); } finally { c.close(); }
});

test('REAL: cwd with spaces + default cheap model + progress notifications + meta', T, async () => {
  const cwd = path.join(tmp(), 'my project dir'); cpSync(tmp(), cwd, { recursive: true }); // ensure exists
  const c = rpc();
  try {
    await init(c);
    const r = await c.tool('ask_claude', { prompt: 'reply with exactly PONG', cwd }, { _meta: { progressToken: 'p1' } });
    assert.ok(!r.result.isError, text(r)); assert.match(text(r), /PONG/);
    const s = r.result.structuredContent;
    assert.match(s.model, /haiku/); assert.ok(s.sessionId); assert.equal(s.depth, 1); assert.ok(s.usage.output > 0);
    assert.match(r.result.content[1].text, /^\[agentbridge\] /);
    const prog = c.notes.filter((n) => n.method === 'notifications/progress' && n.params.progressToken === 'p1');
    assert.ok(prog.length >= 1, 'progress notifications streamed');
  } finally { c.close(); }
});

test('REAL: concurrent calls (2 asks + ping while in flight)', T, async () => {
  const c = rpc();
  try {
    await init(c);
    const a = c.tool('ask_claude', { prompt: 'reply with exactly ALPHA' });
    const b = c.tool('ask_claude', { prompt: 'reply with exactly BRAVO' });
    const t0 = Date.now(); await c.call('ping', {}); assert.ok(Date.now() - t0 < 2000, 'server stays responsive');
    const [ra, rb] = await Promise.all([a, b]);
    assert.match(text(ra), /ALPHA/); assert.match(text(rb), /BRAVO/);
    assert.notEqual(ra.result.structuredContent.sessionId, rb.result.structuredContent.sessionId);
  } finally { c.close(); }
});

test('REAL: notifications/cancelled aborts the in-flight run promptly', T, async () => {
  const c = rpc();
  try {
    await init(c);
    const call = c.start('tools/call', { name: 'ask_claude', arguments: { prompt: 'Write a 3000 word essay about the history of the bicycle.' } });
    await new Promise((r) => setTimeout(r, 3000));
    const t0 = Date.now(); c.notify('notifications/cancelled', { requestId: call.id });
    const r = await call.promise;
    assert.ok(Date.now() - t0 < 8000, 'cancel latency'); assert.equal(r.result.isError, true); assert.match(text({ result: r.result }), /ABORTED|Abort/i);
  } finally { c.close(); }
});

test('REAL: per-call default timeout is applied (timeoutSeconds)', T, async () => {
  const c = rpc();
  try {
    await init(c);
    const r = await c.tool('ask_claude', { prompt: 'Write a 3000 word essay about trains.', timeoutSeconds: 3 });
    assert.equal(r.result.isError, true); assert.match(text(r), /TIMEOUT|timed out/i);
  } finally { c.close(); }
});

test('REAL: async dispatch/wait/check/list/cancel + idempotency + persisted registry', T, async () => {
  const home = tmp('ab-home-');
  const c = rpc({ AGENTBRIDGE_HOME: home });
  try {
    await init(c);
    const d1 = await c.tool('dispatch_claude', { prompt: 'reply with exactly PONG', idempotencyKey: 'k1' });
    const id = d1.result.structuredContent.runId; assert.ok(id); assert.equal(d1.result.structuredContent.deduped, false);
    const d2 = await c.tool('dispatch_claude', { prompt: 'reply with exactly PONG', idempotencyKey: 'k1' });
    assert.equal(d2.result.structuredContent.runId, id); assert.equal(d2.result.structuredContent.deduped, true);
    const ck = await c.tool('check_run', { id }); assert.ok(['running', 'done'].includes(ck.result.structuredContent.state));
    const w = await c.tool('wait_run', { id, timeoutSeconds: 120 });
    assert.equal(w.result.structuredContent.state, 'done'); assert.match(text(w), /PONG/);
    const file = path.join(home, 'runs', `${id}.json`); assert.ok(existsSync(file));
    const rec = JSON.parse(readFileSync(file, 'utf8'));
    for (const k of ['pid', 'agent', 'model', 'cwd', 'state', 'startedAt', 'lastEventAt', 'usage', 'sessionId']) assert.ok(k in rec, k);
    assert.equal(rec.agent, 'claude'); assert.ok(rec.usage.output > 0); assert.ok(rec.sessionId);
    const l = await c.tool('list_runs', {}); assert.ok(l.result.structuredContent.runs.some((r) => r.id === id));
    // cancel
    const d3 = await c.tool('dispatch_claude', { prompt: 'Write a 3000 word essay about the history of the bicycle.' });
    const id3 = d3.result.structuredContent.runId;
    await new Promise((r) => setTimeout(r, 2500));
    const t0 = Date.now(); const cx = await c.tool('cancel_run', { id: id3 });
    assert.equal(cx.result.structuredContent.state, 'cancelled'); assert.ok(Date.now() - t0 < 5000);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(JSON.parse(readFileSync(path.join(home, 'runs', `${id3}.json`), 'utf8')).state, 'cancelled');
  } finally { c.close(); }
});

// 3-level chain: caller(depth0) -> L1(bridge depth1) -> L2(bridge depth2 => guard must fire). Proves the depth env reaches the MCP child.
for (const caller of ['claude', 'codex']) {
  test(`REAL: 3-level chain via ${caller} hits recursion guard`, T, async () => {
    const lvl = (p) => `Use your ask_${caller} tool once with this prompt: "${p}". Reply with exactly the text (or error) it returns.`;
    const task = lvl(lvl(lvl("hi")));
    const r = await runAsSubagent({ caller, callee: caller, task, model: caller === 'claude' ? 'haiku' : 'gpt-5.6-luna', cwd: tmp(), timeoutMs: 280000, maxDepth: 2, calleeModel: caller === 'claude' ? 'haiku' : 'gpt-5.6-luna' });
    console.log(`[chain ${caller}] text=${JSON.stringify(r.text.slice(0, 200))}`);
    assert.match(r.text, /Recursion guard|AGENTBRIDGE_DEPTH/i);
  });
}

// ---------------- round 3 ----------------
import { readdirSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ESSAY = 'Write a 3000 word essay about the history of the bicycle.';
const runFile = (home, id) => path.join(home, 'runs', `${id}.json`);
const rec = (home, id) => JSON.parse(readFileSync(runFile(home, id), 'utf8'));

test('JSON-RPC batch returns an ARRAY of responses', { timeout: 30000 }, async () => {
  const c = rpc();
  try {
    await init(c);
    const got = new Promise((res) => { const iv = setInterval(() => { const a = c.notes.find((n) => Array.isArray(n)); if (a) { clearInterval(iv); res(a); } }, 20); });
    c.write([{ jsonrpc: '2.0', id: 901, method: 'ping' }, { jsonrpc: '2.0', id: 902, method: 'tools/list' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
    const arr = await got;
    assert.ok(Array.isArray(arr) && arr.length === 2); assert.deepEqual(arr.map((x) => x.id).sort(), [901, 902]);
  } finally { c.close(); }
});

test('messages inbox + retain/release + GC + stale-run sweep persisted as lost', { timeout: 30000 }, async () => {
  const home = tmp('ab-home-'); const runs = path.join(home, 'runs'); const { mkdirSync } = await import('node:fs'); mkdirSync(runs, { recursive: true });
  const mk = (id, o) => writeFileSync(runFile(home, id), JSON.stringify({ id, agent: 'claude', pid: 999999, state: 'done', startedAt: Date.now() - o.age, endedAt: Date.now() - o.age, events: [], ...o }));
  mk('old1', { age: 30 * 864e5 }); mk('old2keep', { age: 30 * 864e5 }); writeFileSync(path.join(runs, 'old2keep.keep'), ''); mk('fresh1', { age: 1000 }); mk('zombie', { age: 1000, state: 'running', endedAt: null });
  const c = rpc({ AGENTBRIDGE_HOME: home });
  try {
    await init(c); await sleep(2500); // startup sweep is deferred ~1.5s so it never delays initialize/tools/list
    assert.ok(!existsSync(runFile(home, 'old1')), 'old run GC-ed'); assert.ok(existsSync(runFile(home, 'old2keep')), 'retained run kept'); assert.ok(existsSync(runFile(home, 'fresh1')));
    assert.equal(rec(home, 'zombie').state, 'lost', 'stale running run persisted as lost');
    const r1 = await c.tool('retain_run', { id: 'fresh1' }); assert.equal(r1.result.structuredContent.keep, true); assert.ok(existsSync(path.join(runs, 'fresh1.keep')), 'keep marker file');
    const r2 = await c.tool('release_run', { id: 'fresh1' }); assert.equal(r2.result.structuredContent.keep, false);
    await c.tool('send_message', { to: 'fresh1', from: 'tester', text: 'hello' });
    const m = await c.tool('check_messages', { for: 'fresh1' }); assert.equal(m.result.structuredContent.messages.length, 1); assert.equal(m.result.structuredContent.messages[0].text, 'hello');
    assert.equal((await c.tool('check_messages', { for: 'fresh1' })).result.structuredContent.messages.length, 0, 'marked read');
  } finally { c.close(); }
});

test('REAL: cross-process registry (owner A, B checks/waits/cancels) + stdin-close kills dispatched runs', T, async () => {
  const home = tmp('ab-home-');
  const A = rpc({ AGENTBRIDGE_HOME: home }), B = rpc({ AGENTBRIDGE_HOME: home });
  try {
    await init(A); await init(B);
    const d = await A.tool('dispatch_claude', { prompt: ESSAY });
    const id = d.result.structuredContent.runId; await sleep(2500);
    const ck = await B.tool('check_run', { id }); assert.equal(ck.result.structuredContent.state, 'running'); assert.equal(ck.result.structuredContent.ownerPid, A.proc.pid);
    const waiter = B.tool('wait_run', { id, timeoutSeconds: 60 });
    const t0 = Date.now(); const cx = await B.tool('cancel_run', { id });
    const w = await waiter;
    assert.equal(w.result.structuredContent.state, 'cancelled'); assert.ok(Date.now() - t0 < 10000, 'cross-process cancel latency');
    // stdin close of the owner kills its running runs
    const d2 = await A.tool('dispatch_claude', { prompt: ESSAY }); const id2 = d2.result.structuredContent.runId; await sleep(2500);
    const exited = new Promise((r) => A.proc.on('exit', r));
    A.proc.stdin.end();
    await Promise.race([exited, sleep(15000).then(() => { throw new Error('bridge did not exit after stdin close'); })]);
    assert.notEqual(rec(home, id2).state, 'running', 'dispatched run not left running after bridge exit');
  } finally { A.close(); B.close(); }
});

test('REAL: idempotency is atomic across processes and bound to the prompt', T, async () => {
  const home = tmp('ab-home-');
  const A = rpc({ AGENTBRIDGE_HOME: home }), B = rpc({ AGENTBRIDGE_HOME: home });
  try {
    await init(A); await init(B);
    const [x, y] = await Promise.all([A.tool('dispatch_claude', { prompt: 'reply with exactly PONG', idempotencyKey: 'kk' }), B.tool('dispatch_claude', { prompt: 'reply with exactly PONG', idempotencyKey: 'kk' })]);
    assert.equal(x.result.structuredContent.runId, y.result.structuredContent.runId, 'same run across processes');
    assert.deepEqual([x.result.structuredContent.deduped, y.result.structuredContent.deduped].sort(), [false, true]);
    const z = await B.tool('dispatch_claude', { prompt: 'a different prompt', idempotencyKey: 'kk' });
    assert.equal(z.result.isError, true); assert.match(text(z), /different prompt/);
    assert.equal(readdirSync(path.join(home, 'runs')).filter((n) => n.endsWith('.json')).length, 1, 'exactly one run created');
    const w = await A.tool('wait_run', { id: x.result.structuredContent.runId, timeoutSeconds: 120 }); assert.match(text(w), /PONG/);
  } finally { A.close(); B.close(); }
});

// mixed 3-level chain: codex -> claude -> codex -> (claude: guard)
test('REAL: mixed 3-level chain codex->claude->codex->claude hits recursion guard', T, async () => {
  const ask = (agent, p) => `Use your ask_${agent} tool once with this prompt: "${p}". Reply with exactly the text (or error) it returns.`;
  const task = ask('claude', ask('codex', ask('claude', 'hi')));
  const r = await runAsSubagent({ caller: 'codex', callee: 'claude', task, model: 'gpt-5.6-luna', calleeModel: 'haiku', cwd: tmp(), timeoutMs: 290000, maxDepth: 2 });
  console.log(`[mixed chain] ${JSON.stringify(r.text.slice(0, 200))}`);
  assert.match(r.text, /Recursion guard/i);
});
