// `ab setup` interactive / automated wizard acceptance tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdSetup } from '../dist/cli/setup.js';

const MAIN = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));

const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));

const sandbox = () => {
  const r = tmp('ab-setup-test-');
  const d = {
    r,
    proj: path.join(r, 'proj'),
    home: path.join(r, 'home'),
    cx: path.join(r, 'cx'),
    xdg: path.join(r, 'xdg'),
    pi: path.join(r, 'pi'),
    ab: path.join(r, 'ab'),
  };
  for (const k of ['proj', 'home', 'cx', 'xdg', 'pi', 'ab']) mkdirSync(d[k]);
  return d;
};

const runSetup = (d, args = []) =>
  new Promise((res) => {
    const env = {
      ...process.env,
      HOME: d.home,
      USERPROFILE: d.home,
      CODEX_HOME: d.cx,
      XDG_CONFIG_HOME: d.xdg,
      PI_CODING_AGENT_DIR: d.pi,
      AGENTBRIDGE_HOME: d.ab,
    };
    const p = spawn(process.execPath, [MAIN, 'setup', ...args, '--cwd', d.proj], { env });
    let o = '',
      e = '';
    p.stdout.on('data', (b) => (o += b));
    p.stderr.on('data', (b) => (e += b));
    p.on('close', (c) => res({ c, o, e }));
  });

test('setup: non-interactive with --yes runs scan and configures detected agents cleanly', async () => {
  const d = sandbox();
  const r = await runSetup(d, ['--yes']);
  assert.equal(r.c, 0, r.e + r.o);
  assert.match(r.o, /⚡ AGENTBRIDGE/);
  assert.match(r.o, /Setup Complete/);
  assert.match(r.o, /Quick Start Commands/);

  // Check OpenCode config was created
  const opencodeFile = path.join(d.xdg, 'opencode', 'opencode.json');
  if (existsSync(opencodeFile)) {
    const cfg = JSON.parse(readFileSync(opencodeFile, 'utf8'));
    assert.ok(cfg.mcp?.agentbridge);
  }

  // Check Pi config was created
  const piFile = path.join(d.pi, 'mcp.json');
  if (existsSync(piFile)) {
    const cfg = JSON.parse(readFileSync(piFile, 'utf8'));
    assert.ok(cfg.mcpServers?.agentbridge);
  }
});

test('setup: --help flag or command works', async () => {
  const d = sandbox();
  const p = spawn(process.execPath, [MAIN, 'setup', '--help'], {
    env: { ...process.env, HOME: d.home, USERPROFILE: d.home },
  });
  let o = '';
  p.stdout.on('data', (b) => (o += b));
  const c = await new Promise((res) => p.on('close', res));
  assert.equal(c, 0);
  assert.match(o, /agentbridge/);
});

test('setup rejects invalid scope and timeout before creating setup files', async () => {
  const d = sandbox();
  for (const args of [
    ['--yes', '--scope', 'porject'],
    ['--yes', '--scope', 'user', '--timeout', '0'],
    ['--yes', '--scope', 'project', '--timeout', '-1'],
    ['--yes', '--scope', 'project', '--permissions', 'read-onyl'],
  ]) {
    const r = await runSetup(d, args);
    assert.notEqual(r.c, 0, r.o + r.e);
  }
  assert.equal(existsSync(path.join(d.proj, '.agents')), false);
  assert.equal(existsSync(path.join(d.pi, 'mcp.json')), false);
  assert.equal(existsSync(path.join(d.xdg, 'opencode', 'opencode.json')), false);
});

test('setup preserves supported local scope and a valid timeout for a selected CLI', async () => {
  const d = sandbox();
  const r = await runSetup(d, ['--yes', '--agent', 'pi', '--scope', 'local', '--timeout', '42', '--no-skill']);
  assert.equal(r.c, 0, r.e + r.o);
  assert.match(r.o, /Scope:\s+local/);
  const cfg = JSON.parse(readFileSync(path.join(d.pi, 'mcp.json'), 'utf8'));
  assert.equal(cfg.mcpServers.agentbridge.timeout, 42);
});

test('cmdSetup rejects a boolean timeout before environment scanning or file writes', async () => {
  let output = '';
  await assert.rejects(
    cmdSetup([], { timeout: true }, { out: (value) => (output += String(value)), err() {} }),
    /timeout/i
  );
  assert.equal(output, '');
});
