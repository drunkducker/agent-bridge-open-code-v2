import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import codex, { codexDaemonPool } from '../dist/adapters/codex.js';
import { AsyncQueue, CodexAppServerDaemon } from '../dist/adapters/codex-daemon.js';
import { validateOptions } from '../dist/index.js';
import { AgentError } from '../dist/core/errors.js';
import { isInstalled } from '../dist/core/readiness.js';

const T = 120000;
const cwd = mkdtempSync(path.join(tmpdir(), 'cx-appserver-'));

test('codex daemon normalizes current and legacy completed tool items', () => {
  for (const camel of [true, false]) {
    const daemon = new CodexAppServerDaemon(cwd);
    const events = [];
    daemon.activeTurn = { queue: { push: (e) => events.push(e) } };
    const items = [
      { id: 'cmd', type: camel ? 'commandExecution' : 'command_execution', command: 'cat marker.txt',
        ...(camel ? { aggregatedOutput: 'marker', exitCode: 0 } : { aggregated_output: 'marker', exit_code: 0 }) },
      { id: 'file', type: camel ? 'fileChange' : 'file_change', changes: [{ path: 'marker.txt', kind: 'add' }], status: 'completed' },
    ];
    for (const item of items) daemon.handleServerNotification('item/completed', { item }, { item });
    assert.deepEqual(events.filter((e) => e.type === 'tool'), [
      { type: 'tool', name: 'shell', input: { command: 'cat marker.txt' }, output: 'marker', id: 'cmd', exitCode: 0 },
      { type: 'tool', name: 'file_change', input: { changes: items[1].changes }, output: 'completed', id: 'file' },
    ]);
  }
});

test('validateOptions accepts transport and appServer options', () => {
  const o1 = validateOptions({ prompt: 'test', transport: 'app-server' });
  assert.equal(o1.transport, 'app-server');

  const o2 = validateOptions({ prompt: 'test', transport: 'cli' });
  assert.equal(o2.transport, 'cli');

  const o3 = validateOptions({ prompt: 'test', appServer: true });
  assert.equal(o3.appServer, true);

  assert.throws(
    () => validateOptions({ prompt: 'test', transport: 'banana' }),
    (e) => e instanceof AgentError && e.code === 'BAD_OPTION'
  );

  assert.throws(
    () => validateOptions({ prompt: 'test', appServer: 'yes' }),
    (e) => e instanceof AgentError && e.code === 'BAD_OPTION'
  );
});

test('codex app-server: live turn with streaming deltas and session continuity', { timeout: T }, async (t) => {
  if (!isInstalled('codex')) {
    t.skip('codex is not installed');
    return;
  }
  // First turn
  const gen1 = codex.run({
    cwd,
    prompt: 'Reply with exactly: HELLO_APP_SERVER',
    transport: 'app-server',
    permissions: 'full',
    timeoutMs: T,
  });

  const events1 = [];
  let n1 = await gen1.next();
  while (!n1.done) {
    events1.push(n1.value);
    n1 = await gen1.next();
  }
  const res1 = n1.value;

  assert.match(res1.text, /HELLO_APP_SERVER/);
  assert.ok(res1.sessionId, 'Should return a sessionId (threadId)');
  assert.equal(res1.transport, 'app-server');
  assert.ok(res1.usage.input > 0 || res1.usage.output > 0, 'Should have usage metrics');
  assert.ok(events1.some((e) => e.type === 'session'), 'Should emit session event');
  assert.ok(events1.some((e) => e.type === 'text'), 'Should emit streaming text delta events');

  // Verify daemon is alive in the pool
  const daemon = codexDaemonPool.get(cwd);
  assert.ok(daemon.alive, 'Codex daemon process should remain alive in daemon pool');

  // Second turn reusing the persistent daemon in the same session
  const gen2 = codex.run({
    cwd,
    prompt: 'Reply with exactly: TURN_TWO_OK',
    transport: 'app-server',
    session: { mode: 'continue', id: res1.sessionId },
    permissions: 'full',
    timeoutMs: T,
  });

  const events2 = [];
  let n2 = await gen2.next();
  while (!n2.done) {
    events2.push(n2.value);
    n2 = await gen2.next();
  }
  const res2 = n2.value;

  assert.match(res2.text, /TURN_TWO_OK/);
  assert.equal(res2.sessionId, res1.sessionId, 'Should continue the same thread');
  assert.ok(daemon.alive, 'Codex daemon should still be alive after second turn');
});

test('codex daemon approval handler responds correctly by permissions', () => {
  const daemon = codexDaemonPool.get(cwd);

  const responses = [];
  const origSend = daemon.sendResponse;
  const origTurn = daemon.activeTurn;

  daemon.sendResponse = (id, res) => { responses.push({ id, res }); };
  daemon.activeTurn = {
    permissions: 'full',
    queue: { push: () => {}, close: () => {} },
  };

  try {
    // 1. Full permissions -> approved
    daemon.handleServerRequest(10, 'item/commandExecution/requestApproval', { command: 'npm run test' });
    assert.equal(responses[responses.length - 1].res.decision, 'approved');

    // 2. Read-only permissions -> denied
    daemon.activeTurn.permissions = 'read-only';
    daemon.handleServerRequest(11, 'item/commandExecution/requestApproval', { command: 'rm -rf test' });
    assert.deepEqual(responses[responses.length - 1].res.decision, {
      denied: { rejection: 'read-only permission: command execution denied' },
    });

    // 3. Plan mode on file changes -> denied
    daemon.activeTurn.permissions = 'plan';
    daemon.handleServerRequest(12, 'item/fileChange/requestApproval', { path: 'src/file.ts' });
    assert.deepEqual(responses[responses.length - 1].res.decision, {
      denied: { rejection: 'plan permission: file modification denied' },
    });

    // 4. Edit mode on file changes -> approved
    daemon.activeTurn.permissions = 'edit';
    daemon.handleServerRequest(13, 'item/fileChange/requestApproval', { path: 'src/file.ts' });
    assert.equal(responses[responses.length - 1].res.decision, 'approved');
  } finally {
    daemon.sendResponse = origSend;
    daemon.activeTurn = origTurn;
  }
});

test('ACP adapter handles in-flight tool approval and session deltas', async () => {
  const { makeAcpAdapter } = await import('../dist/adapters/acp.js');
  const mockScript = `
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    rl.on('line', (line) => {
      try {
        const j = JSON.parse(line);
        if (j.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { capabilities: {} } }) + '\\n');
        } else if (j.method === 'session/prompt') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/created', params: { sessionId: 'sess-123' } }) + '\\n');
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tool/requestApproval', params: { tool: 'deploy' } }) + '\\n');
        } else if (j.id === 99) {
          if (j.result && j.result.approved) {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'text/delta', params: { delta: 'APPROVED_AND_DONE' } }) + '\\n');
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'turn/completed', params: { usage: { inputTokens: 10, outputTokens: 20 } } }) + '\\n');
          }
        }
      } catch (e) {}
    });
  `;

  const adapter = makeAcpAdapter({
    command: process.execPath,
    args: ['-e', mockScript],
  });

  const gen = adapter.run({ prompt: 'deploy app', permissions: 'full' });
  const events = [];
  let n = await gen.next();
  while (!n.done) {
    events.push(n.value);
    n = await gen.next();
  }
  const res = n.value;

  assert.equal(res.text, 'APPROVED_AND_DONE');
  assert.equal(res.sessionId, 'sess-123');
  assert.equal(res.usage.input, 10);
  assert.equal(res.usage.output, 20);
  assert.ok(events.some((e) => e.type === 'tool' && e.name === 'acp:approval'));
});

test('AsyncQueue: fail() must reject a suspended consumer; close() must end it normally', async () => {
  const err = new AgentError('ABORTED', 'Codex turn aborted', { agent: 'codex' });

  // A consumer suspended inside next() gets the error thrown at it, not a done:true
  const q = new AsyncQueue();
  const pending = q.next();
  q.fail(err);
  await assert.rejects(pending, (e) => e === err);
  await assert.rejects(q.next(), (e) => e === err, 'a later next() must also throw the stored error');

  const drain = async (queue) => {
    const seen = [];
    try {
      for await (const v of queue) seen.push(v);
      return { seen, ended: true };
    } catch (e) {
      return { seen, err: e };
    }
  };

  // A for-await loop suspended on an empty queue must THROW on fail(), never end like success
  const q2 = new AsyncQueue();
  const d2 = drain(q2);
  q2.fail(err);
  const r2 = await d2;
  assert.deepEqual(r2.seen, []);
  assert.ok(!r2.ended, 'fail() must not look like a normal end-of-stream');
  assert.ok(r2.err instanceof AgentError);

  // Aborts must not be swallowed into exitCode:0 turn results
  assert.equal(r2.err.code, 'ABORTED');

  // close() still ends the loop normally (successful turns keep working)
  const q3 = new AsyncQueue();
  q3.push('a');
  const d3 = drain(q3);
  q3.close();
  const r3 = await d3;
  assert.deepEqual(r3.seen, ['a']);
  assert.ok(r3.ended, 'close() must end the loop normally');
  assert.ok(!r3.err);
});

test('codex daemon drops notifications belonging to another turn or thread', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cx-app-gate-'));
  const daemon = new CodexAppServerDaemon(dir);

  const events = [];
  let closed = 0;
  let failErr = null;
  daemon.activeTurn = {
    queue: {
      push: (e) => events.push(e),
      close: () => { closed++; },
      fail: (e) => { failErr = e; },
    },
    permissions: 'full',
    text: '',
    usage: { input: 0, output: 0 },
    threadId: 'th-A',
    turnId: 'turn-A',
  };

  const notify = (method, params) => daemon['handleServerNotification'](method, params, { method, params });

  // Orphan from another turn on the same thread: dropped, never routed to the active queue
  notify('item/agentMessage/delta', { threadId: 'th-A', turnId: 'turn-ORPHAN', itemId: 'i1', delta: 'orphan' });
  assert.equal(daemon.activeTurn.text, '', "another turn's delta must be dropped");
  assert.ok(!events.some((e) => e.type === 'text' && e.delta === 'orphan'));

  // Own turn: accepted
  notify('item/agentMessage/delta', { threadId: 'th-A', turnId: 'turn-A', itemId: 'i2', delta: 'mine' });
  assert.equal(daemon.activeTurn.text, 'mine');

  // Different thread, no turn id: dropped
  notify('item/reasoning/delta', { threadId: 'th-B', delta: 'wrong-thread' });
  assert.ok(!events.some((e) => e.type === 'thinking'));

  // Legacy shape without any ids (existing fixtures): still accepted
  notify('item/reasoning/delta', { delta: 'legacy' });
  assert.ok(events.some((e) => e.type === 'thinking' && e.delta === 'legacy'));

  // Between thread/start and turn/start resolution (turnId unknown yet): accepted while thread matches
  daemon.activeTurn.turnId = undefined;
  notify('item/agentMessage/delta', { threadId: 'th-A', turnId: 'turn-INFLIGHT', delta: 'early' });
  assert.equal(daemon.activeTurn.text, 'mineearly');
  daemon.activeTurn.turnId = 'turn-A';

  // An orphan's turn/completed must neither close nor fail the active (different) turn's queue
  notify('turn/completed', { threadId: 'th-A', turn: { id: 'turn-ORPHAN', status: 'completed' } });
  assert.equal(closed, 0, "orphan completion must not close the active turn's queue");
  assert.equal(failErr, null);

  // Same-turn failure still fails the queue
  notify('turn/completed', { threadId: 'th-A', turn: { id: 'turn-A', status: 'failed', error: { message: 'boom' } } });
  assert.ok(failErr instanceof AgentError);
  assert.match(failErr.message, /boom/);
  assert.equal(closed, 0);

  // Same-turn success still closes the queue
  closed = 0;
  daemon.activeTurn = { ...daemon.activeTurn, turnId: 'turn-A', queue: { push: () => {}, close: () => { closed++; }, fail: () => {} } };
  notify('turn/completed', { threadId: 'th-A', turn: { id: 'turn-A', status: 'completed' } });
  assert.equal(closed, 1);
});

const acpErrScript = (exitCode) => `
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on('line', (line) => {
    try {
      const j = JSON.parse(line);
      if (j.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { capabilities: {} } }) + '\\n');
      } else if (j.method === 'session/prompt') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: -32000, message: 'model exploded' } }) + '\\n');
        process.exit(${exitCode});
      }
    } catch (e) {}
  });
`;

// adapter.run() is a generator method: drain it to completion so assert.rejects sees the throw
const drainRun = (gen) => (async () => {
  for (;;) {
    const n = await gen.next();
    if (n.done) return n.value;
  }
})();

test('ACP adapter fails the run on a JSON-RPC error response (exit 0)', async () => {
  const { makeAcpAdapter } = await import('../dist/adapters/acp.js');
  const adapter = makeAcpAdapter({ command: process.execPath, args: ['-e', acpErrScript(0)] });
  await assert.rejects(
    drainRun(adapter.run({ prompt: 'deploy app', permissions: 'full' })),
    (e) => e instanceof AgentError && e.code === 'AGENT_FAILED' && /ACP agent error -32000/.test(e.message) && /model exploded/.test(e.message)
  );
});

test('ACP adapter fails the run on a JSON-RPC error response (exit 1)', async () => {
  const { makeAcpAdapter } = await import('../dist/adapters/acp.js');
  const adapter = makeAcpAdapter({ command: process.execPath, args: ['-e', acpErrScript(1)] });
  await assert.rejects(
    drainRun(adapter.run({ prompt: 'deploy app', permissions: 'full' })),
    (e) => e instanceof AgentError && e.code === 'AGENT_FAILED' && /model exploded/.test(e.message)
  );
});

const acpInitErrScript = `
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on('line', (line) => {
    try {
      const j = JSON.parse(line);
      if (j.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: -32603, message: 'handshake refused' } }) + '\\n');
        process.exit(0);
      }
    } catch (e) {}
  });
`;

test('ACP adapter fails fast when the initialize handshake returns an error', async () => {
  const { makeAcpAdapter } = await import('../dist/adapters/acp.js');
  const adapter = makeAcpAdapter({ command: process.execPath, args: ['-e', acpInitErrScript] });
  await assert.rejects(
    drainRun(adapter.run({ prompt: 'x', permissions: 'full' })),
    (e) => e instanceof AgentError && e.code === 'AGENT_FAILED' && /handshake refused/.test(e.message)
  );
});

const acpExitScript = `
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on('line', (line) => {
    try {
      const j = JSON.parse(line);
      if (j.method === 'initialize') {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: { capabilities: {} } }) + '\\n');
        process.exit(1);
      }
    } catch (e) {}
  });
`;

test('ACP adapter fails when the process exits nonzero with no text and no completion', async () => {
  const { makeAcpAdapter } = await import('../dist/adapters/acp.js');
  const adapter = makeAcpAdapter({ command: process.execPath, args: ['-e', acpExitScript] });
  await assert.rejects(
    drainRun(adapter.run({ prompt: 'x', permissions: 'full' })),
    (e) => e instanceof AgentError && e.code === 'AGENT_FAILED' && /exited with code 1/.test(e.message)
  );
});

test('codex daemon shutdown cleanup', () => {
  codexDaemonPool.shutdownAll();
  const daemon = codexDaemonPool.get(cwd);
  // After shutdown, get returns a fresh unstarted daemon
  assert.equal(daemon.alive, false);
});

