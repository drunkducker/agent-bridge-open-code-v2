// Protocol/auth regressions with a private executable; no provider calls or local credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import oc from '../dist/adapters/opencode.js';

const collect = async (it) => {
  const events = [];
  for (;;) {
    const next = await it.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
};

function mockOpenCode({ exitCode = 0 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-oc-v2-'));
  const calls = path.join(dir, 'calls.jsonl');
  const script = path.join(dir, 'mock-opencode.cjs');
  writeFileSync(script, `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') {
  console.log('opencode v2.1.4');
  process.exit(0);
}
if (args[0] !== 'run') process.exit(44);
if (${exitCode}) {
  console.error('simulated provider failure');
  process.exit(${exitCode});
}
const prompt = args.at(-1);
const sid = args.includes('--fork') ? 'ses_forked' : 'ses_test';
console.log(JSON.stringify({ type: 'step_start', sessionID: sid, part: { type: 'step-start' } }));
console.log(JSON.stringify({ type: 'text', sessionID: sid, part: { type: 'text', text: 'OK: ' + prompt } }));
console.log(JSON.stringify({ type: 'tool_use', sessionID: sid, part: { type: 'tool', tool: 'read', state: { input: { filePath: 'README.md' }, output: 'done' } } }));
console.log(JSON.stringify({ type: 'step_finish', sessionID: sid, part: { type: 'step-finish', cost: 0, tokens: { input: 5, output: 2, reasoning: 1, cache: { read: 3, write: 4 } } } }));
`);
  if (process.platform === 'win32') {
    writeFileSync(path.join(dir, 'opencode.cmd'), `@"${process.execPath}" "%~dp0mock-opencode.cjs" %*\r\n`);
  } else {
    const executable = path.join(dir, 'opencode');
    writeFileSync(executable, `#!${process.execPath}\nrequire(${JSON.stringify(script)});\n`);
    chmodSync(executable, 0o755);
  }
  return { dir, calls };
}

test('OpenCode v2 CLI streams nested events and returns a complete result', async () => {
  const mock = mockOpenCode();
  try {
    const { events, result } = await collect(oc.run({
      prompt: 'reply once',
      model: 'openrouter/free-model',
      cwd: mock.dir,
      permissions: 'edit',
      timeoutMs: 5000,
      env: { PATH: mock.dir, OPENCODE_DATA_DIR: mock.dir },
    }));
    assert.deepEqual(events.map((event) => event.type), ['session', 'text', 'tool', 'usage']);
    assert.equal(events[1].delta, 'OK: reply once');
    assert.equal(events[2].name, 'read');
    assert.deepEqual(events[2].input, { filePath: 'README.md' });
    assert.equal(result.text, 'OK: reply once');
    assert.equal(result.sessionId, 'ses_test');
    assert.deepEqual(result.usage, { input: 12, output: 3, cost: 0 });
    assert.equal(result.exitCode, 0);
    const calls = readFileSync(mock.calls, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(calls[0], ['--version']);
    assert.deepEqual(calls[1], [
      'run', '--standalone', '--format', 'json', '--auto', '--model', 'openrouter/free-model', 'reply once',
    ]);
  } finally {
    rmSync(mock.dir, { recursive: true, force: true });
  }
});

for (const mode of ['continue', 'fork']) {
  test(`OpenCode v2 CLI supports ${mode} sessions`, async () => {
    const mock = mockOpenCode();
    try {
      const { result } = await collect(oc.run({
        prompt: 'next',
        model: 'openrouter/free-model',
        cwd: mock.dir,
        permissions: 'read-only',
        session: { mode, id: 'ses_parent' },
        timeoutMs: 5000,
        env: { PATH: mock.dir, OPENCODE_DATA_DIR: mock.dir },
      }));
      const calls = readFileSync(mock.calls, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
      assert.ok(calls[1].includes('--session'));
      assert.ok(calls[1].includes('ses_parent'));
      assert.equal(calls[1].includes('--fork'), mode === 'fork');
      assert.equal(result.sessionId, mode === 'fork' ? 'ses_forked' : 'ses_test');
    } finally {
      rmSync(mock.dir, { recursive: true, force: true });
    }
  });
}

test('OpenCode v2 CLI reports non-zero exits', async () => {
  const mock = mockOpenCode({ exitCode: 7 });
  try {
    const it = oc.run({
      prompt: 'fail', model: 'openrouter/free-model', cwd: mock.dir, permissions: 'read-only', timeoutMs: 5000,
      env: { PATH: mock.dir, OPENCODE_DATA_DIR: mock.dir },
    });
    await assert.rejects(collect(it), (error) => {
      assert.equal(error.code, 'AGENT_FAILED');
      assert.equal(error.exitCode, 7);
      assert.match(error.message, /simulated provider failure/);
      return true;
    });
  } finally {
    rmSync(mock.dir, { recursive: true, force: true });
  }
});
