// Public telemetry API (re-exported from src/index.ts).
export { runWithTelemetry, runTracked, askWithTelemetry } from './track.js';
export type { TelemetryOptions } from './track.js';
export {
  stats,
  statsAsync,
  readSessionContextAsync,
  contextOf,
  setContextWindow,
  windowFor,
  estimateTokens,
  telemetryDir,
  runStatus,
  listSessions,
  DEFAULT_WINDOWS,
} from './stats.js';
export { setPolicy, getPolicy, resolvePolicy, evaluate, handoff, compact, buildHandoffDoc } from './context.js';
export type { PolicyLimits } from './context.js';
export { wait, waitAll, fire, bus, normalizeHooks, HOOK_EVENTS } from './hooks.js';
export type { RunSummary } from './hooks.js';
export {
  loadMemory,
  saveMemory,
  addRule,
  addDecision,
  setVariable,
  clearMemory,
  formatMemoryForPrompt,
  cmdMemory,
  cliMemoryAdd,
  cliMemoryDecision,
  cliMemoryList,
} from './memory.js';
export type { ProjectMemory, MemoryDecision } from './memory.js';

