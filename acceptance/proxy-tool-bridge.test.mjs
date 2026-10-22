// Regression: in API mode, client tools for the claude target must reach the CLI as an MCP server (--mcp-config).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'ab-bridge-test-'));
const argsFile = path.join(dir, 'args.json');
const bin = path.join(dir, 'bin');
import { mkdirSync } from 'node:fs';
mkdirSync(bin);
writeFileSync(
  path.join(bin, 'claude'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const i = a.indexOf('--mcp-config');
let cfg = null;
try { cfg = JSON.parse(a[i + 1].trim().startsWith('{') ? a[i + 1] : fs.readFileSync(a[i + 1], 'utf8')); } catch {}
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args: a, cfg }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'no tool needed', usage: { input_tokens: 1, output_tokens: 1 } }));
`
);
chmodSync(path.join(bin, 'claude'), 0o755);
process.env.PATH = bin + path.delimiter + process.env.PATH;
process.env.AGENTBRIDGE_HOME = path.join(dir, 'home');

const { startProxy } = await import('../dist/server/index.js');

test('claude API mode with client tools passes the bridge MCP server to the CLI', async () => {
  const p = await startProxy({ port: 0, sessionsFile: false });
  try {
    const tools = [{ type: 'function', function: { name: 'consultar_estoque', description: 'stock', parameters: { type: 'object', properties: { sku: { type: 'string' } } } } }];
    await fetch(p.url + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude/haiku', tools, messages: [{ role: 'user', content: 'go' }] }),
    });
    assert.ok(existsSync(argsFile), 'fake claude was spawned');
    const { cfg } = JSON.parse(readFileSync(argsFile, 'utf8'));
    assert.ok(cfg?.mcpServers?.client_tools, 'client_tools MCP server is configured');
  } finally {
    await p.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
