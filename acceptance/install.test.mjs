// `ab install <agent>`: registers the MCP bridge (+ the agentbridge-delegate skill) in OpenCode, Codex and Antigravity.
// Everything runs against throw-away config homes; the user's real configs are never touched. No model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdInstall } from '../dist/cli/install.js';

const MAIN = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const tmp = (p) => realpathSync(mkdtempSync(path.join(tmpdir(), p)));
const sandbox = () => {
  const r = tmp('ab-inst-');
  const d = { r, proj: path.join(r, 'proj'), home: path.join(r, 'home'), cx: path.join(r, 'cx'), xdg: path.join(r, 'xdg') };
  for (const k of ['proj', 'home', 'cx', 'xdg']) mkdirSync(d[k]);
  return d;
};
const ab = (d, args) => new Promise((res) => {
  const env = { ...process.env, HOME: d.home, USERPROFILE: d.home, CODEX_HOME: d.cx, XDG_CONFIG_HOME: d.xdg, PI_CODING_AGENT_DIR: path.join(d.r, 'pi'), AGENTBRIDGE_HOME: path.join(d.r, 'ab') };
  const p = spawn(process.execPath, [MAIN, 'install', ...args, '--cwd', d.proj], { env });
  let o = '', e = '';
  p.stdout.on('data', (b) => (o += b)); p.stderr.on('data', (b) => (e += b)); p.on('close', (c) => res({ c, o, e }));
});
const has = (bin) => new Promise((res) => {
  const p = spawn(bin, ['--version'], { shell: process.platform === 'win32', stdio: 'ignore' });
  p.on('error', () => res(false)); p.on('close', (c) => res(c === 0));
});
const skillOk = (d) => {
  const f = path.join(d.proj, '.agents', 'skills', 'agentbridge-delegate', 'SKILL.md');
  assert.ok(existsSync(f), f);
  assert.match(readFileSync(f, 'utf8'), /^---\r?\nname: agentbridge-delegate/);
};
// Install tests need a predictable fake Codex executable, independent of the host OS.
const fakeCodex = (bin, source) => {
  const script = path.join(bin, 'fake-codex.js');
  writeFileSync(script, source);
  if (process.platform === 'win32') {
    writeFileSync(path.join(bin, 'codex.cmd'), '@"%~dp0fake-codex.js" %*\r\n');
  } else {
    const executable = path.join(bin, 'codex');
    writeFileSync(executable, `#!/usr/bin/env node\n${source}`);
    chmodSync(executable, 0o755);
  }
};
// An env whose PATH holds no agent CLI, so `claude mcp add-json` reliably falls back to writing .mcp.json
const abNoClaude = (d, args) => {
  const env = { ...process.env, HOME: d.home, USERPROFILE: d.home, CODEX_HOME: d.cx, XDG_CONFIG_HOME: d.xdg, PI_CODING_AGENT_DIR: path.join(d.r, 'pi'), AGENTBRIDGE_HOME: path.join(d.r, 'ab') };
  delete env.Path;
  env.PATH = ''; // resolveBinary then finds no `claude`, on every platform and install layout
  return new Promise((res) => {
    const p = spawn(process.execPath, [MAIN, 'install', ...args, '--cwd', d.proj], { env });
    let o = '', e = '';
    p.stdout.on('data', (b) => (o += b)); p.stderr.on('data', (b) => (e += b)); p.on('close', (c) => res({ c, o, e }));
  });
};

test('opencode: merges into an existing opencode.json, keeps other keys, installs the skill', async () => {
  const d = sandbox();
  writeFileSync(path.join(d.proj, 'opencode.json'), JSON.stringify({ model: 'x/y', mcp: { other: { type: 'local', command: ['z'] } } }));
  const r = await ab(d, ['opencode', '--permissions', 'plan', '--max-depth', '1']);
  assert.equal(r.c, 0, r.e + r.o);
  const cfg = JSON.parse(readFileSync(path.join(d.proj, 'opencode.json'), 'utf8'));
  assert.equal(cfg.model, 'x/y'); assert.ok(cfg.mcp.other);
  assert.equal(cfg.mcp.agentbridge.type, 'local'); assert.deepEqual(cfg.mcp.agentbridge.command.slice(-1), ['bridge']);
  assert.equal(cfg.mcp.agentbridge.environment.AGENTBRIDGE_PERMS, 'plan');
  assert.equal(cfg.mcp.agentbridge.environment.AGENTBRIDGE_MAX_DEPTH, '1');
  skillOk(d);
  assert.equal((await ab(d, ['opencode'])).c, 0, 'idempotent');
});

test('opencode: a config with comments is refused untouched; --no-skill skips the skill', async () => {
  const d = sandbox(); const f = path.join(d.proj, 'opencode.json'); const src = '{ // mine\n "model": "a/b" }';
  writeFileSync(f, src);
  const r = await ab(d, ['opencode']);
  assert.notEqual(r.c, 0); assert.equal(readFileSync(f, 'utf8'), src);
  const d2 = sandbox();
  assert.equal((await ab(d2, ['opencode', '--no-skill'])).c, 0);
  assert.ok(!existsSync(path.join(d2.proj, '.agents')));
});

test('opencode user scope writes into XDG_CONFIG_HOME', async () => {
  const d = sandbox(); const r = await ab(d, ['opencode', '--scope', 'user', '--no-skill']);
  assert.equal(r.c, 0, r.e);
  const cfg = JSON.parse(readFileSync(path.join(d.xdg, 'opencode', 'opencode.json'), 'utf8'));
  assert.ok(cfg.mcp.agentbridge);
});

test('codex: registered in its (isolated) config.toml', { skip: !(await has('codex')) && 'codex is not installed' }, async () => {
  const d = sandbox(); const r = await ab(d, ['codex', '--permissions', 'edit']);
  assert.equal(r.c, 0, r.e + r.o);
  const toml = readFileSync(path.join(d.cx, 'config.toml'), 'utf8');
  assert.match(toml, /\[mcp_servers\.agentbridge\]/); assert.match(toml, /AGENTBRIDGE_PERMS = "edit"/); assert.match(toml, /bridge/);
  skillOk(d);
});

test('codex --auto-approve pre-approves the bridge tools (codex exec cannot answer the prompt)', { skip: !(await has('codex')) && 'codex is not installed' }, async () => {
  const d = sandbox();
  const plain = await ab(d, ['codex']);
  assert.equal(plain.c, 0, plain.e + plain.o);
  assert.doesNotMatch(readFileSync(path.join(d.cx, 'config.toml'), 'utf8'), /default_tools_approval_mode/);
  const r = await ab(d, ['codex', '--auto-approve']);
  assert.equal(r.c, 0, r.e + r.o);
  const toml = readFileSync(path.join(d.cx, 'config.toml'), 'utf8');
  assert.match(toml, /\[mcp_servers\.agentbridge\]\r?\n(?:.*\r?\n)*?default_tools_approval_mode = "approve"/);
  assert.match(toml, /AGENTBRIDGE_PERMS = "full"/);
});

test('agy: registered in its (isolated) mcp_config.json', { skip: !(await has('agy')) && 'agy is not installed' }, async () => {
  const d = sandbox(); const r = await ab(d, ['agy']);
  assert.equal(r.c, 0, r.e + r.o);
  const cfg = JSON.parse(readFileSync(path.join(d.home, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
  assert.equal(cfg.mcpServers.agentbridge.env.AGENTBRIDGE_PERMS, 'full');
  assert.deepEqual(cfg.mcpServers.agentbridge.args.slice(-1), ['bridge']);
  skillOk(d);
});

test('pi: registered in its (isolated) mcp.json with direct exposure, and the bridge connects', { skip: !(await has('pi')) && 'pi is not installed', timeout: 90000 }, async () => {
  const d = sandbox(); const r = await ab(d, ['pi']);
  assert.equal(r.c, 0, r.e + r.o);
  const cfg = JSON.parse(readFileSync(path.join(d.r, 'pi', 'mcp.json'), 'utf8'));
  const s = cfg.mcpServers.agentbridge;
  assert.equal(s.exposure, 'direct'); assert.equal(s.env.AGENTBRIDGE_PERMS, 'full'); assert.deepEqual(s.args.slice(-1), ['bridge']);
  skillOk(d);
});

test('claude fallback (no claude CLI): an absent .mcp.json is created with the agentbridge entry', async () => {
  const d = sandbox();
  const r = await abNoClaude(d, ['claude', '--no-skill', '--no-agents']);
  assert.equal(r.c, 0, r.e + r.o);
  const cfg = JSON.parse(readFileSync(path.join(d.proj, '.mcp.json'), 'utf8'));
  assert.deepEqual(cfg.mcpServers.agentbridge.args.slice(-1), ['bridge']);
  assert.equal(cfg.mcpServers.agentbridge.env.AGENTBRIDGE_DEFAULT_PERMS, 'read-only');
});

test('claude fallback (no claude CLI): merges into a valid .mcp.json and keeps the user servers', async () => {
  const d = sandbox();
  writeFileSync(path.join(d.proj, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'z' } } }));
  const r = await abNoClaude(d, ['claude', '--no-skill', '--no-agents']);
  assert.equal(r.c, 0, r.e + r.o);
  const cfg = JSON.parse(readFileSync(path.join(d.proj, '.mcp.json'), 'utf8'));
  assert.ok(cfg.mcpServers.other, 'the pre-existing server must survive the merge');
  assert.deepEqual(cfg.mcpServers.agentbridge.args.slice(-1), ['bridge']);
});

test('claude fallback (no claude CLI): a .mcp.json with comments is refused untouched', async () => {
  const d = sandbox(); const f = path.join(d.proj, '.mcp.json');
  const src = '/* mine */\n{ "mcpServers": { "other": { "command": "z" } } }';
  writeFileSync(f, src);
  const r = await abNoClaude(d, ['claude']);
  assert.notEqual(r.c, 0);
  assert.match(r.e + r.o, /not touched/);
  assert.equal(readFileSync(f, 'utf8'), src);
});

test('unknown target and bad options fail', async () => {
  const d = sandbox();
  assert.notEqual((await ab(d, ['nope'])).c, 0);
  assert.notEqual((await ab(d, ['opencode', '--permissions', 'root'])).c, 0);
  assert.notEqual((await ab(d, ['opencode', '--scope', 'weird'])).c, 0);
});

test('IDE install rejects typo scope and invalid timeout without touching project or user config', async () => {
  const d = sandbox();
  for (const args of [
    ['cursor', '--scope', 'porject'],
    ['cursor', '--scope', 'project', '--timeout', '0'],
    ['cursor', '--scope', 'project', '--timeout', '-1'],
  ]) {
    const r = await ab(d, args);
    assert.notEqual(r.c, 0, r.o + r.e);
  }
  assert.equal(existsSync(path.join(d.proj, '.cursor', 'mcp.json')), false);
  assert.equal(existsSync(path.join(d.home, '.cursor', 'mcp.json')), false);

  const valid = await ab(d, ['cursor', '--scope', 'project', '--timeout', '42']);
  assert.equal(valid.c, 0, valid.e + valid.o);
  assert.equal(JSON.parse(readFileSync(path.join(d.proj, '.cursor', 'mcp.json'), 'utf8')).mcpServers.agentbridge.timeout, 42);
});

test('Codex install replaces the complete existing timeout literal and preserves TOML comments and tables', async () => {
  const d = sandbox();
  const bin = path.join(d.r, 'bin');
  mkdirSync(bin);
  fakeCodex(bin, 'process.exit(0);\n');
  const config = path.join(d.cx, 'config.toml');
  const env = {
    ...process.env,
    HOME: d.home,
    USERPROFILE: d.home,
    CODEX_HOME: d.cx,
    XDG_CONFIG_HOME: d.xdg,
    AGENTBRIDGE_HOME: path.join(d.r, 'ab'),
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
  };
  if (process.platform === 'win32') env.Path = env.PATH;
  for (const oldLiteral of ['60.5', '6.05e1', '6_000']) {
    writeFileSync(config, `# [mcp_servers.agentbridge]\n  [mcp_servers.agentbridge]\ntimeout = ${oldLiteral} # keep this note\nextra = "still here"\n  [other]\ntimeout = 777\n`);
    const r = await new Promise((resolve) => {
      const p = spawn(process.execPath, [MAIN, 'install', 'codex', '--timeout', '600', '--no-skill', '--cwd', d.proj], { env });
      let out = '', err = '';
      p.stdout.on('data', (b) => (out += b));
      p.stderr.on('data', (b) => (err += b));
      p.on('close', (code) => resolve({ code, out, err }));
    });
    assert.equal(r.code, 0, r.err + r.out);
    const after = readFileSync(config, 'utf8');
    const agentStart = after.indexOf('[mcp_servers.agentbridge]');
    const otherStart = after.indexOf('[other]');
    const agentSection = after.slice(agentStart, otherStart);
    assert.match(after, /^[ \t]*\[mcp_servers\.agentbridge\]\r?\ntool_timeout_sec = 600 # keep this note\r?\nextra = "still here"/m);
    assert.match(after, /^[ \t]*\[other\]\r?\ntimeout = 777/m);
    assert.doesNotMatch(agentSection, /^timeout\s*=/m);
    assert.doesNotMatch(after, new RegExp(`tool_timeout_sec = ${oldLiteral.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  }

  writeFileSync(config, '  [mcp_servers.agentbridge]\ntimeout = 30.5 # legacy note\ntool_timeout_sec = 45.5 # native note\n  [other]\ntimeout = 777\n');
  const both = await new Promise((resolve) => {
    const p = spawn(process.execPath, [MAIN, 'install', 'codex', '--timeout', '600', '--no-skill', '--cwd', d.proj], { env });
    let out = '', err = '';
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (err += b));
    p.on('close', (code) => resolve({ code, out, err }));
  });
  assert.equal(both.code, 0, both.err + both.out);
  const merged = readFileSync(config, 'utf8');
  const mergedAgentSection = merged.slice(merged.indexOf('[mcp_servers.agentbridge]'), merged.indexOf('[other]'));
  assert.match(merged, /^tool_timeout_sec = 600 # native note/m);
  assert.match(merged, /^# legacy note/m);
  assert.doesNotMatch(mergedAgentSection, /^timeout\s*=/m);
  assert.equal((mergedAgentSection.match(/^tool_timeout_sec\s*=/gm) || []).length, 1);
});

test('install all rejects invalid options before probing agent CLIs', async () => {
  const d = sandbox();
  const bin = path.join(d.r, 'bin');
  const probeLog = path.join(d.r, 'probe.log');
  mkdirSync(bin);
  fakeCodex(bin, 'require("node:fs").appendFileSync(process.env.PROBE_LOG, process.argv.slice(2).join(" ") + "\\n"); process.exit(0);\n');
  const env = {
    ...process.env,
    HOME: d.home,
    USERPROFILE: d.home,
    CODEX_HOME: d.cx,
    XDG_CONFIG_HOME: d.xdg,
    PROBE_LOG: probeLog,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
  };
  if (process.platform === 'win32') env.Path = env.PATH;
  const result = await new Promise((resolve) => {
    const p = spawn(process.execPath, [MAIN, 'install', 'all', '--permissions', 'read-onyl', '--cwd', d.proj], { env });
    let out = '', err = '';
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (err += b));
    p.on('close', (code) => resolve({ code, out, err }));
  });
  assert.notEqual(result.code, 0, result.out + result.err);
  assert.equal(existsSync(probeLog), false, 'the invalid options must be rejected before any --version probe');
});

test('cmdInstall rejects boolean timeout values before touching IDE config', async () => {
  const d = sandbox();
  await assert.rejects(
    cmdInstall(['cursor'], { scope: 'project', timeout: true, cwd: d.proj }, { out() {}, err() {} }),
    /timeout/i
  );
  assert.equal(existsSync(path.join(d.proj, '.cursor', 'mcp.json')), false);
  assert.equal(existsSync(path.join(d.home, '.cursor', 'mcp.json')), false);
});
