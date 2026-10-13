// OpenAI-compatible endpoints
import { withAgentMode } from './agent.js';
import { attachImages } from './images.js';
import {
  toolsFromChat,
  toolsFromResponses,
  choiceFrom,
  chatTurns,
  responsesToolTurn,
  chatToolCalls,
  chatToolDeltas,
  responsesItems,
} from './tools/format.js';
import { runTools } from './tools/run.js';
import {
  HttpError,
  rid,
  now,
  pickTarget,
  listModels,
  effortFrom,
  buildPrompt,
  incrementalPrompt,
  joinSystem,
  drive,
  runToEnd,
  warnHeaders,
  mapError,
  readJson,
  sendJson,
  sseStart,
  sseData,
  clientAbort,
  assertClientActive,
  contentText,
  readParams,
  ignoredHeaders,
  applyPayloadRules,
  sessionKeyOf,
} from './common.js';

export function openaiError(e: HttpError) {
  return { error: { message: e.message, type: e.type, param: null, code: e.code } };
}

function finishErr(res: any, e: HttpError, started: boolean) {
  if (res.destroyed) return;
  if (!started)
    return sendJson(
      res,
      e.status,
      openaiError(e),
      e.retryAfter != null ? { 'retry-after': String(e.retryAfter) } : {}
    );
  sseData(res, openaiError(e));
  sseData(res, '[DONE]');
  res.end();
}

function schemaFromFormat(rf: any, sys: string[]) {
  if (!rf) return undefined;
  if (rf.type === 'json_schema' && rf.json_schema?.schema) return rf.json_schema.schema;
  if (rf.type === 'json_object') sys.push('Reply with a single valid JSON object and nothing else.');
  return undefined;
}

function prepChat(body: any, opts: any = {}, req?: any) {
  if (!Array.isArray(body.messages) || !body.messages.length)
    throw new HttpError(400, '`messages` must be a non-empty array', 'invalid_request_error', 'invalid_messages');
  const choice = choiceFrom(body.tool_choice, body.function_call);
  const tools = choice.mode === 'none' ? [] : toolsFromChat(body);
  if (choice.mode === 'tool' && !tools.some((t) => t.name === choice.name))
    throw new HttpError(
      400,
      `tool_choice names an unknown tool "${choice.name}"`,
      'invalid_request_error',
      'invalid_tool_choice'
    );
  if (body.n != null && body.n !== 1)
    throw new HttpError(400, 'Only n=1 is supported', 'invalid_request_error', 'unsupported_n');
  const target = pickTarget(body.model, opts, req);
  const { sys, turns } = chatTurns(body.messages);
  if (!turns.length)
    throw new HttpError(400, 'At least one user message is required', 'invalid_request_error', 'invalid_messages');
  const jsonSchema = schemaFromFormat(body.response_format, sys);
  return { ...common(target, turns, sys, effortFrom(body.reasoning_effort), jsonSchema, body, opts, req), tools, choice };
}

function common(
  target: any,
  turns: any[],
  sys: string[],
  effort: string | undefined,
  jsonSchema: any,
  body: any,
  opts: any,
  req: any
) {
  const params = readParams(body);
  const budget = opts.cfg?.get().historyBudgetTokens || 0;
  const o = applyPayloadRules(opts.cfg, target.canonical, { effort: effort ?? target.effort });
  return {
    target,
    prompt: buildPrompt(turns, budget),
    incremental: incrementalPrompt(turns),
    systemPrompt: joinSystem(sys, [], target.mode),
    effort: o.effort,
    quotaPolicy: opts.quotaPolicy,
    jsonSchema,
    maxTokens: params.maxTokens,
    stop: params.stop,
    ignored: params.ignored,
    sessionKey: sessionKeyOf(req, opts),
  };
}

async function chat(req: any, res: any, opts: any) {
  const signal = clientAbort(res);
  const body = await readJson(req);
  assertClientActive(signal);
  const p = await attachImages(prepChat(body, opts, req), body, { signal });
  assertClientActive(signal);
  const ag = withAgentMode(
    {
      ...p,
      signal,
      timeoutMs: opts.timeoutMs,
      fallback: opts.fallback,
      pool: opts.pool,
      stats: opts.stats,
    },
    req,
    opts
  );
  const o = ag.o,
    hdr = { ...ignoredHeaders(p.ignored), ...warnHeaders(p.warning), ...ag.headers };
  const id = rid('chatcmpl-'),
    created = now(),
    model = body.model;
  const fin = (r: any) => r.finishReason || 'stop';
  const mk = (delta: any, finish: any, extra: any = {}) => ({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    ...extra,
  });
  if (p.tools.length) {
    let r: any;
    try {
      r = await runTools(o, p.tools, p.choice);
    } catch (e) {
      ag.abort();
      throw e;
    }
    ag.finish();
    const calls = r.toolCalls || [],
      h2 = { ...hdr, ...warnHeaders(r.warning) };
    const finish = calls.length ? 'tool_calls' : fin(r);
    const usage = {
      prompt_tokens: r.usage.input,
      completion_tokens: r.usage.output,
      total_tokens: r.usage.input + r.usage.output,
    };
    if (!body.stream) {
      const message = {
        role: 'assistant',
        content: r.text || (calls.length ? null : ''),
        refusal: null,
        ...(calls.length ? { tool_calls: chatToolCalls(calls) } : {}),
      };
      return sendJson(
        res,
        200,
        { id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish, logprobs: null }], usage },
        h2
      );
    }
    sseStart(res, h2);
    sseData(res, mk({ role: 'assistant', content: r.text ? '' : null }, null));
    if (r.text) sseData(res, mk({ content: r.text }, null));
    for (const pair of chatToolDeltas(calls)) for (const d of pair) sseData(res, mk({ tool_calls: [d] }, null));
    sseData(res, mk({}, finish));
    if (body.stream_options?.include_usage)
      sseData(res, { id, object: 'chat.completion.chunk', created, model, choices: [], usage });
    sseData(res, '[DONE]');
    return res.end();
  }
  if (!body.stream) {
    let r: any;
    try {
      r = await runToEnd(o);
    } catch (e) {
      ag.abort();
      throw e;
    }
    const extra = ag.finish();
    return sendJson(
      res,
      200,
      {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          { index: 0, message: { role: 'assistant', content: r.text, refusal: null }, finish_reason: fin(r), logprobs: null },
        ],
        usage: { prompt_tokens: r.usage.input, completion_tokens: r.usage.output, total_tokens: r.usage.input + r.usage.output },
        ...(extra ? { agentbridge: extra } : {}),
      },
      hdr
    );
  }
  let started = false;
  try {
    const r = await drive(o, {
      onStart() {
        started = true;
        sseStart(res, hdr);
        sseData(res, mk({ role: 'assistant', content: '' }, null));
      },
      onDelta(d: string) {
        if (d) sseData(res, mk({ content: d }, null));
      },
    });
    sseData(res, mk({}, fin(r)));
    if (body.stream_options?.include_usage) {
      sseData(res, {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage: { prompt_tokens: r.usage.input, completion_tokens: r.usage.output, total_tokens: r.usage.input + r.usage.output },
      });
    }
    const extra = ag.finish();
    if (extra) sseData(res, { id, object: 'chat.completion.chunk', created, model, choices: [], agentbridge: extra });
    sseData(res, '[DONE]');
    res.end();
  } catch (e: any) {
    ag.abort();
    if (signal.aborted) return res.end();
    throw Object.assign(e, { _started: started });
  }
}

function responsesInput(body: any) {
  const sys: string[] = body.instructions ? [body.instructions] : [];
  const turns: any[] = [],
    names = new Map<string, string>();
  const inp = body.input;
  if (typeof inp === 'string') turns.push({ role: 'user', text: inp });
  else if (Array.isArray(inp)) {
    for (const it of inp) {
      if (typeof it === 'string') {
        turns.push({ role: 'user', text: it });
        continue;
      }
      const ty = it.type || 'message';
      if (ty === 'reasoning') continue;
      if (ty === 'function_call' || ty === 'function_call_output') {
        turns.push(responsesToolTurn(it, names));
        continue;
      }
      if (ty !== 'message')
        throw new HttpError(
          400,
          `Input item type "${ty}" is not supported by the agentbridge proxy`,
          'invalid_request_error',
          'tools_not_supported'
        );
      const t = contentText(it.content);
      if (it.role === 'system' || it.role === 'developer') sys.push(t);
      else if (it.role === 'user' || it.role === 'assistant') turns.push({ role: it.role, text: t });
      else throw new HttpError(400, `Unsupported role "${it.role}"`, 'invalid_request_error', 'invalid_role');
    }
  } else throw new HttpError(400, '`input` must be a string or array', 'invalid_request_error', 'invalid_input');
  if (!turns.length)
    throw new HttpError(400, 'At least one user input is required', 'invalid_request_error', 'invalid_input');
  return { sys, turns };
}

async function responses(req: any, res: any, opts: any) {
  const signal = clientAbort(res);
  const body = await readJson(req);
  assertClientActive(signal);
  if (body.previous_response_id) {
    throw new HttpError(
      400,
      '`previous_response_id` is not supported by the agentbridge proxy',
      'invalid_request_error',
      'unsupported_parameter'
    );
  }
  const choice = choiceFrom(body.tool_choice);
  const tools = choice.mode === 'none' ? [] : toolsFromResponses(body);
  if (choice.mode === 'tool' && !tools.some((t) => t.name === choice.name))
    throw new HttpError(
      400,
      `tool_choice names an unknown tool "${choice.name}"`,
      'invalid_request_error',
      'invalid_tool_choice'
    );
  const target = pickTarget(body.model, opts, req);
  const { sys, turns } = responsesInput(body);
  let jsonSchema: any;
  const f = body.text?.format;
  if (f?.type === 'json_schema' && f.schema) jsonSchema = f.schema;
  else if (f?.type === 'json_object') sys.push('Reply with a single valid JSON object and nothing else.');
  const p = await attachImages(
    {
      ...common(target, turns, sys, effortFrom(body.reasoning?.effort), jsonSchema, body, opts, req),
      tools,
      choice,
    },
    body,
    { signal }
  );
  assertClientActive(signal);
  const ag = withAgentMode(
    {
      ...p,
      signal,
      timeoutMs: opts.timeoutMs,
      fallback: opts.fallback,
      pool: opts.pool,
      stats: opts.stats,
    },
    req,
    opts
  );
  const o = ag.o,
    hdr = { ...ignoredHeaders(p.ignored), ...warnHeaders(p.warning), ...ag.headers };
  const id = rid('resp_'),
    msgId = rid('msg_'),
    created = now(),
    model = body.model;
  const resp = (status: string, text?: string, usage?: any, incomplete?: boolean) => ({
    id,
    object: 'response',
    created_at: created,
    status,
    model,
    error: null,
    incomplete_details: incomplete ? { reason: 'max_output_tokens' } : null,
    instructions: body.instructions ?? null,
    output:
      status === 'completed' || status === 'incomplete'
        ? [
            {
              id: msgId,
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text, annotations: [] }],
            },
          ]
        : [],
    parallel_tool_calls: false,
    tool_choice: 'none',
    tools: [],
    temperature: body.temperature ?? null,
    top_p: body.top_p ?? null,
    usage: usage
      ? {
          input_tokens: usage.input,
          output_tokens: usage.output,
          total_tokens: usage.input + usage.output,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        }
      : null,
  });
  const st = (r: any) => (r.finishReason === 'length' ? 'incomplete' : 'completed');
  if (p.tools.length) {
    let r: any;
    try {
      r = await runTools(o, p.tools, p.choice);
    } catch (e) {
      ag.abort();
      throw e;
    }
    ag.finish();
    const calls = r.toolCalls || [],
      h2 = { ...hdr, ...warnHeaders(r.warning) };
    const msg = r.text
      ? {
          id: msgId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: r.text, annotations: [] }],
        }
      : null;
    const fcs = responsesItems(calls, rid);
    const output = [...(msg ? [msg] : []), ...fcs];
    const full = {
      ...resp('completed', r.text, r.usage),
      tool_choice: body.tool_choice ?? 'auto',
      tools: body.tools ?? [],
      parallel_tool_calls: true,
      output,
    };
    if (!body.stream) return sendJson(res, 200, full, h2);
    sseStart(res, h2);
    let seq = 0;
    const ev = (type: string, data: any) => sseData(res, { type, sequence_number: seq++, ...data }, type);
    ev('response.created', { response: { ...full, status: 'in_progress', output: [] } });
    ev('response.in_progress', { response: { ...full, status: 'in_progress', output: [] } });
    let oi = 0;
    if (msg) {
      ev('response.output_item.added', { output_index: oi, item: { ...msg, status: 'in_progress', content: [] } });
      ev('response.content_part.added', {
        item_id: msgId,
        output_index: oi,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
      ev('response.output_text.delta', { item_id: msgId, output_index: oi, content_index: 0, delta: r.text });
      ev('response.output_text.done', { item_id: msgId, output_index: oi, content_index: 0, text: r.text });
      ev('response.content_part.done', { item_id: msgId, output_index: oi, content_index: 0, part: msg.content[0] });
      ev('response.output_item.done', { output_index: oi, item: msg });
      oi++;
    }
    for (const fc of fcs) {
      ev('response.output_item.added', { output_index: oi, item: { ...fc, status: 'in_progress', arguments: '' } });
      ev('response.function_call_arguments.delta', { item_id: fc.id, output_index: oi, delta: fc.arguments });
      ev('response.function_call_arguments.done', { item_id: fc.id, output_index: oi, arguments: fc.arguments });
      ev('response.output_item.done', { output_index: oi, item: fc });
      oi++;
    }
    ev('response.completed', { response: full });
    return res.end();
  }
  if (!body.stream) {
    let r: any;
    try {
      r = await runToEnd(o);
    } catch (e) {
      ag.abort();
      throw e;
    }
    const extra = ag.finish();
    return sendJson(
      res,
      200,
      {
        ...resp(st(r), r.text, r.usage, r.finishReason === 'length'),
        ...(extra ? { agentbridge: extra } : {}),
      },
      hdr
    );
  }
  let started = false,
    seq = 0;
  const ev = (type: string, data: any) => sseData(res, { type, sequence_number: seq++, ...data }, type);
  try {
    const r = await drive(o, {
      onStart() {
        started = true;
        sseStart(res, hdr);
        ev('response.created', { response: resp('in_progress') });
        ev('response.in_progress', { response: resp('in_progress') });
        ev('response.output_item.added', {
          output_index: 0,
          item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
        });
        ev('response.content_part.added', {
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
      },
      onDelta(d: string) {
        if (d) ev('response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: d });
      },
    });
    ev('response.output_text.done', { item_id: msgId, output_index: 0, content_index: 0, text: r.text });
    ev('response.content_part.done', {
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: r.text, annotations: [] },
    });
    ev('response.output_item.done', {
      output_index: 0,
      item: { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: r.text, annotations: [] }] },
    });
    ev(st(r) === 'incomplete' ? 'response.incomplete' : 'response.completed', {
      response: resp(st(r), r.text, r.usage, r.finishReason === 'length'),
    });
    ag.finish();
    res.end();
  } catch (e: any) {
    ag.abort();
    if (signal.aborted) return res.end();
    throw Object.assign(e, { _started: started });
  }
}

export async function models(req: any, res: any): Promise<void> {
  const ids = await listModels();
  sendJson(res, 200, {
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: id.split('/')[0] })),
  });
}

/** returns true if handled */
export async function handle(req: any, res: any, url: string, opts: any): Promise<boolean> {
  const m = req.method;
  try {
    if (m === 'POST' && url === '/v1/chat/completions') {
      await chat(req, res, opts);
      return true;
    }
    if (m === 'POST' && url === '/v1/responses') {
      await responses(req, res, opts);
      return true;
    }
  } catch (e: any) {
    finishErr(res, mapError(e), !!e._started);
    return true;
  }
  return false;
}
