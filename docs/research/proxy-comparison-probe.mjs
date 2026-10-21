// Offline probe: node docs/research/proxy-comparison-probe.mjs /path/to/copilot-api [build-dir]
// Requires Node >=24 and an AgentBridge build (defaults to dist/). No provider credentials are used.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { pathToFileURL } from 'node:url';

const copilotRoot = process.argv[2];
assert.ok(copilotRoot, 'Pass the path to the copilot-api checkout');
const root = path.resolve(import.meta.dirname, '../..');
const buildDir = path.resolve(process.argv[3] || path.join(root, 'dist'));
const { startProxy } = await import(pathToFileURL(path.join(buildDir, 'server/index.js')));
const { makeEndpointAdapter } = await import(pathToFileURL(path.join(buildDir, 'adapters/endpoint.js')));

// Execute the checked-out translator with its original function bodies, stripping types only.
function loadTranslator(file, bindings = {}) {
  let source = readFileSync(path.join(copilotRoot, file), 'utf8');
  source = source.replace(/^import\s[\s\S]*?from\s+"[^"]+"\s*;?\s*$/gm, '');
  source = stripTypeScriptTypes(source, { mode: 'strip' });
  const names = [...source.matchAll(/export function (\w+)/g)].map((match) => match[1]);
  source = source.replace(/export function /g, 'function ');
  return new Function(...Object.keys(bindings), `${source}\nreturn {${names.join(',')}};`)(...Object.values(bindings));
}
const utils = loadTranslator('src/routes/messages/utils.ts');
const translator = loadTranslator('src/routes/messages/non-stream-translation.ts', utils);
const streamTranslator = loadTranslator('src/routes/messages/stream-translation.ts', utils);
const translated = translator.translateToOpenAI({
  model: 'fixture', max_tokens: 123, temperature: 0.2,
  system: 'System fixture',
  tools: [{ name: 'lookup', description: 'Fixture', input_schema: { type: 'object' } }],
  tool_choice: { type: 'tool', name: 'lookup' },
  messages: [
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_fixture', name: 'lookup', input: { key: 'value' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_fixture', content: 'Result' }] },
  ],
});
assert.equal(translated.temperature, 0.2);
assert.equal(translated.max_tokens, 123);
assert.equal(translated.tools[0].function.name, 'lookup');
assert.equal(translated.messages.at(-1).role, 'tool');
assert.equal(translated.messages.at(-2).tool_calls[0].id, 'call_fixture');
const streamState = { messageStartSent: false, contentBlockIndex: 0, contentBlockOpen: false, toolCalls: {} };
const streamEvents = streamTranslator.translateChunkToAnthropicEvents({
  id: 'fixture', model: 'fixture',
  choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_fixture', function: { name: 'lookup', arguments: '{"key":' } }] }, finish_reason: null }],
}, streamState);
assert.ok(streamEvents.some((event) => event.delta?.partial_json === '{"key":'));

const upstreamBodies = [];
let nativeToolOnly = false;
const upstream = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  upstreamBodies.push(JSON.parse(raw));
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (nativeToolOnly) {
    res.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_fixture","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');
    return;
  }
  res.end('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\ndata: [DONE]\n\n');
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
let proxy;
try {
  const adapter = makeEndpointAdapter({ name: 'directfixture', type: 'openai', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, defaultModel: 'fixture' });
  proxy = await startProxy({ port: 0, adapters: { directfixture: adapter } });
  const call = async (extra) => {
    const response = await fetch(`${proxy.url}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'directfixture/fixture', messages: [
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'Previous answer' },
        { role: 'user', content: 'Next question' },
      ], ...extra }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return { ignored: response.headers.get('x-agentbridge-ignored'), body };
  };
  const plain = await call({ temperature: 0.2, max_tokens: 123 });
  const plainUpstream = upstreamBodies.at(-1);
  assert.ok(plain.ignored.includes('temperature'));
  assert.equal(plainUpstream.temperature, undefined);
  assert.equal(plainUpstream.max_tokens, undefined);
  assert.equal(plainUpstream.messages.filter((message) => message.role !== 'system').length, 1);
  assert.ok(plainUpstream.messages.at(-1).content.includes('Previous answer'));
  await call({ tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] });
  const toolsUpstream = upstreamBodies.at(-1);
  assert.equal(toolsUpstream.tools, undefined);
  assert.ok(toolsUpstream.messages.some((message) => message.content.includes('lookup')));
  nativeToolOnly = true;
  const iterator = adapter.run({ prompt: 'Fixture', harness: 'none', session: { mode: 'ephemeral' } });
  const endpointEvents = [];
  let endpointResult;
  for (;;) {
    const item = await iterator.next();
    if (item.done) { endpointResult = item.value; break; }
    endpointEvents.push(item.value);
  }
  assert.equal(endpointResult.text, '');
  assert.equal(endpointEvents.some((event) => event.type === 'tool'), false);
  console.log(JSON.stringify({
    scope: 'Offline fixtures; no inference, OAuth, latency or throughput benchmark',
    copilot: { structuredToolHistory: true, samplingAndLimitTranslated: true, partialToolArgumentsStreamed: true },
    agentbridge: {
      httpEndpointWorks: true,
      historyConvertedToSingleUserMessage: true,
      temperatureIgnored: true,
      maxTokensNotForwardedToOpenAIEndpoint: true,
      toolsRenderedInPromptInsteadOfForwardedAsSchemas: true,
      nativeEndpointToolDeltasNotExposed: true,
      upstreamRequestCount: upstreamBodies.length,
    },
  }, null, 2));
} finally {
  if (proxy) await proxy.close();
  await new Promise((resolve) => upstream.close(resolve));
}
