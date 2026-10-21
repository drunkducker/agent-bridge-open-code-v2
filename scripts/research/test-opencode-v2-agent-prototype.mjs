// Proof of integration only; does not change/register a production adapter.
// Usage: node scripts/research/test-opencode-v2-agent-prototype.mjs <fresh-dist> <results.json> [provider/model]
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startV2, sessionV2, modelRef } from './opencode-v2-minimal.mjs';

const [dist, output, selectedModel = 'opencode/flint-40b-free'] = process.argv.slice(2);
const model = modelRef(selectedModel);
if (!dist || !output) throw Error('Provide fresh dist and output JSON');
const scratch = await mkdtemp(join(tmpdir(), 'agentbridge-opencode-v2-prototype-'));
const workspace = join(scratch, 'workspace');
await mkdir(workspace);
process.env.AGENTBRIDGE_HOME = join(scratch, 'home');
await mkdir(process.env.AGENTBRIDGE_HOME);
const fixture = { lote: randomBytes(8).toString('hex'), pedidos: [
  { status: 'pago', valor_centavos: 1327 }, { status: 'cancelado', valor_centavos: 99999 },
  { status: 'pago', valor_centavos: 4890 }, { status: 'pago', valor_centavos: 2153 },
  { status: 'pago', valor_centavos: 8711 },
] };
const original = JSON.stringify(fixture, null, 2) + '\n';
await writeFile(join(workspace, 'pedidos.json'), original);
const git = args => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
git(['init', '-q']); git(['add', 'pedidos.json']);
git(['-c', 'user.name=AgentBridge Experiment', '-c', 'user.email=experiment@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Prototype fixture']);
const { startProxy } = await import(pathToFileURL(join(resolve(dist), 'server/index.js')));
const result = { date: new Date().toISOString(), path: 'agentbridge-agent-v2-prototype', model: selectedModel,
  expected: { lote: fixture.lote, quantidade_pagos: 4, total_centavos: 17081 }, toolEvidence: [],
  note: 'Injected experiment adapter, not the production adapter. Buffers events. No validation of production streaming/concurrency/session resumption.' };
let server, proxy;
const start = performance.now();
try {
  server = await startV2(workspace);
  const adapter = { name: 'opencode', async *run(o) {
    const tools = [];
    const reply = await sessionV2(server, { prompt: [o.systemPrompt, o.prompt].filter(Boolean).join('\n\n'), cwd: o.cwd,
      allowRead: true, model, signal: AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs || 70000)]), onTool: item => {
        result.toolEvidence.push({ name: item.name, status: item.state?.status,
          containsFixtureMarker: JSON.stringify(item.state?.content || []).includes(fixture.lote) });
        tools.push({ type: 'tool', name: item.name, input: item.state?.input, output: item.state?.content });
      } });
    for (const tool of tools) yield tool;
    yield { type: 'text', delta: reply.text };
    result.modelEvidence = reply.evidence;
    return { text: reply.text, usage: { input: reply.usage?.input || 0, output: reply.usage?.output || 0 }, durationMs: 0, finishReason: 'stop' };
  } };
  const token = randomBytes(24).toString('hex');
  proxy = await startProxy({ port: 0, token, agentRoot: workspace, maxPermission: 'read-only', sessionsFile: false,
    pruneLeftovers: false, timeoutMs: 70000, adapters: { opencode: adapter } });
  const response = await fetch(`${proxy.url}/v1/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(80000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-ab-permissions': 'read-only' },
    body: JSON.stringify({ model: `agent/opencode/${selectedModel}`, messages: [{ role: 'user', content:
      'Leia pedidos.json com a ferramenta read. Não edite nada nem execute comandos. Some valor_centavos dos pedidos cujo status é "pago". Responda JSON puro, sem Markdown, com lote copiado do arquivo, quantidade_pagos e total_centavos.' }] }) });
  const body = await response.json();
  if (!response.ok) throw Error(`AgentBridge prototype HTTP ${response.status}: ${body.error?.code || 'error'}`);
  result.text = body.choices?.[0]?.message?.content;
  let parsed;
  try { parsed = JSON.parse(result.text); result.strictJson = true; } catch {
    result.strictJson = false;
    try { parsed = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch {}
  }
  result.semanticCorrect = parsed?.lote === fixture.lote && parsed?.quantidade_pagos === 4 && parsed?.total_centavos === 17081;
  result.diskReadObserved = result.toolEvidence.some(t => t.containsFixtureMarker);
  result.correct = result.semanticCorrect && result.diskReadObserved && result.strictJson;
  result.fixtureUnchanged = await readFile(join(workspace, 'pedidos.json'), 'utf8') === original;
} catch (e) { result.error = e.message; result.evidence = e.evidence; result.correct = false; }
finally {
  await proxy?.close(); await server?.close(); await rm(scratch, { recursive: true, force: true });
  result.totalMs = performance.now() - start; result.temporaryWorkspaceRemoved = true;
  await writeFile(resolve(output), JSON.stringify(result, null, 2) + '\n'); console.log(JSON.stringify(result));
}
if (!result.correct || !result.fixtureUnchanged) process.exitCode = 1;
