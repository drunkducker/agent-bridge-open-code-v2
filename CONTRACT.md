# AgentBridge Architectural Contract (all builders MUST follow)

TypeScript native (ESM, strict typecheck, compiled to `dist/`), Node >= 22. Zero external runtime dependencies for core workflows.
No API keys required for local agents: orchestrate built-in coding agents (`claude`, `codex`, `opencode`, `agy`, `pi`, `cursor`, `grok`, `gemini`, `devin`, `acp`) — *installed* coding CLIs or protocol-level sessions — using their existing local authentications.
Windows + POSIX safe (resolve `.cmd` shims, UTF-8 code page enforcement, explicit quoting without vulnerable `shell: true`).

---

## 1. Adapter Interface (`src/adapters/<agent>.ts`)
All agent adapters must satisfy the unified interface:
```typescript
export interface AgentAdapter {
  name?: string;                                       // Optional adapter name
  models?(env?: NodeJS.ProcessEnv): Promise<string[]>; // Optional: best-effort discoverable models
  run(opts: RunOptions): AsyncGenerator<AgentEvent, RunResult, void>; // Required: streaming generator yielding events and returning RunResult
  isInstalled?(): Promise<boolean>;                    // Optional runtime presence check
}
```

### RunOptions (`src/types/index.ts`)
- `prompt`: string
- `model`?: string
- `effort`?: `'low'` | `'medium'` | `'high'` | `'xhigh'` | `'max'` (mapped per agent backend)
- `permissions`?: `'read-only'` | `'plan'` | `'edit'` | `'full'` (default `'read-only'`)
- `transport`?: `'cli'` | `'app-server'` | `'stdio'` | `'auto'` (Codex dual transport: `'app-server'` picks the warm daemon, otherwise the one-shot CLI)
- `cwd`?: string
- `timeoutMs`?: number
- `signal`?: AbortSignal
- `session`?: `{ mode: 'new' | 'ephemeral' | 'continue' | 'fork', id?: string }`
- `systemPrompt`?: string
- `mcpServers`?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>
- `env`?: Record<string, string>
- `jsonSchema`?: object
- `extraArgs`?: string[]
- `isolated`?: boolean (run without the user's local config/plugins/slash commands where supported)
- `fallback`?: `Array<string | { agent, model?, ... }>` and `fallbackOn`?: error codes that trigger it (default `RATE_LIMITED`)
- `quotaPolicy`?: proactive quota routing (`minRemainingPercent`, `waitForReset`, `maxWaitMs`)
- `harness`?: `'auto'` | `'claude'` | `'pi'` | `'none'` (which CLI executes an HTTP endpoint)
- `offline`?: boolean (no network tools; disables MCP passthrough)
- `appServer`?: boolean (shorthand for `transport: 'app-server'`)
- `yolo`?: boolean (Codex only) and `dangerouslySkipPermissions`?: boolean (Claude only); both require `permissions: 'full'`
- `skills`?: boolean (let children see skills), `mcpPassthrough`?: string[] (host MCP servers children may use)
- `images`?: attached images, `writableRoots`?: extra writable directories, `defaultPermissions`?: boolean

### Normalized AgentEvent
- `{ type: 'session', id: string }`
- `{ type: 'text', delta: string }`
- `{ type: 'thinking', delta: string }`
- `{ type: 'tool', name: string, input: any, output?: any }`
- `{ type: 'usage', input: number, output: number, cost?: number, incremental?: boolean }`
- `{ type: 'error', message: string }`
- `{ type: 'raw', data: any }`
- `{ type: 'fallback', from: string, to: string, code: string, message: string }`
- `{ type: 'quota', phase: 'waiting' | 'ready' | 'skipped', agent: string, message: string, threshold: number, remainingPercent?: number, resetAt?: number, nextCheckAt?: number }`

### Normalized RunResult
- `{ text: string, sessionId?: string, usage: { input: number, output: number, cost?: number }, exitCode: number, model?: string, durationMs: number, timedOut: boolean }`

---

## 2. Core Pillars & Architecture

### A. Dual Transport Architecture (OpenAI Codex)
- **CLI Transport (`transport: 'cli'`):** Standard one-shot process execution via `codex exec`.
- **App-Server Transport (`transport: 'app-server'`):** Warm JSON-RPC daemon over stdio (`codex app-server`). Eliminates cold start overhead, maintains persistent workspace state, and enables low-latency interactive tool approvals.

### B. Shared Resource Mirroring & Worktree Isolation
- Worktree execution (`--worktree`) isolates workspace changes into temporary Git branches.
- To prevent loss of skills and MCP tools during directory isolation, AgentBridge utilizes NTFS Junctions (Windows) or Symlinks (POSIX) combined with config merging (`~/.codex/config.toml`, `~/.pi/agent/mcp.json`) and shared-resource linking for Claude (skills, commands, agents, plugins, `CLAUDE.md` — `src/core/shared-resources.ts`).

### C. Zero-Accident Git Checkpoints
- Automated snapshots via Git dangling commits / trees (`checkpoint_create`, `checkpoint_rollback`, `checkpoint_list`).
- Invisible to branch history, enabling risk-free autonomous edits and instant rollbacks on test failures.

### D. Centralized Agent Roster & Catalog
- Centralized registry in `src/core/catalog.ts`: `BUILTIN_AGENTS` (`claude`, `codex`, `opencode`, `agy`, `pi`, `cursor`, `grok`, `gemini`, `devin`, `acp`) and `VALID_ACCOUNT_AGENTS`.
- Prevents desynchronization between CLI commands, account management, proxy router, and MCP tools.

### E. Proactive Quotas & Rate-Limit Tracking
- Tracks usage, tokens, and rate limits dynamically per agent.
- Provides `check_quota` MCP tool and `ab quota` CLI command to inspect limits before launching heavy tasks.

### F. Real-time Telemetry & Web Dashboard
- Embedded HTTP web dashboard (`ab ui`) provides live visualization of multi-agent runs, token consumption, execution timelines, and subagent trees.

### G. MCP Timeout Propagation & 60s Cutoff Elimination
- `McpServerConfig.timeout` is fully typed, validated, and propagated across all adapters (Codex, Pi, OpenCode, Antigravity, Claude).
- Installers (`install`, `setup`, `install-ide`) configure standard `"timeout": 300` (seconds) across the registered client configurations (Pi, OpenCode, Claude, Cursor, VS Code, Zed, Windsurf); Codex uses its native `tool_timeout_sec` key instead (legacy `timeout` entries are migrated), completely eliminating the MCP SDK default 60-second execution cutoff.
- `ask_*` and `dispatch_*` tool schemas support both `timeout` and `timeoutSeconds`.

### H. Universal Open Agent Skills & Collision Guard
- Universal canonical skill path is `.agents/skills/agentbridge-delegate/SKILL.md`.
- Shared simultaneously across Pi, Codex, OpenCode, and Antigravity without redundant per-harness installations.
- Skill writes are deduplicated per install process (`writeSkill` writes each destination copy once per run, `src/cli/install.ts`).
- Collision guard: a project/other-scope copy byte-identical to the pre-existing global skill (`~/.agents/skills/agentbridge-delegate/SKILL.md`) is skipped instead of duplicated; `--force` writes it anyway. Writing the global skill itself always writes normally.

---

## 3. Directory Structure
```
src/
├── adapters/       # Agent-specific drivers (claude, codex, codex-daemon, opencode, agy, pi, cursor, grok, gemini, devin, acp, endpoint) + cli-json-lines (shared runner for cursor/grok/gemini/devin)
├── bridge/         # Stdio MCP server exposing tools (ask_*, dispatch_*, checkpoints, quota)
├── cli/            # Command line commands (run, ask, fanout, install, setup, quota, ui)
├── core/           # Catalog, spawn, errors, events, sandboxing, shared resources
├── extras/         # Environment diagnostics (ab doctor: probes every catalog agent + endpoint; a missing CLI is [skip], exit 1 only on real problems or when no agent is usable)
├── quota/          # Rate limits, token counters, quota trackers
├── server/         # OpenAI / Anthropic proxy compatibility server
├── telemetry/      # Usage tracking, context policy, compaction, memory retention, hooks
├── types/          # Strict TypeScript interfaces and schemas
└── ui/             # Web dashboard server and assets
```

---

## 4. Error Handling Contract
All runtime errors must instantiate `AgentError` with normalized codes:
- `NOT_INSTALLED`: Agent binary not found in PATH or environment.
- `NOT_LOGGED_IN`: Agent has not completed authentication.
- `TIMEOUT`: Execution exceeded configured timeout limit.
- `ABORTED`: Execution aborted via `AbortSignal`.
- `BAD_OPTION`: Option unsupported by target agent or invalid argument passed.
- `AGENT_FAILED`: Process crashed or exited with non-zero status.
- `RATE_LIMITED`: Provider quota exhausted or rate-limited (HTTP 429/529, "usage limit", "quota exceeded"), carrying optional `retryAfterMs`; the default trigger of the fallback chain (`src/index.ts`).
