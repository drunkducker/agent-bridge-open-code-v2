import { fileURLToPath } from 'node:url';

const MCP = fileURLToPath(new URL('./mcp.js', import.meta.url));

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface PassthroughMcpOptions {
  /** What the caller asks for. Can only narrow the operator allowlist, never widen it. */
  passthrough?: string | string[];
  sourceDir?: string;
  /** Working directory of the child; its git root's `.mcp.json` is also a source. */
  cwd?: string;
  offline?: boolean;
  permissions?: string;
  env?: NodeJS.ProcessEnv;
}

const listOf = (raw: unknown): string[] =>
  (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [])
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);

export interface PassthroughDrop {
  name: string;
  reason: string;
}

/**
 * Host MCP servers a delegated child may inherit, plus why each requested name was dropped.
 * Gates, in order: offline blocks everything; read-only/plan get nothing; the operator allowlist
 * (AGENTBRIDGE_MCP_PASSTHROUGH) is the ceiling and a caller's `passthrough` can only select a subset of it.
 * Only stdio servers (with a `command`) are passed, always with `exposure: "direct"` (a deferred server
 * never shows its tools to the model).
 * Drops are reported only for explicitly requested names; a `*` request expands to the allowlist.
 */
export function resolvePassthrough(opts: PassthroughMcpOptions = {}): { servers: Record<string, any>; drops: PassthroughDrop[] } {
  const env = opts.env || process.env;
  const drops: PassthroughDrop[] = [];
  const asked = listOf(opts.passthrough);
  const isOffline = opts.offline || env.AGENTBRIDGE_OFFLINE === '1' || env.AGENTBRIDGE_OFFLINE === 'true';
  if (isOffline) {
    for (const n of asked) drops.push({ name: n, reason: 'offline mode' });
    return { servers: {}, drops };
  }

  const perms = opts.permissions || env.AGENTBRIDGE_PERMS || 'read-only';
  if (perms === 'read-only' || perms === 'plan') {
    for (const n of asked) drops.push({ name: n, reason: `permissions "${perms}" blocks MCP passthrough` });
    return { servers: {}, drops };
  }

  const ceiling = listOf(env.AGENTBRIDGE_MCP_PASSTHROUGH);
  if (!ceiling.length) {
    for (const n of asked) drops.push({ name: n, reason: 'operator allowlist AGENTBRIDGE_MCP_PASSTHROUGH is not set' });
    return { servers: {}, drops };
  }
  const anyOk = ceiling.includes('*');
  const allowed = asked.length
    ? asked.includes('*')
      ? ceiling
      : asked.filter((n) => anyOk || ceiling.includes(n))
    : ceiling;
  if (!allowed.length) {
    for (const n of asked) drops.push({ name: n, reason: 'not in operator allowlist' });
    return { servers: {}, drops };
  }
  for (const n of asked) {
    if (n !== '*' && !allowed.includes(n)) drops.push({ name: n, reason: 'not in operator allowlist' });
  }

  const files = [path.join(opts.sourceDir || env.AGENTBRIDGE_MCP_SOURCE_DIR || path.join(os.homedir(), '.pi', 'agent'), 'mcp.json')];
  if (opts.cwd) {
    let d = path.resolve(opts.cwd);
    for (;;) {
      if (existsSync(path.join(d, '.mcp.json'))) {
        files.push(path.join(d, '.mcp.json'));
        break;
      }
      if (existsSync(path.join(d, '.git'))) break;
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }

  const result: Record<string, any> = {};
  const landed = new Set<string>();
  const invalid = new Map<string, string>();
  for (const f of files) {
    if (!existsSync(f)) continue;
    let servers: Record<string, any> = {};
    try {
      servers = JSON.parse(readFileSync(f, 'utf8'))?.mcpServers || {};
    } catch {
      continue;
    }
    for (const [name, cfg] of Object.entries<any>(servers)) {
      const key = name.toLowerCase();
      if (key === 'agentbridge' || name in result) continue;
      if (!/^[A-Za-z0-9_-]+$/.test(name)) continue;
      if (!allowed.includes('*') && !allowed.includes(key)) continue;
      if (!cfg || typeof cfg !== 'object' || typeof cfg.command !== 'string') {
        invalid.set(key, !cfg || typeof cfg !== 'object' ? 'invalid server config' : 'not a stdio server (only command servers are passed)');
        continue;
      }
      result[name] = { command: cfg.command, args: cfg.args || [], env: cfg.env || {}, exposure: 'direct' };
      landed.add(key);
    }
  }
  if (asked.length) {
    for (const [n, reason] of invalid) drops.push({ name: n, reason });
    for (const n of allowed) {
      if (n === '*' || landed.has(n) || invalid.has(n)) continue;
      drops.push({ name: n, reason: 'not found in any mcp.json source' });
    }
  }
  return { servers: result, drops };
}

/** Same gates, servers only (previous shape, kept for callers that do not care about drops). */
export function getPassthroughMcpServers(opts: PassthroughMcpOptions = {}): Record<string, any> {
  return resolvePassthrough(opts).servers;
}

export interface McpConfigOptions {
  depth?: number;
  maxDepth?: number;
  permissions?: string;
  models?: Record<string, string | undefined>;
  home?: string;
  attestBind?: string;
  root?: string;
  childCwd?: string;
  defaultTimeoutS?: number | string;
  subdelegation?: boolean;
}

export interface McpConfigResult {
  agentbridge?: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  [key: string]: any;
}

/**
 * mcpServers entry for the adapters' `mcpServers` option. Works for any caller (claude|codex|opencode).
 * `models` = { callee: model } is enforced server-side (AGENTBRIDGE_MODEL_<CALLEE>), so it cannot be dropped by the calling LLM.
 */
export function mcpConfigFor(callerAgent: string, opts: McpConfigOptions = {}): McpConfigResult {
  const { depth = 0, maxDepth, permissions = 'full', models = {}, home, attestBind, root, childCwd, defaultTimeoutS, subdelegation = true } = opts;
  const KNOWN_AGENTS = ['claude', 'codex', 'opencode', 'agy', 'pi', 'cursor', 'gemini', 'devin', 'grok', 'acp'];
  if (!KNOWN_AGENTS.includes(callerAgent)) {
    return {};
  }
  const env: Record<string, string> = {
    AGENTBRIDGE_DEPTH: String(depth),
    AGENTBRIDGE_PERMS: permissions,
    AGENTBRIDGE_SUBDELEGATION: String(subdelegation),
  };
  if (maxDepth != null) env.AGENTBRIDGE_MAX_DEPTH = String(maxDepth);
  for (const [a, m] of Object.entries(models)) {
    if (m) env[`AGENTBRIDGE_MODEL_${a.toUpperCase()}`] = m;
  }
  if (home) env.AGENTBRIDGE_HOME = home;
  if (attestBind) env.AGENTBRIDGE_ATTEST_BIND = attestBind;
  if (root) env.AGENTBRIDGE_ROOT = root;
  if (childCwd) env.AGENTBRIDGE_CHILD_CWD = childCwd;
  if (defaultTimeoutS) env.AGENTBRIDGE_DEFAULT_TIMEOUT_S = String(defaultTimeoutS);
  return { agentbridge: { command: process.execPath, args: [MCP], env } };
}
