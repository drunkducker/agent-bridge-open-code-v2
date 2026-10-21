# Changelog

## [Unreleased]

### Resource safety
- **Concurrent process cap:** `AGENTBRIDGE_MAX_PROCS` (default 24, `0` = unlimited) limits live agent processes per AgentBridge process. Beyond it, spawns fail with `RATE_LIMITED` (HTTP 429 with `retry-after` in the proxy) instead of exhausting RAM.
- **Orphan cleanup:** background children left in an agent's process group after the CLI exits are now terminated, and the exit handler escalates to SIGKILL synchronously.
- **Proxy scratch directory** is recreated if it was removed while the server runs (previously every API-mode request failed with `cwd does not exist`).
- Proxy startup trims old per-request telemetry records.
- **Agent-mode sandbox limits:** `--agent-max-runs` (default 8, `0` = unlimited) caps live sandboxes (429 `agent_runs_limit` + `retry-after`; runs with unapplied diffs are never evicted), `--agent-run-ttl` replaces the fixed 30 min, applied runs are dropped after ~2 min. Sandbox creation/diff/apply are now async (no event-loop stalls), concurrent requests of one `x-ab-session` share one sandbox, and stale `ab-wt-*` sandboxes (marker + dead pid) and their `git worktree` registrations are cleaned at proxy startup.

### API
- `runAsSubagent` and `mcpConfigFor` are exported from the package root (the documented deep imports were blocked by the `exports` map).

### Documentation
- README rewritten; the proxy is described as a harness proxy and API mode as CLI-executed. New PROXY.md sections on what is written to disk and concurrency limits.
- Corrected REFERENCE.md (default permissions, import paths, links, unfenced CLI block, missing flags, MCP tool parameters, env vars), SECURITY.md credential wording, and the `agentbridge-delegate` skill (agent list, links, transport default).

## [0.5.2] - 2026-10-13

### Documentation & Agent Skill
- Clarified that `edit` permission allows file changes but does not provide shell access. Delegated tasks that must run commands such as builds, tests, or other CLIs require `full` permission, subject to the configured permission ceiling.
- Updated the README and `agentbridge-delegate` skill with the same permission guidance.

## [0.5.1] - 2026-10-13

### Safety & MCP Run Controls
- **Claude root bypass guard:** Reject `--dangerously-skip-permissions` up front when AgentBridge runs as root, with guidance for non-root execution and genuine sandbox use.
- **Unambiguous MCP timeout units:** `timeoutSeconds` is always seconds; the legacy `timeout` alias retains its millisecond heuristic for values of 1000 or more. Schemas and documentation now explain the difference.

### Updates & Documentation
- **Stale skill notices:** npm installs print a reminder when lifecycle output is visible, and interactive CLI use warns when installed `agentbridge-delegate` copies differ from the bundled skill. No agent files or configuration are changed automatically.
- Clarified quota fallback, MCP diagnostics, harness permissions, and skill refresh instructions.

## [0.5.0] - 2026-10-13

### Quota-Aware Routing
- **Measured route thresholds:** Claude, Codex, and Antigravity (`agy`) can be gated by remaining quota, with inclusive thresholds per route and a global default. Unknown or unavailable measurements do not qualify as available quota; unsupported per-route thresholds are rejected before the primary starts.
- **Provider-specific windows:** AGY 1.1.11 or later reports model-family pools with native five-hour and weekly windows. Gemini OAuth measurements are conditional on an unexpired file-based OAuth credential and expose model-specific request buckets; their window duration is unknown, and no fixed five-hour reset is assumed. Keychain-only, expired or absent OAuth, API-key, and Vertex AI credentials do not produce a measurement.
- **Wait for reset:** Quota policies can wait for a reported reset, with a configurable maximum wait. This is an in-process wait, not a durable scheduled job. Quota routing is opt-in; without a quota policy or fallback threshold, fallback remains error-driven and defaults to rate-limit errors. Fallback does not rerun work after tools have run with edit or full permissions.

### Run Control, Safety & Isolation
- **Long-running MCP work:** `dispatch_*` runs can be collected with bounded `wait_run` calls (up to 30 seconds each), inspected with `check_run` for recent event and tool snippets, and managed with `cancel_run`. A wait timeout only ends that wait call; it does not stop the run. Abort and timeout handling now tracks the cause, cleans up processes, and reports progress and tool activity.
- **Explicit high-risk modes:** Codex YOLO and Claude's `dangerouslySkipPermissions` require callers to request `permissions: "full"`; they remain subject to the configured permission ceiling.
- **Execution hardening:** Improved configuration validation, permission enforcement, checkpoints, worktree isolation, execution budgets, session metadata handling, credential separation, proxy image handling, and installer behavior across supported environments.
- **Cross-platform path handling:** Canonicalized home and project detection to avoid memory mixing across Windows 8.3 path aliases, and hardened sandbox link validation for macOS and Windows parent-path aliases without relaxing escape checks. Updated test fixtures for portable POSIX paths and headless mock timeouts on Node 22.

### Provider & CLI Updates
- **Provider protocol corrections:** Updated CLI invocation and response handling for Grok, Cursor, Gemini, and Devin, including stream and run-control behavior.
- **Proxy images:** Image input handling is more robust; supported agents receive validated image data, while unsupported agents receive a placeholder and warning.
- **Documentation:** Clarified quota measurement limits, fallback behavior, and MCP run controls; removed obsolete internal planning and competitor comparison material.

## [0.4.3] - 2026-10-10

### Quota & Credentials
- **Native logins are read:** `check_quota` and `ab account quota` now find the Claude Code (`~/.claude/.credentials.json`) and Codex (`~/.codex/auth.json`) logins, honoring `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. Profile directories are still isolated. (#6)
- **Live usage fields:** Claude's `utilization` and Codex's `rate_limit` windows are parsed, so real accounts no longer show `0%`. Codex requests send `ChatGPT-Account-Id`. (#6)

### Localization
- **English user-facing text:** the `ab setup` usage guide and the README, README_AI, REFERENCE and agent skill docs are now in English. (#7)

## [0.4.2] - 2026-10-09

### CI & Cross-Platform Stability
- **CI Test Guards:** Added runtime presence check (`isInstalled('codex')`) to skip live Codex daemon turn execution on CI runners lacking the `codex` executable.
- **Setup Non-Interactive Resilience:** Handled environments where zero agent CLIs are detected on `PATH` (such as clean CI containers) without triggering unexpected failure exit codes.
- **Windows Path Canonicalization:**
  - Resolved Windows 8.3 short names (`RUNNER~1`) vs long path discrepancies in `createSandbox` and worktree isolation.
  - Normalized drive casing and symlink paths in `findProjectRoot` and `getRepoHash` for bulletproof memory persistence across all platforms.
  - Streamlined per-execution skill write deduplication across harnesses.

## [0.4.1] - 2026-10-09

### MCP Timeout & Universal Open Agent Skills Hardening
- **Fix (MCP Timeout):** Resolved critical issue where AgentBridge discarded the `timeout` configuration of MCP servers, causing subagent executions to be abruptly terminated at the 60-second default limit of MCP SDK clients (Claude Code, Pi, IDEs).
  - Added typed `timeout?: number` to `McpServerConfig` and validation in `validateOptions`.
  - Propagated `timeout` across all adapters: Codex (`-c mcp_servers.<name>.timeout=...`), Pi (`mcp.json`), OpenCode (`opencode.json`), Antigravity (`mcp_config.json`), and Claude.
  - Registered `agentbridge` with `"timeout": 300` across all harness configurations (`install`, `setup`, `install-ide` for Cursor, VS Code, Zed, Windsurf, Claude Desktop).
  - Added support for both `timeout` and `timeoutSeconds` in `ask_*` and `dispatch_*` tool schemas.
- **Fix (Skill Collision):** Resolved skill conflict warnings in Pi (`[Skill conflicts] "agentbridge-delegate" collision: auto (project) vs ~/.agents/skills (skipped)`).
  - Adopted `.agents/skills` as the universal canonical Open Agent Skills standard shared across Pi, Codex, OpenCode, and Antigravity.
  - Smart installer now detects existing global installations (`~/.agents/skills`) and avoids writing redundant duplicates to project folders.
  - Setup and harness installers deduplicate skill writes during execution and prevent cross-directory duplicate copies.

## [0.4.0] - 2026-10-09

### Changes
  - 7d37238 fix(install): prioritize standard json for opencode configs and assert execPath in ide tests
  - b913c42 fix(tooling): complete Phase 7 audit items (A19, A32, A45-A53, A56, A71) - installers, contracts, catalog and release automation
  - befd1b8 fix(phase6): harden storage, configuration, memory and dashboard security (A25, A26, A27, A28, A33, A34, A35, A40, A54, A66, A67)
  - accf2df fix(telemetry): complete Phase 5 telemetry, quotas, context and accounts hardening (A18, A20, A21, A22, A23, A24, A29, A30, A41, A42, A62, A65)
  - e39ccb1 fix(adapters): complete Phase 4 adapters, roster, consensus and schema hardening (A06, A31, A36, A37, A43, A44, A61, A63, A64, A69, A70, A72)
  - b90c58a fix(isolation): complete Phase 3 worktree sandboxes, streaming budgets and return cleanup (A07, A08, A09, A38, A39, A60)
  - 8ed3d4b fix(codex): complete Phase 2 app-server concurrency and stability (A03, A04, A05, A58, A59, A68)
  - 8a338ff fix(security): complete Phase 1 audit remediation (A01, A02, A10-A17, A57)
  - cf50a72 feat(cli): interactive terminal installer with ASCII art, rich probing and quickstart guide


## [0.3.5] - 2026-10-09

### Changes
  - c1ffc41 docs(skill): document app-server dual-mode and expose transport option in CLI & MCP
  - 1c8bcdc feat: shared skills, MCP mirroring and safe passthrough (v0.3.4)
  - 378a2ef feat: MCP passthrough, skills discovery, and host diagnostics (v0.3.3)
  - 2fc3ba4 feat: add check_quota MCP tool and showcase Escalation Ladder (A Escadinha) across docs and README
  - bb24ac5 docs: emphasize Safety Lock (trava de seguranca) concept in skill and documentation


## [0.3.4] - 2026-10-09

### Shared Skills, MCPs and Safer Passthrough

- **Fix:** `skills` and `mcpPassthrough` were missing from the option allowlist, so `skills: true` failed with `BAD_OPTION`. Both are accepted now.
- **Passthrough is operator-controlled:** `AGENTBRIDGE_MCP_PASSTHROUGH` is the ceiling and a call's `mcpPassthrough` can only narrow it (previously a caller could ask for `*`). Project `.mcp.json` is read as a source, only stdio servers are passed, always `exposure: "direct"`, and Codex now receives the server `env`.
- **Account profiles share resources:** `ab account add` links skills, prompts, plugins, hooks and `AGENTS.md` (never credentials or sessions) and mirrors Codex `[mcp_servers.*]` into the new profile, using NTFS junctions on Windows with a copy fallback. `--no-share` opts out. `--purge` unlinks first so real skills are never deleted.
- **Pi skills:** with `skills: true` the per-run home gets the user's `skills/` linked in; cleanup removes the link before deleting the directory.
- **Skill roots:** project `.agents/skills` and `.claude/skills` are resolved up to the git root; `--worktree` sandboxes copy uncommitted ones (kept out of the diff). `ab doctor` lists the roots and the passthrough state.

## [0.3.3] - 2026-10-09

### MCP Passthrough, Skills Discovery & Host Diagnostics

- **Controlled MCP Passthrough for Subagents:**
  - Implemented `getPassthroughMcpServers()` to allow subagents to inherit specific host MCP servers (e.g. `rea`, `playwright`, database tools) rather than running in total isolation.
  - Granular control via `mcpPassthrough` parameter on `ask_*` / `dispatch_*` tool calls, or persistently via `AGENTBRIDGE_MCP_PASSTHROUGH` and `AGENTBRIDGE_MCP_SOURCE_DIR`.
  - Automatic normalization to `"exposure": "direct"` for Pi harness compatibility.
- **Strict Safety & Offline Gates:**
  - External MCP passthrough is **strictly blocked** when `offline: true` is passed, preventing network or data exfiltration in air-gapped runs.
  - Passthrough is locked down under `read-only` and `plan` permission levels to prevent unprivileged subagents from executing mutating tools.
- **Skills Discovery Support in Pi:**
  - Added support for `skills: true` (and `AGENTBRIDGE_ENABLE_SKILLS=1`), selectively disabling the `-ns` (`--no-skills`) flag in Pi so it can discover shared skills from `~/.agents/skills/`.
- **Host MCP Diagnostics in `ab doctor`:**
  - `ab doctor` now scans and reports host MCP servers configured across all installed harnesses (`pi`, `claude`, `codex`, `opencode`, `agy`).
  - Added explicit check and warning explaining the default subagent isolation policy.
- **Updated Delegation Skill & AI Documentation:**
  - Expanded `skills/agentbridge-delegate/SKILL.md`, `README.md`, `README_AI.md`, and `docs/REFERENCE.md` with harness isolation architecture and pre-delegation readiness checklists.

## [0.3.2] - 2026-10-09

### Least Privilege Security Architecture & Standardized Configuration (`ab config`)

- **Separation of Permission Ceiling vs Default Execution:**
  - **Permission Ceiling (`ceiling`):** Defaults to `full`. Agents and callers can request any permission level up to `full` without artificial blockage.
  - **Default Execution Permission (`default`):** Defaults to **`read-only`** for maximum safety. Prevents unintended file modifications or destructive shell execution when invoking agents without explicit flags.
  - **Explicit Elevation:** Callers explicitly pass `permissions: "edit"` or `permissions: "full"` when file creation, modifications, or test execution are desired.
- **Unified Configuration Manager (`ab config`):**
  - Project-level (`.agentbridge/config.json`) and user-level (`~/.agentbridge/config.json`) configuration with full precedence.
  - Subcommands: `ab config list`, `ab config get <key>`, `ab config set <key> <val> [--global]`, `ab config reset [key]`.
  - Environment variable overrides: `AGENTBRIDGE_DEFAULT_PERMS` and `AGENTBRIDGE_PERMS_CEILING`.
- **Standardized Endpoints & Ollama Execution:**
  - Completely eliminated special-casing and hidden flags (`defaultPermissions`) across endpoint adapters.
  - Under `read-only` / `plan` (the default), Ollama and HTTP endpoints execute lightning-fast native chat completions with zero file mutation risk.
  - Under `edit` / `full`, endpoints cleanly route to execution harnesses (Claude Code or Pi) with clear installation and setup instructions.
- **Updated Agent Delegation Skills & Documentation:**
  - Synchronized `skills/agentbridge-delegate/SKILL.md` and `README_AI.md` to guide AI agents to explicitly pass `permissions: "edit"` when implementing code or fixing bugs.

## [0.3.1] - 2026-10-09

### Documentation, Proxy Code Samples & Concurrency Stability

- **Proxy Ready-to-Run Code Examples:** Added comprehensive, production-ready code examples in `docs/PROXY.md`, `README.md`, and `README_AI.md` covering Python (`openai` and `anthropic` SDKs, streaming, LangChain, and Agent Sandbox Mode), TypeScript/Node.js (`openai` and `@anthropic-ai/sdk`), and cURL.
- **AI Agent Integration Reference:** Updated `README_AI.md` with complete MCP checkpoint tools, agent sandbox mode invocation, and practical code snippets for autonomous workflows.
- **Test Suite Concurrency Tuning:** Improved timing assertions in endpoint tests under high concurrency.
- **Synchronized npm Distribution:** Guaranteed identical package parity across GitHub Releases and the official npm registry.

## [0.3.0] - 2026-10-09

### Managed Multiple Accounts, Time-Machine Checkpoints, TDD Auto-Repair & Zero-Remote Telemetry

- **Managed Multiple Accounts & Profiles (`ab account`):**
  - Full directory isolation for accounts (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`, etc.).
  - Interactive multi-login commands: `ab account list [agent]`, `ab account add <agent> <name> [--copy-current] [--login]`, `ab account use <agent> <name>`, `ab account remove <agent> <name> [--purge]`.
  - Zero-friction integration with `--account <name>` on CLI runs and automatic conversion to rotating pools for `ab serve --accept-tos-risk`.
  - Proactive per-account quota inspection via `ab account quota [agent]`.
- **Git Hidden-Ref Checkpoint Engine & Visual Time Machine:**
  - Non-destructive workspaces snapshots stored under `refs/agentbridge/checkpoints/` using an isolated `GIT_INDEX_FILE`.
  - Visual Time Machine tab integrated into `ab ui` (`http://127.0.0.1:8788`) with split diff viewing and instant one-click rollback.
  - MCP Bridge tools exposed for AI agents: `checkpoint_create`, `checkpoint_list`, `checkpoint_diff`, `checkpoint_rollback`.
- **TDD Auto-Repair Loop (`ab fix`):**
  - Autonomous test-driven repair loop with bounded stdout/stderr capture.
  - Automated pre-execution checkpointing and safe rollback on persistent failure.
- **Multi-Agent Review Loop & Consensus (`ab review`, `ab ensemble`):**
  - Implementer-reviewer feedback cycles with structured JSON/Markdown verdicts and git diff inspection under `read-only` ceiling.
  - Parallel multi-agent ensemble runs with plurality consensus voting and optional synthesizer judge.
- **DAG Pipeline Task Orchestrator (`ab pipeline`):**
  - Directed Acyclic Graph runner with topological wave execution, concurrency limits, and wave checkpoints.
- **Zero-Friction MCP Installers (`ab install <ide>`):**
  - Instant zero-dependency setup for Cursor, VS Code, Zed, Windsurf, Claude Desktop, Claude Code, Codex, Pi, OpenCode, and Antigravity.
- **Shared Project Memory (`ab memory`):**
  - Machine-readable persistent repository conventions and decisions in `.agentbridge/memory.json`.
- **Proactive Quota Probing (`ab quota`):**
  - Proactive querying of Anthropic OAuth 5-hour/7-day windows and ChatGPT Wham usage limits, auto-throttling credentials at $\ge 95\%$ before encountering HTTP 429 penalties.
- **CommonMark Boundary-Aware Streaming:**
  - Throttled Markdown stream filter ensuring UI/WebSocket streams split only on clean Markdown boundaries (closing code fences, list items, blank lines).
- **Subagent Native Roster:**
  - Complete hierarchical parent-child subagent tree tracking with token usage aggregation and status transitions.
- **Audited 100% Local Privacy Guarantee:**
  - Verified and documented zero remote analytics/tracking policy: all run logs, token counts, and metrics remain on-device in `~/.agentbridge/`.

## [0.2.0] - 2026-10-09

### Smart Model Resolution, Real-Time Active Agent Tracking & Agent Autonomy

- **Smart Model Resolver (`resolvePiModel` & endpoint auto-mapping):** Seamlessly normalizes model names between bare format (`glm-5.3-flash:cloud`) and provider-namespaced format (`ollama/glm-5.3-flash:cloud`) for Pi, Ollama, and custom endpoints. No more 5-minute timeouts on subagent/agent calls.
- **Active Agent Monitoring in Web UI (`ab ui`):**
  - Live header indicator displaying active processes and unique agents (`● X active across Y agents`).
  - Dedicated "Active Agents" KPI card breaking down real-time active runs per agent (e.g. `ollama (2) · pi (1)`).
  - New "Active" status filter tab in the Recent Runs table.
  - Inline error diagnostics directly under badges for failed runs (e.g. `timeout (5m)`, `lost (process exited)`).
  - Subagent count and lineage inspection in the run details drawer.
- **Full Autonomy by Default (`permissions: 'full'`):** Default permissions ceiling across `ab install`, `ab setup`, MCP server bridge, and proxy sandbox updated to `full` so agents and subagents can run tools, shell commands, and builds without being rejected by an arbitrary ceiling.
- **Proxy Bare Model Routing (`ab serve`):** The OpenAI/Anthropic-compatible proxy server now automatically detects and routes bare Ollama model names (like `glm-5.3-flash:cloud`) directly to the Ollama runner.
- **Agent Skill & Onboarding Documentation:**
  - Updated `agentbridge-delegate` skill with smart model resolution and subagent delegation guidance.
  - Added `README_AI.md` / `AGENTS.md` specifying architecture, commands, and workflows for autonomous coding agents.

## [0.1.0] - 2026-10-08

### First Official Public Release of AgentBridge (`ab`)

- **Interactive Terminal Setup Wizard:** Modern ANSI setup wizard (`ab setup` / `ab wizard`) with automatic environment detection for Claude Code, Codex, OpenCode, Pi, Antigravity, and Ollama.
- **TypeScript Migration:** 100% strict TypeScript (`.ts`) architecture with zero external runtime dependencies (`"dependencies": {}`). All source compiled and packaged in `dist/`.
- **Unified Multi-Agent Interface:** Seamlessly drive `claude`, `codex`, `opencode`, `agy`, `pi`, `cursor`, `grok`, `gemini`, `devin`, and Agent Client Protocol (`acp`) using existing local authentications.
- **Endpoint Coding Harnesses (`--harness auto|claude|pi|none`):** Drive HTTP endpoints (local Ollama, OpenRouter, vLLM) via Claude Code or Pi harnesses to execute workspace edits, tool calls, and tests.
- **Git Hidden-Ref Checkpoints:** Zero-risk snapshots stored in isolated `refs/agentbridge/checkpoints/<session>/<id>` without branch pollution (`ab checkpoint create|list|diff|rollback`).
- **Proactive Quota Probing & Pool Cooldown:** Real-time quota polling for Anthropic and Codex usage limits with automatic pool cooldown and rotation.
- **Subagent Hierarchy Roster:** Parent-child delegation tracking with interactive lineage tree visualization in `ab ui`.
- **Dual-Mode Codex Execution:** Persistent JSON-RPC 2.0 stdio server mode (`codex app-server`) alongside batch CLI execution (`codex exec`).
- **MCP Bridge Server:** Any agent can delegate tasks to any other agent (`ask_claude`, `ask_codex`, `ask_opencode`, `ask_agy`, `ask_pi`, `ask_ollama`) with recursion depth guard, permission ceiling, and HMAC attestation.
- **Automatic Fallback on Rate Limits:** `RATE_LIMITED` error detection with automatic fallback chains across agents.
- **Local Proxy Server:** OpenAI- and Anthropic-compatible local proxy (`ab serve`) with streaming, tool calling, and account rotation.
- **Telemetry & Context Policies:** Context window tracking (`ab context`), real-time terminal monitor (`ab top`), and auto-compaction policies (`autoCompact`) with cross-agent handoffs (`ab handoff`).
- **Visual Web Dashboard:** Live read-only dashboard (`ab ui`) on `http://127.0.0.1:8788`.
