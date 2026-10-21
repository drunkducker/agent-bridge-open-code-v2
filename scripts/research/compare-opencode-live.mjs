// Usage: node scripts/research/compare-opencode-live.mjs <fresh-dist> <results.json>
// Uses the installed OpenCode and explicitly selected Flint model; never substitutes models.
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startV2, sessionV2, generateV2, FLINT } from './opencode-v2-minimal.mjs';

const [dist, output] = process.argv.slice(2);
if (!dist || !output) throw Error('Provide freshly compiled dist and output file');
const scratch = await mkdtemp(join(tmpdir(), 'agentbridge-flint-'));
const workspace = join(scratch, 'workspace');
await mkdir(workspace);
process.env.AGENTBRIDGE_HOME = join(scratch, 'home');
await mkdir(process.env.AGENTBRIDGE_HOME);
const fixture = { lote: randomBytes(8).toString('hex'), pedidos: [
  { status: 'pago', valor_centavos: 1327 }, { status: 'cancelado', valor_centavos: 99999 },
  { status: 'pago', valor_centavos: 4890 }, { status: 'pendente', valor_centavos: 7800 },
  { status: 'pago', valor_centavos: 2153 }, { status: 'pago', valor_centavos: 8711 },
] };
const source = JSON.stringify(fixture, null, 2) + '\n';
const file = join(workspace, 'pedidos.json');
await writeFile(file, source);
const git = args => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
git(['init', '-q']); git(['add', 'pedidos.json']);
git(['-c', 'user.name=AgentBridge Experiment', '-c', 'user.email=experiment@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Temporary fixture']);
const expected = { lote: fixture.lote, quantidade_pagos: 4, total_centavos: 17081 };
const task = 'Leia pedidos.json do diretório de trabalho usando a ferramenta read. Não altere arquivos, não execute comandos e não consulte outros arquivos ou serviços. Some valor_centavos somente de status exatamente "pago". Responda somente JSON com lote (copiado do arquivo), quantidade_pagos e total_centavos.';
const { startProxy } = await import(pathToFileURL(join(resolve(dist), 'server/index.js')));
const results = { date: new Date().toISOString(), installedVersion: execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim(),
  model: 'opencode/flint-40b-free', fixture, expected, task, probes: [], skipped: [],
  references: ['https://opencode.ai/v2/docs/api', 'https://opencode.ai/v2/openapi.json'],
  note: 'Local v2 server is still OpenCode, not a direct connection to the remote model provider. Failure durations are not inference benchmarks.' };
let server, proxy, experimentalProxy;
const save = () => writeFile(resolve(output), JSON.stringify(results, null, 2) + '\n');
async function probe(path, fn, check) {
  const start = performance.now();
  const r = { path };
  try { const value = await fn(); Object.assign(r, value); r.correct = check ? check(value) : false; }
  catch (e) { r.error = e.message; r.evidence = e.evidence; r.correct = false; }
  r.totalMs = performance.now() - start;
  results.probes.push(r); await save();
  console.log(JSON.stringify(r));
  return r;
}
async function chat(p, messages, extra = {}) {
  const r = await fetch(`${p.url}/v1/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(95000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'opencode/opencode/flint-40b-free', messages, stream: false, ...extra }) });
  const body = await r.json();
  if (!r.ok || body.error) { const e = Error(`AgentBridge HTTP ${r.status}: ${body.error?.code || body.error?.type || 'error'}`); e.evidence = { status: r.status, code: body.error?.code, type: body.error?.type }; throw e; }
  return { text: body.choices?.[0]?.message?.content || '', tool_calls: body.choices?.[0]?.message?.tool_calls || [] };
}
const exact = r => r.text?.trim() === 'PONTE_OK';
try {
  proxy = await startProxy({ port: 0, sessionsFile: false, pruneLeftovers: false, timeoutMs: 60000 });
  await probe('agentbridge-current-api-exact', () => chat(proxy, [{ role: 'user', content: 'Responda exatamente: PONTE_OK' }]), exact);
  server = await startV2(workspace);
  results.privateServer = { version: server.version, startupMs: server.startupMs };
  const modelList = await server.api('GET', '/api/model');
  const modelInfo = modelList.data?.find(m => m.providerID === FLINT.providerID && m.id === FLINT.id);
  if (!modelInfo) throw Error('Selected model not found in private OpenCode server');
  results.modelInfo = { id: modelInfo.id, providerID: modelInfo.providerID, name: modelInfo.name,
    enabled: modelInfo.enabled, capabilities: modelInfo.capabilities, limit: modelInfo.limit };
  for (const path of ['v2-generate-exact-1', 'v2-generate-exact-2']) {
    await probe(path, () => generateV2(server, 'Responda exatamente: PONTE_OK', AbortSignal.timeout(30000)), exact);
  }
  await probe('v2-native-session-exact', () => sessionV2(server, { prompt: 'Responda exatamente: PONTE_OK. Não use ferramentas.',
    cwd: workspace, signal: AbortSignal.timeout(60000) }), exact);
  const toolEvidence = [];
  await probe('v2-native-session-file', async () => {
    try {
      const r = await sessionV2(server, { prompt: task, cwd: workspace, allowRead: true, signal: AbortSignal.timeout(60000),
        onTool: item => toolEvidence.push({ name: item.name, status: item.state?.status,
          containsFixtureMarker: JSON.stringify(item.state?.content || []).includes(fixture.lote) }) });
      return { ...r, toolEvidence };
    } catch (e) { e.evidence = { ...e.evidence, toolEvidence }; throw e; }
  }, r => {
    try { const p = JSON.parse(r.text); return p.lote === expected.lote && p.quantidade_pagos === 4 && p.total_centavos === 17081 && r.toolEvidence.some(t => t.containsFixtureMarker); }
    catch { return false; }
  });
  if (results.probes.some(p => p.path.startsWith('v2-generate') && p.correct)) {
    const minimalAdapter = { name: 'opencode', async *run(o) {
      const r = await generateV2(server, [o.systemPrompt, o.prompt].filter(Boolean).join('\n\n'), o.signal);
      yield { type: 'text', delta: r.text };
      return { text: r.text, usage: { input: 0, output: 0 }, durationMs: 0, finishReason: 'stop' };
    } };
    experimentalProxy = await startProxy({ port: 0, sessionsFile: false, pruneLeftovers: false, timeoutMs: 60000,
      adapters: { opencode: minimalAdapter } });
    for (const choice of ['auto', 'required']) {
      await probe(`experimental-v2-api-file-${choice}`, async () => {
        const tools = [{ type: 'function', function: { name: 'ler_arquivo', description: 'Lê pedidos.json do disco.',
          parameters: { type: 'object', properties: { caminho: { type: 'string', enum: ['pedidos.json'] } }, required: ['caminho'], additionalProperties: false } } }];
        const messages = [{ role: 'user', content: task.replace('ferramenta read', 'ferramenta ler_arquivo') }];
        const first = await chat(experimentalProxy, messages, { tools, tool_choice: choice });
        if (first.tool_calls.length !== 1) return { ...first, diskReadObserved: false };
        const c = first.tool_calls[0];
        if (c.function.name !== 'ler_arquivo' || JSON.parse(c.function.arguments).caminho !== 'pedidos.json') throw Error('Unexpected tool arguments');
        const content = await readFile(file, 'utf8');
        const final = await chat(experimentalProxy, [...messages, { role: 'assistant', content: first.text || null, tool_calls: first.tool_calls },
          { role: 'tool', tool_call_id: c.id, content }], { tools, tool_choice: 'none' });
        return { ...final, diskReadObserved: true };
      }, r => {
        try { const p = JSON.parse(r.text); return r.diskReadObserved && p.lote === expected.lote && p.quantidade_pagos === 4 && p.total_centavos === 17081; }
        catch { return false; }
      });
    }
  } else {
    results.skipped.push({ paths: ['experimental-v2-api-file-auto', 'experimental-v2-api-file-required', 'latency-benchmark', 'concurrency-and-cancellation'],
      reason: 'Flint did not complete basic generation through OpenCode v2; model-dependent downstream tests cannot establish capabilities.' });
  }
  results.fixtureUnchanged = (await readFile(file, 'utf8')) === source;
  results.fixtureSha256 = createHash('sha256').update(source).digest('hex');
} finally {
  await experimentalProxy?.close(); await proxy?.close(); await server?.close();
  await rm(scratch, { recursive: true, force: true });
  results.temporaryWorkspaceRemoved = true;
  await save();
}
if (results.probes.some(p => !p.correct) || !results.fixtureUnchanged) process.exitCode = 1;
