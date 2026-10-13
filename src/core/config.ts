import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { home } from '../bridge/runs.js';
import { AgentError } from './errors.js';
import { PermissionLevel } from '../types/index.js';

export const PERMISSION_LEVELS: readonly PermissionLevel[] = ['read-only', 'plan', 'edit', 'full'] as const;

export const PERMISSION_RANK: Record<PermissionLevel, number> = {
  'read-only': 0,
  plan: 1,
  edit: 2,
  full: 3,
};

export interface AgentBridgeConfig {
  defaultPermissions?: PermissionLevel;
  permissionsCeiling?: PermissionLevel;
  defaultAgent?: string;
  autoRollback?: boolean;
  [key: string]: any;
}

export function findProjectRoot(startDir: string = process.cwd()): string {
  let cur = path.resolve(startDir);
  const userHome = path.resolve(homedir());
  const isSameDir = (a: string, b: string) =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

  while (true) {
    if (existsSync(path.join(cur, '.agentbridge')) && !isSameDir(cur, userHome)) {
      return cur;
    }
    if (existsSync(path.join(cur, '.git')) && !isSameDir(cur, userHome)) {
      return cur;
    }
    if (isSameDir(cur, userHome)) {
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) {
      break;
    }
    cur = parent;
  }
  return path.resolve(startDir);
}

export function globalConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(home(env), 'config.json');
}

export function projectConfigFile(cwd: string = process.cwd()): string {
  const root = findProjectRoot(cwd);
  return path.join(root, '.agentbridge', 'config.json');
}

function readJsonFile(filePath: string): any {
  if (!existsSync(filePath)) return {};
  try {
    const content = readFileSync(filePath, 'utf8');
    if (!content.trim()) {
      throw new AgentError('BAD_OPTION', `Configuration file "${filePath}" is empty`);
    }
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    throw new AgentError('BAD_OPTION', `Configuration file "${filePath}" must contain a JSON object`);
  } catch (err: any) {
    if (err instanceof AgentError) throw err;
    throw new AgentError('BAD_OPTION', `Failed to parse configuration file "${filePath}": ${err.message}`);
  }
}

function validatePermissionConfig(config: any, filePath: string): void {
  for (const key of ['permissionsCeiling', 'defaultPermissions'] as const) {
    if (Object.hasOwn(config, key) && !PERMISSION_LEVELS.includes(config[key])) {
      throw new AgentError(
        'BAD_OPTION',
        `Invalid "${key}" in configuration file "${filePath}": expected one of ${PERMISSION_LEVELS.join('|')}`
      );
    }
  }
}

function validatePermissionEnv(value: string | undefined, variable: string): void {
  if (value && !PERMISSION_LEVELS.includes(value as PermissionLevel)) {
    throw new AgentError(
      'BAD_OPTION',
      `Invalid ${variable} value "${value}": expected one of ${PERMISSION_LEVELS.join('|')}`
    );
  }
}

function writeJsonFile(filePath: string, data: any): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  try {
    renameSync(tmp, filePath);
  } catch (err: any) {
    try {
      writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
      unlinkSync(tmp);
    } catch {
      throw new AgentError('BAD_OPTION', `Failed to write configuration file "${filePath}": ${err.message}`);
    }
  }
}

/**
 * Loads merged configuration: defaults < global config < project config < env vars.
 */
export function loadConfig(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): AgentBridgeConfig {
  const globalFile = globalConfigFile(env);
  const projectFile = projectConfigFile(cwd);
  const globalCfg = readJsonFile(globalFile);
  const projectCfg = readJsonFile(projectFile);
  validatePermissionConfig(globalCfg, globalFile);
  validatePermissionConfig(projectCfg, projectFile);

  const merged: AgentBridgeConfig = {
    ...globalCfg,
    ...projectCfg,
  };

  // Environment variables take precedence over config files
  const envDefault = env.AGENTBRIDGE_DEFAULT_PERMS || env.AGENTBRIDGE_DEFAULT_PERMISSIONS;
  validatePermissionEnv(env.AGENTBRIDGE_DEFAULT_PERMS, 'AGENTBRIDGE_DEFAULT_PERMS');
  validatePermissionEnv(env.AGENTBRIDGE_DEFAULT_PERMISSIONS, 'AGENTBRIDGE_DEFAULT_PERMISSIONS');
  if (envDefault && PERMISSION_LEVELS.includes(envDefault as PermissionLevel)) {
    merged.defaultPermissions = envDefault as PermissionLevel;
  }

  const envCeiling = env.AGENTBRIDGE_PERMS_CEILING || env.AGENTBRIDGE_PERMS;
  validatePermissionEnv(env.AGENTBRIDGE_PERMS_CEILING, 'AGENTBRIDGE_PERMS_CEILING');
  validatePermissionEnv(env.AGENTBRIDGE_PERMS, 'AGENTBRIDGE_PERMS');
  if (envCeiling && PERMISSION_LEVELS.includes(envCeiling as PermissionLevel)) {
    merged.permissionsCeiling = envCeiling as PermissionLevel;
  }

  return merged;
}

/**
 * Returns the effective permission ceiling (defaults to 'full').
 */
export function getPermissionsCeiling(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): PermissionLevel {
  const cfg = loadConfig(cwd, env);
  const ceiling = cfg.permissionsCeiling;
  return ceiling && PERMISSION_LEVELS.includes(ceiling) ? ceiling : 'full';
}

/**
 * Returns the effective default permission level (defaults to 'read-only' for security).
 */
export function getDefaultPermissions(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): PermissionLevel {
  const cfg = loadConfig(cwd, env);
  const def = cfg.defaultPermissions;
  return def && PERMISSION_LEVELS.includes(def) ? def : 'read-only';
}

/**
 * Normalizes and validates requested permissions against ceiling and default.
 */
export function resolvePermissionLevel(
  requested?: string | null,
  options?: { env?: NodeJS.ProcessEnv; cwd?: string }
): { permissions: PermissionLevel; ceiling: PermissionLevel; isDefault: boolean } {
  const env = options?.env || process.env;
  const cwd = options?.cwd || process.cwd();

  const ceiling = getPermissionsCeiling(env, cwd);
  const def = getDefaultPermissions(env, cwd);

  const isDefault = requested == null;
  const perms = (isDefault ? def : requested) as PermissionLevel;

  if (!PERMISSION_LEVELS.includes(perms)) {
    throw new AgentError('BAD_OPTION', `permissions must be one of ${PERMISSION_LEVELS.join('|')}`);
  }

  if (PERMISSION_RANK[perms] > PERMISSION_RANK[ceiling]) {
    throw new AgentError(
      'BAD_OPTION',
      `permissions "${perms}" exceeds the configured permission ceiling "${ceiling}" (increase ceiling or configure permission)`
    );
  }

  return { permissions: perms, ceiling, isDefault };
}

/**
 * Saves multiple configuration keys.
 */
export function saveConfig(
  cfg: Partial<AgentBridgeConfig>,
  options?: { global?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }
): void {
  for (const [k, v] of Object.entries(cfg)) {
    setConfigValue(k, v, options);
  }
}

/**
 * Sets a configuration key globally or for the current project.
 */
export function setConfigValue(
  key: string,
  value: any,
  options?: { global?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }
): void {
  const isGlobal = options?.global ?? false;
  const filePath = isGlobal ? globalConfigFile(options?.env) : projectConfigFile(options?.cwd);

  const normalizedKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); // kebab to camel
  if (normalizedKey === 'defaultPermissions' || normalizedKey === 'permissionsCeiling') {
    if (!PERMISSION_LEVELS.includes(value)) {
      throw new AgentError(
        'BAD_OPTION',
        `Invalid permission level "${value}". Expected one of: ${PERMISSION_LEVELS.join(', ')}`
      );
    }
  }

  const current = readJsonFile(filePath);
  current[normalizedKey] = value;
  writeJsonFile(filePath, current);
}

/**
 * Gets a configuration value.
 */
export function getConfigValue(
  key: string,
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): any {
  const cfg = loadConfig(options?.cwd, options?.env);
  const normalizedKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return cfg[normalizedKey] ?? cfg[key];
}

/**
 * Removes a configuration key or clears the config file.
 */
export function resetConfigValue(
  key?: string,
  options?: { global?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }
): void {
  const isGlobal = options?.global ?? false;
  const filePath = isGlobal ? globalConfigFile(options?.env) : projectConfigFile(options?.cwd);
  if (!existsSync(filePath)) return;

  if (!key) {
    unlinkSync(filePath);
    return;
  }

  const current = readJsonFile(filePath);
  const normalizedKey = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  delete current[normalizedKey];
  delete current[key];
  writeJsonFile(filePath, current);
}
