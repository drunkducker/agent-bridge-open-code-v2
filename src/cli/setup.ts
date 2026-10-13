// Interactive modern setup wizard for AgentBridge (`ab setup` / `ab wizard`).
// Pure Node ESM, zero external dependencies.
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { homedir } from 'node:os';
import path from 'node:path';
import { runCollect, resolveBinary } from '../core/spawn.js';
import { findBinary as findAgy } from '../adapters/agy.js';
import { findBinary as findPi } from '../adapters/pi.js';
import { cmdInstall, cmdEndpoint, writeSkill } from './install.js';
import { UsageError } from './args.js';
import { doctor } from '../extras/doctor.js';

import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface SetupOptions {
  interactive?: boolean;
  scope?: 'user' | 'project' | 'local';
  permissions?: 'read-only' | 'plan' | 'edit' | 'full';
  installSkill?: boolean;
  autoApproveCodex?: boolean;
  targetAgents?: string[];
  endpoint?: {
    name: string;
    baseUrl: string;
    type: 'openai' | 'anthropic';
    apiKeyEnv?: string;
    model?: string;
  };
}

interface DetectedAgent {
  name: string;
  displayName: string;
  installed: boolean;
  path?: string | null;
  version?: string | null;
  extra?: string | null;
  category?: 'cli' | 'endpoint' | 'ide';
}

function getColors() {
  const hasColor = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR === '1');
  return {
    reset: hasColor ? '\x1b[0m' : '',
    bold: hasColor ? '\x1b[1m' : '',
    dim: hasColor ? '\x1b[2m' : '',
    cyan: hasColor ? '\x1b[36m' : '',
    brightCyan: hasColor ? '\x1b[96m' : '',
    green: hasColor ? '\x1b[32m' : '',
    brightGreen: hasColor ? '\x1b[92m' : '',
    yellow: hasColor ? '\x1b[33m' : '',
    brightYellow: hasColor ? '\x1b[93m' : '',
    blue: hasColor ? '\x1b[34m' : '',
    brightBlue: hasColor ? '\x1b[94m' : '',
    magenta: hasColor ? '\x1b[35m' : '',
    brightMagenta: hasColor ? '\x1b[95m' : '',
    red: hasColor ? '\x1b[31m' : '',
    gray: hasColor ? '\x1b[90m' : '',
  };
}

async function probeVersion(bin: string): Promise<string | null> {
  try {
    const r = await runCollect(bin, ['--version'], { timeoutMs: 10000 });
    const line = (r.stdout || r.stderr || '').trim().split('\n')[0];
    const match = line.match(/\b\d+\.\d+(\.\d+)?(-[\w.]+)?\b/);
    return match ? match[0] : line.slice(0, 30) || null;
  } catch {
    return null;
  }
}

async function probeOllamaServer(): Promise<{ running: boolean; version?: string }> {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/version', {
      signal: AbortSignal.timeout(1200),
    });
    if (res.ok) {
      const data: any = await res.json().catch(() => ({}));
      return { running: true, version: data.version || 'active' };
    }
  } catch {
    /* not running */
  }
  return { running: false };
}

async function scanEnvironment(): Promise<DetectedAgent[]> {
  const list: DetectedAgent[] = [];

  // Claude Code
  const claudeBin = resolveBinary('claude');
  const claudeVer = claudeBin ? await probeVersion(claudeBin) : null;
  list.push({
    name: 'claude',
    displayName: 'Claude Code',
    installed: !!claudeBin,
    path: claudeBin,
    version: claudeVer,
    category: 'cli',
  });

  // OpenAI Codex
  const codexBin = resolveBinary('codex');
  const codexVer = codexBin ? await probeVersion(codexBin) : null;
  list.push({
    name: 'codex',
    displayName: 'OpenAI Codex',
    installed: !!codexBin,
    path: codexBin,
    version: codexVer,
    category: 'cli',
  });

  // OpenCode
  const opencodeBin = resolveBinary('opencode');
  const opencodeVer = opencodeBin ? await probeVersion(opencodeBin) : null;
  list.push({
    name: 'opencode',
    displayName: 'OpenCode CLI',
    installed: !!opencodeBin,
    path: opencodeBin,
    version: opencodeVer,
    category: 'cli',
  });

  // Pi
  const piBin = findPi();
  const piVer = piBin ? await probeVersion(piBin) : null;
  list.push({
    name: 'pi',
    displayName: 'Pi Coding Agent',
    installed: !!piBin,
    path: piBin,
    version: piVer,
    category: 'cli',
  });

  // Ollama
  const ollamaBin = resolveBinary('ollama');
  const ollamaVer = ollamaBin ? await probeVersion(ollamaBin) : null;
  const ollamaServer = await probeOllamaServer();
  list.push({
    name: 'ollama',
    displayName: 'Ollama Runner',
    installed: !!ollamaBin || ollamaServer.running,
    path: ollamaBin,
    version: ollamaVer || (ollamaServer.version ? `v${ollamaServer.version}` : null),
    extra: ollamaServer.running ? 'Server online at 127.0.0.1:11434' : 'Server offline',
    category: 'endpoint',
  });

  // Antigravity CLI
  const agyBin = findAgy();
  const agyVer = agyBin ? await probeVersion(agyBin) : null;
  list.push({
    name: 'agy',
    displayName: 'Antigravity CLI (agy)',
    installed: !!agyBin,
    path: agyBin,
    version: agyVer,
    category: 'cli',
  });

  // IDE Detection (Cursor, VS Code, Zed, Windsurf, Claude Desktop)
  const home = homedir();
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  const cursorExists =
    existsSync(path.join(home, '.cursor')) ||
    existsSync(path.join(process.cwd(), '.cursor')) ||
    (isWin && existsSync(path.join(process.env.APPDATA || '', 'Cursor')));
  list.push({
    name: 'cursor',
    displayName: 'Cursor IDE',
    installed: cursorExists,
    category: 'ide',
  });

  const vscodeExists =
    existsSync(path.join(home, '.vscode')) ||
    existsSync(path.join(process.cwd(), '.vscode')) ||
    (isWin && existsSync(path.join(process.env.APPDATA || '', 'Code')));
  list.push({
    name: 'vscode',
    displayName: 'VS Code',
    installed: vscodeExists,
    category: 'ide',
  });

  const claudeDesktopExists =
    (isWin && existsSync(path.join(process.env.APPDATA || '', 'Claude'))) ||
    (isMac && existsSync(path.join(home, 'Library', 'Application Support', 'Claude')));
  list.push({
    name: 'claude-desktop',
    displayName: 'Claude Desktop',
    installed: claudeDesktopExists,
    category: 'ide',
  });

  const zedExists =
    existsSync(path.join(home, '.config', 'zed')) ||
    (isWin && existsSync(path.join(process.env.LOCALAPPDATA || '', 'Zed')));
  list.push({
    name: 'zed',
    displayName: 'Zed Editor',
    installed: zedExists,
    category: 'ide',
  });

  const windsurfExists =
    existsSync(path.join(home, '.windsurf')) ||
    existsSync(path.join(home, '.codeium')) ||
    (isWin && existsSync(path.join(process.env.APPDATA || '', 'Windsurf')));
  list.push({
    name: 'windsurf',
    displayName: 'Windsurf IDE',
    installed: windsurfExists,
    category: 'ide',
  });

  return list;
}

function printHeader(c: ReturnType<typeof getColors>, io: { out: (msg: string) => void }) {
  const ascii = [
    `   ${c.brightCyan} ___                    __  ____       _     __           ${c.reset}`,
    `  ${c.brightCyan} /   | ____ ____  ____  / /_/ __ )_____(_)___/ /___ ____   ${c.reset}`,
    ` ${c.brightBlue}  / /| |/ __ \`/ _ \\/ __ \\/ __/ __  / ___/ / __  / __ \`/ _ \\  ${c.reset}`,
    `${c.brightBlue}  / ___ / /_/ /  __/ / / / /_/ /_/ / /  / / /_/ / /_/ /  __/  ${c.reset}`,
    `${c.magenta} /_/  |_\\__, /\\___/_/ /_/\\__/_____/_/  /_/\\__,_/\\__, /\\___/   ${c.reset}`,
    `${c.brightMagenta}       /____/                                  /____/         ${c.reset}`
  ];
  for (const line of ascii) io.out(line);
  io.out('');

  const line = '─'.repeat(70);
  io.out(`${c.cyan}╭${line}╮${c.reset}`);
  io.out(`${c.cyan}│${c.reset}  ${c.bold}${c.magenta}⚡ AGENTBRIDGE${c.reset} — ${c.bold}Interactive Multi-Agent Setup & Onboarding Wizard${c.reset}  ${c.cyan}│${c.reset}`);
  io.out(`${c.cyan}│${c.reset}  ${c.dim}Connect Claude Code, Codex, OpenCode, Pi, Antigravity, Ollama & IDEs${c.reset}  ${c.cyan}│${c.reset}`);
  io.out(`${c.cyan}╰${line}╯${c.reset}\n`);
}

function printDetected(agents: DetectedAgent[], c: ReturnType<typeof getColors>, io: { out: (msg: string) => void }) {
  const cliAgents = agents.filter((a) => a.category === 'cli' || a.category === 'endpoint');
  const ides = agents.filter((a) => a.category === 'ide');

  io.out(`${c.bold}${c.brightBlue}✦ Probing Coding Agent CLIs & Runtimes:${c.reset}`);
  for (const a of cliAgents) {
    if (a.installed) {
      const v = a.version ? `${c.dim}(${a.version})${c.reset}` : '';
      const extra = a.extra ? ` ${c.cyan}[${a.extra}]${c.reset}` : '';
      io.out(`  ${c.green}✔${c.reset} ${c.bold}${a.displayName.padEnd(24)}${c.reset} ${v}${extra}`);
    } else {
      io.out(`  ${c.gray}○${c.reset} ${c.dim}${a.displayName.padEnd(24)} Not found (optional)${c.reset}`);
    }
  }

  const installedIdes = ides.filter((i) => i.installed);
  if (installedIdes.length > 0) {
    io.out(`\n${c.bold}${c.brightBlue}✦ Probing Installed IDEs & Desktop Editors:${c.reset}`);
    for (const ide of installedIdes) {
      io.out(`  ${c.green}✔${c.reset} ${c.bold}${ide.displayName.padEnd(24)}${c.reset} ${c.dim}(Config detected)${c.reset}`);
    }
  }
  io.out('');
}

async function promptConfirm(
  rl: readline.Interface,
  query: string,
  defaultValue = true,
  c: ReturnType<typeof getColors>
): Promise<boolean> {
  const hint = defaultValue ? `${c.bold}[Y/n]${c.reset}` : `${c.bold}[y/N]${c.reset}`;
  const ans = (await rl.question(`  ${c.yellow}?${c.reset} ${query} ${hint} `)).trim().toLowerCase();
  if (!ans) return defaultValue;
  return ans === 'y' || ans === 'yes' || ans === 's' || ans === 'sim';
}

async function promptChoice<T extends string>(
  rl: readline.Interface,
  query: string,
  choices: { label: string; value: T; desc?: string }[],
  defaultIdx = 0,
  c: ReturnType<typeof getColors>
): Promise<T> {
  process.stdout.write(`  ${c.yellow}?${c.reset} ${c.bold}${query}${c.reset}\n`);
  for (let i = 0; i < choices.length; i++) {
    const isDef = i === defaultIdx;
    const marker = isDef ? `${c.green}❯ [${i + 1}]${c.reset}` : `  [${i + 1}]`;
    const tag = isDef ? ` ${c.dim}(Default)${c.reset}` : '';
    const desc = choices[i].desc ? `\n      ${c.dim}${choices[i].desc}${c.reset}` : '';
    process.stdout.write(`    ${marker} ${choices[i].label}${tag}${desc}\n`);
  }
  const ans = (await rl.question(`    ${c.dim}Choice (1-${choices.length}) [${defaultIdx + 1}]:${c.reset} `)).trim();
  const idx = parseInt(ans, 10) - 1;
  if (!isNaN(idx) && idx >= 0 && idx < choices.length) {
    return choices[idx].value;
  }
  return choices[defaultIdx].value;
}

export async function cmdSetup(
  _args: string[],
  flags: Record<string, any>,
  io: { out: (msg: any) => void; err: (msg: any) => void }
): Promise<void> {
  if (flags.scope != null && !['user', 'project', 'local'].includes(flags.scope)) {
    throw new UsageError('--scope must be user|project|local');
  }
  if (flags.permissions != null && !['read-only', 'plan', 'edit', 'full'].includes(flags.permissions)) {
    throw new UsageError('--permissions must be read-only|plan|edit|full');
  }
  const hasTimeout = Object.prototype.hasOwnProperty.call(flags, 'timeout');
  const timeout = hasTimeout ? flags.timeout : 300;
  if (hasTimeout) {
    if (typeof timeout !== 'string' && typeof timeout !== 'number') {
      throw new UsageError('--timeout must be a finite positive number');
    }
    const value = Number(timeout);
    if (!Number.isFinite(value) || value <= 0) throw new UsageError('--timeout must be a finite positive number');
  }

  const c = getColors();
  printHeader(c, io);

  const detected = await scanEnvironment();
  printDetected(detected, c, io);

  const installedNames = detected.filter((d) => d.installed && ['claude', 'codex', 'opencode', 'agy', 'pi'].includes(d.name)).map((d) => d.name);
  const isInteractive = Boolean(process.stdin.isTTY && !flags.yes && !flags['non-interactive']);

  let targets: string[] = [];
  let scope: 'user' | 'project' | 'local' = 'user';
  let permissions: 'read-only' | 'plan' | 'edit' | 'full' = 'full';
  let installSkill = true;
  let autoApproveCodex = true;
  let customEndpoint: SetupOptions['endpoint'] | null = null;
  let runDoctorAtEnd = true;

  if (isInteractive) {
    const rl = readline.createInterface({ input, output });
    try {
      // 1. Choose Agents
      io.out(`${c.bold}${c.cyan}Step 1 / 5 · Target Agents${c.reset}`);
      const agentChoice = await promptChoice(
        rl,
        'Which agents would you like to configure with AgentBridge?',
        [
          {
            label: installedNames.length
              ? `All detected agents (${installedNames.join(', ')})`
              : 'All standard agents (claude, codex, opencode, pi)',
            value: 'all_detected',
            desc: 'Auto-detects and connects all coding agent CLIs currently available.',
          },
          {
            label: 'Select agents individually',
            value: 'custom',
            desc: 'Choose manually agent by agent.',
          },
          {
            label: 'All supported agents (claude, codex, opencode, agy, pi)',
            value: 'all',
            desc: 'Configures every known agent CLI even if not yet installed.',
          },
        ],
        0,
        c
      );

      if (agentChoice === 'all_detected') {
        targets = installedNames.length ? installedNames : ['claude', 'codex', 'opencode', 'pi'];
      } else if (agentChoice === 'all') {
        targets = ['claude', 'codex', 'opencode', 'agy', 'pi'];
      } else {
        const available = ['claude', 'codex', 'opencode', 'agy', 'pi'];
        for (const a of available) {
          const isInst = detected.find((d) => d.name === a)?.installed;
          const conf = await promptConfirm(
            rl,
            `Configure ${a.toUpperCase()}? ${isInst ? `${c.green}(detected)${c.reset}` : `${c.dim}(not detected)${c.reset}`}`,
            !!isInst,
            c
          );
          if (conf) targets.push(a);
        }
        if (!targets.length) {
          io.out(`  ${c.yellow}No agents selected. Defaulting to all detected agents.${c.reset}`);
          targets = installedNames.length ? installedNames : ['claude'];
        }
      }
      io.out('');

      // 2. Scope
      io.out(`${c.bold}${c.cyan}Step 2 / 5 · Installation Scope${c.reset}`);
      scope = await promptChoice(
        rl,
        'Where should the AgentBridge MCP configuration be saved?',
        [
          {
            label: `User / Global (~/.claude, ~/.codex, ~/.pi)`,
            value: 'user',
            desc: 'Available globally across all projects and terminals on your machine.',
          },
          {
            label: `Project / Local (${process.cwd()})`,
            value: 'project',
            desc: 'Scoped only to the current repository / directory.',
          },
        ],
        0,
        c
      );
      io.out('');

      // 3. Permission Ceiling
      io.out(`${c.bold}${c.cyan}Step 3 / 5 · Permission Ceiling${c.reset}`);
      permissions = await promptChoice(
        rl,
        'Select the maximum permission level granted to delegated agents:',
        [
          {
            label: 'full (Full shell execution + file modifications) [Default]',
            value: 'full',
            desc: 'Unrestricted execution. The agent can do everything (edit files, run shell/PowerShell).',
          },
          {
            label: 'edit (Workspace file modifications allowed)',
            value: 'edit',
            desc: 'Allows agents to inspect, refactor, and write files in the active workspace.',
          },
          {
            label: 'plan (Read-only + planning, no disk modifications)',
            value: 'plan',
            desc: 'Allows agents to inspect files and generate plans/diffs without modifying files.',
          },
          {
            label: 'read-only (Read-only questions & responses only)',
            value: 'read-only',
            desc: 'Maximum isolation: agents can answer questions and read code, but cannot edit files.',
          },
        ],
        0,
        c
      );
      io.out('');

      // 4. Skills & Auto-Approval
      io.out(`${c.bold}${c.cyan}Step 4 / 5 · Skills & Approvals${c.reset}`);
      installSkill = await promptConfirm(
        rl,
        'Install agentbridge-delegate skill (enables Claude & agents to call each other)?',
        true,
        c
      );

      if (targets.includes('codex')) {
        autoApproveCodex = await promptConfirm(
          rl,
          'Enable auto-approval for AgentBridge MCP tools in Codex config (avoids repetitive prompts)?',
          true,
          c
        );
      }
      io.out('');

      // 5. External HTTP Endpoints (Ollama / OpenRouter)
      io.out(`${c.bold}${c.cyan}Step 5 / 5 · Model Endpoints${c.reset}`);
      const ollamaItem = detected.find((d) => d.name === 'ollama');
      if (ollamaItem?.installed) {
        const addOllama = await promptConfirm(
          rl,
          'Local Ollama was detected! Register local Ollama as an endpoint (ollama-local)?',
          true,
          c
        );
        if (addOllama) {
          customEndpoint = {
            name: 'ollama-local',
            baseUrl: 'http://127.0.0.1:11434/v1',
            type: 'openai',
            model: 'glm-5.3-flash:cloud',
          };
        }
      }

      if (!customEndpoint) {
        const addEp = await promptConfirm(
          rl,
          'Would you like to register an external endpoint (e.g., OpenRouter, vLLM)?',
          false,
          c
        );
        if (addEp) {
          const epType = await promptChoice(
            rl,
            'Endpoint preset:',
            [
              {
                label: 'OpenRouter (https://openrouter.ai/api/v1)',
                value: 'openrouter',
                desc: 'Universal access to 200+ models via OPENROUTER_API_KEY.',
              },
              {
                label: 'Custom HTTP URL (OpenAI-compatible)',
                value: 'custom',
                desc: 'Any local or remote OpenAI-compatible API.',
              },
            ],
            0,
            c
          );

          if (epType === 'openrouter') {
            customEndpoint = {
              name: 'openrouter',
              baseUrl: 'https://openrouter.ai/api/v1',
              type: 'openai',
              apiKeyEnv: 'OPENROUTER_API_KEY',
              model: 'anthropic/claude-sonnet-5.5',
            };
          } else {
            const urlAns = (await rl.question(`    ${c.dim}Base URL:${c.reset} `)).trim();
            if (urlAns) {
              const nameAns = (await rl.question(`    ${c.dim}Endpoint name [custom]:${c.reset} `)).trim() || 'custom';
              customEndpoint = {
                name: nameAns,
                baseUrl: urlAns,
                type: 'openai',
              };
            }
          }
        }
      }
      io.out('');

      runDoctorAtEnd = await promptConfirm(rl, 'Run "ab doctor" at the end to verify the installation?', true, c);
      io.out('');
    } finally {
      rl.close();
    }
  } else {
    // Non-interactive mode (flags or piped)
    targets = flags.agent ? [flags.agent] : installedNames;
    scope = flags.scope || 'user';
    permissions = (flags.permissions || 'full') as any;
    installSkill = flags['no-skill'] !== true;
    autoApproveCodex = flags['auto-approve'] !== false;
    runDoctorAtEnd = false;
    io.out(`  ${c.dim}Running non-interactive setup with default options...${c.reset}\n`);
  }

  // Execute configurations
  const divider = '─'.repeat(66);
  io.out(`${c.bold}${c.cyan}╭${divider}╮${c.reset}`);
  io.out(`${c.bold}${c.cyan}│${c.reset}   ${c.bold}⚙  Applying Configurations${c.reset}${' '.repeat(41)}${c.cyan}│${c.reset}`);
  io.out(`${c.bold}${c.cyan}╰${divider}╯${c.reset}`);

  const targetCwd = flags.cwd ? path.resolve(flags.cwd) : process.cwd();

  const installFlags: Record<string, any> = {
    scope,
    permissions,
    'no-skill': !installSkill,
    'auto-approve': autoApproveCodex,
    timeout: Number(timeout),
    ...(flags.cwd ? { cwd: targetCwd } : {}),
  };

  const results: { agent: string; success: boolean; message: string }[] = [];

  if (targets.length === 0) {
    io.out(`  ${c.dim}No coding agent CLIs detected on PATH. Skipping agent hook installation (use "ab setup --agent <name>" to force a specific CLI).${c.reset}\n`);
  } else {
    for (const t of targets) {
      try {
        await cmdInstall([t], installFlags, {
          out: (msg) => {
            if (typeof msg === 'string' && msg.trim()) {
              io.out(`  ${c.green}✔${c.reset} ${c.bold}${t.toUpperCase()}:${c.reset} ${msg.trim()}`);
            }
          },
          err: io.err,
        });
        results.push({ agent: t, success: true, message: 'Configured' });
      } catch (e: any) {
        io.out(`  ${c.red}✖${c.reset} ${c.bold}${t.toUpperCase()}:${c.reset} ${e.message}`);
        results.push({ agent: t, success: false, message: e.message });
        process.exitCode = 1;
      }
    }
  }

  // Register custom endpoint if selected
  if (customEndpoint) {
    try {
      await cmdEndpoint(
        ['add', customEndpoint.name, customEndpoint.baseUrl],
        {
          type: customEndpoint.type,
          ...(customEndpoint.model ? { model: customEndpoint.model } : {}),
          ...(customEndpoint.apiKeyEnv ? { 'api-key-env': customEndpoint.apiKeyEnv } : {}),
        },
        {
          out: (msg) => {
            if (typeof msg === 'string') {
              io.out(`  ${c.green}✔${c.reset} ${c.bold}ENDPOINT:${c.reset} ${msg.trim()}`);
            }
          },
        }
      );
    } catch (e: any) {
      io.out(`  ${c.red}✖${c.reset} ${c.bold}ENDPOINT:${c.reset} ${e.message}`);
    }
  }

  // Canonical, safe skill sync (no colliding duplicates)
  if (installSkill) {
    try {
      const baseDir = scope === 'user' ? path.join(homedir(), '.agents') : path.join(targetCwd, '.agents');
      writeSkill(baseDir, (msg) => {
        if (typeof msg === 'string' && msg.trim()) {
          io.out(`  ${c.green}✔${c.reset} ${c.bold}SKILL:${c.reset} ${msg.trim()}`);
        }
      });
    } catch {
      /* ignore skill copy errors */
    }
  }

  // Success summary card
  io.out('');
  const boxWidth = 72;
  const cardDivider = '─'.repeat(boxWidth - 2);
  io.out(`${c.green}╭${cardDivider}╮${c.reset}`);
  io.out(`${c.green}│${c.reset}  ${c.bold}${c.green}🎉 AgentBridge Setup Complete!${c.reset}${' '.repeat(40)}${c.green}│${c.reset}`);
  io.out(`${c.green}├${cardDivider}┤${c.reset}`);
  io.out(`${c.green}│${c.reset}  • Scope:            ${c.bold}${scope}${c.reset}${' '.repeat(Math.max(0, 50 - scope.length))}${c.green}│${c.reset}`);
  io.out(`${c.green}│${c.reset}  • Permissions:      ${c.bold}${permissions}${c.reset}${' '.repeat(Math.max(0, 50 - permissions.length))}${c.green}│${c.reset}`);
  const targetStr = targets.length ? targets.join(', ') : 'none (skills installed)';
  io.out(`${c.green}│${c.reset}  • Configured:       ${c.bold}${targetStr}${c.reset}${' '.repeat(Math.max(0, 50 - targetStr.length))}${c.green}│${c.reset}`);
  const skillStr = installSkill ? 'agentbridge-delegate installed & synchronized' : 'skipped';
  io.out(`${c.green}│${c.reset}  • Skills:           ${c.cyan}${skillStr}${c.reset}${' '.repeat(Math.max(0, 50 - skillStr.length))}${c.green}│${c.reset}`);
  io.out(`${c.green}├${cardDivider}┤${c.reset}`);
  io.out(`${c.green}│${c.reset}  ${c.bold}Quick Start Commands:${c.reset}${' '.repeat(47)}${c.green}│${c.reset}`);
  io.out(`${c.green}│${c.reset}    ${c.cyan}ab ask claude "Hello"${c.reset}            Ask a single question              ${c.green}│${c.reset}`);
  io.out(`${c.green}│${c.reset}    ${c.cyan}ab run codex "Write tests"${c.reset}        Run in agentic workspace mode      ${c.green}│${c.reset}`);
  io.out(`${c.green}│${c.reset}    ${c.cyan}ab fanout "Review diff" a b${c.reset}       Run multi-agent consensus          ${c.green}│${c.reset}`);
  io.out(`${c.green}│${c.reset}    ${c.cyan}ab ui --open${c.reset}                      Launch visual web dashboard        ${c.green}│${c.reset}`);
  io.out(`${c.green}│${c.reset}    ${c.cyan}ab doctor${c.reset}                         Run comprehensive health check     ${c.green}│${c.reset}`);
  io.out(`${c.green}╰${cardDivider}╯${c.reset}\n`);

  // Interactive usage guide for the user. Rows are padded by visible width so the border stays aligned.
  const guideRow = (content: string) => {
    const visible = content.replace(/\x1b\[[0-9;]*m/g, '').length;
    io.out(`${c.cyan}│${c.reset}${content}${' '.repeat(Math.max(0, boxWidth - 2 - visible))}${c.cyan}│${c.reset}`);
  };
  io.out(`${c.cyan}╭${cardDivider}╮${c.reset}`);
  guideRow(`  ${c.bold}${c.brightCyan}USAGE GUIDE & QUICK DOCUMENTATION${c.reset}`);
  io.out(`${c.cyan}├${cardDivider}┤${c.reset}`);
  guideRow(`  ${c.bold}${c.yellow}1. How your agents talk to each other (MCP tools):${c.reset}`);
  guideRow(`     Any configured agent can now call the others as tools:`);
  guideRow(`     • ${c.green}ask_<agent>(prompt, permissions="edit")${c.reset} - synchronous call`);
  guideRow(`     • ${c.green}dispatch_<agent>(prompt)${c.reset} - async / parallel dispatch`);
  guideRow(`     • ${c.green}check_quota(agent="codex")${c.reset} - check quota before costly tasks`);
  guideRow(`     • ${c.green}checkpoint_create("message")${c.reset} - invisible, safe Git snapshot`);
  guideRow('');
  guideRow(`  ${c.bold}${c.yellow}2. Zero-Accident Safety Lock:${c.reset}`);
  guideRow(`     • By default, delegations run in ${c.bold}read-only${c.reset} mode.`);
  guideRow(`     • To allow file edits or tests, pass explicitly:`);
  guideRow(`       ${c.bold}permissions: "edit"${c.reset} or ${c.bold}permissions: "full"${c.reset}.`);
  guideRow('');
  guideRow(`  ${c.bold}${c.yellow}3. Ultra-low latency on Codex (App-Server daemon):${c.reset}`);
  guideRow(`     • Add ${c.bold}--transport app-server${c.reset} (CLI) or ${c.bold}transport: "app-server"${c.reset}`);
  guideRow(`       in MCP calls to keep the daemon warm, avoiding cold starts`);
  guideRow(`       and enabling real-time approvals.`);
  guideRow('');
  guideRow(`  ${c.bold}${c.yellow}4. Visual dashboard & live telemetry:${c.reset}`);
  guideRow(`     • Run ${c.bold}ab ui --open${c.reset} to watch token usage live,`);
  guideRow(`       delegated subagent trees and checkpoint history.`);
  io.out(`${c.cyan}╰${cardDivider}╯${c.reset}\n`);

  if (runDoctorAtEnd) {
    io.out(`${c.bold}${c.blue}✦ Running "ab doctor" verification:${c.reset}`);
    const docResult = await doctor({ live: false, models: true });
    for (const chk of docResult.checks) {
      const tag = chk.status === 'ok' ? `${c.green}[  ok  ]${c.reset}` : chk.status === 'warn' ? `${c.yellow}[ WARN ]${c.reset}` : `${c.red}[ FAIL ]${c.reset}`;
      io.out(`  ${tag} ${chk.name}: ${chk.detail}`);
    }
    io.out('');
    if (docResult.ok) {
      io.out(`  ${c.green}${c.bold}All health checks passed! You are ready to bridge agents.${c.reset}\n`);
    } else {
      io.out(`  ${c.yellow}Some checks had warnings or errors. Run "ab doctor --live" for details.${c.reset}\n`);
    }
  }
}
