import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateOptions } from '../dist/index.js';
import { validate as validateSchema } from '../dist/extras/schema.js';
import { parseReviewVerdict, runEnsemble } from '../dist/extras/consensus.js';
import { runPipeline } from '../dist/extras/pipeline.js';
import { Budget } from '../dist/extras/budget.js';
import { BUILTIN } from '../dist/adapters/endpoint.js';
import { SubagentRoster } from '../dist/bridge/subagent-roster.js';
import { mcpConfigFor } from '../dist/bridge/attach.js';
import claudeAdapter from '../dist/adapters/claude.js';

test('A31: validateOptions accepts writableRoots and validates fallbackOn', () => {
  const o = validateOptions({
    prompt: 'test prompt',
    writableRoots: ['/tmp/allowed'],
    fallbackOn: ['TIMEOUT', 'AGENT_FAILED'],
  });
  assert.deepEqual(o.writableRoots, ['/tmp/allowed']);
  assert.deepEqual(o.fallbackOn, ['TIMEOUT', 'AGENT_FAILED']);
});

test('Claude non-full permissions reject both allowed-tools aliases while full preserves extraArgs', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-claude-extraargs-'));
  const bin = path.join(dir, 'bin');
  const capture = path.join(dir, 'args.json');
  mkdirSync(bin);
  const script = `require('node:fs').writeFileSync(process.env.CAPTURE_ARGS, JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({type:'result',result:'ok'}));\n`;
  writeFileSync(path.join(bin, 'fake-claude.js'), script);
  if (process.platform === 'win32') {
    writeFileSync(path.join(bin, 'claude.cmd'), '@"%~dp0fake-claude.js" %*\r\n');
  } else {
    const cli = path.join(bin, 'claude');
    writeFileSync(cli, `#!/bin/sh\n"${process.execPath}" "${path.join(bin, 'fake-claude.js')}" "$@"\n`);
    chmodSync(cli, 0o755);
  }
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`, CAPTURE_ARGS: capture };
  if (process.platform === 'win32') env.Path = env.PATH;
  try {
    for (const permissions of ['read-only', 'edit', 'plan']) {
      await assert.rejects(
        async () => {
          for await (const _event of claudeAdapter.run({ prompt: 'test', cwd: dir, env, permissions, extraArgs: ['--allowed-tools', 'Bash'] })) {}
        },
        { code: 'BAD_OPTION' },
        `${permissions} must reject --allowed-tools`
      );
    }
    assert.equal(existsSync(capture), false, 'restricted runs must reject before starting the fake CLI');
    for await (const _event of claudeAdapter.run({ prompt: 'test', cwd: dir, env, permissions: 'full', extraArgs: ['--allowed-tools', 'Bash'] })) {}
    assert.ok(JSON.parse(readFileSync(capture, 'utf8')).includes('--allowed-tools'));
    assert.ok(JSON.parse(readFileSync(capture, 'utf8')).includes('Bash'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A43: validateSchema prevents prototype pollution and cyclic self-referential refs', () => {
  // Prototype property access blocked
  const protoSchema = { $ref: '#/__proto__/polluted' };
  const errs1 = validateSchema(protoSchema, {});
  assert.ok(errs1.some((e) => e.includes('prohibited prototype property')));

  // Self-referential loop blocked
  const cyclicSchema = { $ref: '#' };
  const errs2 = validateSchema(cyclicSchema, {});
  assert.ok(errs2.some((e) => e.includes('cyclic or self-referential')));

  // Object.hasOwn ensures inherited properties do not satisfy required
  const reqSchema = { type: 'object', required: ['toString'] };
  const objWithoutOwnToString = Object.create({ toString: () => 'ok' });
  const errs3 = validateSchema(reqSchema, objWithoutOwnToString);
  assert.ok(errs3.some((e) => e.includes('missing required property "toString"')));
});

test('A44: parseReviewVerdict enforces rejection precedence over approved boolean', () => {
  const rawJson = JSON.stringify({
    verdict: 'REJECTED',
    approved: true, // Contradictory flag
    issues: ['Critical flaw in design'],
  });
  const verdict = parseReviewVerdict(rawJson);
  assert.equal(verdict.approved, false, 'Explicit REJECTED verdict must never be approved');
  assert.equal(verdict.verdict, 'REJECTED');
  assert.deepEqual(verdict.issues, ['Critical flaw in design']);
});

test('A72: runEnsemble identifies lack of consensus on tie votes', async () => {
  const mockAgent1 = {
    name: 'agent1',
    async *run() {
      yield { type: 'text', delta: 'Output Alpha' };
      return { text: 'Output Alpha', durationMs: 5, exitCode: 0, model: null, sessionId: null, timedOut: false, usage: { input: 0, output: 0 } };
    },
  };
  const mockAgent2 = {
    name: 'agent2',
    async *run() {
      yield { type: 'text', delta: 'Output Beta' };
      return { text: 'Output Beta', durationMs: 5, exitCode: 0, model: null, sessionId: null, timedOut: false, usage: { input: 0, output: 0 } };
    },
  };

  const res = await runEnsemble({
    agents: [mockAgent1, mockAgent2],
    task: 'Generate an identifier',
  });

  assert.equal(res.hasConsensus, false, 'Ensemble with 1 vs 1 tie must report hasConsensus: false');
  assert.equal(res.consensusMethod, 'tie');
  assert.equal(res.consensus, '');
});

test('A36: runPipeline with stopOnError: false reports success: false when a step fails', async () => {
  const pipeline = {
    name: 'multi-wave',
    steps: [
      {
        id: 'step1',
        agent: 'claude',
        prompt: 'Intentional fail step',
      },
      {
        id: 'step2',
        agent: 'codex',
        prompt: 'Step 2 prompt',
        dependsOn: ['step1'],
      },
    ],
  };

  // Mock agent run
  const origGet = (await import('../dist/index.js')).agents.get;
  (await import('../dist/index.js')).agents.get = async (name) => {
    if (name === 'claude') {
      return {
        name: 'claude',
        async *run() {
          throw new Error('Step 1 execution error');
        },
      };
    }
    return {
      name: 'codex',
      async *run() {
        yield { type: 'text', delta: 'Step 2 succeeded' };
        return { text: 'Step 2 succeeded', durationMs: 5, exitCode: 0, model: null, sessionId: null, timedOut: false, usage: { input: 0, output: 0 } };
      },
    };
  };

  try {
    const res = await runPipeline(pipeline, { stopOnError: false });
    assert.equal(res.success, false, 'Pipeline with failing step must report success: false even if stopOnError is false');
    assert.equal(res.failedStepId, 'step1');
    assert.equal(res.stepResults.step1.success, false);
  } finally {
    (await import('../dist/index.js')).agents.get = origGet;
  }
});

test('A37: Budget.track supports multi-turn incremental usage events', () => {
  const b = new Budget({ maxTokens: 100 });
  b.track('run1', { type: 'usage', input: 30, output: 20, incremental: true });
  assert.equal(b.spent.tokens, 50);
  assert.equal(b.exceeded, null);

  b.track('run1', { type: 'usage', input: 40, output: 20, incremental: true });
  assert.equal(b.spent.tokens, 110);
  assert.equal(b.exceeded, 'tokens');
  b.dispose();
});

test('A63: BUILTIN array in endpoint adapter reserves all 10 built-in agents', () => {
  for (const name of ['claude', 'codex', 'opencode', 'agy', 'pi', 'cursor', 'grok', 'gemini', 'devin', 'acp']) {
    assert.ok(BUILTIN.includes(name), `BUILTIN must include ${name}`);
  }
});

test('A64: SubagentRoster parses full MCP prefixes and tracks async dispatch runId', () => {
  const roster = new SubagentRoster();

  // Test full mcp prefix: mcp__agentbridge__ask_codex
  const node = roster.consumeEvent({
    type: 'tool',
    name: 'mcp__agentbridge__ask_codex',
    id: 'call-123',
    input: { prompt: 'Subagent mission' },
  });

  assert.ok(node, 'Roster must register node for mcp__agentbridge__ prefixed call');
  assert.equal(node.name, 'codex');
  assert.equal(node.status, 'running');

  // Test async dispatch response with runId: must remain running
  const updated = roster.consumeEvent({
    type: 'tool',
    name: 'mcp__agentbridge__dispatch_claude',
    id: 'call-123',
    result: { runId: 'run_bg_456' },
  });

  assert.equal(updated.status, 'running', 'Async dispatch with runId must remain running');
});

test('A69: mcpConfigFor gracefully handles all supported agents and returns empty object on unknown', () => {
  const cfgCursor = mcpConfigFor('cursor', {});
  assert.ok(cfgCursor.agentbridge, 'cursor should receive agentbridge bridge configuration');

  const cfgUnknown = mcpConfigFor('custom-unknown-agent', {});
  assert.deepEqual(cfgUnknown, {}, 'unknown caller agent should return empty config without throwing');
});

test('A06 & A70: Cursor adapter rejects unsupported options', async () => {
  const cursorMod = await import('../dist/adapters/cursor.js');
  const cursor = cursorMod.default;

  await assert.rejects(
    async () => {
      const it = cursor.run({ prompt: 'hi', session: { mode: 'continue', id: 's1' } });
      await it.next();
    },
    (err) => {
      assert.equal(err.code, 'BAD_OPTION');
      assert.match(err.message, /session mode "continue"/);
      return true;
    }
  );

  await assert.rejects(
    async () => {
      const it = cursor.run({ prompt: 'hi', offline: true });
      await it.next();
    },
    (err) => {
      assert.equal(err.code, 'BAD_OPTION');
      assert.match(err.message, /Offline mode/);
      return true;
    }
  );
});

test('A71: shared cli-json-lines runner keeps cursor behavior (fake binary: parity, NOT_LOGGED_IN, ABORTED, TIMEOUT)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ab-fake-cursor-'));
  const node = process.execPath;
  writeFileSync(
    path.join(dir, 'fake-cursor.mjs'),
    `import { writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const pick = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const mode = pick('--fake-mode') || 'happy'
const dump = pick('--fake-args-file')
if (dump) writeFileSync(dump, JSON.stringify(args))
if (mode === 'happy') {
  const nl = String.fromCharCode(10)
  const line = (o) => process.stdout.write(JSON.stringify(o) + nl)
  line({ type: 'system', subtype: 'init', session_id: 's1' })
  line({ type: 'tool_call', subtype: 'started', tool_call: { readToolCall: { args: { path: 'a.ts' } } }, session_id: 's1' })
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] }, session_id: 's1' })
  line({ type: 'result', subtype: 'success', result: 'Hello world', session_id: 's1' })
} else if (mode === 'auth') {
  process.stderr.write('error: unauthorized')
  process.exit(1)
} else {
  setInterval(() => {}, 1000)
}
`
  );
  if (process.platform === 'win32') {
    writeFileSync(path.join(dir, 'cursor-agent.cmd'), '@echo off\r\n"' + node + '" "%~dp0fake-cursor.mjs" %*\r\n');
  } else {
    const sh = path.join(dir, 'cursor-agent');
    writeFileSync(sh, '#!/bin/sh\n"' + node + '" "' + path.join(dir, 'fake-cursor.mjs') + '" "$@"\n');
    chmodSync(sh, 0o755);
  }
  const env = { PATH: dir + path.delimiter + process.env.PATH };
  const { default: cursor } = await import('../dist/adapters/cursor.js');
  const drain = async (opts = {}) => {
    const events = [];
    const it = cursor.run({ prompt: 'test prompt', env, permissions: 'read-only', ...opts });
    let x;
    for (;;) {
      x = await it.next();
      if (x.done) break;
      events.push(x.value);
    }
    return { events, result: x.value };
  };
  try {
    // behavior parity: argv order, prompt prefix, event mapping, result fields
    const dumpFile = path.join(dir, 'args.json');
    const { events, result } = await drain({ model: 'gpt-5.3-codex', extraArgs: ['--fake-mode', 'happy', '--fake-args-file', dumpFile] });
    assert.deepEqual(JSON.parse(readFileSync(dumpFile, 'utf8')), [
      '--print', '--output-format', 'stream-json', '--model', 'gpt-5.3-codex', '--mode', 'ask', '--fake-mode', 'happy', '--fake-args-file', dumpFile,
      '--', '[READ-ONLY MODE: Do NOT edit files or run modifying commands]\n\ntest prompt',
    ]);
    assert.equal(events.filter((e) => e.type === 'raw').length, 4);
    assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.delta), ['Hello world']);
    assert.deepEqual(events.find((e) => e.type === 'session'), { type: 'session', id: 's1' });
    assert.deepEqual(events.find((e) => e.type === 'tool'), { type: 'tool', name: 'readToolCall', input: { path: 'a.ts' } });
    assert.equal(events.find((e) => e.type === 'usage'), undefined);
    assert.deepEqual(result.usage, { input: 0, output: 0, cost: null });
    assert.equal(result.sessionId, 's1');
    assert.equal(result.model, 'gpt-5.3-codex');
    assert.equal(result.exitCode, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.text, 'Hello world');

    // default result model when o.model is unset
    const { result: r2 } = await drain({ extraArgs: ['--fake-mode', 'happy'] });
    assert.equal(r2.model, 'auto');

    // auth regex -> NOT_LOGGED_IN (exit 1, no stdout, stderr matches /auth|login|unauthorized/i)
    await assert.rejects(
      async () => {
        await drain({ extraArgs: ['--fake-mode', 'auth'] });
      },
      (e) => {
        assert.equal(e.code, 'NOT_LOGGED_IN');
        assert.equal(e.agent, 'cursor');
        assert.equal(e.message, 'Cursor CLI is not authenticated: error: unauthorized');
        return true;
      }
    );

    // abort signal -> ABORTED
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(
      async () => {
        await drain({ signal: ac.signal, extraArgs: ['--fake-mode', 'hang'] });
      },
      (e) => {
        assert.equal(e.code, 'ABORTED');
        assert.equal(e.message, 'Cursor CLI execution was aborted');
        assert.equal(e.partial, '');
        return true;
      }
    );

    // timeout -> TIMEOUT
    await assert.rejects(
      async () => {
        await drain({ timeoutMs: 300, extraArgs: ['--fake-mode', 'hang'] });
      },
      (e) => {
        assert.equal(e.code, 'TIMEOUT');
        assert.equal(e.message, 'Cursor CLI timed out after 300ms');
        assert.equal(e.timedOut, true);
        assert.equal(e.partial, '');
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
