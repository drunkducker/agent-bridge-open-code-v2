// Experiment only. Reimplements the small HTTP/translation subset studied in
// router-for-me/CLIProxyAPI @ 0db19025571684b198a2ef508f99b41c717337e8:
// internal/runtime/executor/codex_executor_request.go and
// internal/translator/codex/openai/chat-completions/codex_openai_request.go.
// No login, refresh, credential persistence, SDK or upstream installation.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function* sse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  function parse(block) {
    return block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
  }
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const data = parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) throw new Error('Truncated SSE event');
}

export function translate({ model, messages, tools = [], tool_choice, reasoning_effort = 'low' }) {
  const instructions = messages.filter(m => ['system', 'developer'].includes(m.role)).map(m => m.content).join('\n');
  const input = [];
  for (const m of messages) {
    if (['system', 'developer'].includes(m.role)) continue;
    if (m.role === 'tool') input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content });
    else {
      if (m.content) input.push({ role: m.role, content: m.content });
      for (const t of m.tool_calls || []) input.push({ type: 'function_call', call_id: t.id, name: t.function.name, arguments: t.function.arguments });
    }
  }
  return { model, instructions, input, stream: true, store: false,
    reasoning: { effort: reasoning_effort }, parallel_tool_calls: true,
    ...(tools.length ? { tools: tools.map(t => ({ type: 'function', ...t.function })) } : {}),
    ...(tool_choice ? { tool_choice: typeof tool_choice === 'object' ? { type: 'function', name: tool_choice.function.name } : tool_choice } : {}) };
}

export async function direct(request) {
  const start = performance.now();
  const auth = JSON.parse(await readFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'), 'utf8'));
  if (!auth.tokens?.access_token || !auth.tokens?.account_id) throw new Error('Existing Codex session missing');
  const response = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream',
      Authorization: `Bearer ${auth.tokens.access_token}`, 'Chatgpt-Account-Id': auth.tokens.account_id,
      'User-Agent': 'AgentBridge-proxy-experiment/1.0' },
    body: JSON.stringify(translate(request)),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Direct HTTP ${response.status}`); }
  const result = { text: '', tool_calls: [], textDeltas: 0, toolDeltas: 0, firstTextMs: null, firstToolMs: null, eventCounts: {} };
  let terminal = false;
  for await (const e of sse(response.body)) {
    result.eventCounts[e.type] = (result.eventCounts[e.type] || 0) + 1;
    if (e.type === 'response.output_text.delta') {
      result.firstTextMs ??= performance.now() - start;
      result.text += e.delta; result.textDeltas++;
    }
    if (e.type === 'response.function_call_arguments.delta') {
      result.firstToolMs ??= performance.now() - start; result.toolDeltas++;
    }
    if (e.type === 'response.output_item.done' && e.item?.type === 'function_call') result.tool_calls.push({
      id: e.item.call_id, type: 'function', function: { name: e.item.name, arguments: e.item.arguments },
    });
    if (e.type === 'response.completed') {
      terminal = true;
      const u = e.response?.usage;
      if (u) result.usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens, total_tokens: u.total_tokens };
    }
    if (['response.failed', 'response.incomplete', 'error'].includes(e.type)) throw new Error(`Direct terminal event: ${e.type}`);
  }
  if (!terminal) throw new Error('Direct stream ended without response.completed');
  result.totalMs = performance.now() - start;
  return result;
}
