// Usage: node scripts/research/compare-opencode-proxy-live.mjs <fresh-dist> <results.json>
import { runStudy } from './other-harnesses-common.mjs';
import { startV2, generateV2, sessionV2, modelRef } from './opencode-v2-minimal.mjs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const modelName = 'opencode/glm-5.3-flash-free';
if (!process.argv.includes('--diagnose-only')) await runStudy({ harness: 'opencode', model: modelName,
  direct: { implemented: false, measured: false, reason: 'OpenCode is a multi-provider router. The selected free Zen model has no independently authorized API credential identified in this experiment; no CLI-only free-tier restriction is bypassed.',
    sources: ['https://opencode.ai/docs/zen', 'https://opencode.ai/legal/terms-of-service'] },
  limitations: ['Production v0.6.0 adapter is v1-only. A v2 rejection is an actual result, not an inference latency.',
    'Persistent experimental adapter uses the v2 generate route with no native tools and buffers its JSON response. If the free provider rejects this mode, the rejection is preserved.'],
  persistent: async ({ scratch, result }) => {
    const server = await startV2(scratch);
    const info = { transport: 'OpenCode v2 private HTTP server /api/experimental/generate', version: server.version,
      startupMs: server.startupMs, spawns: 1, requests: 0, buffered: true, retainsConversation: false };
    const listing = await server.api('GET', '/api/model');
    const model = modelRef(modelName);
    const found = listing.data?.find(m => m.providerID === model.providerID && m.id === model.id);
    result.selectedModel = found ? { providerID: found.providerID, id: found.id, enabled: found.enabled } : null;
    return { info, close: server.close, adapter: () => ({ name: 'opencode', async *run(o) {
      info.requests++;
      const r = await generateV2(server, [o.systemPrompt, o.prompt].filter(Boolean).join('\n\n'),
        AbortSignal.any([o.signal, AbortSignal.timeout(80000)]), model);
      yield { type: 'text', delta: r.text };
      return { text: r.text, model: modelName, exitCode: 0, timedOut: false };
    } }) };
  } });

// Distinguish a generation-route failure from failure of the native session route.
// Native tool permissions remain deny-all; no filesystem tool is enabled to bypass free-tier checks.
const [, outputArg] = process.argv.slice(2);
if (!outputArg) throw Error('Provide fresh dist and results JSON');
const output = resolve(outputArg), result = JSON.parse(await readFile(output, 'utf8'));
const scratch = await mkdtemp(join(tmpdir(), 'ab-opencode-route-diagnostic-'));
let server;
try {
  server = await startV2(scratch);
  result.routeDiagnostics = [];
  for (const route of ['generate', 'session-deny-all']) {
    const t0 = performance.now(), tools = [];
    try {
      const r = route === 'generate'
        ? await generateV2(server, 'Responda exatamente: PONTE_OK', AbortSignal.timeout(30000), modelRef(modelName))
        : await sessionV2(server, { prompt: 'Responda exatamente: PONTE_OK. Não use ferramentas.', cwd: scratch,
          allowRead: false, signal: AbortSignal.timeout(45000), model: modelRef(modelName), onTool: t => tools.push({name:t.name,status:t.state?.status}) });
      result.routeDiagnostics.push({ route, totalMs: performance.now()-t0, text:r.text, correct:r.text?.trim()==='PONTE_OK',
        nativeTools:tools, evidence:r.evidence });
    } catch (e) {
      result.routeDiagnostics.push({route,totalMs:performance.now()-t0,error:e.message,evidence:e.evidence,correct:false});
    }
  }
} catch(e) { result.diagnosticError=e.message; }
finally {
  await server?.close(); await rm(scratch,{recursive:true,force:true});
  await writeFile(output,JSON.stringify(result,null,2)+'\n');
}
