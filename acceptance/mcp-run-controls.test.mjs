import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { callAny, toolSchema, allTools, prepare, serve, serveHttp } from '../dist/bridge/mcp.js';
import { dispatch, listRuns, loadRun } from '../dist/bridge/runs.js';
import { mcpConfigFor } from '../dist/bridge/attach.js';
import { runAsSubagent } from '../dist/bridge/subagent.js';
import codexAdapter from '../dist/adapters/codex.js';
import piAdapter from '../dist/adapters/pi.js';
import { AgentError } from '../dist/core/errors.js';

function testEnv() {
  const home = mkdtempSync(path.join(tmpdir(), 'ab-mcp-controls-'));
  return { home, env: { AGENTBRIDGE_HOME: home, AGENTBRIDGE_MAX_DEPTH: '4' } };
}

function responseFor(output, id) {
  return new Promise((resolve) => {
    let pending = '';
    const onData = (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === id) {
          output.off('data', onData);
          resolve(message);
        }
      }
    };
    output.on('data', onData);
  });
}

function blockingRunSlot() {
  let startResolve;
  let abortResolve;
  let release;
  const slot = {
    started: new Promise((resolve) => { startResolve = resolve; }),
    aborted: new Promise((resolve) => { abortResolve = resolve; }),
    signal: undefined,
    finish: undefined,
    run: async function* (opts) {
      slot.signal = opts.signal;
      startResolve();
      await new Promise((resolve, reject) => {
        release = resolve;
        const onAbort = () => {
          abortResolve();
          reject(new AgentError('ABORTED', 'mock adapter cancelled', { agent: 'pi' }));
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
        slot.finish = () => {
          opts.signal.removeEventListener('abort', onAbort);
          resolve();
        };
      });
      yield { type: 'text', delta: 'done' };
      return { text: 'done', sessionId: 'mock-session', usage: {}, model: 'mock', durationMs: 1 };
    },
  };
  return slot;
}

const postHttpTool = (bridge, id, name, args, signal) => fetch(bridge.url, {
  method: 'POST',
  headers: { authorization: 'Bearer http-lifecycle-key', 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  signal,
}).then(async (response) => ({ status: response.status, body: await response.json() }));

test('wait_run reports its MCP timeout and caps long waits at thirty seconds', async () => {
  const { home, env } = testEnv();
  try {
    const { rec } = dispatch({ agent: 'codex', prompt: 'complete', env, exec: async () => ({ text: 'done', sessionId: 's1' }) });
    await new Promise((resolve) => setImmediate(resolve));
    const result = await callAny('wait_run', { id: rec.id, timeoutSeconds: 90 }, { env });
    assert.equal(result.structuredContent.requestedTimeoutSeconds, 90);
    assert.equal(result.structuredContent.waitTimeoutSeconds, 30);
    assert.equal(result.structuredContent.waitCapped, true);
    assert.equal(result.structuredContent.text, 'done');
    assert.ok(result.structuredContent.attestation, 'completed run attestation is retained');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('wait_run caps the actual MCP wait while leaving the dispatched run alive', async () => {
  const { home, env } = testEnv();
  let finishRun;
  const originalSetTimeout = globalThis.setTimeout;
  let actualWaitMs;
  try {
    const { rec } = dispatch({
      agent: 'codex', prompt: 'long task', env,
      exec: async () => new Promise((resolve) => { finishRun = resolve; }),
    });
    globalThis.setTimeout = (fn, ms, ...args) => {
      if (ms > 29000) {
        actualWaitMs = ms;
        return originalSetTimeout(fn, 0, ...args);
      }
      return originalSetTimeout(fn, ms, ...args);
    };
    const result = await callAny('wait_run', { id: rec.id, timeoutSeconds: 600 }, { env });
    assert.ok(actualWaitMs > 29000 && actualWaitMs <= 30000, `wait cap should be near 30000ms, got ${actualWaitMs}`);
    assert.equal(result.structuredContent.requestedTimeoutSeconds, 600);
    assert.equal(result.structuredContent.waitTimeoutSeconds, 30);
    assert.equal(result.structuredContent.waitCapped, true);
    assert.equal(result.structuredContent.state, 'running');
    finishRun({ text: 'eventually completed' });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    finishRun?.({ text: 'cleanup' });
    rmSync(home, { recursive: true, force: true });
  }
});

test('wait_run rejects malformed or non-positive MCP timeoutSeconds', async () => {
  const { home, env } = testEnv();
  try {
    const { rec } = dispatch({ agent: 'codex', prompt: 'complete', env, exec: async () => ({ text: 'done' }) });
    await new Promise((resolve) => setImmediate(resolve));
    for (const timeoutSeconds of ['bad', 0, -1, Infinity, NaN]) {
      await assert.rejects(callAny('wait_run', { id: rec.id, timeoutSeconds }, { env }), /timeoutSeconds must be a finite positive number/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('tools/call returns structured error details while keeping the text error', async () => {
  const { home, env } = testEnv();
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding('utf8');
  const bridge = serve({ input, output, env });
  try {
    const { rec } = dispatch({ agent: 'codex', prompt: 'complete', env, exec: async () => ({ text: 'done' }) });
    await new Promise((resolve) => setImmediate(resolve));
    const response = new Promise((resolve) => {
      let text = '';
      output.on('data', (chunk) => {
        text += chunk;
        const newline = text.indexOf('\n');
        if (newline >= 0) resolve(JSON.parse(text.slice(0, newline)));
      });
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'wait_run', arguments: { id: rec.id, timeoutSeconds: 'long' } } })}\n`);
    const message = await response;
    assert.equal(message.result.isError, true);
    assert.equal(message.result.structuredContent.error.code, 'BAD_OPTION');
    assert.match(message.result.structuredContent.error.message, /finite positive number/);
    assert.match(message.result.content[0].text, /BAD_OPTION/);
  } finally {
    input.end();
    await bridge.shutdown();
    rmSync(home, { recursive: true, force: true });
  }
});

test('notifications/cancelled stops only the wait and reports the client reason', async () => {
  const { home, env } = testEnv();
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding('utf8');
  const bridge = serve({ input, output, env });
  let finishRun;
  try {
    const { rec } = dispatch({
      agent: 'codex', prompt: 'long task', env,
      exec: async () => new Promise((resolve) => { finishRun = resolve; }),
    });
    const response = new Promise((resolve) => {
      let text = '';
      const onData = (chunk) => {
        text += chunk;
        const lines = text.split('\n');
        for (const line of lines) {
          if (!line) continue;
          const message = JSON.parse(line);
          if (message.id === 42) {
            output.off('data', onData);
            resolve(message);
          }
        }
      };
      output.on('data', onData);
    });
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'wait_run', arguments: { id: rec.id, timeoutSeconds: 30 } } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42, reason: 'client stopped waiting' } })}\n`);
    const message = await response;
    assert.equal(message.result.structuredContent.error.code, 'REQUEST_CANCELLED');
    assert.equal(message.result.structuredContent.error.message, 'client stopped waiting');
    assert.equal(message.result.isError, true);
    assert.equal((await callAny('check_run', { id: rec.id }, { env })).structuredContent.state, 'running');
    finishRun({ text: 'still completed' });
  } finally {
    finishRun?.({ text: 'cleanup' });
    input.end();
    await bridge.shutdown();
    rmSync(home, { recursive: true, force: true });
  }
});

test('sync MCP calls keep ABORTED while exposing request cancellation cause and agent failures', async () => {
  const { home, env } = testEnv();
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding('utf8');
  const bridge = serve({ input, output, env });
  const originalRun = piAdapter.run;
  const seenPrompts = [];
  piAdapter.run = async function* (opts) {
    seenPrompts.push(opts.prompt);
    if (opts.prompt === 'timeout') throw new AgentError('TIMEOUT', 'adapter timed out', { agent: 'pi' });
    if (opts.prompt === 'child died') throw new AgentError('AGENT_FAILED', 'pi child exited', { agent: 'pi', exitCode: 9, stderr: 'broken pipe' });
    if (opts.prompt === 'abort') {
      await new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new AgentError('ABORTED', 'adapter aborted', { agent: 'pi' })), { once: true }));
    }
    yield { type: 'text', delta: 'ok' };
    return { text: 'ok', sessionId: 'mock-session', usage: { input: 1, output: 1 }, model: 'mock', durationMs: 1 };
  };
  try {
    const prompt = 'x'.repeat(2500);
    const ask = await callAny('ask_pi', { prompt }, { env });
    assert.equal(ask.structuredContent.text, 'ok');
    assert.equal(seenPrompts.at(-1), prompt);
    const dispatch = await callAny('dispatch_pi', { prompt }, { env });
    const waited = await callAny('wait_run', { id: dispatch.structuredContent.runId, timeoutSeconds: 30 }, { env });
    assert.equal(waited.structuredContent.state, 'done');
    assert.equal(seenPrompts.at(-1), prompt);

    const timeoutResponse = responseFor(output, 61);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 61, method: 'tools/call', params: { name: 'ask_pi', arguments: { prompt: 'timeout' } } })}\n`);
    const timedOut = (await timeoutResponse).result;
    assert.equal(timedOut.structuredContent.error.code, 'TIMEOUT');
    assert.equal(timedOut.structuredContent.error.message, 'adapter timed out');

    const childResponse = responseFor(output, 62);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 62, method: 'tools/call', params: { name: 'ask_pi', arguments: { prompt: 'child died' } } })}\n`);
    const childFailed = (await childResponse).result;
    assert.equal(childFailed.structuredContent.error.code, 'AGENT_FAILED');
    assert.equal(childFailed.structuredContent.error.detail.cause, 'CHILD_DIED');
    assert.equal(childFailed.structuredContent.error.detail.exitCode, 9);
    assert.equal(childFailed.structuredContent.error.detail.stderr, 'broken pipe');

    const abortResponse = responseFor(output, 63);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 63, method: 'tools/call', params: { name: 'ask_pi', arguments: { prompt: 'abort' } } })}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 63, reason: 'client cancelled' } })}\n`);
    const aborted = (await abortResponse).result;
    assert.equal(aborted.structuredContent.error.code, 'ABORTED');
    assert.equal(aborted.structuredContent.error.detail.cause, 'REQUEST_CANCELLED');
    assert.equal(aborted.structuredContent.error.detail.reason, 'client cancelled');
  } finally {
    piAdapter.run = originalRun;
    input.end();
    await bridge.shutdown();
    rmSync(home, { recursive: true, force: true });
  }
});

test('ask and dispatch expose subdelegation control and recommend async work for long tasks', () => {
  for (const kind of ['ask', 'dispatch']) {
    const schema = toolSchema('codex', kind);
    assert.equal(schema.inputSchema.properties.subdelegation.type, 'boolean');
    assert.match(schema.inputSchema.properties.subdelegation.description, /default true/i);
    assert.match(schema.description, kind === 'ask' ? /dispatch_codex/ : /wait_run/);
  }
  assert.match(toolSchema('codex', 'ask').description, /dispatch_codex/);
});

test('inherited subdelegation=false hides spawning tools and cannot be overridden by a child request', async () => {
  const env = { AGENTBRIDGE_SUBDELEGATION: 'false', AGENTBRIDGE_MAX_DEPTH: '4' };
  const names = allTools(env).map((tool) => tool.name);
  assert.ok(!names.includes('ask_codex'));
  assert.ok(!names.includes('dispatch_codex'));
  assert.ok(names.includes('wait_run') && names.includes('check_run') && names.includes('cancel_run'));
  await assert.rejects(callAny('dispatch_codex', { prompt: 'still try', subdelegation: true }, { env }), /subdelegation is disabled/);
});

test('prepare validates the switch and carries the no-delegation instruction and environment transitively', () => {
  const enabled = prepare('codex', { prompt: 'task' }, { AGENTBRIDGE_MAX_DEPTH: '4' });
  assert.equal(enabled.opts.env.AGENTBRIDGE_SUBDELEGATION, 'true');
  const disabled = prepare('codex', { prompt: 'task', subdelegation: false }, { AGENTBRIDGE_MAX_DEPTH: '4' });
  assert.match(disabled.opts.systemPrompt, /Do this task yourself/);
  assert.equal(disabled.opts.env.AGENTBRIDGE_SUBDELEGATION, 'false');
  assert.throws(() => prepare('codex', { prompt: 'task', subdelegation: 'false' }, {}), /subdelegation must be a boolean/);
});

test('mcpConfigFor propagates disabled subdelegation to a nested bridge', () => {
  const config = mcpConfigFor('codex', { subdelegation: false });
  assert.equal(config.agentbridge.env.AGENTBRIDGE_SUBDELEGATION, 'false');
});

test('HTTP bridge nested calls preserve AGENTBRIDGE_MODEL_* overrides', async () => {
  const { home, env } = testEnv();
  const originalCodexRun = codexAdapter.run;
  const originalPiRun = piAdapter.run;
  let capturedPiModel;
  codexAdapter.run = async function* (opts) {
    assert.ok(opts.extraArgs.includes('mcp_servers.agentbridge_http.tool_timeout_sec=300'));
    const urlConfig = opts.extraArgs.find((arg) => arg.startsWith('mcp_servers.agentbridge_http.url='));
    const url = urlConfig?.match(/url="([^"]+)"/)?.[1];
    assert.ok(url, 'Codex receives the nested HTTP bridge URL');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${opts.env.AGENTBRIDGE_ATTEST_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'ask_pi', arguments: { prompt: 'nested call' } },
      }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    return { text: 'outer complete', sessionId: 'outer-session', usage: {}, model: 'mock-codex', durationMs: 1, exitCode: 0 };
  };
  piAdapter.run = async function* (opts) {
    capturedPiModel = opts.model;
    return { text: 'nested complete', sessionId: 'nested-session', usage: {}, model: opts.model, durationMs: 1, exitCode: 0 };
  };
  try {
    await callAny('ask_codex', { prompt: 'outer call' }, { env: { ...env, AGENTBRIDGE_MODEL_PI: 'expected-custom-model' } });
    assert.equal(capturedPiModel, 'expected-custom-model');
  } finally {
    codexAdapter.run = originalCodexRun;
    piAdapter.run = originalPiRun;
    rmSync(home, { recursive: true, force: true });
  }
});

test('Codex subagent HTTP bridge uses Codex native MCP tool timeout', async () => {
  const originalCodexRun = codexAdapter.run;
  let capturedArgs;
  codexAdapter.run = async function* (opts) {
    capturedArgs = opts.extraArgs;
    return { text: 'no tool output', sessionId: 'mock-session', usage: {}, model: 'mock-codex', durationMs: 1, exitCode: 0 };
  };
  try {
    await runAsSubagent({ caller: 'codex', callee: 'pi', task: 'local fixture task', cwd: process.cwd() });
    assert.ok(capturedArgs.includes('mcp_servers.agentbridge_http.tool_timeout_sec=300'));
  } finally {
    codexAdapter.run = originalCodexRun;
  }
});

test('prepare rejects malformed dispatch arguments and validates every timeout alias strictly', () => {
  const env = { AGENTBRIDGE_MAX_DEPTH: '4' };
  for (const args of [[], { prompt: '' }, { prompt: '  ' }, { prompt: 12 }]) {
    assert.throws(() => prepare('pi', args, env), { code: 'BAD_OPTION' });
  }
  for (const args of [
    { prompt: 'ok', timeoutSeconds: true },
    { prompt: 'ok', timeoutSeconds: '2' },
    { prompt: 'ok', timeout: 'bad' },
    { prompt: 'ok', timeoutSeconds: 2, timeout: false },
  ]) {
    assert.throws(() => prepare('pi', args, env), { code: 'BAD_OPTION' });
  }
  assert.throws(
    () => prepare('pi', { prompt: 'ok' }, { ...env, AGENTBRIDGE_DEFAULT_TIMEOUT_S: 'bad' }),
    { code: 'BAD_OPTION' },
  );
  assert.equal(prepare('pi', { prompt: 'ok', timeout: 120000 }, env).opts.timeoutMs, 120000);
  assert.throws(() => prepare('pi', { prompt: 'ok', subdelegation: null }, env), { code: 'BAD_OPTION' });
});

test('malformed dispatch arguments are rejected before a run record is created', async () => {
  const { home, env } = testEnv();
  try {
    await assert.rejects(callAny('dispatch_pi', [], { env }), { code: 'BAD_OPTION' });
    assert.deepEqual(listRuns(env), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('fallback rejects malformed shape before invoking an adapter', async () => {
  const originalRun = piAdapter.run;
  let called = false;
  piAdapter.run = async function* () { called = true; return { text: 'unexpected' }; };
  try {
    await assert.rejects(callAny('ask_pi', { prompt: 'ok', fallback: 'codex' }, {}), { code: 'BAD_OPTION' });
    assert.equal(called, false);
  } finally {
    piAdapter.run = originalRun;
  }
});

test('runAsSubagent refuses inherited subdelegation=false before starting the caller', async () => {
  const originalRun = piAdapter.run;
  let called = false;
  piAdapter.run = async function* () { called = true; throw new Error('caller adapter should not run'); };
  try {
    await assert.rejects(
      runAsSubagent({ caller: 'pi', callee: 'claude', task: 'x', maxAttempts: 1, env: { AGENTBRIDGE_SUBDELEGATION: 'false' } }),
      { code: 'BAD_OPTION' },
    );
    assert.equal(called, false);
  } finally {
    piAdapter.run = originalRun;
  }
});

test('stdio rejects malformed JSON-RPC and never responds to notifications', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const home = mkdtempSync(path.join(tmpdir(), 'ab-rpc-'));
  output.setEncoding('utf8');
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  const bridge = serve({ input, output, env: { AGENTBRIDGE_HOME: home } });
  const send = async (message) => {
    const start = text.length;
    input.write(`${JSON.stringify(message)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return text.slice(start).split('\n').filter(Boolean).map((line) => JSON.parse(line)).flat();
  };
  try {
    assert.deepEqual(await send({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2024-11-05' } }), []);
    const invalid = await send({ jsonrpc: '1.0', id: 'keep-me', method: 'ping' });
    assert.equal(invalid[0].error.code, -32600);
    assert.equal(invalid[0].id, 'keep-me');
    const badMethod = await send({ jsonrpc: '2.0', id: {}, method: 'ping' });
    assert.equal(badMethod[0].error.code, -32600);
    assert.equal(badMethod[0].id, null);
    const unknown = await send({ jsonrpc: '2.0', id: null, method: 'no_such_method' });
    assert.equal(unknown[0].error.code, -32601);
    assert.equal(unknown[0].id, null);
    const batch = await send([{ jsonrpc: '2.0', method: 'ping' }, 1]);
    assert.equal(batch.length, 1);
    assert.equal(batch[0].error.code, -32600);
    assert.equal(batch[0].id, null);
    assert.deepEqual(await send([{ jsonrpc: '2.0', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } }]), []);
  } finally {
    input.destroy();
    await bridge.shutdown();
    rmSync(home, { recursive: true, force: true });
  }
});

test('HTTP JSON-RPC has the same invalid-request and notification behavior as stdio', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'ab-http-rpc-'));
  const bridge = await serveHttp({ env: { AGENTBRIDGE_HOME: home, AGENTBRIDGE_ATTEST_KEY: 'test-key' } });
  const post = async (body) => fetch(bridge.url, {
    method: 'POST',
    headers: { authorization: 'Bearer test-key', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  try {
    const notification = await post({ jsonrpc: '2.0', method: 'initialize', params: { protocolVersion: '2024-11-05' } });
    assert.equal(notification.status, 202);
    const invalid = await post({ jsonrpc: '1.0', id: 8, method: 'ping' });
    assert.equal(invalid.status, 200);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.error.code, -32600);
    assert.equal(invalidBody.id, 8);
    const badBatch = await post([{ jsonrpc: '2.0', method: 'ping' }, 1]);
    assert.equal(badBatch.status, 200);
    const batchBody = await badBatch.json();
    assert.equal(batchBody.length, 1);
    assert.equal(batchBody[0].error.code, -32600);
    assert.equal(batchBody[0].id, null);
    const notificationBatch = await post([{ jsonrpc: '2.0', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } }]);
    assert.equal(notificationBatch.status, 202);
    assert.equal(await notificationBatch.text(), '');
  } finally {
    await bridge.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('HTTP client disconnect aborts its active synchronous tool call', async () => {
  const { home, env } = testEnv();
  env.AGENTBRIDGE_ATTEST_KEY = 'http-lifecycle-key';
  const bridge = await serveHttp({ env });
  const originalRun = piAdapter.run;
  const slot = blockingRunSlot();
  const clientAbort = new AbortController();
  piAdapter.run = slot.run;
  try {
    const request = postHttpTool(bridge, 71, 'ask_pi', { prompt: 'disconnect me' }, clientAbort.signal).catch(() => undefined);
    await slot.started;
    clientAbort.abort();
    await request;
    await slot.aborted;
    assert.equal(slot.signal.aborted, true);
    assert.equal(slot.signal.reason.message, 'CLIENT_DISCONNECTED');
  } finally {
    slot.finish?.();
    await bridge.close();
    piAdapter.run = originalRun;
    rmSync(home, { recursive: true, force: true });
  }
});

test('HTTP abort during request upload releases its lifecycle and leaves the bridge usable', async () => {
  const { home, env } = testEnv();
  env.AGENTBRIDGE_ATTEST_KEY = 'http-lifecycle-key';
  const bridge = await serveHttp({ env });
  try {
    const requestObserved = new Promise((resolve) => bridge.server.once('request', resolve));
    const req = http.request(bridge.url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer http-lifecycle-key',
        'content-type': 'application/json',
        'content-length': '1000',
      },
    });
    req.on('error', () => {});
    req.write('{"jsonrpc":"2.0","id":77');
    await requestObserved;
    const closed = new Promise((resolve) => req.once('close', resolve));
    req.destroy();
    await closed;

    const response = await postHttpTool(bridge, 78, 'check_run', { id: 'missing' });
    assert.equal(response.status, 200);
    assert.equal(response.body.result.isError, true);
  } finally {
    await bridge.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('HTTP disconnecting a wait leaves the async run running', async () => {
  const { home, env } = testEnv();
  env.AGENTBRIDGE_ATTEST_KEY = 'http-lifecycle-key';
  const bridge = await serveHttp({ env });
  let finishRun;
  const originalSetTimeout = globalThis.setTimeout;
  let waitStartedResolve;
  const waitStarted = new Promise((resolve) => { waitStartedResolve = resolve; });
  try {
    const { rec } = dispatch({
      agent: 'codex', prompt: 'still running', env,
      exec: async () => new Promise((resolve) => { finishRun = resolve; }),
    });
    const clientAbort = new AbortController();
    globalThis.setTimeout = function (callback, delay, ...args) {
      if (delay === 30000) waitStartedResolve();
      return originalSetTimeout(callback, delay, ...args);
    };
    const request = postHttpTool(bridge, 72, 'wait_run', { id: rec.id, timeoutSeconds: 30 }, clientAbort.signal).catch(() => undefined);
    await waitStarted;
    clientAbort.abort();
    await request;
    assert.equal(loadRun(rec.id, env).state, 'running');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    finishRun?.({ text: 'finished after wait disconnect' });
    await bridge.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('HTTP notifications/cancelled aborts the matching request and normal responses stay live', async () => {
  const { home, env } = testEnv();
  env.AGENTBRIDGE_ATTEST_KEY = 'http-lifecycle-key';
  const bridge = await serveHttp({ env });
  const originalRun = piAdapter.run;
  const slots = new Map([['cancel over http', blockingRunSlot()], ['complete over http', blockingRunSlot()]]);
  piAdapter.run = async function* (opts) { return yield* slots.get(opts.prompt).run(opts); };
  try {
    const cancelledSlot = slots.get('cancel over http');
    const request = postHttpTool(bridge, 73, 'ask_pi', { prompt: 'cancel over http' });
    await cancelledSlot.started;
    const notification = await fetch(bridge.url, {
      method: 'POST',
      headers: { authorization: 'Bearer http-lifecycle-key', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 73, reason: 'cancel from http notification' } }),
    });
    assert.equal(notification.status, 202);
    const cancelledResponse = await request;
    assert.equal(cancelledResponse.body.result.structuredContent.error.code, 'ABORTED');
    assert.equal(cancelledResponse.body.result.structuredContent.error.detail.reason, 'cancel from http notification');

    const completeSlot = slots.get('complete over http');
    const completedRequest = postHttpTool(bridge, 74, 'ask_pi', { prompt: 'complete over http' });
    await completeSlot.started;
    completeSlot.finish();
    const completedResponse = await completedRequest;
    assert.equal(completedResponse.body.result.structuredContent.text, 'done');
    assert.equal(completeSlot.signal.aborted, false);
  } finally {
    for (const slot of slots.values()) slot.finish?.();
    await bridge.close();
    piAdapter.run = originalRun;
    rmSync(home, { recursive: true, force: true });
  }
});

test('closing one HTTP bridge aborts only its own active calls', async () => {
  const { home, env } = testEnv();
  env.AGENTBRIDGE_ATTEST_KEY = 'http-lifecycle-key';
  const bridgeA = await serveHttp({ env });
  const bridgeB = await serveHttp({ env });
  const originalRun = piAdapter.run;
  const slots = new Map([['bridge a active', blockingRunSlot()], ['bridge b active', blockingRunSlot()]]);
  piAdapter.run = async function* (opts) { return yield* slots.get(opts.prompt).run(opts); };
  try {
    const requestA = postHttpTool(bridgeA, 75, 'ask_pi', { prompt: 'bridge a active' }).catch(() => undefined);
    const requestB = postHttpTool(bridgeB, 76, 'ask_pi', { prompt: 'bridge b active' });
    const slotA = slots.get('bridge a active');
    const slotB = slots.get('bridge b active');
    await Promise.all([slotA.started, slotB.started]);
    const closing = bridgeA.close();
    await slotA.aborted;
    await closing;
    assert.equal(slotA.signal.aborted, true);
    assert.equal(slotB.signal.aborted, false);
    slotB.finish();
    const responseB = await requestB;
    assert.equal(responseB.body.result.structuredContent.text, 'done');
    assert.equal(slotB.signal.aborted, false);
    await requestA;
  } finally {
    for (const slot of slots.values()) slot.finish?.();
    await bridgeA.close();
    await bridgeB.close();
    piAdapter.run = originalRun;
    rmSync(home, { recursive: true, force: true });
  }
});
