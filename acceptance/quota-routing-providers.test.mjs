import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearQuotaFixtures,
  setQuotaFixture,
  supportsProactiveQuota,
  validateOptions,
  run,
} from '../dist/index.js';
import { selectQuotaRoute } from '../dist/quota/routing.js';
import { QUOTA_TOOLS } from '../dist/bridge/mcp.js';

test('quota capability registry accepts metered providers and rejects unmetered providers', () => {
  assert.equal(supportsProactiveQuota('claude'), true);
  assert.equal(supportsProactiveQuota('agy'), true);
  assert.equal(supportsProactiveQuota('antigravity'), true);
  assert.equal(supportsProactiveQuota('gemini'), true);
  assert.equal(supportsProactiveQuota('opencode'), false);
});

test('API accepts a quota override for a registered metered provider', () => {
  assert.doesNotThrow(() => validateOptions({
    prompt: 'test',
    quotaPolicy: { minRemainingPercent: 20 },
    fallback: [{ agent: 'gemini', minRemainingPercent: 15 }],
  }));
  assert.throws(() => validateOptions({
    prompt: 'test',
    quotaPolicy: { minRemainingPercent: 20 },
    fallback: [{ agent: 'opencode', minRemainingPercent: 15 }],
  }), /Quota thresholds are unavailable/);
});

test('unsupported explicit route threshold rejects before selecting an earlier ready route', async () => {
  setQuotaFixture('quota-routing-ready-fixture', { usedPercent: 1, windowMinutes: 300 });
  try {
    const iterator = selectQuotaRoute({
      candidates: [
        { id: 'ready', agent: 'quota-routing-ready-fixture' },
        { id: 'unsupported', agent: 'opencode', minRemainingPercent: 10 },
      ],
      quotaPolicy: { minRemainingPercent: 20 },
    });
    await assert.rejects(iterator.next(), /threshold override is not supported|Quota thresholds are unavailable/);
  } finally {
    clearQuotaFixtures();
  }
});

test('quota routing passes the selected model to model-specific readers', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agentbridge-quota-route-model-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, '.gemini');
  mkdirSync(config, { recursive: true });
  writeFileSync(path.join(config, 'oauth_creds.json'), JSON.stringify({
    access_token: 'synthetic-access-token',
    expiry_date: Date.now() + 60_000,
  }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).endsWith(':loadCodeAssist')
    ? { ok: true, status: 200, json: async () => ({ cloudaicompanionProject: 'quota-project' }) }
    : { ok: true, status: 200, json: async () => ({ buckets: [
      { modelId: 'gemini-2.5-pro', tokenType: 'REQUESTS', remainingFraction: 0.8 },
    ] }) };
  try {
    const iterator = selectQuotaRoute({
      candidates: [{ id: 'gemini-model', agent: 'gemini', model: 'gemini-2.5-pro', env: { GEMINI_CLI_HOME: root } }],
      quotaPolicy: { minRemainingPercent: 20 },
    });
    let selected = await iterator.next();
    while (!selected.done) selected = await iterator.next();
    assert.equal(selected.value.model, 'gemini-2.5-pro');
    assert.equal(selected.value.health?.usedPercent, 20);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('library quota routing pins AGY measurement and execution to the same default Gemini model', async () => {
  setQuotaFixture('agy', { groups: [{
    name: 'Gemini models',
    buckets: [
      { window: '5h', remaining_fraction: 0.8 },
      { window: 'weekly', remaining_fraction: 0.8 },
    ],
  }] });
  let executedModel;
  try {
    const adapter = {
      name: 'agy',
      async *run(options) {
        executedModel = options.model;
        return { text: 'done', agent: 'agy' };
      },
    };
    const iterator = run(adapter, { prompt: 'test', quotaPolicy: { minRemainingPercent: 20 } });
    let result = await iterator.next();
    while (!result.done) result = await iterator.next();
    assert.equal(result.value.text, 'done');
    assert.equal(executedModel, 'gemini-3.8-flash-low');
  } finally {
    clearQuotaFixtures();
  }
});

test('offline quota routing does not query live provider quota or authorize an unmeasured route', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('unexpected network query'); };
  let executed = false;
  try {
    const adapter = {
      name: 'gemini',
      async *run() {
        executed = true;
        return { text: 'unexpected', agent: 'gemini' };
      },
    };
    const iterator = run(adapter, {
      prompt: 'test',
      offline: true,
      quotaPolicy: { minRemainingPercent: 20 },
    });
    await assert.rejects(async () => {
      for await (const _event of iterator) { /* drain quota status events */ }
    }, (error) => error.code === 'AGENT_FAILED');
    assert.equal(executed, false);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('check_quota schema accepts a model for model-specific quota providers', () => {
  const schema = QUOTA_TOOLS.find((tool) => tool.name === 'check_quota')?.inputSchema;
  assert.equal(schema?.properties?.model?.type, 'string');
});
