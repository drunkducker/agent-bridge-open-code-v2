import { createHash, randomBytes } from 'node:crypto';
import { run } from '../index.js';
import { mcpConfigFor } from './attach.js';
import { verifyAttestation, serveHttp, Attestation } from './mcp.js';
import { AgentEvent, RunResult, EventTool } from '../types/index.js';
import { AgentError } from '../core/errors.js';

const str = (o: any) =>
  o === undefined || typeof o === 'string'
    ? o
    : (() => {
        try {
          return JSON.stringify(o);
        } catch {
          return String(o);
        }
      })();

export interface BridgeMetaOptions {
  bind?: string;
  seen?: Set<string>;
  promptSha?: string;
}

/**
 * Find a server attestation in a tool result and VERIFY it (HMAC with the launcher's key + sha256 of the returned text).
 * Returns the attestation or null.
 */
export function bridgeMeta(output: any, key: string, { bind, seen, promptSha }: BridgeMetaOptions = {}): Attestation | null {
  const s = str(output) || '';
  if (!key) return null;
  const cands: { a: Attestation; text?: string }[] = [];
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (o.structuredContent) walk(o.structuredContent);
    if (o.attestation) cands.push({ a: o.attestation, text: o.text });
    if (Array.isArray(o.content)) {
      const t0 = o.content[0]?.text;
      for (const c of o.content) {
        const m = /^\[agentbridge\] (\{.*\})\s*$/s.exec(c?.text || '');
        if (m) {
          try {
            cands.push({ a: JSON.parse(m[1]), text: t0 });
          } catch {
            /* skip */
          }
        }
      }
    }
  };
  try {
    walk(JSON.parse(s));
  } catch {
    /* not json */
  }
  if (!cands.length) {
    const u = s.replace(/\\"/g, '"');
    for (const m of u.matchAll(/\{"agent":"[^{}]*"hmac":"[0-9a-f]{64}"\}/g)) {
      try {
        cands.push({
          a: JSON.parse(m[0]),
          text: u.slice(0, m.index).replace(/\s*\[agentbridge\] $/, ''),
        });
      } catch {
        /* skip */
      }
    }
  }
  for (const { a, text } of cands) {
    if (text === undefined || !verifyAttestation(a, key, text)) continue;
    if (bind !== undefined && a.bind !== bind) continue;
    if (promptSha !== undefined && a.promptSha !== promptSha) continue;
    if (seen) {
      if (seen.has(a.callId)) continue;
      seen.add(a.callId);
    }
    return a;
  }
  return null;
}

export interface SubagentOptions {
  caller: string;
  callee: string;
  task: string;
  model?: string;
  effort?: string;
  permissions?: string;
  cwd?: string;
  timeoutMs?: number;
  depth?: number;
  maxDepth?: number;
  onEvent?: (event: AgentEvent) => void;
  calleeModel?: string;
  home?: string;
  toolName?: string;
  childCwd?: string;
  attestKey?: string;
  root?: string;
  maxAttempts?: number;
  [key: string]: any;
}

export interface SubagentResult {
  result: RunResult;
  text: string;
  events: AgentEvent[];
  toolCalls: AgentEvent[];
  results: any[];
  succeeded: boolean;
  meta: Attestation | null;
  toolOutput: any;
  delegated: boolean;
  attestKey: string;
  bind: string;
  attempts?: number;
}

async function runOnce({
  maxAttempts,
  caller,
  callee,
  task,
  model,
  effort,
  permissions = 'full',
  cwd,
  timeoutMs,
  depth = 0,
  maxDepth,
  onEvent,
  calleeModel,
  home,
  toolName,
  childCwd,
  attestKey = randomBytes(24).toString('hex'),
  root,
  ...rest
}: SubagentOptions): Promise<SubagentResult> {
  const inheritedEnv = { ...process.env, ...(rest.env || {}) };
  const subdelegation = inheritedEnv.AGENTBRIDGE_SUBDELEGATION !== 'false';
  const bind = randomBytes(12).toString('hex');
  const seen = new Set<string>();
  const tool = toolName || `ask_${callee}`;
  const serverName = caller === 'codex' ? 'agentbridge_http' : 'agentbridge';
  const prompt = `You MUST call the MCP tool "${tool}" (server "${serverName}") exactly once, passing this as its "prompt" argument, verbatim:\n\n${task}\n\nPass ONLY the "prompt" argument (no model, session or other arguments). Then reply with the tool's returned text and nothing else. Do not answer yourself.`;
  const events: AgentEvent[] = [];

  let httpBridge: any = null;
  let mcp: any = {};
  if (caller === 'codex') {
    const grandchildEnv: Record<string, string> = {
      AGENTBRIDGE_DEPTH: String(depth),
      AGENTBRIDGE_PERMS: permissions,
      AGENTBRIDGE_SUBDELEGATION: String(subdelegation),
      AGENTBRIDGE_ATTEST_KEY: attestKey,
      AGENTBRIDGE_ATTEST_BIND: bind,
    };
    if (maxDepth != null) grandchildEnv.AGENTBRIDGE_MAX_DEPTH = String(maxDepth);
    if (calleeModel) grandchildEnv[`AGENTBRIDGE_MODEL_${callee.toUpperCase()}`] = calleeModel;
    if (home) grandchildEnv.AGENTBRIDGE_HOME = home;
    if (root) grandchildEnv.AGENTBRIDGE_ROOT = root;
    if (childCwd) grandchildEnv.AGENTBRIDGE_CHILD_CWD = childCwd;
    httpBridge = await serveHttp({ env: grandchildEnv });
    rest.extraArgs = [
      ...(rest.extraArgs || []),
      '-c',
      `mcp_servers.${serverName}.url="${httpBridge.url}"`,
      '-c',
      `mcp_servers.${serverName}.bearer_token_env_var="AGENTBRIDGE_ATTEST_KEY"`,
      '-c',
      `mcp_servers.${serverName}.default_tools_approval_mode="approve"`,
      '-c',
      `mcp_servers.${serverName}.tool_timeout_sec=300`,
    ];
  } else {
    mcp = mcpConfigFor(caller, {
      depth,
      maxDepth,
      permissions,
      models: calleeModel ? { [callee]: calleeModel } : {},
      home,
      attestBind: bind,
      root,
      childCwd,
      subdelegation,
    });
  }
  const it = run(caller, {
    prompt,
    model,
    effort: effort as any,
    permissions: permissions as any,
    cwd,
    timeoutMs,
    ...rest,
    env: {
      AGENTBRIDGE_DEPTH: String(depth),
      AGENTBRIDGE_PERMS: permissions,
      AGENTBRIDGE_ATTEST_KEY: attestKey,
      ...(rest.env || {}),
      AGENTBRIDGE_SUBDELEGATION: String(subdelegation),
    },
    mcpServers: { ...mcp, ...(rest.mcpServers || {}) },
  });
  let result!: RunResult;
  try {
    for (;;) {
      const x = await it.next();
      if (x.done) {
        result = x.value;
        break;
      }
      let e = x.value;
      if (e.type === 'raw') continue;
      if (e.type === 'tool') e = { ...e, output: str(e.output) };
      events.push(e);
      onEvent?.(e);
    }
  } finally {
    if (httpBridge) await httpBridge.close();
  }
  const toolCalls = events.filter((e): e is EventTool => e.type === 'tool' && String((e as any).name).includes(tool));
  const promptOf = (e: any) =>
    typeof e.input === 'string'
      ? (() => {
          try {
            return JSON.parse(e.input).prompt;
          } catch {
            return undefined;
          }
        })()
      : e.input?.prompt;
  const withInput = toolCalls.filter((e) => e.input !== undefined);
  const sent = withInput
    .map((e) => promptOf(e))
    .filter((p) => typeof p === 'string')
    .map((p) => createHash('sha256').update(p).digest('hex'));
  const results = toolCalls
    .filter((e) => e.output !== undefined)
    .map((e) => {
      let meta: Attestation | null = null;
      if (sent.length) {
        for (const ps of sent) {
          meta = bridgeMeta(e.output, attestKey, { bind, seen, promptSha: ps });
          if (meta) break;
        }
      } else {
        meta = bridgeMeta(e.output, attestKey, { bind, seen });
      }
      return { ...e, meta };
    });
  const ok = results.filter((e) => e.meta);
  return {
    result,
    text: result.text,
    events,
    toolCalls,
    results,
    succeeded: ok.length > 0,
    meta: ok[0]?.meta || null,
    toolOutput: ok[0]?.output || null,
    delegated: ok.length > 0,
    attestKey,
    bind,
  };
}

/**
 * Public entry. A caller LLM occasionally ends its turn with an EMPTY final message even though the
 * delegated tool call succeeded and was attested. Such runs are retried once with a fresh key/bind.
 */
export async function runAsSubagent(opts: SubagentOptions): Promise<SubagentResult> {
  const inheritedEnv = { ...process.env, ...(opts.env || {}) };
  if (inheritedEnv.AGENTBRIDGE_SUBDELEGATION === 'false') {
    throw new AgentError('BAD_OPTION', 'subdelegation is disabled by AGENTBRIDGE_SUBDELEGATION=false');
  }
  const maxAttempts = opts.maxAttempts ?? 2;
  let r!: SubagentResult;
  let attempts = 0;
  do {
    r = await runOnce(opts);
    attempts++;
  } while (!String(r.text || '').trim() && attempts < maxAttempts);
  r.attempts = attempts;
  return r;
}
