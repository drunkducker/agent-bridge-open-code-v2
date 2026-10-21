// Proxy features that need no real CLI: a fake adapter is injected through startProxy({ adapters }).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startProxy } from '../dist/server/index.js';
import { createLimiter, buildPrompt, incrementalPrompt, resolveModel, readParams, sessions, disposeProxyScratch } from '../dist/server/common.js';
import { ev } from '../dist/core/events.js';

const seen = [];
/** fake agent: streams `chunks`, then returns the full text; opts are recorded in `seen`. */
function fake(chunks, extra = {}) {
  return {
    name: 'fake',
    async *run(opts) {
      seen.push(opts);
      let text = '';
      for (const c of chunks) { text += c; yield ev.text(c); }
      return { text, usage: { input: 11, output: 7 }, sessionId: undefined, ...extra };
    },
  };
}

let proxy, current = fake(['Hello ', 'world']);
const adapters = { fake: { name: 'fake', run: (o) => current.run(o) } };
before(async () => { proxy = await startProxy({ port: 0, sessionsFile: false, adapters, config: { aliases: { quick: 'fake/m1' }, payload: [{ match: 'fake/*', defaults: { effort: 'low' } }] } }); });
after(() => proxy?.close());

const post = (path, body, headers = {}) => fetch(proxy.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const chat = (body, headers) => post('/v1/chat/completions', { model: 'fake/m1', messages: [{ role: 'user', content: 'hi' }], ...body }, headers);
const sse = async (res) => (await res.text()).split('\n\n').map((b) => b.replace(/^data: /, '')).filter((b) => b && b !== '[DONE]').map((b) => JSON.parse(b));

test('limiter: max tokens truncates and reports length', () => {
  const l = createLimiter({ maxTokens: 2 }); // ~8 chars
  assert.deepEqual(l.push('abcd'), { out: 'abcd', done: null });
  const x = l.push('efghijkl');
  assert.equal(x.out, 'efgh');
  assert.equal(x.done.reason, 'length');
});

test('limiter: stop sequence split across chunks', () => {
  const l = createLimiter({ stop: ['END'] });
  let out = '';
  let r = l.push('hello E'); out += r.out; assert.equal(r.done, null);
  r = l.push('ND tail'); out += r.out;
  assert.equal(out, 'hello ');
  assert.equal(r.done.reason, 'stop');
  assert.equal(r.done.stopSequence, 'END');
});

test('limiter: held tail is released on flush when nothing matches', () => {
  const l = createLimiter({ stop: ['XYZ'] });
  const a = l.push('abcXY');
  assert.equal(a.out, 'abc');
  assert.equal(l.flush().out, 'XY');
});

test('buildPrompt: budget drops the oldest turns, keeps the last', () => {
  const turns = [{ role: 'user', text: 'a'.repeat(400) }, { role: 'assistant', text: 'b'.repeat(400) }, { role: 'user', text: 'last question' }];
  const p = buildPrompt(turns, 150);
  assert.match(p, /earlier message/);
  assert.ok(!p.includes('a'.repeat(50)));
  assert.match(p, /last question/);
});

test('incrementalPrompt: only what follows the last assistant turn', () => {
  const t = [{ role: 'user', text: 'one' }, { role: 'assistant', text: 'two' }, { role: 'user', text: 'three' }];
  assert.equal(incrementalPrompt(t), 'three');
});

test('resolveModel: agent/ prefix and effort suffix', () => {
  const r = resolveModel('agent/claude/sonnet(high)');
  assert.equal(r.mode, 'agent'); assert.equal(r.agent, 'claude'); assert.equal(r.model, 'sonnet'); assert.equal(r.effort, 'high');
  assert.equal(resolveModel('claude/haiku').mode, 'api');
  assert.equal(resolveModel('claude/haiku(8192)').effort, 'medium');
  assert.throws(() => resolveModel('claude/haiku(bogus)'), /Invalid effort suffix/);
});

test('readParams: honoured vs ignored', () => {
  const p = readParams({ max_tokens: 5, stop: ['x'], temperature: 0.2, top_p: 1, seed: 3, logprobs: false });
  assert.equal(p.maxTokens, 5); assert.deepEqual(p.stop, ['x']); assert.deepEqual(p.ignored, ['temperature', 'top_p', 'seed']);
});

test('chat: plain completion with adapter usage; sampling params are ignored but reported', async () => {
  current = fake(['Hello ', 'world']);
  const res = await chat({ temperature: 0.7, top_p: 0.9 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-agentbridge-ignored'), 'temperature,top_p');
  const j = await res.json();
  assert.equal(j.choices[0].message.content, 'Hello world');
  assert.equal(j.choices[0].finish_reason, 'stop');
  assert.deepEqual(j.usage, { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
});

test('chat: max_tokens cuts the output and finish_reason is length', async () => {
  current = fake(['0123456789', '0123456789', '0123456789']);
  const j = await (await chat({ max_tokens: 3 })).json(); // ~12 chars
  assert.equal(j.choices[0].message.content.length, 12);
  assert.equal(j.choices[0].finish_reason, 'length');
});

test('chat: stop sequence cuts the output (streaming)', async () => {
  current = fake(['one two ', 'th', 'ree four']);
  const chunks = await sse(await chat({ stream: true, stop: ['three'] }));
  const text = chunks.map((c) => c.choices[0]?.delta?.content || '').join('');
  assert.equal(text, 'one two ');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'stop');
});

test('anthropic: stop_reason max_tokens / stop_sequence / end_turn from the adapter', async () => {
  current = fake(['abcdefghijklmnop'], { stopReason: 'max_tokens' });
  const m = (extra) => post('/v1/messages', { model: 'fake/m1', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }], ...extra });
  let j = await (await m({})).json();
  assert.equal(j.stop_reason, 'max_tokens');
  current = fake(['alpha STOP beta']);
  j = await (await m({ stop_sequences: ['STOP'] })).json();
  assert.equal(j.stop_reason, 'stop_sequence'); assert.equal(j.stop_sequence, 'STOP'); assert.equal(j.content[0].text, 'alpha ');
  current = fake(['ok']);
  j = await (await m({ max_tokens: 100 })).json();
  assert.equal(j.stop_reason, 'end_turn');
});

test('anthropic: malformed messages are rejected as 400s, not 502s', async () => {
  const m = (body) => post('/v1/messages', { model: 'fake/m1', max_tokens: 10, ...body });
  // thinking-only content renders to no turns; previously a TypeError on turns[-1] surfaced as 502 agent_failed
  let r = await m({ messages: [{ role: 'user', content: [{ type: 'thinking' }] }] });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.type, 'invalid_request_error');
  r = await m({ messages: [{ role: 'user', content: [] }] });
  assert.equal(r.status, 400);
  r = await m({ messages: [null] });
  assert.equal(r.status, 400);
  r = await m({ messages: [42] });
  assert.equal(r.status, 400);
  // the same prep guards back /v1/messages/count_tokens
  r = await post('/v1/messages/count_tokens', { model: 'fake/m1', messages: [{ role: 'user', content: [{ type: 'thinking' }] }] });
  assert.equal(r.status, 400);
});

test('chat: malformed messages are rejected as 400s, not 502s', async () => {
  const m = (body) => post('/v1/chat/completions', { model: 'fake/m1', ...body });
  // null/42 entries previously TypeError'd on m.role inside chatTurns, surfacing as 502 agent_failed
  let r = await m({ messages: [{ role: 'user', content: 'hi' }, null] });
  assert.equal(r.status, 400);
  let j = await r.json();
  assert.equal(j.error.type, 'invalid_request_error');
  assert.equal(j.error.code, 'invalid_messages');
  r = await m({ messages: [42] });
  assert.equal(r.status, 400);
  r = await m({ messages: [null] });
  assert.equal(r.status, 400);
  r = await m({ messages: [] });
  assert.equal(r.status, 400); // still reaches the existing empty-messages guard
});

test('config aliases and payload defaults reach the adapter', async () => {
  current = fake(['x']); seen.length = 0;
  await chat({ model: 'quick' });
  assert.equal(seen.at(-1).model, 'm1');
  assert.equal(seen.at(-1).effort, 'low'); // payload default for fake/*
  await chat({ model: 'fake/m1(high)' });
  assert.equal(seen.at(-1).effort, 'high'); // the suffix beats the default
  await chat({ reasoning_effort: 'medium' });
  assert.equal(seen.at(-1).effort, 'medium');
});

test('session header continues the same session id, sending only the new turns', async () => {
  current = { name: 'fake', async *run(opts) { seen.push(opts); return { text: 'ok', usage: { input: 1, output: 1 }, sessionId: 'sess-1' }; } };
  seen.length = 0;
  const msgs = [{ role: 'user', content: 'first' }];
  await chat({ messages: msgs }, { 'x-ab-session': 'abc' });
  assert.equal(seen[0].session.mode, 'new');
  await chat({ messages: [...msgs, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'second' }] }, { 'x-ab-session': 'abc' });
  assert.equal(seen[1].session.mode, 'continue'); assert.equal(seen[1].session.id, 'sess-1');
  assert.equal(seen[1].prompt, 'second');
  await chat({ messages: msgs });
  assert.equal(seen[2].session.mode, 'ephemeral');
});

test('fallback chain: text held back from a failed attempt is dropped, not sent to the client', async () => {
  const flaky = { name: 'fake', async *run() { yield ev.text('partial from the failed agent '); yield ev.fallback('fake', 'codex', 'RATE_LIMITED', 'usage limit'); yield ev.text('clean answer'); return { text: 'clean answer', usage: { input: 1, output: 1 } }; } };
  const p2 = await startProxy({ port: 0, adapters: { fake: flaky }, fallback: ['codex'] });
  try {
    const r = await fetch(p2.url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake/m1', messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal((await r.json()).choices[0].message.content, 'clean answer');
  } finally { await p2.close(); }
});

// ---------- agent mode ----------
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('host header is validated against DNS rebinding', async () => {
  const withHost = (host) => new Promise((ok, bad) => {
    const rq = http.request({ host: '127.0.0.1', port: proxy.port, path: '/', headers: { host } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => ok({ status: res.statusCode, body: b }));
    });
    rq.on('error', bad);
    rq.end();
  });
  const evil = await withHost('evil.example.com');
  assert.equal(evil.status, 403);
  assert.match(evil.body, /bad host/);
  assert.equal((await withHost(`127.0.0.1:${proxy.port + 1}`)).status, 403, 'wrong port');
  assert.equal((await withHost(`[::1]:${proxy.port}`)).status, 200, 'IPv6 loopback host passes');
  assert.equal((await fetch(proxy.url + '/')).status, 200, 'the default 127.0.0.1:<port> host passes');
});

const writer = { name: 'fake', async *run(opts) {
  seen.push(opts);
  writeFileSync(path.join(opts.cwd, 'hello.txt'), 'made by the agent\n');
  yield ev.text('done');
  return { text: 'done', usage: { input: 1, output: 1 } };
} };

async function agentProxy(extra = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'ab-agent-root-'));
  mkdirSync(path.join(root, 'proj')); writeFileSync(path.join(root, 'proj', 'a.txt'), 'original\n');
  const p = await startProxy({ port: 0, adapters: { fake: writer }, token: 'tok', agentRoot: root, ...extra });
  const call = (url, body, headers = {}, method = 'POST') => fetch(p.url + url, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer tok', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { p, root, call, done: async () => { await p.close(); rmSync(root, { recursive: true, force: true }); } };
}
const agentBody = { model: 'agent/fake/m1', messages: [{ role: 'user', content: 'create hello.txt' }] };

test('agent mode is refused without --agent-root or without a token', async () => {
  let r = await post('/v1/chat/completions', agentBody);
  assert.equal(r.status, 403); assert.equal((await r.json()).error.code, 'agent_mode_disabled');
  const root = mkdtempSync(path.join(tmpdir(), 'ab-agent-root-'));
  const p = await startProxy({ port: 0, adapters, agentRoot: root });
  try {
    r = await fetch(p.url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(agentBody) });
    assert.equal(r.status, 403); assert.equal((await r.json()).error.code, 'agent_mode_needs_token');
  } finally { await p.close(); rmSync(root, { recursive: true, force: true }); }
});

test('agent mode: the agent edits a sandbox, the diff comes back, the real folder changes only on apply', async () => {
  const t = await agentProxy();
  try {
    const r = await t.call('/v1/chat/completions', agentBody, { 'x-ab-cwd': 'proj' });
    assert.equal(r.status, 200);
    const j = await r.json();
    const runId = r.headers.get('x-agentbridge-run');
    assert.equal(j.choices[0].message.content, 'done');
    assert.equal(j.agentbridge.runId, runId);
    assert.deepEqual(j.agentbridge.filesChanged, ['hello.txt']);
    assert.match(j.agentbridge.diff, /made by the agent/);
    assert.equal(existsSync(path.join(t.root, 'proj', 'hello.txt')), false); // untouched so far
    assert.notEqual(seen.at(-1).cwd, path.join(t.root, 'proj'));
    assert.equal(seen.at(-1).permissions, 'edit');
    const d = await (await t.call(`/agent/runs/${runId}/diff`, null, {}, 'GET')).text();
    assert.match(d, /hello\.txt/);
    const a = await (await t.call(`/agent/runs/${runId}/apply`)).json();
    assert.equal(a.applied, true);
    assert.equal(readFileSync(path.join(t.root, 'proj', 'hello.txt'), 'utf8').replace(/\r\n/g, '\n'), 'made by the agent\n'); // git may write CRLF on Windows
    const del = await t.call(`/agent/runs/${runId}`, null, {}, 'DELETE');
    assert.equal(del.status, 200);
    assert.equal((await t.call(`/agent/runs/${runId}`, null, {}, 'GET')).status, 404);
  } finally { await t.done(); }
});

test('agent mode: /agent/v1 base path, streaming extra chunk, anthropic header', async () => {
  const t = await agentProxy();
  try {
    const r = await t.call('/agent/v1/chat/completions', { model: 'fake/m1', stream: true, messages: [{ role: 'user', content: 'go' }] });
    const chunks = await sse(r);
    assert.ok(chunks.some((c) => c.agentbridge?.filesChanged?.includes('hello.txt')));
    assert.ok(r.headers.get('x-agentbridge-run'));
    const m = await t.call('/agent/v1/messages', { model: 'fake/m1', max_tokens: 10, messages: [{ role: 'user', content: 'go' }] });
    assert.equal(m.status, 200); assert.ok(m.headers.get('x-agentbridge-run'));
  } finally { await t.done(); }
});

test('agent mode: cwd must stay inside the root; permissions cannot exceed the ceiling', async () => {
  const t = await agentProxy({ maxPermission: 'edit' });
  try {
    let r = await t.call('/v1/chat/completions', agentBody, { 'x-ab-cwd': '..' });
    assert.equal(r.status, 403); assert.equal((await r.json()).error.code, 'cwd_outside_agent_root');
    r = await t.call('/v1/chat/completions', agentBody, { 'x-ab-cwd': path.dirname(t.root) });
    assert.equal(r.status, 403);
    r = await t.call('/v1/chat/completions', agentBody, { 'x-ab-permissions': 'full' });
    assert.equal(r.status, 403); assert.equal((await r.json()).error.code, 'permissions_exceed_ceiling');
    r = await t.call('/v1/chat/completions', agentBody, { 'x-ab-permissions': 'read-only' });
    assert.equal(r.status, 200); assert.equal(seen.at(-1).permissions, 'read-only');
  } finally { await t.done(); }
});

test('agent mode: the same x-ab-session keeps working in one sandbox', async () => {
  const t = await agentProxy();
  try {
    const a = await t.call('/v1/chat/completions', agentBody, { 'x-ab-session': 's1' });
    const b = await t.call('/v1/chat/completions', agentBody, { 'x-ab-session': 's1' });
    assert.equal(a.headers.get('x-agentbridge-run'), b.headers.get('x-agentbridge-run'));
    const c = await t.call('/v1/chat/completions', agentBody, { 'x-ab-session': 's2' });
    assert.notEqual(c.headers.get('x-agentbridge-run'), a.headers.get('x-agentbridge-run'));
  } finally { await t.done(); }
});

// ---------- leak guards ----------
test('sessions registry is capped at 500 entries, evicting the oldest', () => {
  const prior = [...sessions.entries()];
  try {
    for (let i = 0; i < 502; i++) sessions.set(`cap:${i}`, { agent: 'fake', id: String(i) });
    assert.ok(sessions.size <= 500, `expected size <= 500, got ${sessions.size}`);
    assert.equal(sessions.has('cap:0'), false); // oldest evicted
    assert.equal(sessions.has('cap:501'), true); // newest kept
    assert.equal(sessions.has('cap:2'), true); // only the oldest ones were dropped
  } finally {
    sessions.clear();
    for (const [k, v] of prior) sessions.set(k, v);
  }
});

test('disposeProxyScratch removes the proxy scratch dir and stays safe on a second call', async () => {
  current = { name: 'fake', async *run(opts) { seen.push(opts); return { text: 'ok', usage: { input: 1, output: 1 } }; } };
  await chat({ messages: [{ role: 'user', content: 'hi' }] }); // creates the process-wide scratch dir when missing
  const dir = seen.at(-1).cwd; // API-mode runs receive the shared scratch dir as opts.cwd
  assert.match(path.basename(dir), /^agentbridge-proxy-/);
  assert.ok(existsSync(dir), 'the API-mode run used a real scratch dir');
  disposeProxyScratch();
  assert.equal(existsSync(dir), false, 'scratch dir removed on dispose');
  disposeProxyScratch(); // second call is a no-op and must not throw
});
