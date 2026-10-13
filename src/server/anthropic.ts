// Anthropic-compatible endpoints
import { withAgentMode } from './agent.js';
import { attachImages } from './images.js';
import { toolsFromAnthropic, choiceFrom, anthropicTurns, anthropicBlocks } from './tools/format.js';
import { runTools } from './tools/run.js';
import {
  HttpError,
  rid,
  pickTarget,
  effortFrom,
  effortFromBudget,
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
  est,
  readParams,
  ignoredHeaders,
  applyPayloadRules,
  sessionKeyOf,
} from './common.js';

export function anthropicError(e: HttpError) {
  const typeMap: Record<number, string> = {
    400: 'invalid_request_error',
    401: 'authentication_error',
    403: 'permission_error',
    404: 'not_found_error',
    413: 'request_too_large',
    429: 'rate_limit_error',
  };
  const type =
    typeMap[e.status] || (e.status >= 500 || e.status === 499 ? 'api_error' : e.type);
  return { type: 'error', error: { type, message: e.message }, request_id: rid('req_') };
}

function finishErr(res: any, e: HttpError, started: boolean) {
  if (res.destroyed) return;
  if (!started)
    return sendJson(
      res,
      e.status,
      anthropicError(e),
      e.retryAfter != null ? { 'retry-after': String(e.retryAfter) } : {}
    );
  sseData(res, anthropicError(e), 'error');
  res.end();
}

const blockText = (c: any) => contentText(c);

function prep(body: any, opts: any = {}, req?: any) {
  if (!Array.isArray(body.messages) || !body.messages.length)
    throw new HttpError(400, 'messages: Field required', 'invalid_request_error');
  const choice = choiceFrom(body.tool_choice);
  const tools = choice.mode === 'none' ? [] : toolsFromAnthropic(body);
  if (choice.mode === 'tool' && !tools.some((t) => t.name === choice.name))
    throw new HttpError(
      400,
      `tool_choice names an unknown tool "${choice.name}"`,
      'invalid_request_error',
      'invalid_tool_choice'
    );
  const target = pickTarget(body.model, opts, req);
  const sys: string[] = [];
  if (body.system) sys.push(blockText(body.system));
  const turns: any[] = [],
    names = new Map<string, string>();
  for (const m of body.messages) {
    if (!m || typeof m !== 'object' || typeof m.role !== 'string')
      throw new HttpError(400, 'messages: each entry must be an object with a string role', 'invalid_request_error');
    if (m.role !== 'user' && m.role !== 'assistant')
      throw new HttpError(400, `messages: unsupported role "${m.role}"`, 'invalid_request_error');
    turns.push(...anthropicTurns(m.role, m.content, names));
  }
  // content that renders to nothing (thinking-only, empty arrays) must reach the guard below, not crash on turns[]
  if (!turns.length)
    throw new HttpError(400, 'messages: must contain at least one message with content', 'invalid_request_error');
  if (turns[turns.length - 1].role === 'assistant')
    throw new HttpError(
      400,
      'The last message must have role "user" (assistant prefill is not supported by the agentbridge proxy)',
      'invalid_request_error'
    );
  const effort =
    effortFrom(body.output_config?.effort) ?? effortFromBudget(body.thinking) ?? target.effort;
  const params = readParams(body);
  const r = applyPayloadRules(opts.cfg, target.canonical, { effort });
  return {
    target,
    prompt: buildPrompt(turns, opts.cfg?.get().historyBudgetTokens || 0),
    incremental: incrementalPrompt(turns),
    systemPrompt: joinSystem(sys, [], target.mode),
    effort: r.effort,
    quotaPolicy: opts.quotaPolicy,
    turns,
    sysText: sys.join('\n'),
    tools,
    choice,
    maxTokens: params.maxTokens,
    stop: params.stop,
    ignored: params.ignored,
    sessionKey: sessionKeyOf(req),
  };
}

async function messages(req: any, res: any, opts: any) {
  const signal = clientAbort(res);
  const body = await readJson(req);
  assertClientActive(signal);
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1)
    throw new HttpError(400, 'max_tokens: Field required (positive integer)', 'invalid_request_error');
  const p = await attachImages(prep(body, opts, req), body, { signal });
  assertClientActive(signal);
  const ag = withAgentMode(
    {
      target: p.target,
      prompt: p.prompt,
      incremental: p.incremental,
      systemPrompt: p.systemPrompt,
      effort: p.effort,
      maxTokens: p.maxTokens,
      stop: p.stop,
      sessionKey: p.sessionKey,
      mode: p.target.mode,
      signal,
      timeoutMs: opts.timeoutMs,
      quotaPolicy: p.quotaPolicy,
      fallback: opts.fallback,
      pool: opts.pool,
      stats: opts.stats,
      images: p.images,
    },
    req,
    opts
  );
  const o = ag.o,
    hdr = { ...ignoredHeaders(p.ignored), ...warnHeaders(p.warning), ...ag.headers };
  const id = rid('msg_'),
    model = body.model;
  const stopOf = (r: any) => ({
    stop_reason:
      ({ length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'refusal' } as Record<string, string>)[
        r.finishReason
      ] || (r.stopSequence ? 'stop_sequence' : 'end_turn'),
    stop_sequence: r.stopSequence ?? null,
  });
  const usageOf = (u: any) => ({ input_tokens: u.input, output_tokens: u.output });
  const skeleton = { id, type: 'message', role: 'assistant', model, content: [] as any[], stop_reason: null, stop_sequence: null };
  const ev = (type: string, data: any) => sseData(res, { type, ...data }, type);
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
    const blocks = [...(r.text ? [{ type: 'text', text: r.text }] : []), ...anthropicBlocks(calls)];
    const so = calls.length ? { stop_reason: 'tool_use', stop_sequence: null } : stopOf(r);
    if (!body.stream)
      return sendJson(res, 200, { ...skeleton, content: blocks, ...so, usage: usageOf(r.usage) }, h2);
    sseStart(res, h2);
    ev('message_start', { message: { ...skeleton, usage: { input_tokens: r.usage.input, output_tokens: 1 } } });
    blocks.forEach((b: any, i) => {
      if (b.type === 'text') {
        ev('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
        ev('content_block_delta', { index: i, delta: { type: 'text_delta', text: b.text } });
      } else {
        ev('content_block_start', { index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        ev('content_block_delta', {
          index: i,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
        });
      }
      ev('content_block_stop', { index: i });
    });
    ev('message_delta', { delta: so, usage: { input_tokens: r.usage.input, output_tokens: r.usage.output } });
    ev('message_stop', {});
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
        ...skeleton,
        content: [{ type: 'text', text: r.text }],
        ...stopOf(r),
        usage: usageOf(r.usage),
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
        ev('message_start', { message: { ...skeleton, usage: { input_tokens: est(p.prompt), output_tokens: 1 } } });
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        ev('ping', {});
      },
      onDelta(d: string) {
        if (d) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: d } });
      },
    });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: stopOf(r), usage: { input_tokens: r.usage.input, output_tokens: r.usage.output } });
    ev('message_stop', {});
    ag.finish();
    res.end();
  } catch (e: any) {
    ag.abort();
    if (signal.aborted) return res.end();
    throw Object.assign(e, { _started: started });
  }
}

async function countTokens(req: any, res: any, opts: any) {
  const body = await readJson(req);
  const p = prep(body, opts, req);
  sendJson(res, 200, { input_tokens: est(p.systemPrompt) + est(p.prompt) });
}

export async function handle(req: any, res: any, url: string, opts: any): Promise<boolean> {
  try {
    if (req.method === 'POST' && url === '/v1/messages') {
      await messages(req, res, opts);
      return true;
    }
    if (req.method === 'POST' && url === '/v1/messages/count_tokens') {
      await countTokens(req, res, opts);
      return true;
    }
  } catch (e: any) {
    finishErr(res, mapError(e), !!e._started);
    return true;
  }
  return false;
}
