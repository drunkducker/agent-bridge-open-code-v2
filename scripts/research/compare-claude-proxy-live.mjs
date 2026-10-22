// Usage: node scripts/research/compare-claude-proxy-live.mjs <fresh-dist> <results.json>
import { runStudy, PersistentStdio } from './other-harnesses-common.mjs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stockTool } from './other-harnesses-common.mjs';
import { sse } from './codex-direct-minimal.mjs';
if (!process.argv.includes('--diagnose-only')) await runStudy({ harness: 'claude', model: 'haiku',
  direct: { implemented: false, measured: false, reason: 'Existing subscription login is not treated as an API key. OAuth replay outside the official binary was not authorized by provider documentation.',
    source: 'https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use' },
  limitations: ['Production Claude uses the native MCP client-tool bridge; injected adapter selection uses prompt emulation. Tool-path differences are not pure process overhead.',
    'Persistent CLI is a sequential continuous conversation, not independent stateless requests. No production pooling/isolation claim.'],
  persistent: async ({ dist, scratch }) => new PersistentStdio('claude', 'haiku', dist, scratch) });

// Additional control: keep spawn-per-request, change only dispatch to the injected/emulated tool path.
// This prevents attributing a tool-bridge defect to a benefit of process persistence.
const [distArg, outputArg] = process.argv.slice(2);
if (!distArg || !outputArg) throw Error('Provide fresh dist and results JSON');
const dist = resolve(distArg), output = resolve(outputArg);
const result = JSON.parse(await readFile(output, 'utf8'));
const scratch = await mkdtemp(join(tmpdir(), 'ab-claude-tool-control-'));
process.env.AGENTBRIDGE_HOME = join(scratch, 'state');
const { startProxy } = await import(pathToFileURL(join(dist, 'server/index.js')));
const { default: native } = await import(pathToFileURL(join(dist, 'adapters/claude.js')));
const original = native.run;
let proxy, control;
const tools = [{ type: 'function', function: stockTool }];
const messages = [{ role: 'user', content: 'Consulte o estoque do SKU CANECA-AZUL com consultar_estoque. Quando receber o resultado, responda exatamente: Estoque: N unidades. Substitua N pela quantidade retornada.' }];
try {
  // Offline seam inspection: no model call, no change to files or production implementation.
  native.run = async function* (o) {
    result.currentDispatchDiagnostic = { offline: true, mcpServerNames: Object.keys(o.mcpServers || {}),
      extraArgs: o.extraArgs, hasToolSchemasInSystem: o.systemPrompt?.includes('<tools>') || false,
      hasBridgeInstructions: o.systemPrompt?.includes('native tool-calling mechanism') || false };
    yield { type: 'text', delta: 'DIAGNOSTIC_ONLY' };
    return { text: 'DIAGNOSTIC_ONLY', usage: { input: 0, output: 0 } };
  };
  proxy = await startProxy({ port: 0, sessionsFile: false, pruneLeftovers: false });
  await (await fetch(proxy.url + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude/haiku', messages, tools }) })).text();
  await proxy.close(); proxy = null; native.run = original;
  control = await startProxy({ port: 0, sessionsFile: false, pruneLeftovers: false,
    adapters: { claude: { ...native, run: o => original.call(native, o) } } });
  const rows = [];
  const chat = async (task, extra) => {
    const t0 = performance.now(), row = { task, text: '', tool_calls: [], textDeltas: 0, argumentDeltas: 0, firstArgumentMs: null };
    const r = await fetch(control.url + '/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(90000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'claude/haiku', stream: true, messages, tools, ...extra }) });
    if (!r.ok) throw Error(`Control HTTP ${r.status}`);
    for await (const e of sse(r.body)) {
      if (e.error) throw Error('Control SSE error');
      const c = e.choices?.[0]; if (c?.finish_reason) row.finishReason = c.finish_reason;
      if (c?.delta?.content) { row.text += c.delta.content; row.textDeltas++; }
      for (const t of c?.delta?.tool_calls || []) {
        const v = row.tool_calls[t.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (t.id) v.id = t.id; if (t.function?.name) v.function.name += t.function.name;
        if (t.function?.arguments) { v.function.arguments += t.function.arguments; row.firstArgumentMs ??= performance.now() - t0; row.argumentDeltas++; }
      }
    }
    row.totalMs = performance.now() - t0; rows.push(row); return row;
  };
  const first = await chat('stock-tool', { tool_choice: { type: 'function', function: { name: stockTool.name } } });
  first.correct = first.tool_calls.length === 1 && first.tool_calls[0].function.name === stockTool.name && JSON.parse(first.tool_calls[0].function.arguments).sku === 'CANECA-AZUL';
  if (first.correct) {
    const fixture = join(scratch, 'stock.json'); await writeFile(fixture, '{"sku":"CANECA-AZUL","quantidade":17}');
    messages.push({ role: 'assistant', content: null, tool_calls: first.tool_calls },
      { role: 'tool', tool_call_id: first.tool_calls[0].id, content: await readFile(fixture, 'utf8') });
    const final = await chat('stock-result', { tool_choice: 'none' }); final.correct = final.text.trim() === 'Estoque: 17 unidades.';
  }
  result.spawnEmulationControl = { experimental: true, changes: 'injected adapter selects textual client-tool emulation; process still respawned per request',
    calls: rows, correct: rows.length === 2 && rows.every(r => r.correct), totalMs: rows.reduce((n, r) => n + r.totalMs, 0) };
} catch (e) { result.controlError = e.message; }
finally {
  native.run = original; await proxy?.close(); await control?.close(); await rm(scratch, { recursive: true, force: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
}
