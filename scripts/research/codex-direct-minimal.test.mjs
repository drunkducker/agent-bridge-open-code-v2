import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sse, translate } from './codex-direct-minimal.mjs';

test('SSE survives every byte boundary, UTF-8, CRLF, comments and DONE', async () => {
  const bytes = new TextEncoder().encode(':keepalive\r\ndata: {"text":"ação"}\r\n\r\ndata: [DONE]\r\n\r\n');
  async function* source() { for (const byte of bytes) yield Uint8Array.of(byte); }
  assert.deepEqual(await Array.fromAsync(sse(source())), [{ text: 'ação' }]);
});

test('SSE rejects truncated payload rather than accepting a partial result', async () => {
  async function* source() { yield new TextEncoder().encode('data: {"partial":true}'); }
  await assert.rejects(Array.fromAsync(sse(source())), /Truncated/);
});

test('native tool history preserves name, arguments, call ID and matching result', () => {
  const payload = translate({ model: 'test', messages: [
    { role: 'system', content: 'Use estoque' },
    { role: 'user', content: 'Quantidade?' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_demo', function: { name: 'estoque', arguments: '{"sku":"A"}' } }] },
    { role: 'tool', tool_call_id: 'call_demo', content: '{"quantidade":17}' },
  ], tools: [{ type: 'function', function: { name: 'estoque', parameters: { type: 'object' } } }], tool_choice: 'none' });
  assert.equal(payload.instructions, 'Use estoque');
  assert.deepEqual(payload.input.slice(1), [
    { type: 'function_call', call_id: 'call_demo', name: 'estoque', arguments: '{"sku":"A"}' },
    { type: 'function_call_output', call_id: 'call_demo', output: '{"quantidade":17}' },
  ]);
  assert.equal(payload.tools[0].name, 'estoque');
  assert.equal(payload.store, false);
});
