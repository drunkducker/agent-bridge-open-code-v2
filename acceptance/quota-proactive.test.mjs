import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MOCK_FIXTURES,
  parseAnthropicUsage,
  parseCodexUsage,
  fetchAnthropicUsage,
  fetchCodexUsage,
  getProactiveQuotaStatus,
  formatQuotaStatus,
  formatQuotaForPrompt,
  setQuotaFixture,
  clearQuotaFixtures,
  ANTHROPIC_OAUTH_USAGE_URL,
  CODEX_USAGE_URL,
} from '../dist/quota/proactive.js';

test('parseAnthropicUsage extracts 5h and 7d window usage and resets correctly', () => {
  const fixture = {
    five_hour: {
      used_percentage: 42.6,
      resets_at: '2026-10-09T18:00:00Z',
    },
    seven_day: {
      used_percentage: 15.2,
      resets_at: 1791650000,
    },
  };

  const parsed = parseAnthropicUsage(fixture);
  assert.equal(parsed.fiveHourPercent, 42.6);
  assert.equal(parsed.sevenDayPercent, 15.2);
  assert.equal(typeof parsed.fiveHourResetsAt, 'number');
  assert.equal(typeof parsed.sevenDayResetsAt, 'number');
  assert.equal(parsed.fiveHour?.usedPercent, 42.6);
  assert.equal(parsed.sevenDay?.usedPercent, 15.2);
});

test('parseCodexUsage extracts primary window %, window duration, and reset timestamp', () => {
  const fixture = {
    primary_window: {
      used_percent: 78.4,
      limit_window_seconds: 18000, // 300 minutes
      reset_at: 1791500000,
    },
    secondary_window: {
      used_percent: 32,
      limit_window_seconds: 604800,
      reset_at: 1792100000,
    },
  };

  const parsed = parseCodexUsage(fixture);
  assert.equal(parsed.primaryPercent, 78.4);
  assert.equal(parsed.secondaryPercent, 32);
  assert.equal(parsed.windowMinutes, 300);
  assert.equal(parsed.resetsAt, 1791500000000);
});

test('fetchAnthropicUsage sends oauth-2025-04-20 header and Authorization token', async () => {
  let capturedUrl = '';
  let capturedHeaders = {};

  const mockFetch = async (url, init) => {
    capturedUrl = String(url);
    capturedHeaders = init?.headers || {};
    return {
      ok: true,
      json: async () => ({
        five_hour: { used_percentage: 25, resets_at: Date.now() + 3600000 },
        seven_day: { used_percentage: 10, resets_at: Date.now() + 86400000 },
      }),
    };
  };

  const usage = await fetchAnthropicUsage('test-anthropic-token', { fetchImpl: mockFetch });
  assert.equal(capturedUrl, ANTHROPIC_OAUTH_USAGE_URL);
  assert.equal(capturedHeaders['Authorization'], 'Bearer test-anthropic-token');
  assert.equal(capturedHeaders['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(usage.fiveHourPercent, 25);
  assert.equal(usage.sevenDayPercent, 10);
});

test('fetchCodexUsage sends Authorization token to ChatGPT backend endpoint', async () => {
  let capturedUrl = '';
  let capturedHeaders = {};

  const mockFetch = async (url, init) => {
    capturedUrl = String(url);
    capturedHeaders = init?.headers || {};
    return {
      ok: true,
      json: async () => ({
        primary_window: { used_percent: 65, limit_window_seconds: 18000, reset_at: 1791500000 },
      }),
    };
  };

  const usage = await fetchCodexUsage('test-codex-token', { fetchImpl: mockFetch });
  assert.equal(capturedUrl, CODEX_USAGE_URL);
  assert.equal(capturedHeaders['Authorization'], 'Bearer test-codex-token');
  assert.equal(usage.primaryPercent, 65);
  assert.equal(usage.windowMinutes, 300);
});

test('fallback mock and fixture support when offline or in test mode', async () => {
  clearQuotaFixtures();

  // Test explicit fixture injection
  setQuotaFixture('claude', {
    five_hour: { used_percentage: 88, resets_at: 1791500000 },
    seven_day: { used_percentage: 20, resets_at: 1792000000 },
  });

  const claudeHealth = await getProactiveQuotaStatus('claude', 'any-token');
  assert.equal(claudeHealth.agent, 'claude');
  assert.equal(claudeHealth.usedPercent, 88);
  assert.equal(claudeHealth.windowMinutes, 300);
  assert.equal(claudeHealth.okToProceed, true); // < 95% threshold

  clearQuotaFixtures();
});

test('getProactiveQuotaStatus threshold checks detect approaching limits', async () => {
  clearQuotaFixtures();

  // 1. Normal usage: okToProceed is true
  setQuotaFixture('claude', {
    five_hour: { used_percentage: 40, resets_at: Date.now() + 3600000 },
    seven_day: { used_percentage: 15, resets_at: Date.now() + 86400000 },
  });
  const okStatus = await getProactiveQuotaStatus('claude');
  assert.equal(okStatus.usedPercent, 40);
  assert.equal(okStatus.okToProceed, true);

  // 2. High usage (>= 95%): okToProceed is false
  setQuotaFixture('claude', {
    five_hour: { used_percentage: 96, resets_at: Date.now() + 1800000 },
    seven_day: { used_percentage: 30, resets_at: Date.now() + 86400000 },
  });
  const throttledStatus = await getProactiveQuotaStatus('claude');
  assert.equal(throttledStatus.usedPercent, 96);
  assert.equal(throttledStatus.okToProceed, false);

  // 3. Custom threshold (e.g. 80%)
  setQuotaFixture('codex', {
    primary_window: { used_percent: 85, limit_window_seconds: 18000, reset_at: Date.now() + 3600000 },
  });
  const customThreshold = await getProactiveQuotaStatus('codex', 'token', { thresholdPercent: 80 });
  assert.equal(customThreshold.usedPercent, 85);
  assert.equal(customThreshold.okToProceed, false);

  clearQuotaFixtures();
});

test('formatQuotaStatus and formatQuotaForPrompt format human and prompt outputs', () => {
  const health = {
    agent: 'claude',
    usedPercent: 92,
    windowMinutes: 300,
    resetAt: 1791500000000,
    okToProceed: true,
  };

  const formatted = formatQuotaStatus(health);
  assert.ok(formatted.includes('[claude]'));
  assert.ok(formatted.includes('92% used'));
  assert.ok(formatted.includes('300m window'));
  assert.ok(formatted.includes('OK'));

  const promptBlock = formatQuotaForPrompt(health);
  assert.ok(promptBlock.includes('[PROACTIVE QUOTA - CLAUDE]'));
  assert.ok(promptBlock.includes('Used: 92%'));
  assert.ok(promptBlock.includes('Window: 300m'));
});

test('MCP bridge exposes check_quota tool and returns structured quota status', async () => {
  const { allTools, callAny } = await import('../dist/bridge/mcp.js');
  const tools = allTools();
  const quotaTool = tools.find((t) => t.name === 'check_quota');
  assert.ok(quotaTool, 'check_quota tool should be registered in MCP');

  setQuotaFixture('codex', {
    primary_window: { used_percent: 80, limit_window_seconds: 18000, reset_at: Date.now() + 60000 },
  });

  const res = await callAny('check_quota', { agent: 'codex' });
  assert.ok(res.structuredContent);
  assert.equal(res.structuredContent.agent, 'codex');
  assert.equal(res.structuredContent.usedPercent, 80);
  assert.equal(res.structuredContent.remainingPercent, 20);
  assert.equal(res.structuredContent.okToProceed, true);

  clearQuotaFixtures();
});

// Credential discovery: read the native CLI logins (and ab account profiles) without touching the real home.
function tmpHome(files = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ab-quota-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), JSON.stringify(body));
  }
  return dir;
}

function captureFetch(body) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetchImpl };
}

test('claude quota reads the native login from CLAUDE_CONFIG_DIR and sends the OAuth beta header', async () => {
  clearQuotaFixtures();
  const dir = tmpHome({ '.credentials.json': { claudeAiOauth: { accessToken: 'tok-claude' } } });
  try {
    const { calls, fetchImpl } = captureFetch(DEFAULT_MOCK_FIXTURES.claude);
    const status = await getProactiveQuotaStatus('claude', undefined, { env: { CLAUDE_CONFIG_DIR: dir }, fetchImpl });
    assert.equal(status.status, 'ok');
    assert.equal(status.usedPercent, 15);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, ANTHROPIC_OAUTH_USAGE_URL);
    assert.equal(calls[0].headers.Authorization, 'Bearer tok-claude');
    assert.equal(calls[0].headers['anthropic-beta'], 'oauth-2025-04-20');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claude quota searches the profile dir, not the default home, when a profile is given', async () => {
  clearQuotaFixtures();
  const profile = tmpHome({ '.credentials.json': { claudeAiOauth: { accessToken: 'tok-profile' } } });
  const home = tmpHome({ '.credentials.json': { claudeAiOauth: { accessToken: 'tok-home' } } });
  try {
    const { calls, fetchImpl } = captureFetch(DEFAULT_MOCK_FIXTURES.claude);
    await getProactiveQuotaStatus('claude', undefined, { profileDir: profile, env: { CLAUDE_CONFIG_DIR: home }, fetchImpl });
    assert.equal(calls[0].headers.Authorization, 'Bearer tok-profile');
  } finally {
    rmSync(profile, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('claude profile without a login does not fall back to the default home', async () => {
  clearQuotaFixtures();
  const profile = tmpHome();
  const home = tmpHome({ '.credentials.json': { claudeAiOauth: { accessToken: 'tok-home' } } });
  try {
    const { calls, fetchImpl } = captureFetch(DEFAULT_MOCK_FIXTURES.claude);
    const status = await getProactiveQuotaStatus('claude', undefined, { profileDir: profile, env: { CLAUDE_CONFIG_DIR: home }, fetchImpl });
    assert.equal(status.status, 'unknown');
    assert.equal(status.error, 'No credential or API token configured');
    assert.equal(calls.length, 0);
  } finally {
    rmSync(profile, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('codex quota reads tokens.access_token from CODEX_HOME and sends the ChatGPT account id', async () => {
  clearQuotaFixtures();
  const dir = tmpHome({ 'auth.json': { tokens: { access_token: 'tok-codex', account_id: 'acct-1' } } });
  try {
    const { calls, fetchImpl } = captureFetch(DEFAULT_MOCK_FIXTURES.codex);
    const status = await getProactiveQuotaStatus('codex', undefined, { env: { CODEX_HOME: dir }, fetchImpl });
    assert.equal(status.status, 'ok');
    assert.equal(calls[0].url, CODEX_USAGE_URL);
    assert.equal(calls[0].headers.Authorization, 'Bearer tok-codex');
    assert.equal(calls[0].headers['ChatGPT-Account-Id'], 'acct-1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex profile keeps working with the legacy .auth file', async () => {
  clearQuotaFixtures();
  const profile = tmpHome({ '.auth': { accessToken: 'tok-legacy' } });
  try {
    const { calls, fetchImpl } = captureFetch(DEFAULT_MOCK_FIXTURES.codex);
    await getProactiveQuotaStatus('codex', undefined, { profileDir: profile, env: {}, fetchImpl });
    assert.equal(calls[0].headers.Authorization, 'Bearer tok-legacy');
    assert.equal(calls[0].headers['ChatGPT-Account-Id'], undefined);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('no login anywhere returns unknown without making a request', async () => {
  clearQuotaFixtures();
  const claudeDir = tmpHome();
  const codexDir = tmpHome();
  try {
    const { calls, fetchImpl } = captureFetch({});
    const env = { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir };
    const claude = await getProactiveQuotaStatus('claude', undefined, { env, fetchImpl });
    const codex = await getProactiveQuotaStatus('codex', undefined, { env, fetchImpl });
    assert.equal(claude.status, 'unknown');
    assert.equal(codex.status, 'unknown');
    assert.equal(calls.length, 0);
  } finally {
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(codexDir, { recursive: true, force: true });
  }
});

test('parseAnthropicUsage reads the live `utilization` field', () => {
  const parsed = parseAnthropicUsage({
    five_hour: { utilization: 4, resets_at: '2026-10-10T07:40:00Z' },
    seven_day: { utilization: 2, resets_at: '2026-10-14T00:00:00Z' },
  });
  assert.equal(parsed.fiveHourPercent, 4);
  assert.equal(parsed.sevenDayPercent, 2);
});

test('parseCodexUsage reads windows nested under rate_limit', () => {
  const parsed = parseCodexUsage({
    rate_limit: {
      primary_window: { used_percent: 7, reset_at: 1791650000 },
      secondary_window: { used_percent: 3, reset_at: 1792254800 },
    },
  });
  assert.equal(parsed.primaryPercent, 7);
  assert.equal(parsed.secondaryPercent, 3);
});
