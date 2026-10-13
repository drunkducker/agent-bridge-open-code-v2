import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateOptions } from '../dist/index.js';
import { installIde } from '../dist/cli/install-ide.js';
import { cmdInstall, writeSkill } from '../dist/cli/install.js';
import { toolSchema } from '../dist/bridge/mcp.js';
import codexAdapter from '../dist/adapters/codex.js';
import piAdapter from '../dist/adapters/pi.js';

// Use a controllable fake Codex CLI without depending on a host installation.
function fakeCodex(bin, source) {
  const script = path.join(bin, 'fake-codex.js');
  writeFileSync(script, source);
  if (process.platform === 'win32') {
    writeFileSync(path.join(bin, 'codex.cmd'), '@"%~dp0fake-codex.js" %*\r\n');
  } else {
    const executable = path.join(bin, 'codex');
    writeFileSync(executable, `#!/usr/bin/env node\n${source}`);
    chmodSync(executable, 0o755);
  }
}

test('mcpServers timeout validation', () => {
  // Valid positive numbers in seconds or ms
  const valid = validateOptions({
    prompt: 'hello',
    mcpServers: {
      test: { command: 'node', args: ['server.js'], timeout: 300 },
      other: { command: 'node', timeout: 120000 },
    },
  });
  assert.equal(valid.mcpServers.test.timeout, 300);
  assert.equal(valid.mcpServers.other.timeout, 120000);

  // Invalid timeout (zero, negative, non-number)
  assert.throws(() => {
    validateOptions({
      prompt: 'hello',
      mcpServers: {
        test: { command: 'node', timeout: -1 },
      },
    });
  }, /mcpServers\.test\.timeout must be a positive number/);

  assert.throws(() => {
    validateOptions({
      prompt: 'hello',
      mcpServers: {
        test: { command: 'node', timeout: 0 },
      },
    });
  }, /mcpServers\.test\.timeout must be a positive number/);

  assert.throws(() => {
    validateOptions({
      prompt: 'hello',
      mcpServers: {
        test: { command: 'node', timeout: 'long' },
      },
    });
  }, /mcpServers\.test\.timeout must be a positive number/);
});

test('codex adapter preserves mcp timeout in args', async () => {
  // Verify that Codex receives its native tool_timeout_sec field in seconds.
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-codex-test-'));
  const bin = path.join(tmp, 'bin');
  mkdirSync(bin);
  try {
    const capture = path.join(tmp, 'args.json');
    fakeCodex(bin, `require('node:fs').writeFileSync(process.env.CAPTURE_ARGS, JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({type:'thread.started',thread_id:'12345678-1234-1234-1234-123456789abc'})); console.log(JSON.stringify({type:'turn.completed',usage:{}}));\n`);
    const env = { ...process.env, CODEX_HOME: tmp, CAPTURE_ARGS: capture, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` };
    if (process.platform === 'win32') env.Path = env.PATH;
    const events = [];
    for await (const event of codexAdapter.run({
      prompt: 'test prompt',
      cwd: tmp,
      env,
      mcpServers: {
        worker: { command: 'node', args: ['worker.js'], timeout: 300 },
      },
    })) events.push(event);
    const args = JSON.parse(readFileSync(capture, 'utf8'));
    assert.ok(args.includes('mcp_servers.worker.tool_timeout_sec=300'), args.join(' '));
    assert.equal(args.some((arg) => /^mcp_servers\.worker\.timeout=/.test(arg)), false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('Codex read-only, plan, and edit modes reject sandbox bypass flags and config overrides', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-codex-sandbox-guard-'));
  const bin = path.join(tmp, 'bin');
  mkdirSync(bin);
  try {
    const capture = path.join(tmp, 'args.json');
    fakeCodex(bin, `require('node:fs').writeFileSync(process.env.CAPTURE_ARGS, JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({type:'thread.started',thread_id:'12345678-1234-1234-1234-123456789abc'})); console.log(JSON.stringify({type:'turn.completed',usage:{}}));\n`);
    const env = { ...process.env, CODEX_HOME: tmp, CAPTURE_ARGS: capture, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` };
    if (process.platform === 'win32') env.Path = env.PATH;
    const blocked = [
      ['--dangerously-bypass-approvals-and-sandbox'],
      ['--yolo'],
      ['--full-auto'],
      ['--add-dir', 'C:/additional-root'],
      ['--add-dir=C:/additional-root'],
      ['--sandbox', 'danger-full-access'],
      ['--sandbox=danger-full-access'],
      ['-s', 'danger-full-access'],
      ['-sdanger-full-access'],
      ['-c', 'sandbox_mode="danger-full-access"'],
      ['--config', 'sandbox_mode="danger-full-access"'],
      ['-c=sandbox_mode="danger-full-access"'],
      ['--config=sandbox_mode="danger-full-access"'],
      ['-csandbox_mode="danger-full-access"'],
      ['-c', 'windows.sandbox="elevated"'],
      ['--config', 'sandbox_workspace_write.writable_roots=["C:/"]'],
      ['-c', 'windows={sandbox="elevated"}'],
      ['--config=windows = { sandbox = "elevated" }'],
    ];
    for (const permissions of ['read-only', 'plan', 'edit']) {
      for (const extraArgs of blocked) {
        await assert.rejects(
          async () => {
            for await (const _event of codexAdapter.run({ prompt: 'test', cwd: tmp, env, permissions, extraArgs })) {}
          },
          { code: 'BAD_OPTION' },
          `${permissions}: ${extraArgs.join(' ')}`
        );
      }
    }
    assert.equal(existsSync(capture), false, 'blocked runs must be rejected before Codex starts');

    for await (const _event of codexAdapter.run({
      prompt: 'test', cwd: tmp, env, permissions: 'full', extraArgs: ['--dangerously-bypass-approvals-and-sandbox'],
    })) {}
    assert.ok(JSON.parse(readFileSync(capture, 'utf8')).includes('--dangerously-bypass-approvals-and-sandbox'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('bridge tool schema exposes timeout alias alongside timeoutSeconds', () => {
  const schema = toolSchema('codex', 'ask');
  assert.ok(schema.inputSchema.properties.timeout, 'schema must contain timeout property');
  assert.ok(schema.inputSchema.properties.timeoutSeconds, 'schema must contain timeoutSeconds property');
  assert.equal(schema.inputSchema.properties.timeout.type, 'number');
});

test('installIde writes default timeout of 300 seconds into config', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-ide-test-'));
  try {
    const configFile = path.join(tmp, 'cursor-mcp.json');
    const res = installIde('cursor', {
      configPath: configFile,
      cwd: tmp,
      timeout: 450,
    });
    assert.equal(res.modified, true);
    const content = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.ok(content.mcpServers?.agentbridge);
    assert.equal(content.mcpServers.agentbridge.timeout, 450);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('install pi writes timeout into mcp.json', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-pi-test-'));
  try {
    const piDir = path.join(tmp, 'pi-agent');
    const oldEnv = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = piDir;
    try {
      const msgs = [];
      await cmdInstall(['pi'], { cwd: tmp, timeout: 600 }, { out: (m) => msgs.push(m), err: () => {} });
      const mcpJsonPath = path.join(piDir, 'mcp.json');
      assert.ok(existsSync(mcpJsonPath), 'mcp.json must be created');
      const mcpJson = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
      assert.ok(mcpJson.mcpServers?.agentbridge);
      assert.equal(mcpJson.mcpServers.agentbridge.timeout, 600);
    } finally {
      if (oldEnv !== undefined) process.env.PI_CODING_AGENT_DIR = oldEnv;
      else delete process.env.PI_CODING_AGENT_DIR;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('install opencode writes timeout into opencode.json', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-opencode-test-'));
  try {
    const msgs = [];
    await cmdInstall(['opencode'], { cwd: tmp, scope: 'project', timeout: 500 }, { out: (m) => msgs.push(m), err: () => {} });
    const opencodePath = path.join(tmp, 'opencode.json');
    assert.ok(existsSync(opencodePath));
    const cfg = JSON.parse(readFileSync(opencodePath, 'utf8'));
    assert.ok(cfg.mcp?.agentbridge);
    assert.equal(cfg.mcp.agentbridge.timeout, 500);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// writeSkill consults the global ~/.agents skill via homedir(); isolate it per test
// (same HOME/USERPROFILE sandbox pattern as install.test.mjs).
function withFakeHome(home, fn) {
  const oldHome = process.env.HOME;
  const oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    fn();
  } finally {
    if (oldHome !== undefined) process.env.HOME = oldHome;
    else delete process.env.HOME;
    if (oldProfile !== undefined) process.env.USERPROFILE = oldProfile;
    else delete process.env.USERPROFILE;
  }
}

test('skill installation prevents duplicate collision across harnesses and scopes', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-skill-collision-'));
  try {
    withFakeHome(tmp, () => {
      const logs = [];
      const out = (m) => logs.push(m);

      // First write to project
      writeSkill(path.join(tmp, '.agents'), out);
      const skillPath = path.join(tmp, '.agents', 'skills', 'agentbridge-delegate', 'SKILL.md');
      assert.ok(existsSync(skillPath), 'skill must exist in .agents/skills');
      assert.equal(logs.length, 1);
      assert.match(logs[0], /wrote skill/);

      // Second write during same command execution should be deduplicated
      logs.length = 0;
      writeSkill(path.join(tmp, '.agents'), out);
      assert.equal(logs.length, 0, 'subsequent write in same execution must be skipped without duplicate writes');
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeSkill skips a project copy identical to the global skill', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-skill-skip-'));
  try {
    withFakeHome(tmp, () => {
      const logs = [];
      const out = (m) => logs.push(m);

      // User scope writes the global file itself, unconditionally.
      writeSkill(path.join(tmp, '.agents'), out);
      const globalSkill = path.join(tmp, '.agents', 'skills', 'agentbridge-delegate', 'SKILL.md');
      assert.ok(existsSync(globalSkill), 'global skill must be written');

      // A project scope whose copy would be byte-identical: skipped as a duplicate.
      const projBase = path.join(tmp, 'proj', '.agents');
      writeSkill(projBase, out);
      const projSkill = path.join(projBase, 'skills', 'agentbridge-delegate', 'SKILL.md');
      assert.ok(!existsSync(projSkill), 'identical project copy must not be created');
      assert.match(String(logs.at(-1)), /skill identical to global .*skipped duplicate/);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeSkill writes the project copy when the global skill differs', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-skill-diff-'));
  try {
    withFakeHome(tmp, () => {
      const logs = [];
      const out = (m) => logs.push(m);

      const globalSkill = path.join(tmp, '.agents', 'skills', 'agentbridge-delegate', 'SKILL.md');
      mkdirSync(path.dirname(globalSkill), { recursive: true });
      writeFileSync(globalSkill, '---\nname: agentbridge-delegate\nOUTDATED GLOBAL\n', 'utf8');

      // A differing global skill never blocks the project copy.
      const projBase = path.join(tmp, 'proj', '.agents');
      writeSkill(projBase, out);
      const projSkill = path.join(projBase, 'skills', 'agentbridge-delegate', 'SKILL.md');
      assert.ok(existsSync(projSkill), 'a differing global skill must not block the project copy');
      assert.match(readFileSync(projSkill, 'utf8'), /^---/, 'project copy must come from the repo template');
      assert.match(String(logs.at(-1)), /wrote skill/);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('writeSkill --force writes the project copy even when identical to the global skill', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-skill-force-'));
  try {
    withFakeHome(tmp, () => {
      const logs = [];
      const out = (m) => logs.push(m);

      writeSkill(path.join(tmp, '.agents'), out); // identical global skill
      const projBase = path.join(tmp, 'proj', '.agents');
      writeSkill(projBase, out, { force: true });
      const projSkill = path.join(projBase, 'skills', 'agentbridge-delegate', 'SKILL.md');
      assert.ok(existsSync(projSkill), '--force must write the identical project copy');
      assert.match(String(logs.at(-1)), /wrote skill/);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
