// Follow-up: isolate native tools availability and test a real file on warm/fresh servers.
// Usage: node scripts/research/compare-opencode-v2-capabilities-live.mjs <results.json> [provider/model]
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { startV2, sessionV2, modelRef } from './opencode-v2-minimal.mjs';

const output = process.argv[2];
const selectedModel = process.argv[3] || 'opencode/flint-40b-free';
const model = modelRef(selectedModel);
if (!output) throw Error('Provide output JSON');
const workspace = await mkdtemp(join(tmpdir(), 'agentbridge-model-followup-'));
const fixture = { lote: randomBytes(8).toString('hex'), pedidos: [
  { status: 'pago', valor_centavos: 1327 }, { status: 'cancelado', valor_centavos: 99999 },
  { status: 'pago', valor_centavos: 4890 }, { status: 'pendente', valor_centavos: 7800 },
  { status: 'pago', valor_centavos: 2153 }, { status: 'pago', valor_centavos: 8711 },
] };
const original = JSON.stringify(fixture, null, 2) + '\n';
await writeFile(join(workspace, 'pedidos.json'), original);
const expected = { lote: fixture.lote, quantidade_pagos: 4, total_centavos: 17081 };
const results = { date: new Date().toISOString(), model: selectedModel, expected, fixture, runs: [],
  note: 'Native OpenCode v2 API. Fresh session for every case. Same explicit model; no fallback. Compare correctness before timing.' };
const save = () => writeFile(resolve(output), JSON.stringify(results, null, 2) + '\n');
let warm;
async function run(path, { allowRead, file = false, fresh = false }) {
  const start = performance.now();
  const r = { path, allowRead, freshServer: fresh, toolEvidence: [] };
  let server;
  try {
    server = fresh ? await startV2(workspace) : warm;
    if (fresh) r.serverStartupMs = server.startupMs;
    const prompt = file ? 'Use a ferramenta read para ler pedidos.json. Não altere arquivos nem execute comandos. Retorne somente JSON puro, sem Markdown: lote copiado do arquivo, quantidade_pagos e total_centavos somando valor_centavos apenas de status exatamente "pago".' :
      'Responda exatamente: PONTE_OK. Não execute nenhuma ferramenta.';
    const reply = await sessionV2(server, { prompt, cwd: workspace, allowRead, model, signal: AbortSignal.timeout(60000),
      onTool: item => r.toolEvidence.push({ name: item.name, status: item.state?.status,
        containsFixtureMarker: JSON.stringify(item.state?.content || []).includes(fixture.lote) }) });
    Object.assign(r, reply);
    if (file) {
      let parsed;
      try { parsed = JSON.parse(r.text); r.strictJson = true; } catch {
        r.strictJson = false;
        try { parsed = JSON.parse(r.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch {}
      }
      r.semanticCorrect = parsed?.lote === expected.lote && parsed?.quantidade_pagos === 4 && parsed?.total_centavos === 17081;
      r.diskReadObserved = r.toolEvidence.some(t => t.containsFixtureMarker);
      r.correct = r.semanticCorrect && r.diskReadObserved && r.strictJson;
    } else r.correct = r.text?.trim() === 'PONTE_OK';
  } catch (e) { r.error = e.message; r.evidence = e.evidence; r.correct = false; }
  finally { if (fresh) await server?.close(); }
  r.totalMs = performance.now() - start;
  results.runs.push(r); await save(); console.log(JSON.stringify(r));
}
try {
  warm = await startV2(workspace);
  results.warmServerStartupMs = warm.startupMs;
  for (let round = 1; round <= 2; round++) {
    for (const allowRead of (round === 1 ? [true, false] : [false, true])) {
      await run(`exact-read-${allowRead}-${round}`, { allowRead });
    }
  }
  await run('warm-server-file', { allowRead: true, file: true });
  await run('fresh-server-file', { allowRead: true, file: true, fresh: true });
  results.fixtureUnchanged = await readFile(join(workspace, 'pedidos.json'), 'utf8') === original;
  results.fixtureSha256 = createHash('sha256').update(original).digest('hex');
} finally {
  await warm?.close(); await rm(workspace, { recursive: true, force: true });
  results.temporaryWorkspaceRemoved = true; await save();
}
if (results.runs.some(r => !r.correct) || !results.fixtureUnchanged) process.exitCode = 1;
