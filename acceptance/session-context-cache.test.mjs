import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSessionContext } from '../dist/telemetry/stats.js';
import { contextOf } from '../dist/telemetry/stats.js';
import { createTracker } from '../dist/telemetry/stats.js';
import { runWithTelemetry } from '../dist/telemetry/track.js';

test('readSessionContext cache separates identical Claude session IDs in different home profiles', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ab-telemetry-cache-'));
  const homeA = path.join(root, 'home-a');
  const homeB = path.join(root, 'home-b');
  const writeClaude = (home, tokens) => {
    const dir = path.join(home, '.claude', 'projects', 'fixture-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'same-session.jsonl'), JSON.stringify({
      type: 'assistant', message: { model: 'fixture-model', usage: { input_tokens: tokens } },
    }));
  };
  try {
    writeClaude(homeA, 111);
    writeClaude(homeB, 999);
    const a = readSessionContext('claude', 'same-session', { homeDir: homeA });
    const b = readSessionContext('claude', 'same-session', { homeDir: homeB });
    assert.equal(a.tokens, 111);
    assert.equal(b.tokens, 999);
    assert.ok(b.file.startsWith(homeB));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readSessionContext cache separates explicit Claude and Codex profile directories', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ab-telemetry-env-cache-'));
  const claudeA = path.join(root, 'claude-a');
  const claudeB = path.join(root, 'claude-b');
  const codexA = path.join(root, 'codex-a');
  const codexB = path.join(root, 'codex-b');
  const writeClaude = (config, tokens) => {
    const dir = path.join(config, 'projects', 'fixture-project');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'explicit-session.jsonl'), JSON.stringify({
      type: 'assistant', message: { model: 'fixture-model', usage: { input_tokens: tokens } },
    }));
  };
  const writeCodex = (home, tokens) => {
    const dir = path.join(home, 'sessions', '2026', '10', '12');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'rollout-2026-10-12-explicit-session.jsonl'), JSON.stringify({
      type: 'token_count', payload: { info: { last_token_usage: { input_tokens: tokens, output_tokens: 0 } } },
    }));
  };
  try {
    writeClaude(claudeA, 222);
    writeClaude(claudeB, 888);
    writeCodex(codexA, 333);
    writeCodex(codexB, 777);
    assert.equal(readSessionContext('claude', 'explicit-session', { env: { CLAUDE_CONFIG_DIR: claudeA } }).tokens, 222);
    assert.equal(readSessionContext('claude', 'explicit-session', { env: { CLAUDE_CONFIG_DIR: claudeB } }).tokens, 888);
    assert.equal(readSessionContext('codex', 'explicit-session', { env: { CODEX_HOME: codexA } }).tokens, 333);
    assert.equal(readSessionContext('codex', 'explicit-session', { env: { CODEX_HOME: codexB } }).tokens, 777);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('critical context checks refresh cached Claude usage before hard-limit preflight', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ab-context-refresh-'));
  const profile = path.join(root, 'claude');
  const sessionDir = path.join(profile, 'projects', 'fixture-project');
  const sessionFile = path.join(sessionDir, 'session-refresh.jsonl');
  const writeUsage = (tokens) => writeFileSync(sessionFile, JSON.stringify({
    type: 'assistant', message: { model: 'fixture-model', usage: { input_tokens: tokens } },
  }));
  const env = { AGENTBRIDGE_HOME: path.join(root, 'agentbridge'), CLAUDE_CONFIG_DIR: profile };
  let started = false;
  const fake = {
    name: 'claude',
    async *run() {
      started = true;
      return { text: 'unexpected', usage: { input: 0, output: 0 }, sessionId: 'session-refresh' };
    },
  };
  try {
    mkdirSync(sessionDir, { recursive: true });
    writeUsage(111);
    assert.equal(readSessionContext('claude', 'session-refresh', { env }).tokens, 111);
    writeUsage(999);
    assert.equal(JSON.parse(readFileSync(sessionFile, 'utf8')).message.usage.input_tokens, 999);

    const it = runWithTelemetry(fake, {
      prompt: 'continue fixture',
      cwd: root,
      session: { mode: 'continue', id: 'session-refresh' },
    }, { env, noGlobalHooks: true, policy: { warn: null, hard: 500 } });
    await assert.rejects(it.next(), (e) => e.reason === 'CONTEXT_HARD_LIMIT');
    assert.equal(started, false, 'the adapter must not start after fresh context exceeds the hard limit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hard-limit preflight refreshes a tracked session record before starting the adapter', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ab-context-tracked-refresh-'));
  const profile = path.join(root, 'claude');
  const sessionDir = path.join(profile, 'projects', 'fixture-project');
  const sessionFile = path.join(sessionDir, 'session-tracked-refresh.jsonl');
  const writeUsage = (tokens) => writeFileSync(sessionFile, JSON.stringify({
    type: 'assistant', message: { model: 'fixture-model', usage: { input_tokens: tokens } },
  }));
  const env = { AGENTBRIDGE_HOME: path.join(root, 'agentbridge'), CLAUDE_CONFIG_DIR: profile };
  let started = false;
  const fake = {
    name: 'claude',
    async *run() {
      started = true;
      return { text: 'unexpected', usage: { input: 0, output: 0 }, sessionId: 'session-tracked-refresh' };
    },
  };
  try {
    mkdirSync(sessionDir, { recursive: true });
    writeUsage(111);
    const tracker = createTracker({
      agent: 'claude',
      opts: { prompt: 'seed tracked context', cwd: root, session: { mode: 'continue', id: 'session-tracked-refresh' } },
      env,
    });
    tracker.onEvent({ type: 'session', id: 'session-tracked-refresh' });
    tracker.finish({ result: { sessionId: 'session-tracked-refresh', usage: { input: 111, output: 0 } } });
    writeUsage(999);

    const it = runWithTelemetry(fake, {
      prompt: 'continue fixture',
      cwd: root,
      session: { mode: 'continue', id: 'session-tracked-refresh' },
    }, { env, noGlobalHooks: true, policy: { warn: null, hard: 500 } });
    await assert.rejects(it.next(), (e) => e.reason === 'CONTEXT_HARD_LIMIT');
    assert.equal(started, false, 'the adapter must not start after fresh context exceeds the hard limit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tracker finish and post-run policy refresh session context written during the run', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ab-context-finish-refresh-'));
  const profile = path.join(root, 'claude');
  const sessionDir = path.join(profile, 'projects', 'fixture-project');
  const sessionFile = path.join(sessionDir, 'session-finish-refresh.jsonl');
  const writeUsage = (tokens) => writeFileSync(sessionFile, JSON.stringify({
    type: 'assistant', message: { model: 'fixture-model', usage: { input_tokens: tokens } },
  }));
  const env = { AGENTBRIDGE_HOME: path.join(root, 'agentbridge'), CLAUDE_CONFIG_DIR: profile };
  const fake = {
    name: 'claude',
    async *run() {
      writeUsage(777);
      yield { type: 'session', id: 'session-finish-refresh' };
      return { text: 'done', usage: { input: 1, output: 1 }, sessionId: 'session-finish-refresh' };
    },
  };
  try {
    mkdirSync(sessionDir, { recursive: true });
    writeUsage(111);
    assert.equal(readSessionContext('claude', 'session-finish-refresh', { env }).tokens, 111);

    const it = runWithTelemetry(fake, {
      prompt: 'fixture',
      cwd: root,
      session: { mode: 'continue', id: 'session-finish-refresh' },
    }, { env, noGlobalHooks: true, policy: { warn: null, hard: null } });
    let result;
    for (;;) {
      const next = await it.next();
      if (next.done) { result = next.value; break; }
    }
    assert.equal(result.telemetry.context.tokens, 777);
    assert.equal(contextOf('session-finish-refresh', { agent: 'claude', env }).tokens, 777);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
