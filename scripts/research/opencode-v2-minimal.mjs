// Experiment-only client for the installed OpenCode v2 HTTP API.
// Reference: https://opencode.ai/v2/openapi.json . Does not access provider tokens.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

export const FLINT = { providerID: 'opencode', id: 'flint-40b-free' };

export function modelRef(name) {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(name);
  if (!match) throw Error('Model must be provider/model');
  return { providerID: match[1], id: match[2] };
}

function safeMessage(value) {
  let s = String(value || '').slice(0, 700);
  for (const [key, value] of Object.entries(process.env)) {
    if (/key|token|password|secret/i.test(key) && value?.length >= 8) s = s.split(value).join('[redacted]');
  }
  return s.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted JWT]').replace(/\bsk-[\w-]+/g, '[redacted key]');
}

export async function startV2(cwd) {
  const socket = createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const password = randomBytes(24).toString('hex');
  const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd, env: { ...process.env, OPENCODE_SERVER_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  // Drain but do not retain server logs, credentials or unrelated context.
  child.stdout.resume(); child.stderr.resume();
  let spawnError;
  child.on('error', e => { spawnError = e; });
  const base = `http://127.0.0.1:${port}`;
  const authorization = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
  const api = async (method, path, body, signal = AbortSignal.timeout(90000)) => {
    const r = await fetch(base + path, { method, signal, headers: { authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const type = r.headers.get('content-type') || '';
    const data = type.includes('json') ? await r.json() : await r.text();
    if (!r.ok) {
      const e = Error(`OpenCode v2 HTTP ${r.status}: ${typeof data === 'object' ? data?._tag || data?.type || 'error' : 'non-JSON'}`);
      e.evidence = { status: r.status, type: data?._tag || data?.type, message: safeMessage(data?.message) };
      throw e;
    }
    return data;
  };
  const close = async () => {
    if (child.exitCode !== null) return;
    const ended = once(child, 'exit').catch(() => {});
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.race([ended, new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await ended; }
  };
  try {
    const start = performance.now();
    let info;
    while (performance.now() - start < 20000) {
      if (spawnError || child.exitCode !== null) throw Error('Private OpenCode server failed to start');
      try { info = await api('GET', '/api/info', undefined, AbortSignal.timeout(750)); if (info.version) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!info?.version) throw Error('Private OpenCode server readiness timeout');
    return { api, close, version: info.version, startupMs: performance.now() - start };
  } catch (e) { await close(); throw e; }
}

export async function generateV2(server, prompt, signal, model = FLINT) {
  const r = await server.api('POST', '/api/experimental/generate', { prompt, model }, signal);
  if (typeof r.data?.text !== 'string') throw Error('Unexpected generate response');
  return { text: r.data.text, tool_calls: [] };
}

export async function sessionV2(server, { prompt, cwd, allowRead = false, signal, onTool, model = FLINT }) {
  const permissions = [{ action: '*', resource: '*', effect: 'deny' },
    ...(allowRead ? [{ action: 'read', resource: '*', effect: 'allow' }] : [])];
  const created = await server.api('POST', '/api/session', { title: 'AgentBridge model experiment', model,
    agent: 'build', location: { directory: cwd }, permissions }, signal);
  const id = created.data?.id;
  if (!id) throw Error('Session create did not return an ID');
  try {
    await server.api('POST', `/api/session/${id}/prompt`, { text: prompt }, signal);
    await server.api('POST', `/api/experimental/session/${id}/wait`, undefined, signal);
    const messages = await server.api('GET', `/api/session/${id}/message?order=asc&limit=100`, undefined, signal);
    const assistants = (messages.data || []).filter(m => m.type === 'assistant');
    const primary = assistants.filter(m => m.agent === 'build');
    for (const m of primary) {
      if (m.model?.providerID !== model.providerID || m.model?.id !== model.id) throw Error('Unexpected model substitution');
      for (const item of m.content || []) if (item.type === 'tool') onTool?.(item);
    }
    const idle = (messages.data || []).filter(m => m.type === 'idle').at(-1);
    const errors = [...assistants, idle].filter(m => m?.error).map(m => ({ type: m.error.type || m.error._tag || 'unknown',
      status: m.error.status, message: safeMessage(m.error.message) }));
    // Internal compaction/title assistants must not be mistaken for the task reply.
    const last = primary.at(-1);
    const text = (last?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    const evidence = { assistantModels: primary.map(m => m.model),
      assistantAgents: assistants.map(m => ({ agent: m.agent, finish: m.finish, errorType: m.error?.type })),
      outcome: idle?.outcome, errors };
    if (last?.error || idle?.error || idle?.outcome === 'failed' || !text) {
      const e = Error(`OpenCode session failed: ${errors.map(e => e.type).join(',') || idle?.outcome || 'empty reply'}`);
      e.evidence = evidence; throw e;
    }
    return { text, tool_calls: [], usage: last.tokens, evidence };
  } finally {
    await server.api('POST', `/api/session/${id}/interrupt`, undefined, AbortSignal.timeout(3000)).catch(() => {});
    await server.api('DELETE', `/api/session/${id}`, undefined, AbortSignal.timeout(5000)).catch(() => {});
  }
}
