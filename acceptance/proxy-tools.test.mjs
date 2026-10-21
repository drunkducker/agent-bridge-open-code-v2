// Client tool calling through prompt emulation, with a scripted fake adapter (no real CLI).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startProxy } from '../dist/server/index.js';
import { parseToolCalls } from '../dist/server/tools/emulate.js';
import { ev } from '../dist/core/events.js';

const PARAMS = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
const TOOLS = [{ name: 'get_weather', description: 'weather', parameters: PARAMS }];
const CHAT_TOOL = { type: 'function', function: { name: 'get_weather', description: 'weather', parameters: PARAMS } };
const callText = (args, pre = '') => `${pre}<tool_call>${JSON.stringify({ name: 'get_weather', arguments: args })}</tool_call>`;

const seen = [];
let replies = [];
const adapter = { name: 'fake', async *run(opts) {
  seen.push(opts);
  const text = replies.length > 1 ? replies.shift() : replies[0];
  yield ev.text(text);
  return { text, usage: { input: 3, output: 2 } };
} };
const script = (...r) => { replies = r; seen.length = 0; };

let proxy;
before(async () => { proxy = await startProxy({ port: 0, adapters: { fake: adapter } }); });
after(() => proxy?.close());

const post = (p, body) => fetch(proxy.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const chat = (body) => post('/v1/chat/completions', { model: 'fake/m1', messages: [{ role: 'user', content: 'weather?' }], tools: [CHAT_TOOL], ...body });
const sse = async (res) => (await res.text()).split('\n\n').map((b) => b.replace(/^data: /, '')).filter((b) => b && b !== '[DONE]').map((b) => JSON.parse(b));

test('parseToolCalls: valid, fenced, multiple, unterminated', () => {
  let p = parseToolCalls(callText({ city: 'Paris' }, 'Let me check. '), TOOLS);
  assert.equal(p.text, 'Let me check.'); assert.equal(p.calls.length, 1);
  assert.deepEqual(p.calls[0].arguments, { city: 'Paris' }); assert.match(p.calls[0].id, /^call_/); assert.ok(!p.error);
  p = parseToolCalls('<tool_call>```json\n{"name":"get_weather","arguments":{"city":"Rome"}}\n```</tool_call>', TOOLS);
  assert.equal(p.calls[0].arguments.city, 'Rome');
  p = parseToolCalls(callText({ city: 'A' }) + '\n' + callText({ city: 'B' }), TOOLS);
  assert.deepEqual(p.calls.map((c) => c.arguments.city), ['A', 'B']);
  p = parseToolCalls('<tool_call>{"name":"get_weather","arguments":"{\\"city\\":\\"Oslo\\"}"}', TOOLS);
  assert.equal(p.calls[0].arguments.city, 'Oslo');
  assert.deepEqual(parseToolCalls('just text', TOOLS), { text: 'just text', calls: [] });
});

test('parseToolCalls: problems are reported, not thrown', () => {
  assert.match(parseToolCalls('<tool_call>nope</tool_call>', TOOLS).error, /not valid JSON/);
  assert.match(parseToolCalls(callText({}).replace('get_weather', 'other'), TOOLS).error, /unknown tool/);
  const bad = parseToolCalls(callText({ town: 'x' }), TOOLS);
  assert.match(bad.error, /city/); assert.equal(bad.calls.length, 0);
});

test('chat: tool call -> tool_calls + finish_reason (non-stream and stream)', async () => {
  script(callText({ city: 'Paris' }, 'Checking. '));
  const c = (await (await chat()).json()).choices[0];
  assert.equal(c.finish_reason, 'tool_calls'); assert.equal(c.message.content, 'Checking.');
  assert.equal(c.message.tool_calls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(c.message.tool_calls[0].function.arguments), { city: 'Paris' });
  const chunks = await sse(await chat({ stream: true }));
  const deltas = chunks.flatMap((x) => x.choices[0]?.delta?.tool_calls || []);
  assert.equal(deltas[0].function.name, 'get_weather');
  assert.equal(JSON.parse(deltas.map((d) => d.function.arguments || '').join('')).city, 'Paris');
  assert.equal(chunks.at(-1).choices[0].finish_reason, 'tool_calls');
});

test('chat: schemas reach the model; history calls/results are rendered', async () => {
  script('It is sunny.');
  const messages = [
    { role: 'user', content: 'weather in Paris?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '18C' },
  ];
  const j = await (await chat({ messages })).json();
  assert.equal(j.choices[0].finish_reason, 'stop'); assert.equal(j.choices[0].message.content, 'It is sunny.');
  const o = seen.at(-1);
  assert.match(o.systemPrompt, /<tools>/); assert.match(o.systemPrompt, /get_weather/);
  assert.doesNotMatch(o.systemPrompt, /Do NOT use any tools/);
  assert.match(o.systemPrompt, /client.*execut/i);
  assert.match(o.systemPrompt, /harness.*tools/i);
  assert.equal(o.permissions, 'read-only');
  assert.match(o.prompt, /<tool_call>.*get_weather/); assert.match(o.prompt, /<tool_result[^>]*>\s*18C/);
});

test('chat: an invalid call is retried once with the error', async () => {
  script(callText({ town: 'x' }), callText({ city: 'Lima' }));
  const j = await (await chat()).json();
  assert.equal(seen.length, 2); assert.match(seen[1].prompt, /invalid tool call/);
  assert.equal(JSON.parse(j.choices[0].message.tool_calls[0].function.arguments).city, 'Lima');
});

test('chat: unusable output comes back as text with a warning header', async () => {
  script('<tool_call>garbage</tool_call>');
  const r = await chat();
  assert.match(r.headers.get('x-agentbridge-warning') || '', /tool_call_unparsed/);
  assert.equal((await r.json()).choices[0].finish_reason, 'stop');
});

test('chat: tool_choice none; unknown named tool; hosted tools', async () => {
  script('plain');
  const j = await (await chat({ tool_choice: 'none' })).json();
  assert.equal(j.choices[0].message.content, 'plain'); assert.ok(!/<tools>/.test(seen.at(-1).systemPrompt || ''));
  let r = await chat({ tool_choice: { type: 'function', function: { name: 'zzz' } } });
  assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'invalid_tool_choice');
  r = await chat({ tools: [{ type: 'web_search' }] });
  assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'tools_not_supported');
});

test('responses: function_call items and function_call_output input', async () => {
  const tool = { type: 'function', name: 'get_weather', description: 'weather', parameters: PARAMS };
  script(callText({ city: 'Paris' }));
  const j = await (await post('/v1/responses', { model: 'fake/m1', input: 'weather?', tools: [tool] })).json();
  const fc = j.output.find((x) => x.type === 'function_call');
  assert.equal(fc.name, 'get_weather'); assert.deepEqual(JSON.parse(fc.arguments), { city: 'Paris' }); assert.ok(fc.call_id);
  script('sunny');
  const j2 = await (await post('/v1/responses', { model: 'fake/m1', tools: [tool], input: [
    { role: 'user', content: 'weather?' },
    { type: 'function_call', call_id: fc.call_id, name: 'get_weather', arguments: fc.arguments },
    { type: 'function_call_output', call_id: fc.call_id, output: '18C' }] })).json();
  assert.equal(j2.output[0].content[0].text, 'sunny');
  assert.match(seen.at(-1).prompt, /<tool_result/);
  script(callText({ city: 'Paris' }));
  const body = await (await post('/v1/responses', { model: 'fake/m1', input: 'weather?', tools: [tool], stream: true })).text();
  assert.match(body, /response\.function_call_arguments\.done/); assert.match(body, /response\.completed/);
});

test('anthropic: tool_use blocks, tool_result input, streaming', async () => {
  const tool = { name: 'get_weather', description: 'weather', input_schema: PARAMS };
  const m = (body) => post('/v1/messages', { model: 'fake/m1', max_tokens: 100, tools: [tool], ...body });
  script(callText({ city: 'Paris' }, 'One sec. '));
  const j = await (await m({ messages: [{ role: 'user', content: 'weather?' }] })).json();
  assert.equal(j.stop_reason, 'tool_use');
  const use = j.content.find((b) => b.type === 'tool_use');
  assert.deepEqual(use.input, { city: 'Paris' }); assert.match(use.id, /^toolu_/);
  script('sunny');
  const j2 = await (await m({ messages: [
    { role: 'user', content: 'weather?' },
    { role: 'assistant', content: j.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: '18C' }] }] })).json();
  assert.equal(j2.stop_reason, 'end_turn'); assert.equal(j2.content[0].text, 'sunny');
  assert.match(seen.at(-1).prompt, /<tool_result[^>]*>\s*18C/);
  script(callText({ city: 'Paris' }));
  const text = await (await m({ stream: true, messages: [{ role: 'user', content: 'weather?' }] })).text();
  assert.match(text, /input_json_delta/); assert.match(text, /"stop_reason":"tool_use"/);
});

test('agent mode refuses client tools', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'ab-agent-root-'));
  const p = await startProxy({ port: 0, adapters: { fake: adapter }, token: 'tok', agentRoot: root });
  try {
    const r = await fetch(p.url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tok' }, body: JSON.stringify({ model: 'agent/fake/m1', messages: [{ role: 'user', content: 'x' }], tools: [CHAT_TOOL] }) });
    assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'tools_not_supported');
  } finally { await p.close(); rmSync(root, { recursive: true, force: true }); }
});
