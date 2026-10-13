import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type IdeTarget =
  | 'cursor'
  | 'vscode'
  | 'code'
  | 'claude'
  | 'claude-desktop'
  | 'claude_desktop'
  | 'zed'
  | 'windsurf';

export type IdeScope = 'user' | 'project';

export interface InstallIdeOptions {
  scope?: IdeScope;
  cwd?: string;
  configPath?: string;
  cliPath?: string;
  timeout?: number;
}

export interface InstallIdeResult {
  path: string;
  modified: boolean;
}

const DEFAULT_CLI = fileURLToPath(new URL('./main.js', import.meta.url));

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function atomicWriteJson(filePath: string, data: any): void {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  const text = JSON.stringify(data, null, 2) + '\n';
  writeFileSync(tmp, text, 'utf8');

  for (let i = 0; ; i++) {
    try {
      renameSync(tmp, filePath);
      break;
    } catch (e) {
      if (i > 40) {
        try {
          unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        throw e;
      }
      sleep(10);
    }
  }
}

function resolveVsCodeUserPath(): string {
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'),
      'Code',
      'User',
      'mcp.json'
    );
  }
  if (process.platform === 'darwin') {
    return path.join(
      homedir(),
      'Library',
      'Application Support',
      'Code',
      'User',
      'mcp.json'
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'),
    'Code',
    'User',
    'mcp.json'
  );
}

function resolveClaudeDesktopPath(): string {
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'),
      'Claude',
      'claude_desktop_config.json'
    );
  }
  if (process.platform === 'darwin') {
    return path.join(
      homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'),
    'Claude',
    'claude_desktop_config.json'
  );
}

export function getIdeConfigPath(
  target: string,
  options?: InstallIdeOptions
): string {
  const scope = options?.scope === undefined ? 'user' : options.scope;
  if (scope !== 'user' && scope !== 'project') {
    throw new Error('scope must be user|project');
  }
  if (options?.configPath) {
    return path.resolve(options.configPath);
  }

  const raw = target.toLowerCase().trim();
  const cwd = path.resolve(options?.cwd || process.cwd());

  switch (raw) {
    case 'cursor':
      return scope === 'project'
        ? path.join(cwd, '.cursor', 'mcp.json')
        : path.join(homedir(), '.cursor', 'mcp.json');

    case 'vscode':
    case 'code':
      return scope === 'project'
        ? path.join(cwd, '.vscode', 'mcp.json')
        : resolveVsCodeUserPath();

    case 'claude':
    case 'claude-desktop':
    case 'claude_desktop':
      return scope === 'project'
        ? path.join(cwd, '.claude', 'claude_desktop_config.json')
        : resolveClaudeDesktopPath();

    case 'zed':
      return scope === 'project'
        ? path.join(cwd, '.zed', 'settings.json')
        : path.join(
            process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'),
            'zed',
            'settings.json'
          );

    case 'windsurf':
      return scope === 'project'
        ? path.join(cwd, '.windsurf', 'mcp_config.json')
        : path.join(homedir(), '.codeium', 'windsurf', 'mcp_config.json');

    default:
      throw new Error(
        `Unknown IDE target "${target}". Supported: cursor, vscode, claude, zed, windsurf`
      );
  }
}

function isSameServerConfig(existing: any, target: { command: string; args: string[]; timeout?: number }): boolean {
  if (!existing || typeof existing !== 'object') return false;
  const sameCommand =
    existing.command === target.command ||
    existing.command === 'node' ||
    existing.command === 'node.exe' ||
    path.basename(String(existing.command || '')) === path.basename(target.command);
  if (!sameCommand) return false;
  if (!Array.isArray(existing.args)) return false;
  if (existing.args.length !== target.args.length) return false;
  return (
    existing.args.every((arg: any, index: number) => arg === target.args[index]) &&
    (target.timeout == null || existing.timeout === target.timeout)
  );
}

/**
 * Automates zero-friction installation of AgentBridge MCP server into IDEs.
 * Atomically reads, merges, and writes config preserving existing settings and 2-space indentation.
 */
export function installIde(
  target: string,
  options?: InstallIdeOptions
): InstallIdeResult {
  const scope = options?.scope === undefined ? 'user' : options.scope;
  if (scope !== 'user' && scope !== 'project') {
    throw new Error('scope must be user|project');
  }
  const timeout = options?.timeout === undefined ? 300 : options.timeout;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('timeout must be a finite positive number');
  }

  const targetPath = getIdeConfigPath(target, options);
  const cliPath = path.resolve(options?.cliPath || DEFAULT_CLI);
  const serverConfig = {
    command: process.execPath,
    args: [cliPath, 'bridge'],
    timeout,
  };

  const norm = target.toLowerCase().trim();
  const isZed = norm === 'zed';

  let existingData: Record<string, any> = {};
  if (existsSync(targetPath)) {
    const raw = readFileSync(targetPath, 'utf8');
    try {
      existingData = JSON.parse(raw);
    } catch (e: any) {
      throw new Error(`Failed to parse existing JSON in ${targetPath}: ${e.message}`);
    }
  }

  const existingMcp = existingData.mcpServers?.agentbridge;
  const existingContext = existingData.context_servers?.agentbridge;

  const mcpMatches = isSameServerConfig(existingMcp, serverConfig);
  const zedMatches = !isZed || isSameServerConfig(existingContext, serverConfig);

  if (mcpMatches && zedMatches) {
    return { path: targetPath, modified: false };
  }

  const merged = { ...existingData };

  // Standard mcpServers format
  merged.mcpServers = {
    ...(merged.mcpServers && typeof merged.mcpServers === 'object' ? merged.mcpServers : {}),
    agentbridge: serverConfig,
  };

  // Zed also supports context_servers
  if (isZed) {
    merged.context_servers = {
      ...(merged.context_servers && typeof merged.context_servers === 'object'
        ? merged.context_servers
        : {}),
      agentbridge: serverConfig,
    };
  }

  atomicWriteJson(targetPath, merged);

  return { path: targetPath, modified: true };
}
