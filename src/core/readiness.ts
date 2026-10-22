// Which agent CLIs are installed on this machine, and what to tell the user when one is not (or is not logged in).
import { hintFor } from './hints.js';
import { resolveBinary } from './spawn.js';
import { findBinary as findAgy } from '../adapters/agy.js';
import { findBinary as findPi } from '../adapters/pi.js';

export const CLI_AGENTS = ['claude', 'codex', 'opencode', 'agy', 'pi', 'cursor', 'gemini', 'grok', 'devin'] as const;

export function binaryOf(name: string): string | null {
  return name === 'agy' ? findAgy() : name === 'pi' ? findPi() : resolveBinary(name === 'cursor' ? 'cursor-agent' : name);
}

export function isInstalled(name: string): boolean {
  return (CLI_AGENTS as readonly string[]).includes(name) ? !!binaryOf(name) : true;
}

export function installedAgents(): string[] {
  return CLI_AGENTS.filter(isInstalled);
}

/** One line per agent CLI: ready / missing (with how to install) — printed when the proxy starts. */
export function readinessReport(): string[] {
  const lines: string[] = [];
  for (const n of CLI_AGENTS) {
    lines.push(binaryOf(n) ? `  [ok]      ${n}` : `  [missing] ${n}${hintFor(n, 'NOT_INSTALLED')}`);
  }
  return lines;
}
