import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { queryGeminiQuota } from '../dist/quota/gemini.js';

const fixedReset = '2026-10-14T03:00:00Z';

function makeHome(t, { creds = {}, settings } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agentbridge-gemini-quota-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.gemini');
  mkdirSync(dir, { recursive: true });
  if (creds !== null) writeFileSync(path.join(dir, 'oauth_creds.json'), JSON.stringify(creds));
  if (settings !== undefined) writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  return root;
}

function mockFetch({ model = 'gemini-3.5-flash', fraction = 0.72, resetTime = fixedReset } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    if (String(url).endsWith(':loadCodeAssist')) {
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ cloudaicompanionProject: 'quota-project' }) };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ buckets: [{ modelId: model, tokenType: 'REQUESTS', remainingFraction: fraction, resetTime }] }),
    };
  };
  return { fetchImpl, calls };
}

test('queries Code Assist using the explicit OAuth profile and returns the exact model bucket', async (t) => {
  const home = makeHome(t, { creds: { access_token: 'synthetic-access-token', expiry_date: Date.now() + 60_000 } });
  const { fetchImpl, calls } = mockFetch();
  const result = await queryGeminiQuota({ env: { GEMINI_CLI_HOME: home }, fetchImpl, model: 'gemini-3.5-flash' });

  assert.equal(result.agent, 'gemini');
  assert.equal(result.usedPercent, 28);
  assert.equal(result.measured, true);
  assert.equal(result.supported, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.windowMinutes, 0);
  assert.equal(result.resetAt, Date.parse(fixedReset));
  assert.equal(result.source, 'live');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
  assert.equal(calls[0].body.metadata.pluginType, 'GEMINI');
  assert.equal(calls[1].url, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');
  assert.deepEqual(calls[1].body, { project: 'quota-project' });
  for (const call of calls) assert.equal(call.init.headers.Authorization, 'Bearer synthetic-access-token');
});

test('uses GOOGLE_CLOUD_PROJECT when configured and never selects another model bucket', async (t) => {
  const home = makeHome(t, { creds: { access_token: 'synthetic-access-token', expiry_date: Date.now() + 60_000 } });
  const { fetchImpl, calls } = mockFetch({ model: 'gemini-3.5-pro', fraction: 0.1 });
  const result = await queryGeminiQuota({ env: { GEMINI_CLI_HOME: home, GOOGLE_CLOUD_PROJECT: 'chosen-project' }, fetchImpl, model: 'gemini-3.5-flash' });

  assert.equal(calls[0].body.cloudaicompanionProject, 'chosen-project');
  assert.equal(result.status, 'unknown');
  assert.equal(result.measured, false);
  assert.equal(result.usedPercent, null);
  assert.equal(result.resetAt, null);
});

test('returns UNKNOWN for absent credentials without calling Google', async () => {
  const result = await queryGeminiQuota({ env: { GEMINI_CLI_HOME: path.join(os.tmpdir(), 'missing-gemini-profile') }, fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal(result.status, 'unknown');
  assert.equal(result.measured, false);
  assert.equal(result.okToProceed, false);
});

test('offline mode returns OFFLINE without reading credentials or calling Google', async () => {
  let calls = 0;
  const result = await queryGeminiQuota({ env: { AGENTBRIDGE_OFFLINE: '1', GEMINI_CLI_HOME: path.join(os.tmpdir(), 'missing-gemini-profile') }, fetchImpl: async () => { calls++; throw new Error('must not fetch'); } });
  assert.equal(result.status, 'offline');
  assert.equal(result.source, 'offline');
  assert.equal(result.measured, false);
  assert.equal(calls, 0);
});

test('returns UNKNOWN and does not refresh or call Google for an expired access token', async (t) => {
  const home = makeHome(t, { creds: { access_token: 'expired-access-token', refresh_token: 'refresh-token', expiry_date: 1 } });
  let calls = 0;
  const result = await queryGeminiQuota({ env: { GEMINI_CLI_HOME: home }, fetchImpl: async () => { calls++; throw new Error('must not fetch'); } });
  assert.equal(result.status, 'unknown');
  assert.equal(calls, 0);
});

test('returns UNKNOWN for API-key and Vertex auth identities', async (t) => {
  const home = makeHome(t, { creds: { access_token: 'synthetic-access-token', expiry_date: Date.now() + 60_000 } });
  const keyMode = makeHome(t, {
    creds: { access_token: 'synthetic-access-token', expiry_date: Date.now() + 60_000 },
    settings: { security: { auth: { selectedType: 'gemini-api-key' } } },
  });
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not fetch'); };
  const apiKey = await queryGeminiQuota({ env: { GEMINI_CLI_HOME: home, GEMINI_API_KEY: 'synthetic-api-key' }, fetchImpl });
  const vertex = await queryGeminiQuota({ env: { GEMINI_CLI_HOME: keyMode, GOOGLE_GENAI_USE_VERTEXAI: 'true' }, fetchImpl });
  assert.equal(apiKey.status, 'unknown');
  assert.equal(vertex.status, 'unknown');
  assert.equal(calls, 0);
});

test('profileDir overrides GEMINI_CLI_HOME as the credential identity', async (t) => {
  const home = makeHome(t, { creds: { access_token: 'wrong-token', expiry_date: Date.now() + 60_000 } });
  const profile = mkdtempSync(path.join(os.tmpdir(), 'agentbridge-gemini-profile-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  writeFileSync(path.join(profile, 'oauth_creds.json'), JSON.stringify({ access_token: 'profile-token', expiry_date: Date.now() + 60_000 }));
  const { fetchImpl, calls } = mockFetch();
  await queryGeminiQuota({ env: { GEMINI_CLI_HOME: home }, profileDir: profile, fetchImpl });
  assert.equal(calls[0].init.headers.Authorization, 'Bearer profile-token');
});

test('returns safe ERROR on HTTP failures and does not leak upstream body text', async (t) => {
  const home = makeHome(t, { creds: { access_token: 'synthetic-access-token', expiry_date: Date.now() + 60_000 } });
  let n = 0;
  const result = await queryGeminiQuota({
    env: { GEMINI_CLI_HOME: home },
    fetchImpl: async () => {
      n++;
      if (n === 1) return { ok: true, status: 200, json: async () => ({ cloudaicompanionProject: 'p' }) };
      return { ok: false, status: 403, statusText: 'Forbidden', json: async () => { throw new Error('secret response body'); } };
    },
  });
  assert.equal(result.status, 'error');
  assert.equal(result.measured, false);
  assert.equal(result.usedPercent, null);
  assert.doesNotMatch(result.error, /secret response body|synthetic-access-token|https:\/\//i);
});

test('uses caller cancellation signal and returns a safe error', async (t) => {
  const home = makeHome(t, { creds: { access_token: 'synthetic-access-token', expiry_date: Date.now() + 60_000 } });
  const controller = new AbortController();
  controller.abort();
  const result = await queryGeminiQuota({
    env: { GEMINI_CLI_HOME: home },
    signal: controller.signal,
    fetchImpl: async (_url, init) => {
      assert.equal(init.signal.aborted, true);
      throw new Error('aborted');
    },
  });
  assert.equal(result.status, 'error');
  assert.equal(result.measured, false);
});

test('uses a supplied fraction of one even when remainingAmount is omitted', async (t) => {
  const home = makeHome(t, { creds: { access_token: 'synthetic-access-token', expiry_date: Date.now() + 60_000 } });
  const { fetchImpl } = mockFetch({ fraction: 1 });
  const result = await queryGeminiQuota({ env: { GEMINI_CLI_HOME: home }, fetchImpl });
  assert.equal(result.status, 'ok');
  assert.equal(result.usedPercent, 0);
});

test('preserves fractional remaining percentage at the configured route threshold', async (t) => {
  const home = makeHome(t, { creds: { access_token: 'synthetic-access-token', expiry_date: Date.now() + 60_000 } });
  const { fetchImpl } = mockFetch({ fraction: 0.804 });
  const result = await queryGeminiQuota({ env: { GEMINI_CLI_HOME: home }, fetchImpl, thresholdPercent: 20 });
  assert.equal(result.usedPercent, 19.6);
  assert.equal(result.okToProceed, true);
});

test('treats an exact remaining threshold as exhausted', async (t) => {
  const home = makeHome(t, { creds: { access_token: 'synthetic-access-token', expiry_date: Date.now() + 60_000 } });
  const { fetchImpl } = mockFetch({ fraction: 0.8 });
  const result = await queryGeminiQuota({ env: { GEMINI_CLI_HOME: home }, fetchImpl, thresholdPercent: 20 });
  assert.equal(result.usedPercent, 20);
  assert.equal(result.okToProceed, false);
});

test('uses the lowest remaining fraction and latest reset across duplicate matching request buckets', async (t) => {
  const home = makeHome(t, { creds: { access_token: 'synthetic-access-token', expiry_date: Date.now() + 60_000 } });
  let n = 0;
  const fetchImpl = async (url, init) => {
    n++;
    if (String(url).endsWith(':loadCodeAssist')) {
      return { ok: true, status: 200, json: async () => ({ cloudaicompanionProject: 'p' }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ buckets: [
        { modelId: 'gemini-3.5-flash', tokenType: 'REQUESTS', remainingFraction: 0.8, resetTime: '2026-10-14T02:00:00Z' },
        { modelId: 'gemini-3.5-flash', tokenType: 'REQUESTS', remainingFraction: 0.6, resetTime: '2026-10-14T04:00:00Z' },
        { modelId: 'gemini-3.5-flash', tokenType: 'INPUT_TOKENS', remainingFraction: 0, resetTime: '2026-10-14T01:00:00Z' },
      ] }),
    };
  };
  const result = await queryGeminiQuota({ env: { GEMINI_CLI_HOME: home }, fetchImpl });
  assert.equal(result.usedPercent, 40);
  assert.equal(result.resetAt, Date.parse('2026-10-14T04:00:00Z'));
});

test('returns UNKNOWN when any matching request bucket has a malformed fraction', async (t) => {
  const home = makeHome(t, { creds: { access_token: 'synthetic-access-token', expiry_date: Date.now() + 60_000 } });
  let n = 0;
  const fetchImpl = async (url) => {
    n++;
    if (String(url).endsWith(':loadCodeAssist')) {
      return { ok: true, status: 200, json: async () => ({ cloudaicompanionProject: 'p' }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ buckets: [
        { modelId: 'gemini-3.5-flash', tokenType: 'REQUESTS', remainingFraction: 0.1, resetTime: fixedReset },
        { modelId: 'gemini-3.5-flash', tokenType: 'REQUESTS', remainingFraction: 2, resetTime: fixedReset },
      ] }),
    };
  };
  const result = await queryGeminiQuota({ env: { GEMINI_CLI_HOME: home }, fetchImpl });
  assert.equal(result.status, 'unknown');
  assert.equal(result.measured, false);
  assert.equal(result.usedPercent, null);
});

test('honors inherited API-key authentication when options.env only overrides the profile', async (t) => {
  const home = makeHome(t, { creds: { access_token: 'synthetic-access-token', expiry_date: Date.now() + 60_000 } });
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'synthetic-inherited-api-key';
  t.after(() => {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  });
  let calls = 0;
  const result = await queryGeminiQuota({
    env: { GEMINI_CLI_HOME: home },
    fetchImpl: async () => { calls++; throw new Error('must not fetch'); },
  });
  assert.equal(result.status, 'unknown');
  assert.equal(calls, 0);
});

test('does not treat a malformed fraction as a measured quota', async (t) => {
  const home = makeHome(t, { creds: { access_token: 'synthetic-access-token', expiry_date: Date.now() + 60_000 } });
  const { fetchImpl } = mockFetch({ fraction: 1.2 });
  const result = await queryGeminiQuota({ env: { GEMINI_CLI_HOME: home }, fetchImpl });
  assert.equal(result.status, 'unknown');
  assert.equal(result.measured, false);
  assert.equal(result.usedPercent, null);
});

test('does not invent a reset timestamp when a valid quota bucket omits one', async (t) => {
  const home = makeHome(t, { creds: { access_token: 'synthetic-access-token', expiry_date: Date.now() + 60_000 } });
  const { fetchImpl } = mockFetch({ fraction: 0.4, resetTime: null });
  const result = await queryGeminiQuota({ env: { GEMINI_CLI_HOME: home }, fetchImpl });
  assert.equal(result.status, 'ok');
  assert.equal(result.measured, true);
  assert.equal(result.usedPercent, 60);
  assert.equal(result.resetAt, null);
  assert.equal(result.windowMinutes, 0);
});
