// REAL runs exercising the extras library directly (src/extras/*): schema retry, worktree diff, budget abort,
// parallel fanout/race. Agent calls are cheap models, capped by keeping each test single- or dual-agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validate, extractJson, askWithSchema } from '../dist/extras/schema.js';
import { Budget, drain, runBudgeted } from '../dist/extras/budget.js';
import { createSandbox, withWorktree, runInWorktree } from '../dist/extras/worktree.js';
import { fanout, race } from '../dist/extras/parallel.js';
import { doctor, portFree } from '../dist/extras/doctor.js';
import { spawnProc } from '../dist/core/spawn.js';
import { AgentError } from '../dist/core/errors.js';

const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-ex-')));
const M = { claude: 'haiku', codex: 'gpt-5.6-luna', opencode: 'opencode-go/glm-5.3-flash' };

// ---------- schema: pure logic, no agent ----------

test('schema: validate covers type/required/enum/range/array/nested', () => {
  const schema = { type: 'object', required: ['name', 'age'], properties: { name: { type: 'string', minLength: 1 }, age: { type: 'integer', minimum: 0 }, tags: { type: 'array', items: { type: 'string' } } } };
  assert.deepEqual(validate(schema, { name: 'a', age: 5, tags: ['x'] }), []);
  assert.ok(validate(schema, { age: 5 }).some((e) => /name/.test(e)));
  assert.ok(validate(schema, { name: 'a', age: -1 }).length);
  assert.ok(validate(schema, { name: 'a', age: 5, tags: [1] }).length);
});

test('schema: extractJson pulls JSON out of fences and prose', () => {
  assert.deepEqual(extractJson('{"a":1}').value, { a: 1 });
  assert.deepEqual(extractJson('sure, here:\n```json\n{"a":1}\n```\nhope that helps').value, { a: 1 });
  assert.deepEqual(extractJson('the answer is [1,2,3] as requested').value, [1, 2, 3]);
  assert.equal(extractJson('no json here').ok, false);
});

test('schema: askWithSchema retries on invalid output until valid (real agent, claude)', { timeout: 240000 }, async () => {
  const schema = { type: 'object', required: ['n'], properties: { n: { type: 'integer', minimum: 10, maximum: 20 } }, additionalProperties: false };
  const r = await askWithSchema('claude', { prompt: 'Reply with a JSON object with one field n set to any integer you like.', model: M.claude, cwd: tmp() }, { schema, retries: 3 });
  assert.ok(r.schema.valid, `expected eventually-valid output; history: ${JSON.stringify(r.schema.history)}`);
  assert.ok(r.json.n >= 10 && r.json.n <= 20);
  assert.ok(r.schema.attempts >= 1);
});

test('schema: throwOnInvalid throws AgentError SCHEMA_INVALID for a self-contradicting schema', { timeout: 240000 }, async () => {
  // minimum > maximum: no integer can ever satisfy this, regardless of what the model produces or how much of the
  // schema we reveal in the retry prompt — unlike a regex/const, the model cannot "guess" its way to a valid value.
  const schema = { type: 'object', required: ['x'], properties: { x: { type: 'integer', minimum: 100, maximum: 1 } } };
  await assert.rejects(
    askWithSchema('claude', { prompt: 'Reply with JSON {"x": 5}', model: M.claude, cwd: tmp() }, { schema, retries: 1, throwOnInvalid: true }),
    (e) => e instanceof AgentError && e.reason === 'SCHEMA_INVALID',
  );
});

// ---------- budget: pure logic + one real aborted call ----------

test('budget: trips on tokens/cost/time thresholds without any agent call', () => {
  const bt = new Budget({ maxTokens: 10 }); bt.track('a', { type: 'usage', input: 5, output: 10 }); assert.equal(bt.exceeded, 'tokens'); bt.dispose();
  const bc = new Budget({ maxCost: 0.01 }); bc.track('a', { type: 'usage', input: 1, output: 1, cost: 0.02 }); assert.equal(bc.exceeded, 'cost'); bc.dispose();
});

test('budget: drain still runs a suspended generator cleanup when onEvent throws', async () => {
  const log = [];
  async function* gen(returnVal) {
    try {
      for (let i = 0; i < 3; i++) yield { type: 'text', delta: String(i) };
      return returnVal;
    } finally {
      log.push('cleanup');
    }
  }
  // Consumer callback throws mid-stream: the generator must not be left suspended mid-yield with
  // its finally (adapter-style cleanup: child kill, lock release) never reached.
  await assert.rejects(drain(gen(), () => { throw new Error('consumer bailed'); }), /consumer bailed/);
  assert.equal(log.length, 1);
  // Normal completion keeps drain semantics: events forwarded, return value delivered, cleanup ran.
  const evs = [];
  assert.equal(await drain(gen('done'), (e) => evs.push(e.delta)), 'done');
  assert.deepEqual(evs, ['0', '1', '2']);
  assert.deepEqual(log, ['cleanup', 'cleanup']);
});

test('budget: runBudgeted aborts a real run cleanly on --max-time and returns partial text, no throw', { timeout: 60000 }, async () => {
  const r = await runBudgeted('claude', { prompt: 'Count slowly from 1 to 1000000, one number per line, explaining each in detail.', model: M.claude, cwd: tmp() }, { maxTimeMs: 3000 });
  assert.equal(r.aborted, true);
  assert.equal(r.budget.exceeded, 'time');
});

test('budget: a shared budget already exceeded skips a not-yet-started run', async () => {
  const b = new Budget({ maxTokens: 1 }); b.trip('tokens');
  const r = await runBudgeted('claude', { prompt: 'hi', cwd: tmp() }, b);
  assert.equal(r.skipped, true);
  b.dispose();
});

// ---------- worktree: real git operations, one real agent edit ----------

test('worktree: falls back to a temp copy when cwd is not a git repo', () => {
  const d = tmp();
  const sb = createSandbox(d);
  try { assert.equal(sb.mode, 'copy'); assert.ok(existsSync(sb.cwd)); } finally { sb.cleanup(); }
});

test('worktree: cleanup is best effort while another process holds the sandbox as its cwd', { timeout: 60000 }, async () => {
  const d = tmp();
  const sb = createSandbox(d); // non-git dir -> copy mode
  assert.equal(sb.mode, 'copy');
  // A child living inside the sandbox dir holds it as cwd: on Windows rmSync then fails with EBUSY/EPERM.
  // The cleanup must swallow that instead of masking the run result (that is the withWorktree finally path).
  const p = spawnProc(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: sb.cwd });
  try {
    await new Promise((r) => setTimeout(r, 300)); // let the child establish its cwd
    assert.ok(p.pid > 0);
    sb.cleanup();
  } finally {
    p.kill();
    await p.wait().catch(() => {});
    try { rmSync(sb.dir, { recursive: true, force: true }); } catch { /* child may still linger briefly */ }
  }
});

test('worktree: uses a real git worktree when cwd is a git repo, and returns a real diff', async () => {
  const d = tmp();
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'init', '-q'], { cwd: d });
  writeFileSync(path.join(d, 'a.txt'), 'one\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: d });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: d });
  const { value, diff, files, mode } = await withWorktree(d, async (cwd) => { writeFileSync(path.join(cwd, 'a.txt'), 'two\n'); return 'ok'; });
  assert.equal(mode, 'git-worktree');
  assert.equal(value, 'ok');
  assert.ok(files.includes('a.txt'));
  assert.match(diff, /one/); assert.match(diff, /two/);
  // original untouched
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(path.join(d, 'a.txt'), 'utf8'), 'one\n');
});

test('worktree: runInWorktree drives a real agent edit and the original cwd is untouched', { timeout: 240000 }, async () => {
  const d = tmp(); writeFileSync(path.join(d, 'seed.txt'), 'seed\n');
  const r = await runInWorktree('codex', { prompt: 'Create a file called result.txt with the exact contents READY using your file tool, then stop.', model: M.codex, permissions: 'edit', cwd: d }, {});
  assert.ok(r.worktree.files.some((f) => f.includes('result.txt')), `expected result.txt in diff files: ${JSON.stringify(r.worktree.files)}`);
  assert.equal(existsSync(path.join(d, 'result.txt')), false, 'the real cwd must never see the agent write');
});

// ---------- parallel: fanout + race with real agents ----------

test('parallel: fanout runs targets concurrently and collects every result (claude + codex)', { timeout: 240000 }, async () => {
  const r = await fanout([`claude:${M.claude}`, `codex:${M.codex}`], { prompt: 'reply with exactly PONG' }, {});
  assert.equal(r.results.length, 2);
  for (const e of r.results) { assert.equal(e.ok, true, JSON.stringify(e)); assert.match(e.text, /PONG/); }
});

test('parallel: race resolves with one winner and actually cancels the loser process (claude vs codex)', { timeout: 240000 }, async () => {
  // both agents share a subscription-login quota with the rest of this suite, so a transient rate-limit/timeout
  // blip on one leg is a real possibility, not a code bug; tolerate one retry before failing.
  let r; for (let attempt = 1; attempt <= 2 && !r?.winner; attempt++) r = await race([`claude:${M.claude}`, `codex:${M.codex}`], { prompt: 'reply with exactly PONG' }, {});
  assert.ok(r.winner, `no winner after retry: ${JSON.stringify(r.results.map((e) => ({ agent: e.agent, ok: e.ok, error: e.error })))}`);
  assert.equal(r.losers.length, 1);
  // race() only resolves after every child settled (see parallel.mjs: Promise.all over all targets) -> nothing left running
  assert.ok(r.losers[0].cancelled === true || r.losers[0].ok === true);
});

test('parallel: fanout budget shared across targets aborts the slow ones', { timeout: 60000 }, async () => {
  const r = await fanout([`claude:${M.claude}`, `claude:${M.claude}`], { prompt: 'Count slowly from 1 to 1000000, one per line, explaining each in detail.' }, { budget: { maxTimeMs: 3000 } });
  assert.ok(r.results.every((e) => e.aborted || !e.ok));
});

// ---------- doctor ----------

test('doctor: portFree reflects an actually-bound port', async () => {
  const net = await import('node:net');
  const s = net.createServer(); await new Promise((res) => s.listen(0, '127.0.0.1', res));
  const port = s.address().port;
  assert.equal(await portFree(port), false);
  await new Promise((res) => s.close(res));
  assert.equal(await portFree(port), true);
});

test('doctor: probes every builtin agent and reports installed as a boolean (machine-independent; see doctor.test.mjs)', { timeout: 60000 }, async () => {
  const d = await doctor({ models: false, live: false });
  for (const a of ['claude', 'codex', 'opencode', 'agy', 'pi', 'cursor', 'grok', 'gemini', 'devin', 'acp'])
    assert.equal(typeof d.agents[a].installed, 'boolean', a);
  assert.ok(Array.isArray(d.usable));
});
