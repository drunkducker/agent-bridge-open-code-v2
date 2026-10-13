import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { abortAll, cancelRun, dispatch, loadRun, summarize, waitRun, runsDir } from '../dist/bridge/runs.js';
import { ev } from '../dist/core/events.js';
import { Budget, runBudgeted } from '../dist/extras/budget.js';
import { createTracker } from '../dist/telemetry/stats.js';

const tempHome = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'ab-run-diagnostics-')));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('usage event constructor preserves snapshot default and marks explicit deltas', () => {
  assert.deepEqual(ev.usage(6, 2), { type: 'usage', input: 6, output: 2 });
  assert.deepEqual(ev.usage(6, 2, 0.1, true), { type: 'usage', input: 6, output: 2, cost: 0.1, incremental: true });
  assert.deepEqual(ev.usage(6, 2, undefined, true), { type: 'usage', input: 6, output: 2, incremental: true });
});

test('Budget sums incremental usage and replaces it with final snapshots', () => {
  const b = new Budget({ maxTokens: 20 });
  try {
    b.track('run', ev.usage(6, 0, undefined, true));
    b.track('run', ev.usage(6, 0, undefined, true));
    assert.equal(b.spent.tokens, 12);
    b.track('run', ev.usage(12, 0));
    assert.equal(b.spent.tokens, 12, 'final aggregate snapshot must replace, not double-count deltas');
    b.track('snapshot', ev.usage(6, 0));
    b.track('snapshot', ev.usage(6, 0));
    assert.equal(b.spent.tokens, 18, 'unmarked usage remains snapshot-compatible');
  } finally {
    b.dispose();
  }
});

test('runBudgeted stops a generator on the incremental budget event and returns partial totals', async () => {
  let closed = false;
  const seen = [];
  async function* gen() {
    try {
      yield ev.usage(6, 0, undefined, true);
      yield ev.usage(6, 0, undefined, true);
      yield ev.text('SENTINEL');
      return { text: 'SENTINEL', usage: { input: 12, output: 0 } };
    } finally {
      closed = true;
    }
  }
  const r = await runBudgeted('fixture', { prompt: 'fixture' }, { maxTokens: 10 }, { gen, onEvent: (e) => seen.push(e.type) });
  assert.equal(r.aborted, true);
  assert.equal(r.budget.exceeded, 'tokens');
  assert.deepEqual(r.usage, { input: 12, output: 0 });
  assert.deepEqual(seen, ['usage', 'usage']);
  assert.equal(r.text, '');
  assert.equal(closed, true, 'budget abort must close the generator immediately');
});

test('runBudgeted keeps failed fallback usage and replaces only the active attempt with its final snapshot', async () => {
  async function* gen() {
    yield ev.usage(6, 0, undefined, true);
    yield ev.fallback('pi', 'agy', 'RATE_LIMITED', 'fixture');
    yield ev.usage(6, 0, undefined, true);
    return { text: 'done', usage: { input: 6, output: 0 } };
  }
  const r = await runBudgeted('pi', { prompt: 'fixture' }, { maxTokens: 20 }, { gen });
  assert.equal(r.budget.exceeded, null);
  assert.equal(r.budget.spent.tokens, 12, 'the final usage snapshot replaces only the active attempt');
  assert.deepEqual(r.usage, { input: 6, output: 0 });
});

test('runBudgeted applies snapshot cost limits across failed fallback attempts', async () => {
  let reachedText = false;
  async function* gen() {
    yield ev.usage(3, 0, 0.06);
    yield ev.fallback('pi', 'agy', 'RATE_LIMITED', 'fixture');
    yield ev.usage(3, 0, 0.06);
    reachedText = true;
    yield ev.text('SENTINEL');
    return { text: 'SENTINEL', usage: { input: 3, output: 0, cost: 0.06 } };
  }
  const r = await runBudgeted('pi', { prompt: 'fixture' }, { maxCost: 0.1 }, { gen });
  assert.equal(r.aborted, true);
  assert.equal(r.budget.exceeded, 'cost');
  assert.equal(r.budget.spent.cost, 0.12);
  assert.equal(r.usage.cost, 0.12);
  assert.equal(reachedText, false);
});

test('Pi cumulative message usage aborts before a later text event using a local fake binary', async (t) => {
  if (process.platform !== 'win32') return t.skip('fixture uses a Windows .cmd executable');
  const root = tempHome();
  const profile = path.join(root, 'pi-profile');
  mkdirSync(profile, { recursive: true });
  const script = path.join(root, 'fake-pi.mjs');
  const bin = path.join(root, 'fake-pi.cmd');
  writeFileSync(script, [
    "const emit = (x) => process.stdout.write(JSON.stringify(x) + '\\n');",
    "emit({type:'message_end',message:{role:'assistant',usage:{input:6,output:0},content:[],stopReason:'stop'}});",
    "setTimeout(() => emit({type:'message_end',message:{role:'assistant',usage:{input:6,output:0},content:[],stopReason:'stop'}}), 40);",
    "setTimeout(() => { emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'SENTINEL'}}); emit({type:'message_end',message:{role:'assistant',usage:{input:0,output:0},content:[{type:'text',text:'SENTINEL'}],stopReason:'stop'}}); }, 250);",
  ].join('\n'));
  writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`, 'ascii');
  const seen = [];
  try {
    const r = await runBudgeted('pi', {
      prompt: 'fixture prompt', cwd: root, timeoutMs: 3000, session: { mode: 'ephemeral' },
      env: {
        AGENTBRIDGE_HOME: path.join(root, 'agentbridge'),
        PI_BIN: bin,
        PI_CODING_AGENT_DIR: profile,
        PATH: root,
        Path: root,
      },
    }, { maxTokens: 10 }, { onEvent: (e) => { if (e.type === 'usage' || e.type === 'text') seen.push(e); } });
    assert.equal(r.aborted, true);
    assert.equal(r.budget.exceeded, 'tokens');
    assert.equal(r.budget.spent.tokens, 12);
    assert.equal(r.usage.input, 12);
    assert.deepEqual(seen.map((e) => e.type), ['usage', 'usage']);
    assert.ok(seen.every((e) => e.incremental === true));
    assert.equal(r.text, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run registry sums incremental usage and replaces snapshot usage', async () => {
  const env = { AGENTBRIDGE_HOME: tempHome() };
  const hold = deferred();
  let publish;
  const { rec } = dispatch({ agent: 'pi', env, exec: async ({ onEvent }) => {
    publish = onEvent;
    return hold.promise;
  } });
  await Promise.resolve();
  publish(ev.usage(6, 0, undefined, true));
  publish(ev.usage(6, 0, undefined, true));
  assert.deepEqual(loadRun(rec.id, env).usage, { input: 12, output: 0 });
  publish(ev.usage(8, 1));
  assert.deepEqual(loadRun(rec.id, env).usage, { input: 8, output: 1 });
  hold.resolve({ text: 'done', usage: { input: 8, output: 1 } });
  await waitRun(rec.id, 1000, env);
});

test('telemetry replaces unmarked usage snapshots and retains the last event separately', () => {
  const env = { AGENTBRIDGE_HOME: tempHome() };
  const tracker = createTracker({ agent: 'pi', opts: { prompt: 'fixture', session: { mode: 'ephemeral' } }, env });
  tracker.onEvent(ev.usage(6, 0, 0.1));
  tracker.onEvent(ev.usage(10, 0, 0.2));
  const rec = tracker.finish({ error: Object.assign(new Error('fixture failure'), { code: 'AGENT_FAILED' }) });
  assert.deepEqual(rec.usage, { input: 10, output: 0 });
  assert.equal(rec.cost, 0.2);
  assert.deepEqual(rec.lastUsage, { input: 10, output: 0 });
});

test('telemetry accumulates incremental usage while retaining failed fallback attempts on error', () => {
  const env = { AGENTBRIDGE_HOME: tempHome() };
  const tracker = createTracker({ agent: 'pi', opts: { prompt: 'fixture', session: { mode: 'ephemeral' } }, env });
  tracker.onEvent(ev.usage(6, 0, 0.1));
  tracker.onEvent(ev.usage(10, 0, 0.2));
  tracker.onEvent(ev.fallback('pi', 'agy', 'RATE_LIMITED', 'fixture'));
  tracker.onEvent(ev.usage(6, 0, 0.05, true));
  tracker.onEvent(ev.usage(4, 0, 0.05, true));
  const rec = tracker.finish({ error: Object.assign(new Error('fixture failure'), { code: 'AGENT_FAILED' }) });
  assert.deepEqual(rec.usage, { input: 20, output: 0 });
  assert.ok(Math.abs(rec.cost - 0.3) < 1e-10);
  assert.deepEqual(rec.lastUsage, { input: 4, output: 0 });
});

test('run events retain bounded, readable snippets and summarize the latest tool across later thinking events', async () => {
  const env = { AGENTBRIDGE_HOME: tempHome() };
  const hold = deferred();
  let publish;
  const { rec } = dispatch({ agent: 'claude', env, exec: async ({ onEvent }) => {
    publish = onEvent;
    return hold.promise;
  } });
  await Promise.resolve();
  const noisy = 'A\u001b[31mred\u001b[0m\u0000' + 'x'.repeat(300);
  const circular = { answer: noisy };
  circular.self = circular;
  publish({ type: 'text', delta: noisy });
  publish({ type: 'thinking', delta: 'reasoning ' + 't'.repeat(300) });
  publish({ type: 'tool', name: 'search', input: { query: noisy }, output: circular });
  publish({ type: 'thinking', delta: 'later thought' });
  publish({ type: 'tool', name: 'lookup', input: [{ type: 'text', text: noisy }], output: [{ type: 'text', text: noisy }] });
  publish({ type: 'error', error: new Error(noisy) });
  publish({ type: 'error', message: noisy });
  publish({ type: 'tool', name: 'mcp', input: {}, output: { content: [{ type: 'image', data: 'ignored' }, { type: 'text', text: 'MCP readable output' }] } });

  const stored = loadRun(rec.id, env);
  const events = stored.events;
  for (const event of events) {
    for (const value of [event.delta, event.input, event.output, event.error]) {
      if (value !== undefined) assert.ok(value.length <= 200, `${event.type} snippet exceeds 200 characters`);
    }
    const values = [event.delta, event.input, event.output, event.error].filter(Boolean).join(' ');
    assert.doesNotMatch(values, /\u001b|\u0000/);
  }
  assert.equal(events.find((e) => e.type === 'tool').name, 'search');
  assert.ok(events.find((e) => e.type === 'tool').input.includes('query'));
  assert.equal(summarize(stored).lastTool.name, 'mcp');
  assert.match(summarize(stored).lastTool.output, /MCP readable output/);
  assert.ok(summarize(stored).lastTool.t);

  for (let i = 0; i < 25; i++) publish({ type: 'thinking', delta: `t${i}` });
  assert.equal(loadRun(rec.id, env).events.length, 20);
  assert.equal(summarize(loadRun(rec.id, env)).lastTool.name, 'mcp');
  assert.match(summarize(loadRun(rec.id, env)).lastTool.output, /MCP readable output/);
  assert.equal(summarize(loadRun(rec.id, env)).lastEvents.length, 5);
  hold.resolve({ text: 'done' });
  await waitRun(rec.id, 1000, env);
});

test('waitRun abort rejects promptly, clears its timeout, and leaves the live run running', async () => {
  const env = { AGENTBRIDGE_HOME: tempHome() };
  const hold = deferred();
  const { rec } = dispatch({ agent: 'claude', env, exec: () => hold.promise });
  const controller = new AbortController();
  const created = new Set();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = nativeSetTimeout(fn, ms, ...args);
    created.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => { created.delete(handle); return nativeClearTimeout(handle); };
  try {
    const waiting = waitRun(rec.id, 60_000, env, controller.signal);
    const error = new Error('caller gave up');
    error.code = 'REQUEST_CANCELLED';
    controller.abort(error);
    await assert.rejects(waiting, (e) => e.code === 'REQUEST_CANCELLED' && /caller gave up/.test(e.message));
    assert.equal(created.size, 0, 'abort must clear every timer owned by this waiter');
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
  assert.equal(loadRun(rec.id, env).state, 'running', 'aborting a waiter does not cancel the run');
  hold.resolve({ text: 'done' });
});

test('waitRun abort rejects a cross-process registry poll and validates its timeout', async () => {
  const env = { AGENTBRIDGE_HOME: tempHome() };
  const record = {
    id: 'external-run', key: null, promptHash: 'x', root: 'local', pid: process.pid, childPid: null,
    agent: 'claude', model: null, cwd: process.cwd(), state: 'running', startedAt: Date.now(),
    lastEventAt: Date.now(), endedAt: null, usage: null, sessionId: null, events: [], result: null, error: null,
  };
  mkdirSync(runsDir(env), { recursive: true });
  writeFileSync(path.join(runsDir(env), `${record.id}.json`), JSON.stringify(record));
  const controller = new AbortController();
  const waiting = waitRun(record.id, 60_000, env, controller.signal);
  controller.abort({ code: 'REQUEST_CANCELLED', message: 'request cancelled' });
  await assert.rejects(waiting, (e) => e.code === 'REQUEST_CANCELLED' && /request cancelled/.test(e.message));
  await assert.rejects(waitRun(record.id, Infinity, env), /finite nonnegative/);
  await assert.rejects(waitRun(record.id, -1, env), /finite nonnegative/);
  assert.equal(loadRun(record.id, env).state, 'running');
});

test('abortAll only stops live runs in its runs directory', async () => {
  const homeA = tempHome();
  const homeB = tempHome();
  const envA = { AGENTBRIDGE_HOME: homeA, AGENTBRIDGE_ROOT: 'root-a' };
  const envB = { AGENTBRIDGE_HOME: homeB, AGENTBRIDGE_ROOT: 'root-a' };
  let releaseB = () => {};
  const a = dispatch({ agent: 'claude', env: envA, exec: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ text: 'stopped' }), { once: true })) });
  const b = dispatch({ agent: 'claude', env: envB, exec: () => new Promise((resolve) => { releaseB = resolve; }) });
  await Promise.resolve();
  try {
    assert.equal(await abortAll(envA, 1000), 1);
    assert.equal(loadRun(a.rec.id, envA).state, 'cancelled');
    assert.equal(loadRun(b.rec.id, envB).state, 'running');
  } finally {
    releaseB({ text: 'finished' });
    await waitRun(b.rec.id, 1000, envB);
  }
});

test('abortAll scopes by launch root, preserves completed state, and clears its losing timeout', async () => {
  const home = tempHome();
  const envA = { AGENTBRIDGE_HOME: home, AGENTBRIDGE_ROOT: 'root-a' };
  const envAPathAlias = { AGENTBRIDGE_HOME: path.join(home, '.', '..', path.basename(home)), AGENTBRIDGE_ROOT: 'root-a' };
  const envB = { AGENTBRIDGE_HOME: home, AGENTBRIDGE_ROOT: 'root-b' };
  const completed = dispatch({ agent: 'claude', env: envA, exec: async () => ({ text: 'done' }) });
  await waitRun(completed.rec.id, 1000, envA);
  let releaseB = () => {};
  const a = dispatch({ agent: 'claude', env: envA, exec: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ text: 'stopped' }), { once: true })) });
  const b = dispatch({ agent: 'claude', env: envB, exec: () => new Promise((resolve) => { releaseB = resolve; }) });
  await Promise.resolve();

  const pending = new Map();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = nativeSetTimeout(fn, ms, ...args);
    pending.set(handle, ms);
    return handle;
  };
  globalThis.clearTimeout = (handle) => { pending.delete(handle); return nativeClearTimeout(handle); };
  try {
    assert.equal(await abortAll(envAPathAlias, 60_000), 1);
    assert.ok(![...pending.values()].includes(60_000), 'successful shutdown must clear its timeout');
    assert.equal(loadRun(a.rec.id, envA).state, 'cancelled');
    assert.equal(loadRun(b.rec.id, envB).state, 'running');
    assert.equal(loadRun(completed.rec.id, envA).state, 'done');
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
    releaseB({ text: 'finished' });
    await waitRun(b.rec.id, 1000, envB);
  }
  assert.equal(loadRun(a.rec.id, envA).state, 'cancelled');
  assert.equal(loadRun(b.rec.id, envB).state, 'done');
  assert.equal(loadRun(completed.rec.id, envA).state, 'done');
});

test('cancelRun persists cancellation before a signal-ignoring worker settles', async () => {
  const env = { AGENTBRIDGE_HOME: tempHome() };
  const hold = deferred();
  const { rec } = dispatch({ agent: 'claude', env, exec: () => hold.promise });
  try {
    const cancelled = cancelRun(rec.id, env).rec;
    assert.equal(cancelled.state, 'cancelled');
    const persisted = loadRun(rec.id, env);
    assert.equal(persisted.state, 'cancelled');
    assert.equal(persisted.endedAt, null, 'endedAt is set only after worker cleanup settles');
  } finally {
    hold.resolve({ text: 'late completion' });
  }
  const settled = await waitRun(rec.id, 1000, env);
  assert.equal(settled.state, 'cancelled');
  assert.ok(settled.endedAt);
});

test('abortAll persists shutdown cancellation while the worker is still settling', async () => {
  const env = { AGENTBRIDGE_HOME: tempHome() };
  const hold = deferred();
  const { rec } = dispatch({ agent: 'claude', env, exec: () => hold.promise });
  try {
    assert.equal(await abortAll(env, 0), 1);
    const persisted = loadRun(rec.id, env);
    assert.equal(persisted.state, 'cancelled');
    assert.equal(persisted.endedAt, null, 'endedAt is set only after worker cleanup settles');
  } finally {
    hold.resolve({ text: 'late completion' });
  }
  const settled = await waitRun(rec.id, 1000, env);
  assert.equal(settled.state, 'cancelled');
  assert.ok(settled.endedAt);
});
