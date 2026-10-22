// Experiment infrastructure only. Never reads login tokens or calls a provider backend.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sse } from './codex-direct-minimal.mjs'; // parser only; never invokes Codex

const pause = ms => new Promise(r => setTimeout(r, ms));
export const stockTool = { name: 'consultar_estoque', description: 'Consulta o estoque real por SKU.',
  parameters: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'], additionalProperties: false } };

class Lines {
  values = []; waiting = null; error = null;
  push(v) { if (this.waiting) { const w = this.waiting; this.waiting = null; w.resolve(v); } else this.values.push(v); }
  fail(e) { this.error = e; if (this.waiting) { this.waiting.reject(e); this.waiting = null; } }
  next() {
    if (this.values.length) return Promise.resolve(this.values.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }
}

export class PersistentStdio {
  constructor(kind, model, dist, scratch) {
    Object.assign(this, { kind, model, dist, scratch });
    this.info = { transport: 'official CLI stream-json stdin kept open', spawns: 0, turns: 0,
      pids: [], retainsConversation: true, nativeTextDeltas: 0, nativeArgumentDeltas: 0,
      isolation: 'prototype retains context across requests; not a stateless production pool' };
  }
  async start(o) {
    if (this.child?.exitCode === null && !this.queue.error) return;
    this.queue = new Lines(); this.initialSystem = o.systemPrompt || '';
    let args, env = { ...process.env };
    if (this.kind === 'claude') {
      args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
        '--include-partial-messages', '--model', this.model, '--no-session-persistence',
        '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands',
        '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config', '--tools', '',
        '--append-system-prompt', this.initialSystem];
    } else {
      const mod = await import(pathToFileURL(join(this.dist, 'adapters/agy.js')));
      this.agyModule = mod;
      this.hm = mod.makeHome({ env, settings: mod.settingsFor('read-only'), shared: false, rules: this.initialSystem });
      env = { ...env, HOME: this.hm.dir, USERPROFILE: this.hm.dir };
      args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--model', this.model];
    }
    const child = this.child = spawn(this.kind, args, { cwd: this.scratch, env,
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.info.spawns++; this.info.pids.push(child.pid);
    child.stderr.resume(); // do not retain logs/credentials
    child.on('error', e => this.queue.fail(Error(`Native ${this.kind} spawn: ${e.code || 'error'}`)));
    child.on('exit', (code, signal) => this.queue.fail(Error(`Native ${this.kind} exited (${code ?? signal})`)));
    let pending = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      if (pending.length > 8e6) return this.queue.fail(Error('Native output limit exceeded'));
      let n;
      while ((n = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, n); pending = pending.slice(n + 1);
        try { this.queue.push(JSON.parse(line)); } catch { /* progress banners are not protocol events */ }
      }
    });
  }
  adapter() {
    const self = this;
    return { name: this.kind, async *run(o) {
      if (self.active) throw Error('Experimental stdio transport only supports sequential requests');
      self.active = true;
      let timer, onAbort;
      const t0 = performance.now();
      try {
        await self.start(o);
        // Fixed system prompt on process creation; changed tool schemas/history are explicit per-turn input.
        const prompt = [o.systemPrompt !== self.initialSystem ? o.systemPrompt : '', o.prompt].filter(Boolean).join('\n\n');
        const msg = self.kind === 'claude'
          ? { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, session_id: '' }
          : { event: 'user', message: { content: prompt } };
        const timeout = new Promise((_, reject) => {
          const stop = reason => { reject(Error(reason)); self.close().catch(() => {}); };
          timer = setTimeout(() => stop('Persistent turn timed out'), o.timeoutMs || 90000);
          onAbort = () => stop('Persistent turn aborted');
          o.signal?.addEventListener('abort', onAbort, { once: true });
          if (o.signal?.aborted) onAbort();
        });
        self.child.stdin.write(JSON.stringify(msg) + '\n');
        let text = '', usage = { input: 0, output: 0 }, result;
        for (;;) {
          const e = await Promise.race([self.queue.next(), timeout]);
          let delta;
          if (self.kind === 'claude') {
            if (e.type === 'stream_event' && e.event?.type === 'content_block_delta') {
              if (e.event.delta?.type === 'text_delta') delta = e.event.delta.text;
              if (e.event.delta?.type === 'input_json_delta') self.info.nativeArgumentDeltas++;
            }
            if (e.type === 'result') {
              if (e.is_error) throw Error('Native Claude returned an error result');
              result = e; const u = e.usage || {};
              usage = { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), output: u.output_tokens || 0 };
            }
          } else {
            const step = e.step_update;
            if (e.event === 'step_update' && step?.step_type === 'agent_response') {
              delta = step.text_delta;
              if (step.state === 'DONE' && step.usage) {
                usage.input += step.usage.input_tokens || 0; usage.output += step.usage.output_tokens || 0;
              }
            }
            if (e.event === 'result') {
              if (e.result?.status !== 'SUCCESS') throw Error('Native agy returned an error result');
              result = { result: e.result.response };
            }
          }
          if (delta) { text += delta; self.info.nativeTextDeltas++; yield { type: 'text', delta }; }
          if (result) {
            const full = result.result || '';
            if (!text && full) { text = full; yield { type: 'text', delta: full }; }
            self.info.turns++;
            return { text, usage, model: self.model, exitCode: 0, timedOut: false, durationMs: performance.now() - t0 };
          }
        }
      } finally {
        clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); self.active = false;
      }
    } };
  }
  async close() {
    const child = this.child;
    if (child?.exitCode === null) {
      const ended = once(child, 'exit').catch(() => {});
      child.stdin.end();
      await Promise.race([ended, pause(1000)]);
      for (const sig of ['SIGTERM', 'SIGKILL']) if (child.exitCode === null) {
        try { if (process.platform === 'win32') child.kill(sig); else process.kill(-child.pid, sig); } catch {}
        await Promise.race([ended, pause(600)]);
      }
    }
    if (this.hm) { this.agyModule.destroyHome(this.hm); this.hm = undefined; }
  }
}

export async function runStudy(config) {
  const [distArg, outputArg] = process.argv.slice(2);
  if (!distArg || !outputArg) throw Error('Usage: node <script> <fresh-dist> <results.json>');
  const dist = resolve(distArg), output = resolve(outputArg);
  const scratch = await mkdtemp(join(tmpdir(), `ab-${config.harness}-paths-`));
  process.env.AGENTBRIDGE_HOME = join(scratch, 'state'); await mkdir(process.env.AGENTBRIDGE_HOME);
  const { startProxy } = await import(pathToFileURL(join(dist, 'server/index.js')));
  const result = { date: new Date().toISOString(), harness: config.harness, model: config.model,
    agentbridgeHead: 'dabb7e2', upstream: 'router-for-me/CLIProxyAPI@0db19025571684b198a2ef508f99b41c717337e8',
    status: 'running', calls: [], direct: config.direct, limitations: config.limitations || [],
    semantics: 'current is production API; persistent is injected and retains conversation (stdio) or returns buffered generation (OpenCode). No production changes.',
    expected: { exact: 'PONTE_OK', stock: 'Estoque: 17 unidades.' } };
  let current, persistent, transport;
  const save = async () => { await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, JSON.stringify(result, null, 2) + '\n'); };
  async function chat(proxy, request) {
    const t0 = performance.now();
    const response = await fetch(proxy.url + '/v1/chat/completions', { method: 'POST', signal: AbortSignal.timeout(100000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, model: `${config.harness}/${config.model}`,
        stream: true, stream_options: { include_usage: true } }) });
    if (!response.ok) {
      const j = await response.json().catch(() => ({}));
      const error = Error(`AgentBridge HTTP ${response.status}: ${j.error?.code || 'unknown'}`);
      error.evidence = { status: response.status, code: j.error?.code, message: j.error?.message?.slice(0, 800) };
      throw error;
    }
    const r = { text: '', tool_calls: [], textDeltas: 0, toolDeltas: 0, argumentDeltas: 0,
      firstTextMs: null, firstToolMs: null, firstArgumentMs: null, terminal: false };
    for await (const e of sse(response.body)) {
      if (e.error) throw Error(`AgentBridge SSE error: ${e.error.code || e.error.type}`);
      if (e.usage) r.usage = e.usage;
      const c = e.choices?.[0]; if (c?.finish_reason) { r.terminal = true; r.finishReason = c.finish_reason; }
      if (c?.delta?.content) { r.firstTextMs ??= performance.now() - t0; r.text += c.delta.content; r.textDeltas++; }
      for (const t of c?.delta?.tool_calls || []) {
        r.firstToolMs ??= performance.now() - t0; r.toolDeltas++;
        if (t.function?.arguments) { r.firstArgumentMs ??= performance.now() - t0; r.argumentDeltas++; }
        const v = r.tool_calls[t.index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (t.id) v.id = t.id; if (t.function?.name) v.function.name += t.function.name;
        if (t.function?.arguments) v.function.arguments += t.function.arguments;
      }
    }
    if (!r.terminal) throw Error('SSE ended without finish_reason');
    r.totalMs = performance.now() - t0;
    return r;
  }
  async function measure(path, task, messages, extra = {}) {
    const t0 = performance.now(); let r;
    try { r = await chat(path === 'current' ? current : persistent, { messages, ...extra }); }
    catch (e) { r = { error: e.message, evidence: e.evidence, totalMs: performance.now() - t0 }; }
    const row = { path, task, ...r };
    if (task.startsWith('exact')) row.correct = row.text?.trim() === result.expected.exact;
    else if (task === 'stock-tool') {
      try { row.correct = row.tool_calls.length === 1 && row.tool_calls[0].function.name === 'consultar_estoque' && JSON.parse(row.tool_calls[0].function.arguments).sku === 'CANECA-AZUL'; }
      catch { row.correct = false; }
    } else row.correct = row.text?.trim() === result.expected.stock;
    result.calls.push(row); await save();
    console.log(JSON.stringify({ harness: config.harness, path, task, ms: Math.round(row.totalMs), correct: row.correct, error: row.error }));
    return row;
  }
  await save();
  try {
    current = await startProxy({ port: 0, sessionsFile: false, pruneLeftovers: false, timeoutMs: 90000 });
    transport = await config.persistent({ dist, scratch, result });
    persistent = await startProxy({ port: 0, sessionsFile: false, pruneLeftovers: false, timeoutMs: 90000,
      adapters: { [config.harness]: transport.adapter() } });
    for (let round = 0; round < 3; round++) for (const path of round % 2 ? ['persistent', 'current'] : ['current', 'persistent']) {
      await measure(path, `exact-${round + 1}`, [{ role: 'user', content: 'Responda exatamente: PONTE_OK' }]);
    }
    const fixture = join(scratch, 'stock.json');
    await writeFile(fixture, JSON.stringify({ sku: 'CANECA-AZUL', quantidade: 17 }));
    for (const path of ['current', 'persistent']) {
      const tools = [{ type: 'function', function: stockTool }];
      const messages = [{ role: 'user', content: 'Consulte o estoque do SKU CANECA-AZUL com consultar_estoque. Quando receber o resultado, responda exatamente: Estoque: N unidades. Substitua N pela quantidade retornada.' }];
      const r = await measure(path, 'stock-tool', messages, { tools, tool_choice: { type: 'function', function: { name: stockTool.name } } });
      if (r.correct) {
        const content = await readFile(fixture, 'utf8');
        const final = await measure(path, 'stock-result', [...messages, { role: 'assistant', content: null, tool_calls: r.tool_calls },
          { role: 'tool', tool_call_id: r.tool_calls[0].id, content }], { tools, tool_choice: 'none' });
        result[`${path}Cycle`] = { totalMs: r.totalMs + final.totalMs, correct: final.correct,
          fixtureRead: true, calls: 2 };
      } else result[`${path}Cycle`] = { correct: false, calls: 1, secondCall: 'not performed because no valid client tool call was emitted' };
      await save();
    }
    result.status = 'complete';
  } catch (e) { result.status = 'failed'; result.error = e.message; }
  finally {
    await current?.close(); await persistent?.close(); await transport?.close();
    result.persistentTransport = transport?.info;
    result.verification = Object.fromEntries(['current', 'persistent'].map(path => {
      const calls = result.calls.filter(c => c.path === path);
      return [path, { passed: calls.filter(c => c.correct).length, attempted: calls.length,
        expected: 5, allExpectedCompleted: calls.length === 5 && calls.every(c => c.correct) }];
    }));
    await rm(scratch, { recursive: true, force: true }); result.temporaryWorkspaceRemoved = true;
    await save();
  }
  if (result.status !== 'complete' || Object.values(result.verification).some(v => !v.allExpectedCompleted)) process.exitCode = 1;
}
