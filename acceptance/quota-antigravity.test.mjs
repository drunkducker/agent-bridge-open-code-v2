import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryAntigravityQuota } from '../dist/quota/antigravity.js';
import { findBinary as findAgyBinary } from '../dist/adapters/agy.js';

const fixture = (gemini = { five: 18, weekly: 27 }, claude = { five: 62, weekly: 81 }) => ({
  conversation_id: '',
  status: 'SUCCESS',
  response: '',
  num_turns: 0,
  command: {
    name: 'usage',
    data: {
      groups: [
        { name: 'Gemini Models', buckets: [
          { id: 'gem-5h', window: '5h', remaining_fraction: 1 - gemini.five / 100, reset_time: '2026-10-13T18:00:00Z' },
          { id: 'gem-7d', window: 'weekly', remaining_fraction: 1 - gemini.weekly / 100, reset_time: '2026-10-19T18:00:00Z' },
        ] },
        { name: 'Claude and GPT models', buckets: [
          { id: 'claude-5h', window: '5h', remaining_fraction: 1 - claude.five / 100, reset_time: '2026-10-13T18:00:00Z' },
          { id: 'claude-7d', window: 'weekly', remaining_fraction: 1 - claude.weekly / 100, reset_time: '2026-10-19T18:00:00Z' },
        ] },
      ],
    },
  },
});

test('AGY quota maps known model families to 5h and weekly pools', async () => {
  const gemini = await queryAntigravityQuota({ model: 'gemini-3.8-flash-high', fixture: fixture() });
  assert.equal(gemini.usedPercent, 18);
  assert.equal(gemini.secondaryPercent, 27);
  assert.equal(gemini.windowMinutes, 300);
  assert.equal(gemini.status, 'ok');
  assert.equal(gemini.source, 'fixture');
  assert.equal(gemini.resetAt, Date.parse('2026-10-13T18:00:00Z'));

  const gpt = await queryAntigravityQuota({ model: 'gpt-oss-120b-medium', fixture: fixture() });
  assert.equal(gpt.usedPercent, 62);
  assert.equal(gpt.secondaryPercent, 81);
  assert.equal(gpt.status, 'ok');
});

test('AGY quota uses the documented Gemini default when model is omitted', async () => {
  const status = await queryAntigravityQuota({ fixture: fixture({ five: 11, weekly: 22 }) });
  assert.equal(status.usedPercent, 11);
  assert.equal(status.secondaryPercent, 22);
});

test('unknown model and malformed quota are conservative unknowns', async () => {
  const unknownModel = await queryAntigravityQuota({ model: 'custom-model-xyz', fixture: fixture() });
  assert.equal(unknownModel.status, 'unknown');
  assert.equal(unknownModel.usedPercent, null);
  assert.equal(unknownModel.okToProceed, false);

  const invalid = fixture();
  invalid.command.data.groups[0].buckets[0].remaining_fraction = 1.1;
  const malformed = await queryAntigravityQuota({ model: 'gemini-3.8-flash-low', fixture: invalid });
  assert.equal(malformed.status, 'unknown');
  assert.equal(malformed.usedPercent, null);
});

test('AGY weekly exhaustion blocks even when the 5h bucket is healthy', async () => {
  const status = await queryAntigravityQuota({ model: 'claude-sonnet-5-5-high', fixture: fixture(undefined, { five: 10, weekly: 100 }) });
  assert.equal(status.usedPercent, 10);
  assert.equal(status.secondaryPercent, 100);
  assert.equal(status.okToProceed, false);
  assert.equal(status.blockingWindow, 'secondary');
});

test('AGY threshold comparison preserves fractions and blocks at the exact boundary', async () => {
  const below = await queryAntigravityQuota({ model: 'gemini-3.8-flash-low', thresholdPercent: 20, fixture: fixture({ five: 19.6, weekly: 0 }) });
  assert.equal(below.usedPercent, 19.6);
  assert.equal(below.okToProceed, true);

  const at = await queryAntigravityQuota({ model: 'gemini-3.8-flash-low', thresholdPercent: 20, fixture: fixture({ five: 20, weekly: 0 }) });
  assert.equal(at.usedPercent, 20);
  assert.equal(at.okToProceed, false);
});

function fakeAgy(t, { version = '1.2.16', usage = fixture(), delayMs = 0, stderr = '', usePath = false } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agy-quota-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'fake-agy.mjs');
  writeFileSync(script, `
    const args = process.argv.slice(2);
    if (args.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
    if (args.includes('/usage')) {
      ${delayMs ? `await new Promise(r => setTimeout(r, ${delayMs}));` : ''}
      ${stderr ? `console.error(${JSON.stringify(stderr)});` : ''}
      console.log(${JSON.stringify(JSON.stringify(usage))});
      process.exit(0);
    }
    process.exit(3);
  `);
  if (process.platform === 'win32') {
    const shim = path.join(dir, 'agy.cmd');
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return usePath ? { ...process.env, PATH: dir } : { ...process.env, AGY_BIN: shim };
  }
  const bin = path.join(dir, 'agy');
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(bin, 0o755);
  return usePath ? { ...process.env, PATH: dir } : { ...process.env, AGY_BIN: bin };
}

test('native quota reader checks supported version before querying read-only usage', async (t) => {
  const options = { model: 'gemini-3.8-flash-high', env: fakeAgy(t, { usePath: true }) };
  const status = await queryAntigravityQuota(options);
  assert.equal(status.status, 'ok');
  assert.equal(status.source, 'live');
});

test('AGY adapter treats explicit AGY_BIN as authoritative over PATH', async (t) => {
  const onPath = fakeAgy(t, { usePath: true });
  const explicit = fakeAgy(t);
  const expected = path.resolve(explicit.AGY_BIN);
  assert.equal(path.resolve(findAgyBinary({ ...onPath, AGY_BIN: explicit.AGY_BIN })), expected);
  assert.equal(findAgyBinary({ ...onPath, AGY_BIN: path.join(os.tmpdir(), 'agy-that-does-not-exist') }), null);
});

test('native quota reader refuses unsupported versions without invoking usage', async (t) => {
  const status = await queryAntigravityQuota({ model: 'gemini-3.8-flash-high', env: fakeAgy(t, { version: '1.0.9' }) });
  assert.equal(status.status, 'unknown');
  assert.match(status.error, /unsupported/i);
});

test('native quota reader bounds timeout and caller cancellation without exposing stderr', async (t) => {
  const env = fakeAgy(t, { delayMs: 250, stderr: 'sensitive account token' });
  const timed = await queryAntigravityQuota({ model: 'gemini-3.8-flash-high', env, timeoutMs: 80 });
  assert.equal(timed.status, 'unknown');
  assert.equal(timed.usedPercent, null);
  assert.doesNotMatch(timed.error || '', /sensitive|token/i);

  const controller = new AbortController();
  const pending = queryAntigravityQuota({ model: 'gemini-3.8-flash-high', env, signal: controller.signal, timeoutMs: 2000 });
  setTimeout(() => controller.abort(), 80);
  const cancelled = await pending;
  assert.equal(cancelled.status, 'unknown');
  assert.match(cancelled.error, /cancel/i);
});

test('native quota reader reports missing AGY binary as unmeasured supported quota', async () => {
  const status = await queryAntigravityQuota({ env: { AGY_BIN: '', PATH: '' }, model: 'gemini-3.8-flash-high' });
  assert.equal(status.supported, true);
  assert.equal(status.measured, false);
  assert.equal(status.usedPercent, null);
  assert.equal(status.status, 'unknown');
});
