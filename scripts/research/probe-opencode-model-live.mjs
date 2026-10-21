// Usage: node scripts/research/probe-opencode-model-live.mjs <fresh-dist> <results.json> <provider/model>
// Separates the current AgentBridge gate from native v2 one-shot generation.
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startV2, generateV2, modelRef } from './opencode-v2-minimal.mjs';

const [dist, output, selectedModel] = process.argv.slice(2);
if (!dist || !output || !selectedModel) throw Error('Provide fresh dist, output JSON and explicit model');
const model = modelRef(selectedModel);
const workspace = await mkdtemp(join(tmpdir(), 'agentbridge-model-probe-'));
process.env.AGENTBRIDGE_HOME = join(workspace, 'bridge-home');
await mkdir(process.env.AGENTBRIDGE_HOME);
const { startProxy } = await import(pathToFileURL(join(resolve(dist), 'server/index.js')));
const results = { date: new Date().toISOString(), model: selectedModel, probes: [],
  note: 'No new login or provider key. One-shot generation uses the installed OpenCode server, not a direct remote provider request.' };
let server, proxy;
async function probe(path, fn) {
  const start = performance.now();
  const record = { path };
  try { Object.assign(record, await fn()); record.correct = record.text?.trim() === 'PONTE_OK'; }
  catch (e) { record.error = e.message; record.evidence = e.evidence; record.correct = false; }
  record.totalMs = performance.now() - start;
  results.probes.push(record);
  await writeFile(resolve(output), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(record));
}
try {
  proxy = await startProxy({ port: 0, sessionsFile: false, pruneLeftovers: false, timeoutMs: 60000 });
  await probe('agentbridge-current-api-exact', async () => {
    const r = await fetch(`${proxy.url}/v1/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(65000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: `opencode/${selectedModel}`,
        messages: [{ role: 'user', content: 'Responda exatamente: PONTE_OK' }] }) });
    const body = await r.json();
    if (!r.ok || body.error) {
      const e = Error(`AgentBridge HTTP ${r.status}: ${body.error?.code || 'error'}`);
      e.evidence = { status: r.status, code: body.error?.code, type: body.error?.type }; throw e;
    }
    return { text: body.choices?.[0]?.message?.content };
  });
  server = await startV2(workspace);
  results.version = server.version;
  results.serverStartupMs = server.startupMs;
  const models = await server.api('GET', '/api/model');
  const info = models.data?.find(m => m.providerID === model.providerID && m.id === model.id);
  if (!info) throw Error('Requested model not found');
  results.modelInfo = { id: info.id, providerID: info.providerID, name: info.name, enabled: info.enabled, capabilities: info.capabilities, limit: info.limit };
  for (let round = 1; round <= 2; round++) await probe(`v2-generate-exact-${round}`,
    () => generateV2(server, 'Responda exatamente: PONTE_OK', AbortSignal.timeout(30000), model));
} finally {
  await proxy?.close(); await server?.close(); await rm(workspace, { recursive: true, force: true });
  results.temporaryWorkspaceRemoved = true;
  await writeFile(resolve(output), JSON.stringify(results, null, 2) + '\n');
}
if (results.probes.some(p => !p.correct)) process.exitCode = 1;
