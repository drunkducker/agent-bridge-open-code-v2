import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve('acceptance/..');
const fixture = String.raw`import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const name = process.env.FAKE_HARNESS
writeFileSync(process.env.FAKE_ARGS, JSON.stringify(args))
const line = (x) => process.stdout.write(JSON.stringify(x) + '\n')
if (name === 'cursor') {
  line({ type: 'system', subtype: 'init', session_id: 'cur-1' })
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello cursor' }] }, session_id: 'cur-1' })
  line({ type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: 'x' } } }, session_id: 'cur-1' })
  line({ type: 'result', subtype: 'success', result: 'hello cursor', session_id: 'cur-1' })
} else if (name === 'gemini') {
  line({ type: 'init', session_id: 'gem-1', model: 'g' })
  line({ type: 'error', severity: 'warning', message: 'recoverable notice' })
  line({ type: 'message', role: 'assistant', content: 'hello gemini', delta: true })
  line({ type: 'tool_use', tool_name: 'read_file', parameters: { path: 'x' } })
  line({ type: 'result', status: 'success', stats: { input_tokens: 7, output_tokens: 3 } })
} else if (name === 'gemini-error') {
  line({ type: 'result', status: 'error', error: { message: 'terminal gemini failure' }, stats: { input_tokens: 2, output_tokens: 0 } })
} else if (name === 'cursor-error') {
  line({ type: 'result', subtype: 'error', is_error: true, result: 'terminal cursor failure', session_id: 'cur-e' })
} else if (name === 'devin') {
  process.stdout.write('hello devin\n')
} else if (name === 'partial-fail') {
  process.stdout.write('partial output\n')
  process.stderr.write('failed after partial output\n')
  process.exit(7)
}
`;

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-harness-'));
  const script = path.join(dir, 'fake.mjs');
  writeFileSync(script, fixture);
  const env = { ...process.env, FAKE_ARGS: path.join(dir, 'args.json') };
  for (const name of ['cursor-agent', 'gemini', 'devin']) {
    if (process.platform === 'win32') writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0fake.mjs" %*\r\n`);
    else {
      const bin = path.join(dir, name);
      writeFileSync(bin, `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`);
      chmodSync(bin, 0o755);
    }
  }
  env.PATH = dir + path.delimiter + env.PATH;
  return { dir, env };
}

async function run(adapter, opts) {
  const events = [];
  const it = adapter.run(opts);
  for (;;) {
    const x = await it.next();
    if (x.done) return { events, result: x.value };
    events.push(x.value);
  }
}

test('Cursor uses cursor-agent stream-json and maps assistant, tool, and session events', async () => {
  const { dir, env } = setup();
  try {
    env.FAKE_HARNESS = 'cursor';
    const { default: adapter } = await import('../dist/adapters/cursor.js');
    const { events, result } = await run(adapter, { prompt: 'do it', cwd: dir, env, permissions: 'full' });
    assert.deepEqual(JSON.parse(readFileSync(env.FAKE_ARGS, 'utf8')), ['--print', '--output-format', 'stream-json', '--force', '--workspace', dir, '--', 'do it']);
    assert.equal(result.text, 'hello cursor');
    assert.equal(result.sessionId, 'cur-1');
    assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.delta), ['hello cursor']);
    assert.deepEqual(events.find((e) => e.type === 'tool'), { type: 'tool', name: 'readToolCall', input: { path: 'x' } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Gemini uses stream-json and decodes native JSONL event fields', async () => {
  const { dir, env } = setup();
  try {
    env.FAKE_HARNESS = 'gemini';
    const { default: adapter } = await import('../dist/adapters/gemini.js');
    const { events, result } = await run(adapter, { prompt: 'do it', cwd: dir, env, permissions: 'full' });
    assert.deepEqual(JSON.parse(readFileSync(env.FAKE_ARGS, 'utf8')), ['--output-format', 'stream-json', '--yolo', '-p', 'do it']);
    assert.equal(result.text, 'hello gemini');
    assert.equal(result.sessionId, 'gem-1');
    assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.delta), ['hello gemini']);
    assert.deepEqual(events.find((e) => e.type === 'tool'), { type: 'tool', name: 'read_file', input: { path: 'x' } });
    assert.deepEqual(result.usage, { input: 7, output: 3, cost: null });
    assert.ok(events.some((e) => e.type === 'error' && e.message === 'recoverable notice'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Gemini explicitly selects default approval for non-full runs', async () => {
  const { dir, env } = setup();
  try {
    env.FAKE_HARNESS = 'gemini';
    const { default: adapter } = await import('../dist/adapters/gemini.js');
    await run(adapter, { prompt: 'inspect only', cwd: dir, env, permissions: 'read-only' });
    assert.deepEqual(JSON.parse(readFileSync(env.FAKE_ARGS, 'utf8')), ['--output-format', 'stream-json', '--approval-mode', 'default', '-p', '[READ-ONLY MODE: Do NOT edit files or run modifying commands]\n\ninspect only']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Devin uses native print mode, text output, and explicit permission mode', async () => {
  const { dir, env } = setup();
  try {
    env.FAKE_HARNESS = 'devin';
    const { default: adapter } = await import('../dist/adapters/devin.js');
    const { result } = await run(adapter, { prompt: 'do it', cwd: dir, env, permissions: 'full' });
    assert.deepEqual(JSON.parse(readFileSync(env.FAKE_ARGS, 'utf8')), ['--permission-mode', 'dangerous', '-p', '--', 'do it']);
    assert.equal(result.text, 'hello devin');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('provider terminal error events fail even when the CLI exits zero', async () => {
  const { dir, env } = setup();
  try {
    const { default: gemini } = await import('../dist/adapters/gemini.js');
    env.FAKE_HARNESS = 'gemini-error';
    await assert.rejects(run(gemini, { prompt: 'x', env }), (e) => e.code === 'AGENT_FAILED' && /terminal gemini failure/.test(e.message));
    const { default: cursor } = await import('../dist/adapters/cursor.js');
    env.FAKE_HARNESS = 'cursor-error';
    await assert.rejects(run(cursor, { prompt: 'x', env }), (e) => e.code === 'AGENT_FAILED' && /terminal cursor failure/.test(e.message));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unsupported system prompts fail before spawning', async () => {
  const { dir, env } = setup();
  try {
    const { default: cursor } = await import('../dist/adapters/cursor.js');
    await assert.rejects(run(cursor, { prompt: 'x', env, systemPrompt: 'sys' }), (e) => e.code === 'BAD_OPTION');
    assert.equal(existsSync(env.FAKE_ARGS), false);
    const { default: gemini } = await import('../dist/adapters/gemini.js');
    await assert.rejects(run(gemini, { prompt: 'x', env, systemPrompt: 'sys' }), (e) => e.code === 'BAD_OPTION');
    const { default: devin } = await import('../dist/adapters/devin.js');
    await assert.rejects(run(devin, { prompt: 'x', env, systemPrompt: 'sys' }), (e) => e.code === 'BAD_OPTION');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('nonzero exit after partial output remains an agent failure with partial text', async () => {
  const { dir, env } = setup();
  try {
    env.FAKE_HARNESS = 'partial-fail';
    const { default: adapter } = await import('../dist/adapters/devin.js');
    await assert.rejects(run(adapter, { prompt: 'x', env }), (e) => e.code === 'AGENT_FAILED' && e.partial === 'partial output' && e.exitCode === 7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
