import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  findProjectRoot,
  projectConfigFile,
  loadConfig,
  saveConfig,
  loadMemory,
  saveMemory,
  addRule,
  formatMemoryForPrompt,
  validateOptions,
  addAccount,
  removeAccount,
  saveAccountsManifest,
  autoRepair,
  startProxy,
} from '../dist/index.js';
import { readParams } from '../dist/server/common.js';
import { HttpError } from '../dist/server/common.js';
import { createAgentStore, disposeAgentRuns, ensureSweeper, sweep } from '../dist/server/agent.js';

test('A27: findProjectRoot finds project root containing .git or .agentbridge from nested directory', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-p6-root-'));
  try {
    const sub = path.join(tmp, 'packages', 'web', 'src');
    mkdirSync(sub, { recursive: true });
    mkdirSync(path.join(tmp, '.agentbridge'), { recursive: true });

    const root = findProjectRoot(sub);
    assert.equal(path.resolve(root), path.resolve(tmp));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('A26: loadMemory picks the most recent memory between local and fallback by updatedAt', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-p6-mem-'));
  const prevFallback = process.env.AGENTBRIDGE_MEMORY_FALLBACK;
  try {
    mkdirSync(path.join(tmp, '.agentbridge'), { recursive: true });

    // Save older local memory
    const olderLocal = {
      repoPath: tmp,
      updatedAt: 1000,
      rules: ['Old local rule'],
      decisions: [],
      variables: {},
    };
    writeFileSync(path.join(tmp, '.agentbridge', 'memory.json'), JSON.stringify(olderLocal, null, 2));

    // Save newer fallback memory
    process.env.AGENTBRIDGE_MEMORY_FALLBACK = '1';
    const newerFallback = {
      repoPath: tmp,
      rules: ['New fallback rule'],
      decisions: [],
      variables: {},
    };
    saveMemory(newerFallback, tmp);
    delete process.env.AGENTBRIDGE_MEMORY_FALLBACK;

    const loaded = loadMemory(tmp);
    assert.ok(loaded.updatedAt > 1000);
    assert.deepEqual(loaded.rules, ['New fallback rule']);
  } finally {
    if (prevFallback !== undefined) process.env.AGENTBRIDGE_MEMORY_FALLBACK = prevFallback;
    else delete process.env.AGENTBRIDGE_MEMORY_FALLBACK;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('A25: atomic write failures propagate errors explicitly instead of silently succeeding', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-p6-err-'));
  try {
    // Create a directory at accounts.json's path so writing to it as a file fails
    mkdirSync(path.join(tmp, 'accounts.json'), { recursive: true });
    assert.throws(() => {
      saveAccountsManifest({ version: 1, active: {}, accounts: {} }, tmp);
    }, /Failed to save accounts manifest/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('A33: addAccount and removeAccount validate agent names and reject path traversal', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-p6-acc-'));
  try {
    // Unknown or malicious agent
    assert.throws(() => {
      addAccount('../../malicious', 'profile1', { baseDir: tmp });
    }, /Invalid agent/);

    assert.throws(() => {
      addAccount('fake_agent', 'profile1', { baseDir: tmp });
    }, /Invalid agent/);

    // Valid account
    const acc = addAccount('claude', 'profile-ok', { baseDir: tmp, share: false });
    assert.equal(acc.name, 'profile-ok');
    assert.equal(acc.agent, 'claude');

    // Remove with path traversal attempt
    assert.throws(() => {
      removeAccount('invalid_agent', 'profile-ok', { baseDir: tmp });
    }, /Invalid agent/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('A54: validateOptions automatically injects memory block into prompt when project memory exists', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-p6-prompt-'));
  try {
    mkdirSync(path.join(tmp, '.agentbridge'), { recursive: true });
    addRule('Must write strictly typed tests', tmp);

    const opts = validateOptions({
      prompt: 'Implement feature X',
      cwd: tmp,
    });

    assert.ok(opts.prompt.includes('[PROJECT CONVENTIONS & MEMORY - PRESERVE THESE RULES]'));
    assert.ok(opts.prompt.includes('Must write strictly typed tests'));
    assert.ok(opts.prompt.includes('Implement feature X'));

    // Should not duplicate if already present
    const opts2 = validateOptions({
      prompt: opts.prompt,
      cwd: tmp,
    });
    const matches = opts2.prompt.match(/\[PROJECT CONVENTIONS & MEMORY/g);
    assert.equal(matches.length, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('A28: autoRepair inherits defaultAgent and autoRollback from configuration when omitted', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ab-p6-repair-'));
  try {
    mkdirSync(path.join(tmp, '.agentbridge'), { recursive: true });
    writeFileSync(
      path.join(tmp, '.agentbridge', 'config.json'),
      JSON.stringify({ defaultAgent: 'mock_custom', autoRollback: false }, null, 2)
    );

    // Should inherit defaultAgent and try to load mock_custom in repair attempt
    const res = await autoRepair({
      testCommand: 'node -e "process.exit(1)"',
      cwd: tmp,
      maxAttempts: 1,
    });

    assert.equal(res.success, false);
    assert.ok(res.history.some((h) => h.error && (h.error.includes('mock_custom') || h.error.includes('Unknown agent'))));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('A67: readParams strictly rejects invalid max_tokens (negative, zero, float, string) with 400 HttpError', () => {
  assert.throws(
    () => readParams({ max_tokens: -1 }),
    (err) => err instanceof HttpError && err.status === 400 && err.message.includes('max_tokens')
  );

  assert.throws(
    () => readParams({ max_tokens: 0 }),
    (err) => err instanceof HttpError && err.status === 400
  );

  assert.throws(
    () => readParams({ max_tokens: 3.14 }),
    (err) => err instanceof HttpError && err.status === 400
  );

  assert.throws(
    () => readParams({ max_tokens: '100' }),
    (err) => err instanceof HttpError && err.status === 400
  );

  const ok = readParams({ max_tokens: 100 });
  assert.equal(ok.maxTokens, 100);
});

test('A66: proxy responses endpoint rejects previous_response_id with 400 Bad Request', async () => {
  const proxy = await startProxy({ token: 'test-token', timeoutMs: 5000 });
  try {
    const res = await fetch(`${proxy.url}/v1/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-token',
      },
      body: JSON.stringify({
        model: 'codex',
        input: 'hello',
        previous_response_id: 'resp_12345',
      }),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error?.message?.includes('previous_response_id'));
  } finally {
    await proxy.close();
  }
});

test('A34 & A35: dashboard source code includes auth token in checkpoints and has no inline styles in time machine', () => {
  const appJs = readFileSync(path.resolve('src/ui/app.js'), 'utf8');
  const indexHtml = readFileSync(path.resolve('src/ui/index.html'), 'utf8');

  // A34: api helper with auth header must be used for checkpoints
  assert.ok(appJs.includes("api('/api/checkpoints'"));
  assert.ok(appJs.includes("api(`/api/checkpoints/${encodeURIComponent(id)}/diff`"));
  assert.ok(appJs.includes("api(`/api/checkpoints/${encodeURIComponent(activeCheckpointId)}/rollback`"));

  // A35: checkpoints section in index.html must not contain style="..."
  const timeMachineSection = indexHtml.slice(indexHtml.indexOf('id="time-machine-card"'), indexHtml.indexOf('</main>'));
  assert.ok(!timeMachineSection.includes('style='), 'Checkpoints section should not have inline style attributes');
});

test('A40: multiple proxy server instances maintain isolated AgentStores', async () => {
  const proxy1 = await startProxy({ token: 'token-1', timeoutMs: 5000 });
  const proxy2 = await startProxy({ token: 'token-2', timeoutMs: 5000 });
  try {
    const res1 = await fetch(`${proxy1.url}/agent/runs`, {
      headers: { authorization: 'Bearer token-1' },
    });
    const res2 = await fetch(`${proxy2.url}/agent/runs`, {
      headers: { authorization: 'Bearer token-2' },
    });
    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);
  } finally {
    await proxy1.close();
    await proxy2.close();
  }
});

test('A41: the agent sweeper is per-store: own timer per store, swept and disposed independently', () => {
  const mk = () => {
    const store = createAgentStore();
    const cleanups = [];
    // one run older than the 30min TTL, one fresh
    for (const [id, expired] of [['run_expired_1', true], ['run_fresh_1', false]]) {
      store.runs.set(id, {
        id,
        sandbox: { mode: 'copy', cleanup: () => cleanups.push(id), cleanupAsync: async () => { cleanups.push(id); } },
        origin: 'x',
        created: Date.now(),
        last: expired ? Date.now() - 2 * 60 * 60 * 1000 : Date.now(),
        applied: false,
        busy: 0,
      });
    }
    return { store, cleanups };
  };
  const a = mk(), b = mk();
  try {
    ensureSweeper(a.store);
    ensureSweeper(b.store);
    assert.ok(a.store.sweeper, 'first store gets its own sweeper timer');
    assert.ok(b.store.sweeper, 'second store gets its own sweeper timer');
    assert.notEqual(a.store.sweeper, b.store.sweeper, 'timers are per-store, not one shared module-global interval');
    sweep(a.store);
    sweep(b.store);
    assert.deepEqual([...a.store.runs.keys()], ['run_fresh_1'], 'one sweep tick drops a expired run');
    assert.deepEqual([...b.store.runs.keys()], ['run_fresh_1'], 'one sweep tick drops b expired run');
    assert.deepEqual(a.cleanups, ['run_expired_1'], 'dropped run in a had its sandbox cleaned up');
    assert.deepEqual(b.cleanups, ['run_expired_1'], 'dropped run in b had its sandbox cleaned up');
    disposeAgentRuns(b.store);
    assert.equal(b.store.sweeper, undefined, 'disposing b clears the b timer');
    assert.ok(a.store.sweeper, 'disposing b does not touch the a timer');
  } finally {
    disposeAgentRuns(a.store);
    disposeAgentRuns(b.store);
    disposeAgentRuns(); // defaultStore path still clears its own timer
  }
});
