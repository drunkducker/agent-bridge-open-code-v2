// `ab doctor` with a private PATH: never depends on which agent CLIs the machine has. No model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, mkdirSync, symlinkSync, copyFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAIN = path.join(ROOT, 'dist', 'cli', 'main.js');
const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-doctor-')));
mkdirSync(path.join(home, 'proj'));
const bin = path.join(home, 'bin');
mkdirSync(bin);
const nodeLink = path.join(bin, path.basename(process.execPath));
try { symlinkSync(process.execPath, nodeLink); } catch { copyFileSync(process.execPath, nodeLink); }
const baseEnv = {
  ...process.env, PATH: bin, Path: bin, HOME: home, USERPROFILE: home, AGENTBRIDGE_HOME: path.join(home, 'ab'),
  LOCALAPPDATA: path.join(home, 'la'), APPDATA: path.join(home, 'ad'), CODEX_HOME: path.join(home, 'cx'),
  PI_CODING_AGENT_DIR: path.join(home, 'pi'), XDG_DATA_HOME: path.join(home, 'xdg'),
  OLLAMA_HOST: '127.0.0.1:1', // nothing listens there
};
const doctor = (args, env = baseEnv) => new Promise((res) => {
  const p = spawn(process.execPath, [MAIN, 'doctor', ...args], { env, cwd: path.join(home, 'proj') });
  let o = '', e = '';
  p.stdout.on('data', (b) => (o += b)); p.stderr.on('data', (b) => (e += b));
  p.on('close', (c) => res({ c, o, e }));
});

test('no agent at all: every CLI is [skip], and the run fails with a clear message', { timeout: 60000 }, async () => {
  const r = await doctor(['--no-models', '--port', '0']);
  assert.equal(r.c, 1, r.o + r.e);
  for (const a of ['claude', 'codex', 'opencode', 'agy', 'pi', 'cursor', 'grok', 'gemini', 'devin', 'acp'])
    assert.match(r.o, new RegExp(`\\[skip\\] ${a}: not installed`), a);
  assert.match(r.o, /\[skip\] ollama: .*not reachable/);
  assert.match(r.o, /\[FAIL\] agents: no usable agent/);
  assert.doesNotMatch(r.o, /\[FAIL\] (claude|codex|opencode|agy|pi):/);
});

test('--json keeps its shape and adds status skip + usable', { timeout: 60000 }, async () => {
  const d = JSON.parse((await doctor(['--no-models', '--json'])).o.trim());
  assert.equal(d.ok, false);
  assert.ok(Array.isArray(d.checks) && d.agents && typeof d.agents === 'object');
  assert.equal(d.agents.claude.installed, false);
  assert.equal(d.agents.gemini.installed, false);
  assert.equal(d.checks.find((c) => c.name === 'claude').status, 'skip');
  assert.deepEqual(d.usable, []);
});

test('installed but not logged in: WARN, not usable; with a login it is usable and the run passes', { timeout: 60000, skip: process.platform === 'win32' && 'uses POSIX fake CLIs' }, async () => {
  const fake = path.join(bin, 'codex');
  writeFileSync(fake, '#!/bin/sh\necho "codex-cli 9.9.9"\n');
  chmodSync(fake, 0o755);
  const r = await doctor(['--no-models', '--port', '0']);
  assert.match(r.o, /\[WARN\] codex: .*no login found/);
  assert.equal(r.c, 1, 'installed-but-logged-out is the only candidate, so nothing is usable');
  assert.match(r.o, /no usable agent/);
});

test('one installed CLI: missing others do not fail the run (exit 0)', { timeout: 60000, skip: process.platform === 'win32' && 'uses POSIX fake CLIs' }, async () => {
  const fake = path.join(bin, 'codex');
  writeFileSync(fake, '#!/bin/sh\necho "codex-cli 9.9.9"\n');
  chmodSync(fake, 0o755);
  mkdirSync(path.join(home, 'cx'), { recursive: true });
  writeFileSync(path.join(home, 'cx', 'auth.json'), '{}');
  const r = await doctor(['--no-models', '--port', '0']);
  assert.equal(r.c, 0, r.o + r.e);
  assert.match(r.o, /\[ ok \] codex: codex-cli 9\.9\.9/);
  assert.match(r.o, /\[ ok \] agents: 1 usable: codex/);
  assert.match(r.o, /\[skip\] claude: not installed/);
});

test('parseArgs: boolean flags never swallow the next argument', async () => {
  const { parseArgs } = await import('../dist/cli/args.js');
  const r = parseArgs(['run', '--isolated', '--offline', '--app-server', '--delete-dir', 'hi', '-j']);
  assert.deepEqual(r._, ['run', 'hi']);
  for (const k of ['isolated', 'offline', 'app-server', 'delete-dir', 'json']) assert.equal(r.flags[k], true, k);
});
