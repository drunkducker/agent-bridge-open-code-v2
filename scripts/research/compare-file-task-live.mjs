// Real file task. Usage: node scripts/research/compare-file-task-live.mjs <fresh-dist> <results.json>
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { direct } from './codex-direct-minimal.mjs';

const [dist, output] = process.argv.slice(2);
if (!dist || !output) throw Error('Provide fresh dist and output JSON');
const scratch = await mkdtemp(join(tmpdir(), 'agentbridge-file-task-'));
const workspace = join(scratch, 'workspace');
await mkdir(workspace);
process.env.AGENTBRIDGE_HOME = join(scratch, 'home');
await mkdir(process.env.AGENTBRIDGE_HOME);
const fixture = {
  lote: randomBytes(8).toString('hex'),
  pedidos: [
    { id: 1, status: 'pago', valor_centavos: 1327 },
    { id: 2, status: 'cancelado', valor_centavos: 99999 },
    { id: 3, status: 'pago', valor_centavos: 4890 },
    { id: 4, status: 'pendente', valor_centavos: 7800 },
    { id: 5, status: 'pago', valor_centavos: 2153 },
    { id: 6, status: 'pago', valor_centavos: 8711 },
    { id: 7, status: 'cancelado', valor_centavos: 4500 },
  ],
};
const file = join(workspace, 'pedidos.json');
const original = JSON.stringify(fixture, null, 2) + '\n';
await writeFile(file, original);
const git = args => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
git(['init', '-q']);
git(['add', 'pedidos.json']);
git(['-c', 'user.name=AgentBridge Experiment', '-c', 'user.email=experiment@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Local test fixture']);
const paid = fixture.pedidos.filter(p => p.status === 'pago');
const expected = { lote: fixture.lote, quantidade_pagos: paid.length, total_centavos: paid.reduce((s, p) => s + p.valor_centavos, 0) };
const task = 'Leia o arquivo pedidos.json do diretório de trabalho usando uma ferramenta. Não altere arquivos. Considere apenas pedidos com status exatamente "pago". Responda somente um objeto JSON com lote (copiado do arquivo), quantidade_pagos e total_centavos (soma dos valores dos pagos). Não leia outros arquivos nem consulte serviços externos. Se não tiver nenhuma ferramenta para ler o arquivo, responda exatamente {"error":"FILE_ACCESS_UNAVAILABLE"}.';
const model = 'gpt-6.1-sol';
const results = { date: new Date().toISOString(), model, effort: 'low', task, fixture, expected, runs: [],
  note: 'One run per path; real disk read, same file contents. Native agents read a worktree copy. Direct/API client-tool execution is provided by this script.' };
const { startProxy } = await import(pathToFileURL(join(resolve(dist), 'server/index.js')));
const { default: adapter, codexDaemonPool } = await import(pathToFileURL(join(resolve(dist), 'adapters/codex.js')));
const token = randomBytes(24).toString('hex');
const proxies = [];
let evidence = [];

function instrument(transport) {
  return { ...adapter, async *run(options) {
    for await (const event of adapter.run({ ...options, ...(transport ? { transport } : {}) })) {
      if (event.type === 'tool') evidence.push({ name: event.name, command: event.input?.command,
        containsFixtureMarker: JSON.stringify(event.output || '').includes(fixture.lote), exitCode: event.exitCode });
      // Current app-server versions emit camelCase commandExecution items.
      // Observe the raw notification too, without changing production normalization.
      if (event.type === 'raw' && event.data?.method === 'item/completed') {
        const item = event.data.params?.item;
        if (item && ['commandExecution', 'command_execution'].includes(item.type)) evidence.push({
          name: 'raw-command', itemType: item.type, command: item.command,
          containsFixtureMarker: JSON.stringify(item.aggregatedOutput ?? item.aggregated_output ?? '').includes(fixture.lote),
          exitCode: item.exitCode ?? item.exit_code,
        });
      }
      yield event;
    }
  } };
}
async function chat(proxy, request, agent = false) {
  const response = await fetch(`${proxy.url}/v1/chat/completions`, {
    method: 'POST', signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-ab-permissions': 'read-only' },
    body: JSON.stringify({ ...request, model: `${agent ? 'agent/' : ''}codex/${model}`, stream: false }),
  });
  if (!response.ok) { await response.body?.cancel(); throw Error(`AgentBridge HTTP ${response.status}`); }
  const body = await response.json();
  if (body.error) throw Error(`AgentBridge error: ${body.error.code || body.error.type}`);
  const m = body.choices?.[0]?.message;
  return { text: m?.content || '', tool_calls: m?.tool_calls || [], usage: body.usage };
}
const tools = [{ type: 'function', function: { name: 'ler_arquivo', description: 'Lê um arquivo UTF-8 do diretório de trabalho.',
  parameters: { type: 'object', properties: { caminho: { type: 'string', enum: ['pedidos.json'] } }, required: ['caminho'], additionalProperties: false } } }];

async function run(path) {
  const start = performance.now();
  evidence = [];
  const record = { path, modelCalls: 0, clientReads: 0 };
  try {
    const messages = [{ role: 'user', content: task }];
    const native = path.startsWith('agent-');
    const noTools = path === 'direct-without-tools';
    const request = async extra => {
      record.modelCalls++;
      const req = { model, reasoning_effort: 'low', messages, ...extra };
      return path.startsWith('direct') ? await direct(req) : await chat(proxies[path === 'agent-app-server' ? 1 : 0], req, native);
    };
    let response;
    for (let turn = 0; turn < 4; turn++) {
      response = await request(native || noTools ? {} : { tools,
        ...(path.endsWith('-required') && turn === 0 ? { tool_choice: { type: 'function', function: { name: 'ler_arquivo' } } } : {}) });
      if (!response.tool_calls.length) break;
      if (native || noTools) throw Error('Unexpected client tool request');
      messages.push({ role: 'assistant', content: response.text || null, tool_calls: response.tool_calls });
      for (const call of response.tool_calls) {
        const args = JSON.parse(call.function.arguments);
        if (call.function.name !== 'ler_arquivo' || args.caminho !== 'pedidos.json') throw Error('Unexpected tool or file');
        const content = await readFile(file, 'utf8');
        record.clientReads++;
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }
    record.text = response.text;
    record.nativeTools = evidence;
    let parsed;
    try { parsed = JSON.parse(response.text); } catch {}
    record.answerCorrect = noTools ? parsed?.error === 'FILE_ACCESS_UNAVAILABLE' :
      parsed?.lote === expected.lote && parsed?.quantidade_pagos === expected.quantidade_pagos && parsed?.total_centavos === expected.total_centavos;
    record.diskReadObserved = native ? evidence.some(e => e.containsFixtureMarker) : record.clientReads > 0;
    record.correct = record.answerCorrect && (noTools || record.diskReadObserved);
  } catch (e) { record.error = e.message; record.correct = false; }
  record.totalMs = performance.now() - start;
  results.runs.push(record);
  await writeFile(resolve(output), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(record));
}
try {
  const config = { port: 0, token, agentRoot: workspace, maxPermission: 'read-only', sessionsFile: false, pruneLeftovers: false, timeoutMs: 105000 };
  proxies.push(await startProxy({ ...config, adapters: { codex: instrument() } }));
  proxies.push(await startProxy({ ...config, adapters: { codex: instrument('app-server') } }));
  for (const path of ['agent-cli', 'agent-app-server', 'api-cli-client-tool', 'api-cli-client-tool-required', 'direct-client-tool', 'direct-without-tools']) await run(path);
  results.sourceFileUnchanged = (await readFile(file, 'utf8')) === original;
  results.fixtureSha256 = createHash('sha256').update(original).digest('hex');
} finally {
  for (const proxy of proxies) await proxy.close();
  codexDaemonPool.shutdownAll();
  await rm(scratch, { recursive: true, force: true });
  results.temporaryWorkspaceRemoved = true;
  await writeFile(resolve(output), JSON.stringify(results, null, 2) + '\n');
}
if (results.runs.length !== 6 || results.runs.some(r => !r.correct) || !results.sourceFileUnchanged) process.exitCode = 1;
