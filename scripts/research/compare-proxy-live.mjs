// Usage: node scripts/research/compare-proxy-live.mjs /absolute/path/to/fresh/dist results.json
// Runs real inference with the existing local Codex login. No production changes.
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { direct, sse } from './codex-direct-minimal.mjs';

const [dist, output] = process.argv.slice(2);
if (!dist || !output) throw new Error('Provide fresh compiled dist directory and output JSON');
const scratch = await mkdtemp(join(tmpdir(), 'agentbridge-live-ab-'));
process.env.AGENTBRIDGE_HOME = join(scratch, 'home');
await mkdir(process.env.AGENTBRIDGE_HOME);
const { startProxy } = await import(pathToFileURL(join(resolve(dist), 'server/index.js')));
const { default: adapter, codexDaemonPool } = await import(pathToFileURL(join(resolve(dist), 'adapters/codex.js')));
const model = 'gpt-6.1-sol';
const results = { date: new Date().toISOString(), model, effort: 'low', calls: [],
  upstream: 'router-for-me/CLIProxyAPI@0db19025571684b198a2ef508f99b41c717337e8',
  note: 'Minimal HTTP subset, not full CLIProxyAPI. app-server uses experimental adapter injection. Sequential small sample, no statistical speed claim.' };
const proxies = [];

async function chat(proxy, request) {
  const start = performance.now();
  const response = await fetch(`${proxy.url}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(90000), body: JSON.stringify({ ...request, model: `codex/${model}`, stream: true }),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`AgentBridge HTTP ${response.status}`); }
  const r = { text: '', tool_calls: [], textDeltas: 0, toolDeltas: 0, firstTextMs: null, firstToolMs: null };
  let terminal = false;
  for await (const e of sse(response.body)) {
    if (e.error) throw new Error(`AgentBridge stream error: ${e.error.code || e.error.type || 'unknown'}`);
    if (e.usage) r.usage = e.usage;
    const c = e.choices?.[0];
    if (c?.finish_reason) terminal = true;
    if (c?.delta?.content) { r.firstTextMs ??= performance.now() - start; r.text += c.delta.content; r.textDeltas++; }
    for (const t of c?.delta?.tool_calls || []) {
      r.firstToolMs ??= performance.now() - start; r.toolDeltas++;
      const item = r.tool_calls[t.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (t.id) item.id = t.id;
      if (t.function?.name) item.function.name += t.function.name;
      if (t.function?.arguments) item.function.arguments += t.function.arguments;
    }
  }
  if (!terminal) throw new Error('AgentBridge stream ended without finish_reason');
  r.totalMs = performance.now() - start;
  return r;
}

async function measure(path, task, messages, extra = {}) {
  const start = performance.now();
  let r;
  try {
    const request = { model, reasoning_effort: 'low', messages, ...extra };
    r = path === 'direct' ? await direct(request) : await chat(proxies[path === 'cli' ? 0 : 1], request);
  } catch (e) { r = { error: e.message, totalMs: performance.now() - start }; }
  const record = { path, task, ...r };
  results.calls.push(record);
  await writeFile(resolve(output), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify({ path, task, ms: Math.round(r.totalMs), text: r.text, tools: r.tool_calls?.map(t => t.function), error: r.error }));
  return record;
}

try {
  proxies.push(await startProxy({ port: 0, sessionsFile: false, pruneLeftovers: false, timeoutMs: 75000 }));
  proxies.push(await startProxy({ port: 0, sessionsFile: false, pruneLeftovers: false, timeoutMs: 75000,
    adapters: { codex: { ...adapter, run: o => adapter.run({ ...o, transport: 'app-server' }) } } }));
  for (let round = 0; round < 3; round++) {
    for (const path of (round % 2 ? ['direct', 'app-server', 'cli'] : ['cli', 'app-server', 'direct'])) {
      const r = await measure(path, `exact-${round + 1}`, [{ role: 'user', content: 'Responda exatamente: PONTE_OK' }]);
      r.correct = r.text?.trim() === 'PONTE_OK';
    }
  }
  for (const path of ['cli', 'app-server', 'direct']) {
    const tools = [{ type: 'function', function: { name: 'consultar_estoque', description: 'Consulta o estoque real por SKU.',
      parameters: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false } } }];
    const messages = [{ role: 'user', content: 'Consulte o estoque do SKU CANECA-AZUL com consultar_estoque. Quando receber o resultado, responda exatamente: Estoque: N unidades. Substitua N pela quantidade retornada.' }];
    const r = await measure(path, 'stock-tool', messages, { tools, tool_choice: { type: 'function', function: { name: 'consultar_estoque' } } });
    let valid = false;
    try { valid = r.tool_calls?.length === 1 && r.tool_calls[0].function.name === 'consultar_estoque' && JSON.parse(r.tool_calls[0].function.arguments).sku === 'CANECA-AZUL'; } catch {}
    r.correct = valid;
    if (valid) {
      const call = r.tool_calls[0];
      const final = await measure(path, 'stock-result', [...messages,
        { role: 'assistant', content: null, tool_calls: r.tool_calls },
        { role: 'tool', tool_call_id: call.id, content: JSON.stringify({ sku: 'CANECA-AZUL', quantidade: 17 }) }], { tools, tool_choice: 'none' });
      final.correct = final.text?.trim() === 'Estoque: 17 unidades.';
    }
  }
} finally {
  await writeFile(resolve(output), JSON.stringify(results, null, 2) + '\n');
  for (const proxy of proxies) await proxy.close();
  codexDaemonPool.shutdownAll();
  await rm(scratch, { recursive: true, force: true });
}
if (results.calls.length !== 15 || results.calls.some(call => call.correct !== true)) process.exitCode = 1;
