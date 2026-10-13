import test from 'node:test';
import assert from 'node:assert/strict';
import { agents } from '../dist/index.js';

const T = { timeout: 30000 };

test('new providers are registered in agents.builtin and agents.names', T, async () => {
  const newNames = ['cursor', 'grok', 'gemini', 'devin', 'acp'];
  for (const n of newNames) {
    assert.ok(agents.builtin.includes(n), `agents.builtin should include ${n}`);
    assert.ok(agents.names.includes(n), `agents.names should include ${n}`);
  }
});

test('new providers can be lazy-loaded via agents.get and properties', T, async () => {
  const providers = ['cursor', 'grok', 'gemini', 'devin', 'acp'];
  for (const p of providers) {
    const adapter = await agents.get(p);
    assert.ok(adapter, `Adapter ${p} should load`);
    assert.equal(adapter.name, p);
    assert.equal(typeof adapter.run, 'function');
    assert.equal(typeof adapter.models, 'function');

    // Test property accessor
    const directAdapter = await agents[p];
    assert.equal(directAdapter, adapter);
  }
});

test('new providers expose supported models', T, async () => {
  const cursorModels = await agents.models('cursor');
  assert.ok(cursorModels.includes('auto'));
  assert.ok(cursorModels.includes('gpt-5.3-codex'));

  const grokModels = await agents.models('grok');
  assert.ok(grokModels.includes('grok-4.7'));
  assert.ok(grokModels.includes('grok-4'));

  const geminiModels = await agents.models('gemini');
  assert.ok(geminiModels.includes('gemini-3.5-flash'));
  assert.ok(geminiModels.includes('gemini-3-pro-preview'));

  const devinModels = await agents.models('devin');
  assert.ok(devinModels.includes('default'));

  const acpModels = await agents.models('acp');
  assert.ok(acpModels.includes('default'));
});

test('new providers throw NOT_INSTALLED when CLI binary is missing', T, async () => {
  // Test each adapter with an invalid or non-existent binary path via env
  const dummyEnv = process.platform === 'win32' ? { PATH: '', Path: '' } : { PATH: '' };
  for (const name of ['cursor', 'grok', 'gemini', 'devin']) {
    const adapter = await agents.get(name);
    try {
      const it = adapter.run({ prompt: 'test', env: dummyEnv, timeoutMs: 1000 });
      await it.next();
      assert.fail(`Should have thrown for ${name}`);
    } catch (e) {
      assert.ok(
        ['NOT_INSTALLED', 'AGENT_FAILED'].includes(e.code),
        `Expected NOT_INSTALLED or AGENT_FAILED for ${name}, got ${e.code}: ${e.message}`
      );
    }
  }
});
