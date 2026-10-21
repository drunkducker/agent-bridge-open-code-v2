// Proxy session persistence, TTL/cap eviction, safe transcript deletion, `ab sessions prune` and SSE backpressure.
// Offline: a fake adapter (named "claude" so the claude-specific paths apply) is injected through startProxy({ adapters }).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProxy } from '../dist/server/index.js';
import { sessions } from '../dist/server/common.js';
import { ev } from '../dist/core/events.js';
import { parseDuration, transcriptFiles, removeTranscript, readSessionsFile } from '../dist/server/sessions.js';

const root = mkdtempSync(path.join(tmpdir(), 'ab-sess-test-'));
const AB = path.join(root, 'home'), CLAUDE = path.join(root, 'claude'), CODEX = path.join(root, 'codex');
const saved = { h: process.env.AGENTBRIDGE_HOME, c: process.env.CLAUDE_CONFIG_DIR, x: process.env.CODEX_HOME };
process.env.AGENTBRIDGE_HOME = AB; process.env.CLAUDE_CONFIG_DIR = CLAUDE; process.env.CODEX_HOME = CODEX;
const FILE = path.join(AB, 'proxy-sessions.json');
const slug = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const transcript = (cwd, id) => path.join(CLAUDE, 'projects', slug(realpathSync(cwd)), `${id}.jsonl`);
const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));

const seen = [];
let chunks = ['hi'];
let produced = 0;
const fake = {
  name: 'claude',
  async *run(opts) {
    seen.push(opts);
    const id = opts.session?.mode === 'continue' ? opts.session.id : randomUUID();
    if (opts.session?.mode !== 'ephemeral') {
      const f = transcript(opts.cwd, id);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, '{}\n');
    }
    yield ev.session ? ev.session(id) : { type: 'session', id };
    let text = '';
    for (const c of chunks) { produced++; text += c; yield ev.text(c); }
    return { text, usage: { input: 1, output: 1 }, sessionId: id };
  },
};
const adapters = { fake: { name: 'claude', run: (o) => fake.run(o) } };
const start = (o = {}) => startProxy({ port: 0, adapters, ...o });
const chat = (p, key, body = {}, auth = 'Bearer k1') =>
  fetch(p.url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth, ...(key ? { 'x-ab-session': key } : {}) }, body: JSON.stringify({ model: 'fake/m', messages: [{ role: 'user', content: 'hello' }], ...body }) });
const fileJson = () => JSON.parse(readFileSync(FILE, 'utf8'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reset = () => { sessions.clear(); seen.length = 0; rmSync(FILE, { force: true }); rmSync(path.join(CLAUDE, 'projects'), { recursive: true, force: true }); };
before(() => mkdirSync(AB, { recursive: true }));
after(() => {
  for (const [k, v] of [['AGENTBRIDGE_HOME', saved.h], ['CLAUDE_CONFIG_DIR', saved.c], ['CODEX_HOME', saved.x]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
  rmSync(root, { recursive: true, force: true });
});

test('parseDuration', () => {
  assert.equal(parseDuration('7d'), 7 * 864e5);
  assert.equal(parseDuration('12h'), 12 * 36e5);
  assert.equal(parseDuration('0'), 0);
  assert.throws(() => parseDuration('soon'));
});

test('keyed session persists across restart, uses the stable cwd, exposes the id header', async () => {
  reset();
  let p = await start();
  const r1 = await chat(p, 'a');
  const sid = r1.headers.get('x-agentbridge-session');
  assert.match(sid, /^[0-9a-f-]{36}$/);
  assert.equal(realpathSync(seen[0].cwd), realpathSync(path.join(AB, 'proxy-cwd')));
  assert.equal(seen[0].session.mode, 'new');
  await p.close();
  const f = fileJson();
  const [[key, ent]] = Object.entries(f.sessions);
  assert.equal(ent.sessionId, sid);
  assert.equal(ent.agent, 'claude');
  assert.ok(ent.created && ent.lastUsed && ent.cwd);
  assert.ok(!JSON.stringify(f).includes('k1'), 'no raw credential stored');
  sessions.clear(); // simulate a fresh process
  p = await start();
  const r2 = await chat(p, 'a');
  assert.equal(seen.at(-1).session.mode, 'continue');
  assert.equal(seen.at(-1).session.id, sid);
  assert.equal(r2.headers.get('x-agentbridge-session'), sid);
  const r3 = await chat(p, undefined);
  assert.equal(r3.headers.get('x-agentbridge-session'), null);
  assert.equal(seen.at(-1).session.mode, 'ephemeral');
  assert.notEqual(realpathSync(seen.at(-1).cwd), realpathSync(path.join(AB, 'proxy-cwd')));
  await p.close();
});

test('corrupt or missing sessions file is tolerated', async () => {
  reset();
  writeFileSync(FILE, '{not json');
  const p = await start();
  assert.equal((await chat(p, 'z')).status, 200);
  await p.close();
  assert.equal(Object.keys(fileJson().sessions).length, 1);
});

test('TTL expiry on load deletes only the expired transcript; ttl 0 keeps everything', async () => {
  reset();
  const cwd = path.join(AB, 'proxy-cwd'); mkdirSync(cwd, { recursive: true });
  const old = randomUUID(), fresh = randomUUID();
  for (const id of [old, fresh]) { mkdirSync(path.dirname(transcript(cwd, id)), { recursive: true }); writeFileSync(transcript(cwd, id), '{}\n'); }
  const now = Date.now();
  writeFileSync(FILE, JSON.stringify({ version: 1, sessions: {
    'claude:u:old': { agent: 'claude', sessionId: old, cwd, created: now - 9e8, lastUsed: now - 8e8 },
    'claude:u:fresh': { agent: 'claude', sessionId: fresh, cwd, created: now - 9e8, lastUsed: now - 1000 },
  } }));
  let p = await start({ sessionTtlMs: 3_600_000 });
  assert.ok(!existsSync(transcript(cwd, old)));
  assert.ok(existsSync(transcript(cwd, fresh)));
  await p.close();
  assert.deepEqual(Object.keys(fileJson().sessions), ['claude:u:fresh']);
  // ttl 0 = forever
  sessions.clear();
  writeFileSync(FILE, JSON.stringify({ version: 1, sessions: { 'claude:u:old': { agent: 'claude', sessionId: old, cwd, created: 1, lastUsed: 2 } } }));
  p = await start({ sessionTtlMs: 0 });
  await p.close();
  assert.deepEqual(Object.keys(fileJson().sessions), ['claude:u:old']);
});

test('cap eviction removes the oldest keyed session and its transcript', async () => {
  reset();
  const p = await start({ sessionCap: 2 });
  const ids = [];
  for (const k of ['k1', 'k2', 'k3']) { ids.push((await chat(p, k)).headers.get('x-agentbridge-session')); await wait(5); }
  const cwd = path.join(AB, 'proxy-cwd');
  assert.ok(!existsSync(transcript(cwd, ids[0])), 'oldest transcript deleted');
  assert.ok(existsSync(transcript(cwd, ids[1])) && existsSync(transcript(cwd, ids[2])));
  assert.equal(sessions.size, 2);
  await p.close();
  assert.equal(Object.keys(fileJson().sessions).length, 2);
});

test('transcript deletion is exact and confined to the expected roots', () => {
  reset();
  const cwd = path.join(root, 'work'); mkdirSync(cwd, { recursive: true });
  const id = randomUUID(), other = randomUUID();
  const f = transcript(cwd, id), g = transcript(cwd, other);
  mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, 'x'); writeFileSync(g, 'x');
  // hostile / malformed entries resolve to nothing
  assert.deepEqual(transcriptFiles({ agent: 'claude', id: '../../etc/passwd', cwd }), []);
  assert.deepEqual(transcriptFiles({ agent: 'claude', id, cwd: undefined }), []);
  assert.deepEqual(transcriptFiles({ agent: 'opencode', id, cwd }), []);
  assert.deepEqual(removeTranscript({ agent: 'claude', id, cwd }, true), [f]); // dry run
  assert.ok(existsSync(f));
  assert.deepEqual(removeTranscript({ agent: 'claude', id, cwd }), [f]);
  assert.ok(!existsSync(f) && existsSync(g));
  // codex: only the file whose name ends with the exact uuid, symlinks ignored
  const dir = path.join(CODEX, 'sessions', '2026', '01', '02'); mkdirSync(dir, { recursive: true });
  const cx = path.join(dir, `rollout-2026-01-02T00-00-00-${id}.jsonl`), decoy = path.join(dir, `rollout-2026-01-02T00-00-00-${other}.jsonl`);
  const outside = path.join(root, 'outside.jsonl'); writeFileSync(outside, 'keep');
  writeFileSync(cx, 'x'); writeFileSync(decoy, 'x');
  symlinkSync(outside, path.join(dir, `rollout-link-${id}.jsonl`));
  assert.deepEqual(removeTranscript({ agent: 'codex', id }), [cx]);
  assert.ok(!existsSync(cx) && existsSync(decoy) && existsSync(outside));
});

test('ab sessions prune: --dry-run lists, real run deletes (entries + leftover scratch dirs)', () => {
  reset();
  const cwd = path.join(AB, 'proxy-cwd'); mkdirSync(cwd, { recursive: true });
  const id = randomUUID(), keep = randomUUID(), now = Date.now();
  for (const x of [id, keep]) { mkdirSync(path.dirname(transcript(cwd, x)), { recursive: true }); writeFileSync(transcript(cwd, x), '{}\n'); }
  writeFileSync(FILE, JSON.stringify({ version: 1, sessions: {
    'claude:u:a': { agent: 'claude', sessionId: id, cwd, created: now - 9e9, lastUsed: now - 9e9 },
    'claude:u:b': { agent: 'claude', sessionId: keep, cwd, created: now, lastUsed: now },
  } }));
  const proj = path.join(CLAUDE, 'projects');
  const leftover = path.join(proj, slug(path.join(realpathSync(tmpdir()), 'agentbridge-proxy-')) + 'AbC123');
  const decoy = path.join(proj, '-home-someone-agentbridge-proxy-AbC123');
  for (const d of [leftover, decoy]) { mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, 'x.jsonl'), '{}'); const t = new Date(now - 9e9); utimesSync(path.join(d, 'x.jsonl'), t, t); utimesSync(d, t, t); }
  const env = { ...process.env };
  const run = (...a) => spawnSync(process.execPath, [cli, 'sessions', 'prune', '--proxy', '--older-than', '7d', ...a], { env, encoding: 'utf8' });
  const dry = run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /\[dry-run\] 1 session entries \(1 transcripts\), 1 leftover project dirs; 1 entries kept/);
  assert.ok(existsSync(transcript(cwd, id)) && existsSync(leftover));
  assert.equal(Object.keys(fileJson().sessions).length, 2);
  const real = run();
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /removed transcript/);
  assert.ok(!existsSync(transcript(cwd, id)) && !existsSync(leftover));
  assert.ok(existsSync(transcript(cwd, keep)) && existsSync(decoy));
  assert.deepEqual(readSessionsFile(FILE).map(([k]) => k), ['claude:u:b']);
  assert.equal(spawnSync(process.execPath, [cli, 'sessions', '--json'], { env, encoding: 'utf8' }).status, 0); // plain `ab sessions` still works
});

test('SSE backpressure: a paused client stalls the producer instead of buffering unboundedly', { timeout: 60000 }, async () => {
  reset();
  const N = 400, big = 'x'.repeat(64 * 1024);
  chunks = Array.from({ length: N }, () => big);
  produced = 0;
  const p = await start();
  const u = new URL(p.url);
  const got = await new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k1', 'x-ab-session': 'bp' } }, (res) => {
      res.pause();
      setTimeout(() => {
        const atPause = produced;
        let bytes = 0;
        res.on('data', (c) => { bytes += c.length; });
        res.on('end', () => resolve({ atPause, bytes }));
        res.resume();
      }, 1500);
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'fake/m', stream: true, messages: [{ role: 'user', content: 'go' }] }));
  });
  assert.ok(got.atPause < N, `producer ran to completion (${got.atPause}/${N}) despite a paused client`);
  assert.equal(produced, N);
  assert.ok(got.bytes >= N * big.length, 'all data delivered after the client resumed');
  chunks = ['hi'];
  await p.close();
});
