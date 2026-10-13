import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agents } from '../dist/index.js';

const fakeGrok = String.raw`const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_GROK_ARGS, JSON.stringify(args));
if (args.includes('--json')) {
  process.stderr.write("error: unexpected argument '--json' found\n");
  process.exit(2);
}
process.stdout.write([
  { type: 'text', data: 'hello' },
  { type: 'thought', data: 'internal thought' },
  { type: 'end', stopReason: 'EndTurn', sessionId: 'session-fixture', requestId: 'request-fixture' },
].map((event) => JSON.stringify(event)).join('\n') + '\n');`;

function withFakeGrok(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ab-grok-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const isWindows = process.platform === 'win32';
  const shim = path.join(dir, isWindows ? 'grok.cmd' : 'grok');
  const argsFile = path.join(dir, 'argv.json');
  writeFileSync(path.join(dir, 'fake-grok.cjs'), fakeGrok);
  if (isWindows) {
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0fake-grok.cjs" %*\r\n`);
  } else {
    writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$(dirname "$0")/fake-grok.cjs" "$@"\n`);
    chmodSync(shim, 0o755);
  }
  const pathValue = `${dir}${path.delimiter}${process.env.PATH || process.env.Path || ''}`;
  return {
    env: {
      PATH: pathValue,
      ...(isWindows ? { Path: pathValue } : {}),
      PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
      FAKE_GROK_ARGS: argsFile,
    },
    argsFile,
  };
}

async function runGrok(opts) {
  const adapter = await agents.get('grok');
  const events = [];
  const it = adapter.run(opts);
  for (;;) {
    const n = await it.next();
    if (n.done) return { result: n.value, events };
    events.push(n.value);
  }
}

test('Grok uses the documented streaming JSON protocol and retains its ending session ID', async (t) => {
  const fake = withFakeGrok(t);
  const prompt = 'inspect this workspace';
  const cwd = process.cwd();
  const { result, events } = await runGrok({ prompt, cwd, permissions: 'read-only', env: fake.env });
  const args = JSON.parse(readFileSync(fake.argsFile, 'utf8'));

  assert.deepEqual(args.slice(0, 4), [
    '-p',
    `[READ-ONLY MODE: Do NOT edit files or run modifying commands]\n\n${prompt}`,
    '--output-format',
    'streaming-json',
  ]);
  assert.ok(args.includes('--cwd'));
  assert.ok(args.includes(cwd));
  assert.ok(!args.includes('--json'));
  const permissionAt = args.indexOf('--permission-mode');
  assert.notEqual(permissionAt, -1);
  assert.equal(args[permissionAt + 1], 'default');
  assert.equal(result.text, 'hello');
  assert.equal(result.sessionId, 'session-fixture');
  assert.ok(events.some((e) => e.type === 'text' && e.delta === 'hello'));
  assert.ok(events.some((e) => e.type === 'session' && e.id === 'session-fixture'));
});

test('Grok full permissions use the documented bypassPermissions mode', async (t) => {
  const fake = withFakeGrok(t);
  await runGrok({ prompt: 'inspect this workspace', permissions: 'full', env: fake.env });
  const args = JSON.parse(readFileSync(fake.argsFile, 'utf8'));
  const at = args.indexOf('--permission-mode');
  assert.notEqual(at, -1);
  assert.equal(args[at + 1], 'bypassPermissions');
});

test('Grok plan permissions use the native plan mode', async (t) => {
  const fake = withFakeGrok(t);
  await runGrok({ prompt: 'inspect this workspace', permissions: 'plan', env: fake.env });
  const args = JSON.parse(readFileSync(fake.argsFile, 'utf8'));
  const at = args.indexOf('--permission-mode');
  assert.notEqual(at, -1);
  assert.equal(args[at + 1], 'plan');
});
