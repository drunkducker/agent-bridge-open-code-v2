import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  validateOptions,
  getDefaultPermissions,
  getPermissionsCeiling,
  resolvePermissionLevel,
  loadConfig,
  saveConfig,
  setConfigValue,
  getConfigValue,
  resetConfigValue,
  ask,
} from '../dist/index.js';
import { resolvePerms } from '../dist/bridge/mcp.js';
import { spawnProc } from '../dist/core/spawn.js';

const collect = async (p) => {
  const a = [];
  for await (const l of p.lines) a.push(l);
  return a;
};

const N = process.execPath;
const CLI = path.resolve('dist/cli/main.js');

function isolatedConfigFiles() {
  const root = mkdtempSync(path.join(tmpdir(), 'ab-config-policy-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(cwd, '.agentbridge'), { recursive: true });
  const env = { AGENTBRIDGE_HOME: home };
  return {
    root, home, cwd, env,
    globalFile: path.join(home, 'config.json'),
    projectFile: path.join(cwd, '.agentbridge', 'config.json'),
    writeGlobal: (text) => writeFileSync(path.join(home, 'config.json'), text),
    writeProject: (text) => writeFileSync(path.join(cwd, '.agentbridge', 'config.json'), text),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('permissions: default is read-only and ceiling is full by default', () => {
  const cleanEnv = {};
  assert.equal(getDefaultPermissions(cleanEnv), 'read-only');
  assert.equal(getPermissionsCeiling(cleanEnv), 'full');

  const o = validateOptions({ prompt: 'inspect code' });
  assert.equal(o.permissions, 'read-only');
  assert.equal(o.defaultPermissions, true);
});

test('permissions: explicit permissions within ceiling are honored', () => {
  for (const perm of ['read-only', 'plan', 'edit', 'full']) {
    const o = validateOptions({ prompt: 'test', permissions: perm });
    assert.equal(o.permissions, perm);
    assert.equal(o.defaultPermissions, undefined);
  }
});

test('permissions: exceeding ceiling throws BAD_OPTION', () => {
  const restrictedEnv = { AGENTBRIDGE_PERMS_CEILING: 'read-only' };
  assert.throws(
    () => resolvePermissionLevel('edit', { env: restrictedEnv }),
    /exceeds the configured permission ceiling/
  );
  assert.throws(
    () => resolvePermissionLevel('full', { env: restrictedEnv }),
    /exceeds the configured permission ceiling/
  );
});

test('permissions: AGENTBRIDGE_DEFAULT_PERMS overrides default', () => {
  const customEnv = { AGENTBRIDGE_DEFAULT_PERMS: 'edit' };
  assert.equal(getDefaultPermissions(customEnv), 'edit');
  const o = validateOptions({ prompt: 'test', env: customEnv });
  assert.equal(o.permissions, 'edit');
});

test('config rejects present invalid permission policy values in global and project files', () => {
  for (const scope of ['global', 'project']) {
    for (const key of ['permissionsCeiling', 'defaultPermissions']) {
      for (const value of [null, false, 0, '', 'read-onyl']) {
        const c = isolatedConfigFiles();
        try {
          c.writeGlobal(JSON.stringify({ permissionsCeiling: 'read-only', defaultPermissions: 'read-only' }));
          if (scope === 'project') c.writeProject(JSON.stringify({ [key]: value }));
          else c.writeGlobal(JSON.stringify({ [key]: value }));
          assert.throws(
            () => loadConfig(c.cwd, c.env),
            (err) => err.code === 'BAD_OPTION' && err.message.includes(key) && err.message.includes(scope === 'global' ? c.globalFile : c.projectFile),
            `${scope} ${key}=${JSON.stringify(value)} must be rejected`
          );
        } finally {
          c.cleanup();
        }
      }
    }
  }
});

test('config rejects malformed roots and empty existing files', () => {
  for (const text of ['[]', 'null', '', ' \n\t']) {
    const c = isolatedConfigFiles();
    try {
      c.writeGlobal(text);
      assert.throws(
        () => loadConfig(c.cwd, c.env),
        (err) => err.code === 'BAD_OPTION' && err.message.includes(c.globalFile),
        `global config ${JSON.stringify(text)} must be rejected`
      );
    } finally {
      c.cleanup();
    }
  }
});

test('permission helpers reject invalid env values and still validate loaded config under valid overrides', () => {
  const c = isolatedConfigFiles();
  try {
    for (const env of [
      { ...c.env, AGENTBRIDGE_PERMS_CEILING: 'read-onyl' },
      { ...c.env, AGENTBRIDGE_PERMS: 'read-onyl' },
      { ...c.env, AGENTBRIDGE_DEFAULT_PERMS: 'read-onyl' },
      { ...c.env, AGENTBRIDGE_DEFAULT_PERMISSIONS: 'read-onyl' },
      { ...c.env, AGENTBRIDGE_PERMS_CEILING: 'full', AGENTBRIDGE_PERMS: 'read-onyl' },
    ]) {
      assert.throws(() => loadConfig(c.cwd, env), (err) => err.code === 'BAD_OPTION');
      assert.throws(() => getPermissionsCeiling(env, c.cwd), (err) => err.code === 'BAD_OPTION');
      assert.throws(() => getDefaultPermissions(env, c.cwd), (err) => err.code === 'BAD_OPTION');
    }

    c.writeGlobal('{');
    assert.throws(() => getPermissionsCeiling({ ...c.env, AGENTBRIDGE_PERMS_CEILING: 'read-only' }, c.cwd), /Failed to parse/);
    assert.throws(() => getDefaultPermissions({ ...c.env, AGENTBRIDGE_DEFAULT_PERMS: 'edit' }, c.cwd), /Failed to parse/);
  } finally {
    c.cleanup();
  }
});

test('valid config and env permission values retain project and env precedence', () => {
  const c = isolatedConfigFiles();
  try {
    c.writeGlobal(JSON.stringify({ permissionsCeiling: 'edit', defaultPermissions: 'plan' }));
    c.writeProject(JSON.stringify({ permissionsCeiling: 'read-only' }));
    assert.deepEqual(loadConfig(c.cwd, c.env), { permissionsCeiling: 'read-only', defaultPermissions: 'plan' });
    const env = { ...c.env, AGENTBRIDGE_PERMS_CEILING: 'full', AGENTBRIDGE_DEFAULT_PERMS: 'edit' };
    assert.deepEqual(loadConfig(c.cwd, env), { permissionsCeiling: 'full', defaultPermissions: 'edit' });
  } finally {
    c.cleanup();
  }
});

test('bridge: resolvePerms applies default read-only and respects ceiling', () => {
  // Default when omitted is read-only
  assert.equal(resolvePerms(undefined, {}), 'read-only');
  // Explicit within ceiling
  assert.equal(resolvePerms('edit', { AGENTBRIDGE_PERMS: 'full' }), 'edit');
  // Escalating beyond ceiling throws
  assert.throws(
    () => resolvePerms('edit', { AGENTBRIDGE_PERMS: 'read-only' }),
    /exceeds/
  );
});

test('CLI: ab config get/set/list/reset manages settings cleanly', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-cfg-test-'));
  try {
    const env = { ...process.env, AGENTBRIDGE_HOME: tmp };

    // 1. Initial list in JSON
    let p = spawnProc(N, [CLI, 'config', 'list', '--json'], { cwd: tmp, env });
    let lines = await collect(p);
    const initial = JSON.parse(lines.join('\n'));
    assert.equal(initial.effective.defaultPermissions, 'read-only');
    assert.equal(initial.effective.permissionsCeiling, 'full');

    // 2. Set default-permissions to edit
    p = spawnProc(N, [CLI, 'config', 'set', 'default-permissions', 'edit', '--global'], { cwd: tmp, env });
    await collect(p);

    // 3. Get key
    p = spawnProc(N, [CLI, 'config', 'get', 'default-permissions'], { cwd: tmp, env });
    lines = await collect(p);
    assert.match(lines.join(''), /edit/);

    // 4. Verify list reflects change
    p = spawnProc(N, [CLI, 'config', 'list', '--json'], { cwd: tmp, env });
    lines = await collect(p);
    const updated = JSON.parse(lines.join('\n'));
    assert.equal(updated.config.defaultPermissions, 'edit');

    // 5. Reset key
    p = spawnProc(N, [CLI, 'config', 'reset', 'default-permissions', '--global'], { cwd: tmp, env });
    await collect(p);

    p = spawnProc(N, [CLI, 'config', 'get', 'default-permissions'], { cwd: tmp, env });
    lines = await collect(p);
    assert.match(lines.join(''), /not set/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('endpoints: default read-only operates directly without harness, edit requests harness', async () => {
  const fakeEndpoint = {
    name: 'test_local',
    type: 'openai',
    baseUrl: 'http://127.0.0.1:9999/v1',
    defaultModel: 'test-model',
  };
  const { makeEndpointAdapter } = await import('../dist/adapters/endpoint.js');
  const adapter = makeEndpointAdapter(fakeEndpoint);

  // Default call (read-only): attempts direct HTTP without requiring Claude Code or Pi harness
  // It fails with AGENT_FAILED (cannot connect to 9999), NOT with NOT_INSTALLED (harness missing)
  try {
    await ask(adapter, { prompt: 'hi' });
    assert.fail('should have failed connection');
  } catch (err) {
    assert.equal(err.code, 'AGENT_FAILED');
    assert.match(err.message, /Cannot reach/);
  }

  // Edit call: cleanly requests execution harness
  try {
    await ask(adapter, { prompt: 'create file.txt', permissions: 'edit' });
    assert.fail('should have required harness');
  } catch (err) {
    // Harness was invoked (reports model/auth/install error from harness rather than "Cannot reach baseUrl")
    assert.ok(err.code === 'BAD_OPTION' || err.code === 'NOT_INSTALLED' || err.code === 'AGENT_FAILED' || err.code === 'NOT_LOGGED_IN');
    assert.doesNotMatch(err.message, /Cannot reach test_local/);
  }
});
