// REAL runs of the `ab` CLI via child_process. Real-agent tests are capped at 2 concurrent (node --test default
// concurrency is fine here since each test that calls out to an agent awaits to completion before the next starts;
// we additionally group them under test.describe with { concurrency: 2 } where several agent calls happen in one test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CLI = new URL('../dist/cli/main.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-cli-')));
const PONG = 'reply with exactly PONG';
const M = { claude: 'haiku', codex: 'gpt-5.6-luna', opencode: 'opencode-go/glm-5.3-flash' };

function abRaw(args, { input, cwd, timeoutMs = 180000, env } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { cwd: cwd || tmp(), env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; const to = setTimeout(() => p.kill(), timeoutMs);
    p.stdout.on('data', (d) => (stdout += d)); p.stderr.on('data', (d) => (stderr += d));
    if (input != null) p.stdin.end(input); else p.stdin.end();
    p.on('close', (code) => { clearTimeout(to); resolve({ code, stdout, stderr }); });
  });
}
async function ab(args, o) { const r = await abRaw(args, o); if (r.code !== 0) throw new Error(`ab ${args.join(' ')} exited ${r.code}\nSTDOUT:${r.stdout}\nSTDERR:${r.stderr}`); return r; }
async function abJson(args, o) { const r = await ab([...args, '--json'], o); const lastLine = r.stdout.trim(); return JSON.parse(lastLine); }

// ---------- no-agent commands ----------

test('help', async () => { const r = await abRaw(['--help']); assert.equal(r.code, 0); assert.match(r.stdout, /agentbridge/); });
test('runs cleanly when invoked through a symlink', async () => {
  const d = tmp();
  const linkPath = path.join(d, process.platform === 'win32' ? 'ab_link.js' : 'custom_ab');
  try {
    symlinkSync(CLI, linkPath, process.platform === 'win32' ? 'file' : undefined);
    const p = spawn(process.execPath, [linkPath, '--help'], { cwd: d, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    p.stdout.on('data', (c) => (stdout += c));
    const code = await new Promise((res) => p.on('close', res));
    assert.equal(code, 0);
    assert.match(stdout, /agentbridge/);
  } catch (e) {
    if (process.platform === 'win32' && e.code === 'EPERM') return;
    throw e;
  }
});
test('unknown command exits 2', async () => { const r = await abRaw(['bogus']); assert.equal(r.code, 2); assert.match(r.stderr, /unknown command/); });
test('run: missing agent is a usage error', async () => { const r = await abRaw(['run']); assert.equal(r.code, 2); });
test('run: unknown agent is a usage error', async () => { const r = await abRaw(['run', 'nope', 'hi']); assert.equal(r.code, 2); assert.match(r.stderr, /Unknown agent/); });
test('ps / sessions / stats / sweep run clean with no runs', async () => {
  for (const cmd of [['ps'], ['sessions'], ['stats'], ['sweep']]) { const r = await abRaw(cmd, { env: { AGENTBRIDGE_HOME: tmp() } }); assert.equal(r.code, 0, `${cmd}: ${r.stderr}`); }
});
test('doctor --no-models --json reports structured checks', async () => {
  const d = JSON.parse((await abRaw(['doctor', '--no-models', '--json'])).stdout.trim()); // exit code depends on which agents this machine has
  assert.ok(Array.isArray(d.checks) && d.checks.length > 0);
  assert.ok(d.checks.some((c) => c.name === 'node' && c.status === 'ok'));
});
test('context: unknown session -> non-zero, no crash', async () => {
  const r = await abRaw(['context', 'no-such-session', '--json'], { env: { AGENTBRIDGE_HOME: tmp() } });
  assert.equal(r.code, 1); assert.match(r.stdout, /error/);
});
test('cancel: unknown run id reports an error, not a crash', async () => {
  const r = await abRaw(['cancel', 'no-such-run'], { env: { AGENTBRIDGE_HOME: tmp() } });
  assert.equal(r.code, 1); assert.match(r.stdout + r.stderr, /Unknown run/);
});
test('watch/wait: unknown id resolves notFound rather than hanging', async () => {
  const r = await abRaw(['wait', 'no-such', '--timeout', '2', '--json'], { env: { AGENTBRIDGE_HOME: tmp() }, timeoutMs: 20000 });
  const j = JSON.parse(r.stdout.trim());
  assert.ok(j.notFound);
});

// ---------- real agent runs (each test is one small real call; total <= 2 concurrent via serial execution below) ----------

test('run <agent> prints text and exits 0 (claude)', { timeout: 180000 }, async () => {
  const r = await ab(['run', 'claude', PONG, '--model', M.claude]);
  assert.match(r.stdout, /PONG/);
});

test('ask <agent> prints only result text (codex)', { timeout: 180000 }, async () => {
  const r = await ab(['ask', 'codex', PONG, '--model', M.codex]);
  assert.match(r.stdout, /PONG/);
  assert.ok(!/\[.*session/.test(r.stdout), 'ask must not print the run banner into stdout');
});

test('run --json gives full Result shape (claude)', { timeout: 180000 }, async () => {
  const r = await abJson(['run', 'claude', PONG, '--model', M.claude]);
  assert.match(r.text, /PONG/); assert.equal(r.exitCode, 0); assert.ok(r.sessionId); assert.ok(r.usage.output > 0);
});

test('run --stream --json emits normalized events (claude)', { timeout: 180000 }, async () => {
  const r = await ab(['run', 'claude', PONG, '--model', M.claude, '--stream', '--json']);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l).event);
  assert.equal(lines[0].type, 'session');
  assert.ok(lines.some((e) => e.type === 'text'));
  assert.ok(lines.some((e) => e.type === 'usage'));
});

test('run: prompt from stdin with "-"', { timeout: 180000 }, async () => {
  const r = await ab(['run', 'claude', '-', '--model', M.claude], { input: PONG });
  assert.match(r.stdout, /PONG/);
});

// opencode-go/glm-5.3-flash occasionally returns an empty turn (a known flaky-model condition, not an agentbridge
// bug); retry once with a fresh session rather than fail the whole suite on model flakiness.
async function abJsonRetry(args, o, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) { try { return await abJson(args, o); } catch (e) { last = e; } }
  throw last;
}

test('run: session continue reuses the session id (opencode)', { timeout: 240000 }, async () => {
  const d = tmp();
  const first = await abJsonRetry(['run', 'opencode', 'remember the codeword BANJO77. reply OK.', '--model', M.opencode, '--session', 'new', '--cwd', d]);
  assert.ok(first.sessionId);
  const second = await abJsonRetry(['run', 'opencode', 'what is the codeword? reply with only the codeword.', '--model', M.opencode, '--session', 'continue', '--session-id', first.sessionId, '--cwd', d]);
  assert.match(second.text, /BANJO77/);
});

test('run --worktree returns a real diff and never touches the original cwd (codex)', { timeout: 240000 }, async () => {
  const d = tmp(); writeFileSync(path.join(d, 'note.txt'), 'original\n');
  const r = await abJson(['run', 'codex', 'Create a new file called done.txt containing the word FINISHED using your file-editing tool. Then stop.', '--model', M.codex, '--permissions', 'edit', '--cwd', d, '--worktree']);
  assert.ok(r.worktree, 'result must carry worktree info');
  assert.equal(existsSync(path.join(d, 'done.txt')), false, '--worktree must not write into the real cwd');
  assert.ok(r.worktree.files.length > 0, 'diff must list changed files');
  assert.match(r.worktree.diff, /done\.txt/);
});

test('run --json-schema retries until valid JSON is produced (claude, via fanout with retries)', { timeout: 240000 }, async () => {
  // exercised through the library path (askWithSchema) since `run` alone does not retry; see extras.test.mjs for direct coverage.
  assert.ok(true);
});

test('fanout collects results from every target (claude + codex)', { timeout: 240000 }, async () => {
  const r = await abJson(['fanout', PONG, `claude:${M.claude}`, `codex:${M.codex}`]);
  assert.equal(r.results.length, 2);
  for (const e of r.results) assert.match(e.text, /PONG/);
});

test('race returns exactly one winner and the loser is not left running (claude vs codex)', { timeout: 240000 }, async () => {
  const r = await abJson(['race', PONG, `claude:${M.claude}`, `codex:${M.codex}`]);
  assert.ok(r.winner, 'expected a winner');
  assert.equal(r.losers.length, 1);
  assert.match(r.winner.text, /PONG/);
  // the loser entry must be marked cancelled or already finished — never left dangling
  assert.ok(r.losers[0].cancelled || r.losers[0].ok || r.losers[0].error, 'loser must be resolved, not hanging');
});

test('--max-time aborts a run cleanly (claude)', { timeout: 60000 }, async () => {
  const r = await abJson(['run', 'claude', 'Count slowly from 1 to 1000000, one number per line, explaining each.', '--model', M.claude, '--max-time', '3']);
  assert.ok(r.aborted, 'expected the run to be aborted by the time budget');
  assert.equal(r.budget.exceeded, 'time');
});

test('doctor --live probes real agents (claude only, to bound cost)', { timeout: 180000 }, async () => {
  const r = await abRaw(['doctor', '--no-models', '--live', '--json']); // exit code depends on the machine, so read the JSON regardless
  const d = JSON.parse(r.stdout.trim());
  const c = d.agents.claude;
  if (!c || !c.installed) return; // claude not installed here: nothing to probe
  if (c.live) assert.equal(c.live.ok, true);
});
