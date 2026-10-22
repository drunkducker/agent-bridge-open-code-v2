// feat-doctor: environment check. Installed? logged in? versions, models, cwd writable, ports free, git present.
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolveBinary, runCollect } from '../core/spawn.js';
import { findBinary as findAgy } from '../adapters/agy.js';
import { findBinary as findPi } from '../adapters/pi.js';
import { skillRoots } from '../core/shared-resources.js';

import { getOpencodeUserConfigPaths } from '../cli/install.js';
import { BUILTIN_AGENTS } from '../core/catalog.js';
import { loadEndpoints } from '../adapters/endpoint.js';
import { hintFor } from '../core/hints.js';

const home = os.homedir();

export async function withTimeout<T>(promise: Promise<T>, ms: number, errMsg = 'timeout'): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(errMsg)), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const CRED: Record<string, () => string | undefined> = {
  claude: () => {
    const list: string[] = [];
    if (process.env.CLAUDE_CONFIG_DIR) {
      list.push(
        path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'),
        path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
      );
    }
    list.push(
      path.join(home, '.claude', '.credentials.json'),
      path.join(home, '.claude.json')
    );
    return list.find((f) => {
      try {
        return f.endsWith('.json') && /oauthAccount|claudeAiOauth/.test(readFileSync(f, 'utf8'));
      } catch {
        return false;
      }
    });
  },
  codex: () => [path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'auth.json')].find(existsSync),
  opencode: () => {
    const list: string[] = [];
    if (process.env.XDG_DATA_HOME) list.push(path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json'));
    if (process.platform === 'win32') {
      if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'opencode', 'auth.json'));
      if (process.env.APPDATA) list.push(path.join(process.env.APPDATA, 'opencode', 'auth.json'));
    }
    list.push(
      path.join(home, '.local', 'share', 'opencode', 'auth.json'),
      path.join(home, '.config', 'opencode', 'auth.json')
    );
    return list.find((f) => {
      try {
        return Object.keys(JSON.parse(readFileSync(f, 'utf8'))).length > 0;
      } catch {
        return false;
      }
    });
  },
  cursor: () => (process.env.CURSOR_API_KEY ? 'CURSOR_API_KEY' : undefined),
  grok: () => (process.env.XAI_API_KEY || process.env.GROK_API_KEY ? 'XAI_API_KEY' : undefined),
  gemini: () => (process.env.GEMINI_API_KEY ? 'GEMINI_API_KEY' : undefined),
  devin: () => (process.env.DEVIN_API_KEY ? 'DEVIN_API_KEY' : undefined),
};

export function portFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.listen(port, host, () => s.close(() => res(true)));
  });
}

async function version(bin: string): Promise<string | null> {
  try {
    const r = await runCollect(bin, ['--version'], { timeoutMs: 15000 });
    const v = (r.stdout || '').trim().split('\n')[0];
    return v || null;
  } catch {
    return null;
  }
}

export function detectMcpServers(name: string, cwd = process.cwd()): string[] {
  const servers: string[] = [];
  try {
    if (name === 'pi') {
      const piFile = path.join(process.env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent'), 'mcp.json');
      if (existsSync(piFile)) {
        const j = JSON.parse(readFileSync(piFile, 'utf8'));
        if (j?.mcpServers && typeof j.mcpServers === 'object') {
          servers.push(...Object.keys(j.mcpServers));
        }
      }
    } else if (name === 'claude') {
      const candidates = [
        path.join(cwd, '.mcp.json'),
        ...(process.env.CLAUDE_CONFIG_DIR
          ? [
              path.join(process.env.CLAUDE_CONFIG_DIR, 'mcp.json'),
              path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'),
            ]
          : []),
        path.join(home, '.claude.json'),
        path.join(home, '.claude', 'mcp.json'),
      ];
      for (const f of candidates) {
        if (existsSync(f)) {
          try {
            const j = JSON.parse(readFileSync(f, 'utf8'));
            if (j?.mcpServers && typeof j.mcpServers === 'object') {
              servers.push(...Object.keys(j.mcpServers));
            }
          } catch {}
        }
      }
    } else if (name === 'codex') {
      const tomlFile = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
      if (existsSync(tomlFile)) {
        const content = readFileSync(tomlFile, 'utf8');
        const matches = content.matchAll(/\[mcp_servers\.([^\]\s]+)\]/g);
        for (const m of matches) {
          if (m[1]) {
            const base = m[1].split('.')[0];
            if (base) servers.push(base);
          }
        }
      }
    } else if (name === 'opencode') {
      const candidates = [
        path.join(cwd, 'opencode.json'),
        ...getOpencodeUserConfigPaths(home),
      ];
      for (const f of candidates) {
        if (existsSync(f)) {
          try {
            const j = JSON.parse(readFileSync(f, 'utf8'));
            if (j?.mcp && typeof j.mcp === 'object') {
              servers.push(...Object.keys(j.mcp));
            }
          } catch {}
        }
      }
    } else if (name === 'agy') {
      const candidates = [
        path.join(home, '.gemini', 'config', 'mcp_config.json'),
        path.join(cwd, '.gemini', 'config', 'mcp_config.json'),
      ];
      for (const f of candidates) {
        if (existsSync(f)) {
          try {
            const j = JSON.parse(readFileSync(f, 'utf8'));
            if (j?.mcpServers && typeof j.mcpServers === 'object') {
              servers.push(...Object.keys(j.mcpServers));
            }
          } catch {}
        }
      }
    }
  } catch {}
  return [...new Set(servers)];
}

export interface CheckItem {
  name: string;
  /** `skip` = informational (an optional agent that is not installed / an endpoint that is not reachable); never fails the run. */
  status: 'ok' | 'fail' | 'warn' | 'skip';
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: CheckItem[];
  agents: Record<string, any>;
  /** Agents (CLIs and endpoints) that are installed/reachable and not known to be broken. */
  usable?: string[];
}

// Executable name when it differs from the agent name.
const BIN_NAME: Record<string, string> = { cursor: 'cursor-agent', acp: 'acp-agent' };

function endpointConfigs(): Record<string, any> {
  try {
    return loadEndpoints();
  } catch {
    return {};
  }
}

async function reachable(baseUrl: string): Promise<boolean> {
  try {
    await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(4000) });
    return true; // any HTTP answer (even 401) means something is listening
  } catch {
    return false;
  }
}

export async function doctor({
  cwd = process.cwd(),
  ports = [8787],
  live = false,
  agents,
  models = true,
}: {
  cwd?: string;
  ports?: number[];
  live?: boolean;
  /** Default: every BUILTIN_AGENTS entry plus every configured endpoint (ollama + custom). */
  agents?: string[];
  models?: boolean;
} = {}): Promise<DoctorResult> {
  const checks: CheckItem[] = [];
  const add = (name: string, status: CheckItem['status'], detail: string) => checks.push({ name, status, detail });
  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 22 ? 'ok' : 'fail', `v${process.versions.node} (need >= 22)`);
  add('platform', 'ok', `${process.platform} ${os.release()}`);
  const g = resolveBinary('git');
  add('git', g ? 'ok' : 'warn', g ? `${g} (needed by --worktree)` : 'not found: --worktree needs git');
  try {
    const d = mkdtempSync(path.join(cwd, '.ab-doctor-'));
    writeFileSync(path.join(d, 't'), 'x');
    rmSync(d, { recursive: true, force: true });
    add('cwd writable', 'ok', cwd);
  } catch (e: any) {
    add('cwd writable', 'warn', `${cwd}: ${e.code || e.message} (fine for read-only runs)`);
  }
  for (const p of ports) {
    const free = await portFree(p);
    add(`port ${p}`, free ? 'ok' : 'warn', free ? 'free' : 'in use (pick another with --port)');
  }
  const info: Record<string, any> = {};
  const endpoints = endpointConfigs();
  const names = agents ?? [...BUILTIN_AGENTS, ...Object.keys(endpoints)];
  const usable = new Set<string>();
  await Promise.all(
    names.map(async (name) => {
      const ep = (BUILTIN_AGENTS as readonly string[]).includes(name) ? undefined : endpoints[name];
      if (ep) {
        const a: any = (info[name] = { installed: true, endpoint: true, baseUrl: ep.baseUrl, type: ep.type, reachable: null, models: null, live: null });
        a.reachable = await reachable(ep.baseUrl);
        if (!a.reachable) {
          add(name, 'skip', `endpoint ${ep.baseUrl} not reachable (nothing listening; fine if you do not use it)`);
          return;
        }
        if (models) {
          try {
            const { agents: reg } = await import('../index.js');
            a.models = (await withTimeout(reg.models(name), 20000)).slice(0, 30);
          } catch (e: any) {
            a.modelsError = e.message;
          }
        }
        let st: CheckItem['status'] = 'ok';
        if (live) {
          try {
            const { ask } = await import('../index.js');
            const t0 = Date.now();
            const r = await ask(name, { prompt: 'reply with exactly PONG', timeoutMs: 120000, cwd: os.tmpdir(), session: { mode: 'ephemeral' } });
            a.live = { ok: /PONG/i.test(r.text), ms: Date.now() - t0 };
          } catch (e: any) {
            a.live = { ok: false, error: `${e.code || ''} ${e.message}`.trim() };
          }
          if (!a.live.ok) st = 'fail';
        }
        if (st === 'ok') usable.add(name);
        add(name, st, `endpoint ${ep.baseUrl} reachable${a.models ? `; ${a.models.length} models` : ''}${a.live ? `; live ${a.live.ok ? `ok ${a.live.ms}ms` : 'FAILED: ' + a.live.error}` : ''}`);
        return;
      }
      const bin = name === 'agy' ? findAgy() : name === 'pi' ? findPi() : resolveBinary(BIN_NAME[name] || name);
      const a: any = (info[name] = {
        installed: !!bin,
        path: bin,
        version: null,
        loggedIn: null,
        credentials: null,
        models: null,
        live: null,
      });
      if (!bin) {
        add(name, 'skip', `not installed (optional)${hintFor(name, 'NOT_INSTALLED')}`);
        return;
      }
      a.version = await version(bin);
      const noOffline = !CRED[name];
      const cred = CRED[name]?.();
      a.credentials = cred ? path.basename(cred) : null;
      // opencode can authenticate through provider config/env, so a missing auth.json is not proof of no login.
      a.loggedIn = noOffline || (name === 'opencode' && !cred) ? null : !!cred;
      if (models) {
        try {
          const { agents: reg } = await import('../index.js');
          a.models = (await withTimeout(reg.models(name), 20000)).slice(0, 30);
        } catch (e: any) {
          a.models = null;
          a.modelsError = e.message;
        }
      }
      if (live) {
        try {
          const { ask } = await import('../index.js');
          const t0 = Date.now();
          const r = await ask(name, {
            prompt: 'reply with exactly PONG',
            timeoutMs: 120000,
            cwd: os.tmpdir(),
            session: { mode: 'ephemeral' },
          });
          a.live = { ok: /PONG/i.test(r.text), ms: Date.now() - t0 };
          a.loggedIn = a.live.ok ? true : a.loggedIn;
        } catch (e: any) {
          a.live = { ok: false, error: `${e.code || ''} ${e.message}`.trim() };
          if (e.code === 'NOT_LOGGED_IN') a.loggedIn = false;
        }
      }
      a.mcpServers = detectMcpServers(name, cwd);
      const st: CheckItem['status'] = a.live && !a.live.ok ? 'fail' : a.loggedIn === false ? 'warn' : 'ok';
      if (st === 'ok') usable.add(name);
      add(
        name,
        st,
        `${a.version || 'version unknown'}; ${
          a.loggedIn === null
            ? 'login not checkable offline (use --live)'
            : a.loggedIn
            ? `logged in (${a.credentials || 'live test'})`
            : 'no login found (run the CLI login)'
        }${a.models ? `; ${a.models.length} models` : ''}${
          a.mcpServers?.length ? `; host MCPs: [${a.mcpServers.join(', ')}]` : ''
        }${a.live ? `; live ${a.live.ok ? `ok ${a.live.ms}ms` : 'FAILED: ' + a.live.error}` : ''}`
      );
    })
  );
  const agentsWithMcp = Object.entries(info).filter(([_, a]) => Array.isArray(a.mcpServers) && a.mcpServers.length > 0);
  if (agentsWithMcp.length > 0) {
    const list = agentsWithMcp.map(([n, a]) => `${n}: [${a.mcpServers.join(', ')}]`).join('; ');
    const pt = process.env.AGENTBRIDGE_MCP_PASSTHROUGH;
    add(
      'mcp isolation policy',
      'ok',
      `host MCPs configured: ${list}. Delegated children do not inherit them by default; ${
        pt ? `passthrough allowlist: ${pt} (needs permissions edit/full, blocked when offline)` : 'set AGENTBRIDGE_MCP_PASSTHROUGH=<names|*> to allow chosen servers'
      }`
    );
  }
  const roots = skillRoots(cwd);
  if (roots.length) {
    add(
      'skill roots',
      'ok',
      roots.map((r) => `${r.scope}:${r.path} (${r.skills})`).join('; ') +
        ' (children see skills only with skills:true or AGENTBRIDGE_ENABLE_SKILLS=1)'
    );
  }
  if (usable.size === 0 && names.length > 0) {
    add('agents', 'fail', 'no usable agent: install and log in to at least one agent CLI (e.g. npm i -g @anthropic-ai/claude-code, then `claude`), or configure an endpoint with `ab endpoint add`');
  } else if (names.length > 0) {
    add('agents', 'ok', `${usable.size} usable: ${[...usable].sort().join(', ')}`);
  }
  checks.sort((x, y) => x.name.localeCompare(y.name));
  return { ok: !checks.some((c) => c.status === 'fail'), checks, agents: info, usable: [...usable].sort() };
}
