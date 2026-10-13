import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexAppServerDaemon, codexDaemonPool } from '../dist/adapters/codex-daemon.js';
import { AgentError } from '../dist/core/errors.js';

test('A04: daemon pool keys instances by cwd and effective account env', () => {
  const dir1 = mkdtempSync(path.join(tmpdir(), 'cx-p2-pool-'));

  const daemon1 = codexDaemonPool.get(dir1, { CODEX_HOME: '/home/user1/.codex', AGENTBRIDGE_ACCOUNT_NAME: 'work' });
  const daemon2 = codexDaemonPool.get(dir1, { CODEX_HOME: '/home/user2/.codex', AGENTBRIDGE_ACCOUNT_NAME: 'personal' });
  const daemon1Reused = codexDaemonPool.get(dir1, { CODEX_HOME: '/home/user1/.codex', AGENTBRIDGE_ACCOUNT_NAME: 'work' });

  // Different accounts in same directory get distinct daemons
  assert.notEqual(daemon1, daemon2, 'Different accounts in the same directory must yield different daemon instances');
  // Same account in same directory reuses the same daemon
  assert.equal(daemon1, daemon1Reused, 'Same account must reuse the active daemon instance');
});

test('daemon pool separates credentials with identical suffixes and reuses identical effective credentials', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-p2-credential-key-'));
  const alpha = { OPENAI_API_KEY: 'fake-account-alpha-SAME1234', CODEX_HOME: '/codex/shared' };
  const bravo = { OPENAI_API_KEY: 'fake-account-bravo-SAME1234', CODEX_HOME: '/codex/shared' };
  const first = codexDaemonPool.get(dir, alpha);
  assert.equal(codexDaemonPool.get(dir, { ...alpha }), first);
  assert.notEqual(codexDaemonPool.get(dir, bravo), first);
  assert.notEqual(codexDaemonPool.get(dir, { ...alpha, OPENAI_BASE_URL: 'https://provider.invalid/v2' }), first);
});

test('daemon pool identity follows explicit CODEX_API_KEY over inherited credentials', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-p2-codex-key-'));
  const oldOpenAI = process.env.OPENAI_API_KEY;
  const oldCodex = process.env.CODEX_API_KEY;
  process.env.OPENAI_API_KEY = 'inherited-openai-secret';
  process.env.CODEX_API_KEY = 'inherited-codex-secret';
  try {
    const noExplicitKeys = codexDaemonPool.get(dir, {});
    assert.equal(codexDaemonPool.get(dir, { CODEX_API_KEY: '' }), noExplicitKeys, 'inherited API keys are stripped by ensureStarted and must not split the pool');
    const explicitCodexKey = codexDaemonPool.get(dir, { CODEX_API_KEY: 'fake-explicit-codex-secret' });
    assert.notEqual(explicitCodexKey, noExplicitKeys);
    assert.equal(codexDaemonPool.get(dir, { CODEX_API_KEY: 'fake-explicit-codex-secret' }), explicitCodexKey);
  } finally {
    if (oldOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldOpenAI;
    if (oldCodex === undefined) delete process.env.CODEX_API_KEY; else process.env.CODEX_API_KEY = oldCodex;
  }
});

test('daemon pool key respects effective CODEX_HOME and inherited account precedence', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-p2-home-key-'));
  const oldHome = process.env.CODEX_HOME;
  const oldAccount = process.env.AGENTBRIDGE_ACCOUNT_NAME;
  process.env.CODEX_HOME = path.join(dir, 'inherited-home');
  process.env.AGENTBRIDGE_ACCOUNT_NAME = 'process-account';
  try {
    const inherited = codexDaemonPool.get(dir, {});
    assert.equal(codexDaemonPool.get(dir, { AGENTBRIDGE_ACCOUNT_NAME: 'process-account' }), inherited);
    assert.notEqual(codexDaemonPool.get(dir, { CODEX_HOME: '' }), inherited, 'an explicit empty override wins over inherited CODEX_HOME');
  } finally {
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    if (oldAccount === undefined) delete process.env.AGENTBRIDGE_ACCOUNT_NAME; else process.env.AGENTBRIDGE_ACCOUNT_NAME = oldAccount;
  }
});

test('A58 & A05: sendRpc respects AbortSignal and times out cleanly without leaks', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-p2-abort-'));
  const daemon = new CodexAppServerDaemon(dir);
  daemon['isAlive'] = true;
  daemon['p'] = { stdin: { write: () => {} }, child: { killed: false, exitCode: null } };

  // Pre-aborted signal
  const ac = new AbortController();
  ac.abort();

  await assert.rejects(
    daemon.sendRpc('test/method', {}, { signal: ac.signal }),
    (err) => err instanceof AgentError && err.code === 'ABORTED'
  );

  // Signal aborted during execution
  const ac2 = new AbortController();
  const rpcPromise = daemon.sendRpc('test/hanging', {}, { signal: ac2.signal, timeoutMs: 5000 });
  setTimeout(() => ac2.abort(), 10);

  await assert.rejects(
    rpcPromise,
    (err) => err instanceof AgentError && err.code === 'ABORTED'
  );
});

test('A68: turn/completed with failed status propagates AGENT_FAILED', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-p2-fail-'));
  const daemon = new CodexAppServerDaemon(dir);

  // Mock an active turn
  const events = [];
  let errorCaught = null;
  const mockQueue = {
    push: (e) => events.push(e),
    close: () => {},
    fail: (err) => { errorCaught = err; },
  };

  daemon.activeTurn = {
    queue: mockQueue,
    permissions: 'full',
    text: '',
    usage: { input: 10, output: 5 },
  };

  // Simulate turn/completed with failure status
  daemon['handleServerNotification']('turn/completed', {
    turn: {
      status: 'failed',
      error: { message: 'Quota exceeded for model' },
    },
  }, {});

  assert.ok(errorCaught instanceof AgentError);
  assert.equal(errorCaught.code, 'AGENT_FAILED');
  assert.match(errorCaught.message, /Quota exceeded/);
});

test('A03: concurrent runTurn calls are serialized and do not clobber activeTurn', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-p2-turns-'));
  const daemon = new CodexAppServerDaemon(dir);
  daemon['isAlive'] = true;

  const executionLog = [];
  daemon.ensureStarted = async () => {};
  daemon.sendRpc = async (method, params) => {
    if (method === 'turn/start') {
      executionLog.push({ event: 'start', prompt: params.input[0].text });
      // Simulate asynchronous turn completion via notification after delay
      setTimeout(() => {
        executionLog.push({ event: 'complete', prompt: params.input[0].text });
        daemon['handleServerNotification']('turn/completed', { turn: { status: 'completed' } }, {});
      }, 50);
      return { turn: { id: `turn-${Date.now()}` } };
    }
    if (method === 'thread/start') {
      return { thread: { id: 'th-1' } };
    }
    return {};
  };

  // Launch two turns concurrently on the same daemon
  const turn1Promise = (async () => {
    const it = daemon.runTurn({ prompt: 'First turn', permissions: 'read-only' }, Date.now());
    for await (const _ of it) {}
  })();

  const turn2Promise = (async () => {
    const it = daemon.runTurn({ prompt: 'Second turn', permissions: 'full' }, Date.now());
    for await (const _ of it) {}
  })();

  await Promise.all([turn1Promise, turn2Promise]);

  // Turn 1 must start and complete before Turn 2 starts (strictly serialized)
  assert.equal(executionLog.length, 4);
  assert.equal(executionLog[0].event, 'start');
  assert.equal(executionLog[0].prompt, 'First turn');
  assert.equal(executionLog[1].event, 'complete');
  assert.equal(executionLog[1].prompt, 'First turn');
  assert.equal(executionLog[2].event, 'start');
  assert.equal(executionLog[2].prompt, 'Second turn');
  assert.equal(executionLog[3].event, 'complete');
  assert.equal(executionLog[3].prompt, 'Second turn');
});

test('runTurn timeout during delayed thread/start prevents turn/start and is reported as TIMEOUT', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-p2-setup-timeout-'));
  const daemon = new CodexAppServerDaemon(dir);
  daemon.ensureStarted = async () => {};
  const calls = [];
  daemon.sendRpc = async (method) => {
    calls.push(method);
    if (method === 'thread/start') {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { thread: { id: 'thread-late' } };
    }
    if (method === 'turn/start') return { turn: { id: 'turn-should-not-start' } };
    return {};
  };
  const turn = daemon.runTurn({ prompt: 'x', permissions: 'full', timeoutMs: 10 }, Date.now());
  await assert.rejects(async () => { for await (const _ of turn) {} }, (e) => e instanceof AgentError && e.code === 'TIMEOUT');
  assert.deepEqual(calls, ['thread/start']);
});

test('runTurn with an expired t0 deadline does not start the daemon or any RPC', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-p2-expired-deadline-'));
  const daemon = new CodexAppServerDaemon(dir);
  let startupCalls = 0;
  let rpcCalls = 0;
  daemon.ensureStarted = async () => { startupCalls++; };
  daemon.sendRpc = async () => { rpcCalls++; return {}; };
  const expiredT0 = Date.now() - 100;
  await assert.rejects(async () => {
    for await (const _ of daemon.runTurn({ prompt: 'x', permissions: 'full', timeoutMs: 5 }, expiredT0)) {}
  }, (e) => e instanceof AgentError && e.code === 'TIMEOUT');
  assert.equal(startupCalls, 0);
  assert.equal(rpcCalls, 0);
});

test('runTurn timeout aborts a hanging setup RPC promptly with TIMEOUT', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-p2-setup-hang-'));
  const daemon = new CodexAppServerDaemon(dir);
  daemon['isAlive'] = true;
  daemon['p'] = { stdin: { write: () => {} }, child: { killed: false, exitCode: null } };
  daemon.ensureStarted = async (_env, signal) => daemon.sendRpc('thread/start', {}, { signal });
  const t0 = Date.now();
  await assert.rejects(async () => { for await (const _ of daemon.runTurn({ prompt: 'x', permissions: 'full', timeoutMs: 25 }, t0)) {} },
    (e) => e instanceof AgentError && e.code === 'TIMEOUT');
  assert.ok(Date.now() - t0 < 500, 'setup timeout should not wait for sendRpc default timeout');
});

test('runTurn caller abort remains ABORTED, including while queued behind another turn', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-p2-queued-abort-'));
  const daemon = new CodexAppServerDaemon(dir);
  daemon.ensureStarted = async () => {};
  const calls = [];
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  daemon.sendRpc = async (method, params) => {
    calls.push({ method, prompt: params?.input?.[0]?.text });
    if (method === 'thread/start') return { thread: { id: 'thread-1' } };
    if (method === 'turn/start') {
      if (params.input[0].text === 'first') { markFirstStarted(); return { turn: { id: 'turn-1' } }; }
      return { turn: { id: 'turn-2' } };
    }
    return {};
  };
  const first = daemon.runTurn({ prompt: 'first', permissions: 'full' }, Date.now());
  const firstTask = (async () => { for await (const _ of first) {} })();
  await firstStarted;
  const controller = new AbortController();
  const second = daemon.runTurn({ prompt: 'second', permissions: 'full', signal: controller.signal }, Date.now());
  const secondTask = (async () => { for await (const _ of second) {} })();
  controller.abort();
  await assert.rejects(secondTask, (e) => e instanceof AgentError && e.code === 'ABORTED');
  assert.equal(daemon.activeTurn?.text, '', 'queued cancellation must not clobber the active turn');
  const timed = daemon.runTurn({ prompt: 'timed', permissions: 'full', timeoutMs: 10 }, Date.now());
  const timedTask = (async () => { for await (const _ of timed) {} })();
  await assert.rejects(timedTask, (e) => e instanceof AgentError && e.code === 'TIMEOUT');
  assert.equal(daemon.activeTurn?.turnId, 'turn-1', 'queued timeout must not clear the active turn');
  assert.ok(!calls.some((call) => call.prompt === 'timed'), 'a timed out queued turn must never start an RPC');
  daemon['handleServerNotification']('turn/completed', { turn: { status: 'completed' } }, {});
  await firstTask;
});

