---
name: agentbridge-delegate
description: Delegate work to other coding agents (Codex, OpenCode, Antigravity/agy, pi, Ollama endpoints) through the AgentBridge MCP tools (mcp__agentbridge__ask_*, dispatch_*). Use when the user asks for a second opinion, to run something on another agent or model, to run agents in parallel, or when a task should go to a cheaper/different model.
---

# Delegating with AgentBridge

The MCP server `agentbridge` exposes other coding agents as tools. Each runs as a separate process with its own login; you get back its final text, session id and token usage.

## Tools

- `ask_<agent>`: run and wait. Agents: `codex`, `opencode`, `agy`, `pi`, plus any endpoint added with `ab endpoint add` (e.g. `ask_ollama`, custom OpenAI/Anthropic/OpenRouter endpoints).
- `dispatch_<agent>`: start asynchronously, returns a run id at once. Then `wait_run` (blocks, with `timeoutSeconds`), `check_run` (status, last events, tokens), `cancel_run`, `list_runs`.
- `send_message` / `check_messages`: inbox for a run id or agent name (no live injection into a running agent).
- **Git Checkpoint Tools (Fail-safe Workspace Snapshots):**
  - `checkpoint_create(message, cwd?)`: creates an instant non-destructive hidden-ref git snapshot (`refs/agentbridge/checkpoints/...`). Use **before** delegating risky code modifications.
  - `checkpoint_list(cwd?)`: lists recent workspace checkpoints with id, timestamp, message, and session id.
  - `checkpoint_diff(id, cwd?)`: returns unified git diff between current workspace and the checkpoint.
  - `checkpoint_rollback(id, cwd?)`: safely restores workspace to the checkpoint, recovering modified files and pruning untracked files created since the snapshot.

## When to use which

- **Short, bounded task (expected to finish within 30 seconds):** `ask_<agent>`.
- **Long task, or several in parallel:** `dispatch_<agent>` for each, keep working, then `wait_run` on every id. Use an `idempotencyKey` so a retry does not start a duplicate.
- **Risky refactor or complex changes:** First call `checkpoint_create(message="Before refactor")`, run the delegation with `ask_*` or `dispatch_*`, verify tests, and if broken, call `checkpoint_rollback(id)`.
- **Second opinion or review:** ask a *different* agent than the one that wrote the code; give it the file paths and the question, not your conclusion.
- **Cheap bulk work (summaries, searches, boilerplate):** pick a cheap model/agent; reserve strong models for hard problems.

## Writing the delegated prompt

The other agent has none of your context. Give it: the goal, the exact files/paths, constraints, and the form the answer should take. Set `cwd` to the project folder. Ask it to be concise.

## The Safety Lock: How Edits are Blocked vs Allowed

AgentBridge is engineered with a **Zero-Accident Safety Lock**:
- **Why it exists:** Unrestricted subagent execution is dangerous. An autonomous agent asked to "audit this function" or "check tests" could hallucinate and overwrite source code or execute destructive bash commands.
- **Default Request (`read-only`):** Delegations default to requesting read-only behavior. The enforcement mechanism depends on the destination harness; some use native sandboxes/tool filters, while other CLI adapters may rely on prompt guidance or provider defaults.
- **Intentional Unlocking:** When you *want* the agent to write code, refactor, or run tests, you must explicitly unlock it by passing `permissions: "edit"` or `permissions: "full"`.
- **The Inviolable Ceiling:** The Permission Ceiling defaults to `full` (so you can request whatever powers you need), but if you or the user configure a stricter ceiling (e.g. `ab config set permissions-ceiling edit`), AgentBridge acts as an unbypassable circuit-breaker: subagents cannot escalate privileges beyond that ceiling under any circumstances.
- **Configurability:** You can customize persistent defaults per project or globally via `ab config set default-permissions <level>`.

> ⚠️ **DELEGATION INSTRUCTION:** When you delegate a task that requires creating or modifying files or refactoring code, explicitly request `permissions: "edit"`. If the agent must **run commands** (build, tests, CLIs such as `rea`), request `permissions: "full"`: `edit` has no shell, so every Bash call fails with "requires approval" in the non-interactive run, and `extraArgs` cannot add `--allowedTools` under `edit`. Without it, AgentBridge requests `read-only`; provider-specific limitations mean that this request is not a universal OS-level guarantee.

| Permission | Filesystem & Tools Allowed | When to Use | Under the Hood Enforcement |
|---|---|---|---|
| `full` | Requests the provider's full tool and execution mode, including shell where supported. | Code edits, test runs, builds, package installs, automated fixes. | Uses each provider's native full-access control where available; not every provider supplies an OS sandbox. |
| `edit` | Requests file edits, with arbitrary shell disabled where supported. | Refactoring, bug fixes, file creation & code edits. | Provider-native tool/sandbox controls; varies by harness. |
| `plan` | Requests planning without edits. | Solution design, checklist proposals, diff reviews. | Provider-native plan mode, tool filters, or prompt guidance. |
| `read-only` *(default)* | Requests read-only behavior. | Reviews, code audits, questions, file inspection. | Provider-native sandbox, tool filters, deny rules, or prompt guidance. |

> **How AgentBridge Prevents Edits:**
> **Provider-specific enforcement:** Claude Code and Pi receive restricted tool lists; Codex uses its sandbox modes; Antigravity uses a throwaway profile with deny rules; Cursor uses its native ask/plan modes when applicable. Other generic CLI adapters may rely on prompt guidance or provider defaults. These controls do not guarantee that provider configuration, hooks, MCP servers, or subprocesses cannot cause side effects. See [Harness validation](../../docs/HARNESS_VALIDATION.md).

## Options that matter

- `permissions`: `read-only` (safe default), `edit`, `plan`, `full`. Use `edit` or `full` whenever files need to be modified.
- `harness`: `auto` (default), `claude`, `pi`, `none`.
  - For endpoints like Ollama or OpenRouter:
    - If `permissions` is `edit` or `full`, AgentBridge **automatically** drives the endpoint via a coding harness (`claude` or `pi`) so the model has tools to modify files.
    - If you want the model to **read files or search the web** without editing, pass `harness: "claude"` (or `harness: "pi"`) with `permissions: "read-only"`.
    - If you only want a quick text answer without filesystem access, omit `harness` under `read-only` (or set `harness: "none"`), and it runs as a fast direct HTTP API call.
- `model`: default is the cheapest model for that agent; set it only when asked or when the task needs more. Model names are **smart-resolved**: you can specify models with or without provider prefixes (e.g. `glm-5.3-flash:cloud` or `ollama/glm-5.3-flash:cloud`). AgentBridge automatically handles provider namespaces for Pi, Ollama, and other endpoints.
- `effort`: `low` ... `max`.
- `timeoutSeconds`: task lifetime limit in **seconds**, always (default 300; `2400` = 40 min). Prefer it over `timeout`. The legacy alias `timeout` reads values at least 1000 as milliseconds (`timeout: 2400` = 2.4 s), so do not use it for long runs.
- `session`: `{mode:'continue', id}` to follow up in the same agent conversation (`new`, `ephemeral`, `continue`, `fork`).
- `fallback`: e.g. `["codex@15","ollama:glm-5.3-flash:cloud"]` or `{ agent: "codex", minRemainingPercent: 15, model }`. A route threshold overrides the primary quota threshold; CLI syntax puts `@N` before the first colon, as in `codex@15:model`. If a route override is present without a global quota setting, CLI enables the default 20% primary threshold. Do not assign a threshold to unmetered Ollama. If the agent fails with `RATE_LIMITED` (or a code listed in `fallbackOn`), the next one answers. It is skipped if the first agent already ran tools under `edit`/`full`, to avoid redoing side effects. The result's `fallback` field says who answered and whether context was lost (fallback agents start a fresh session).
- `transport`: `auto` (default), `cli`, `app-server`.
  - Pass `transport: "app-server"` for **Codex** to run via a persistent JSON-RPC 2.0 daemon instead of batch process spawns.
- `quotaPolicy`: `{ minRemainingPercent, waitForReset?, maxWaitMs? }` gates an ordered route on measured remaining quota. Unknown measurements do not pass the threshold; quota waiting is separate from execution timeout.
- Codex `yolo: true` (CLI `--yolo`) requests Codex's native bypass mode and requires explicit `permissions: "full"`; it does not raise the operator permission ceiling.
- Claude `permissions: "full"` maps to `bypassPermissions` and does **not** add `--dangerously-skip-permissions` on its own (that flag is opt-in via `dangerouslySkipPermissions`). `dangerouslySkipPermissions: true` (CLI: `--dangerously-skip-permissions`) explicitly adds Claude's literal flag and requires full permissions; it does not raise the configured ceiling. Claude itself refuses that flag when the process runs as root/sudo (e.g. WSL as root, Docker), so AgentBridge rejects it up front with `BAD_OPTION`. Omit the flag (`full` alone already bypasses prompts), run as a non-root user, or set `IS_SANDBOX=1` only inside a real sandbox.
- OpenCode `full` uses its native `allow` permission configuration and approves permission requests once; Antigravity (`agy`) `full` requests its native `--dangerously-skip-permissions` mode.
- Cursor `full` uses `--force`; `read-only` and `plan` use Cursor's native `ask` and `plan` modes. Gemini `full` uses `--yolo`. Grok `full` requests `--permission-mode bypassPermissions`. Devin uses `--permission-mode dangerous` for `full` and `normal` otherwise; its lower modes are not an OS isolation boundary.
- Pi applies its tool filter for restricted modes and has no dedicated native YOLO flag. `--yolo` is a Codex-only AgentBridge option; it is not a generic cross-harness flag.
- Generic adapter permission modes can be advisory. Do not assume `read-only`/`plan` prevent provider hooks, MCP configuration, or subprocesses from causing side effects. See [Harness validation](../../docs/HARNESS_VALIDATION.md) for the documented scope and checks.

## MCP results, waits, and timeouts

MCP calls return a result object, commonly `{ content: [{ type: "text", text: "..." }], structuredContent?, isError? }`; do not assume a tool result is a string. Normalize strings directly or collect only `content` text blocks that do not start with `[agentbridge] `, then join their text with newlines. Use `structuredContent` when present; some clients omit it, so parse JSON from normalized text as a fallback. Treat `isError: true` as failure.

Use `ask_<agent>` for a short, bounded task. For work that may exceed 30 seconds, use `dispatch_<agent>`, then poll `wait_run(id, timeoutSeconds: 30)` until state is `done`, `error`, `lost`, or `cancelled`. A wait call is capped at 30 seconds; larger requested values are capped and reported by `requestedTimeoutSeconds`, `waitTimeoutSeconds`, and `waitCapped`. A timeout from `wait_run` means the run is still active; continue waiting or inspect it with `check_run`. If a call errors or returns no useful run id/state, report the failure.

Keep the CLI or MCP server process alive while a run is quota-waiting. Run status supports observation; it is not a durable scheduler and a waiting run does not resume after its bridge process restarts.

The task timeout (`timeoutSeconds` on ask/dispatch) controls how long the delegated run may execute; for example, `timeoutSeconds: 600`, always in seconds (only the legacy `timeout` alias reads values at least 1000 as milliseconds). The MCP client's transport deadline is client- and configuration-specific; installers commonly configure 300 seconds, but there is no universal 60- or 300-second limit. A synchronous call cannot outlast a fixed client deadline, and server-side streaming/progress cannot guarantee extending it. Dispatch plus bounded waits lets the caller resume polling while the run continues. Synchronous request cancellation retains code `ABORTED` with detail cause `REQUEST_CANCELLED`; a waiter may report `REQUEST_CANCELLED`.

For usage events, `incremental: true` means add the event as a delta; absent or false means replace with the current snapshot. `Result.usage` aggregates the final attempt. Budget tracking also retains usage from earlier fallback attempts. Codex child MCP server deadlines use native `tool_timeout_sec`; temporary HTTP bridges injected for Codex use 300 seconds.

`subdelegation: false` on `ask_*` or `dispatch_*` instructs the child not to spawn further AgentBridge runs and enforces that restriction for bridge spawning; monitoring tools remain available. It is optional and defaults to `true` for backward compatibility.

## Universal Skills (`.agents/skills`) & Zero Collision Guarantee

The modern AI ecosystem (Pi, Codex, OpenCode, Antigravity, and recent Claude Code) adheres to the **Open Agent Skills standard** rooted in `.agents/skills/`.

- **One Install Covers All Harnesses:** When you install the `agentbridge-delegate` skill into `.agents/skills/`, Pi, Codex, OpenCode, and Antigravity **automatically share and discover it simultaneously**. You do not need to install duplicate copies for each harness.
- **Preventing Collision Warnings (`[Skill conflicts] collision`):**
  - Previously, running setup or installers could create conflicting copies in both `.agents/skills` and `.claude/skills`, or in both project `<cwd>/.agents/skills` and user `~/.agents/skills`, prompting Pi to log:
    ```
    [Skill conflicts] "agentbridge-delegate" collision: auto (project) vs ~/.agents/skills (skipped)
    ```
  - AgentBridge's smart installer now checks for existing global installations:
    - If the skill is already installed globally (`~/.agents/skills`), it safely skips creating an identical local duplicate in your project to prevent collision alerts.
    - If installing specifically under `--scope project`, the project copy is placed cleanly in `.agents/skills/` once, without generating redundant legacy duplicates in `.claude/skills/`.
    - Passing `--force` allows explicitly overriding this behavior when an isolated project modification is needed.

## Execution Transports: CLI vs App-Server Mode

AgentBridge supports **Dual-Mode Execution** for OpenAI Codex:

1. **Batch CLI Mode (`transport: "cli"`, default):**
   - Each call spawns a one-off `codex exec` process.
   - Clean, fully isolated, and requires no daemon state.
   - Ideal for independent, single-turn tasks or when process teardown between runs is desired.

2. **Persistent Daemon Mode (`transport: "app-server"`):**
   - Spawns `codex app-server` once and communicates via JSON-RPC 2.0 frames over bidirectional stdio.
   - **What You Gain:**
     - **Zero Cold-Start:** The process stays warm in memory. Eliminates 2-5 seconds of process startup and auth bootstrapping on subsequent turns.
     - **Live Interactive Approval:** Codex proactively asks via RPC before mutating files or executing shell commands (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`). AgentBridge evaluates permissions programmatically (`read-only` denies immediately; `edit`/`full` approves) without ever blocking on an interactive terminal prompt.
     - **Structured Streaming:** Token-by-token deltas and granular tool lifecycle notifications without terminal scraping or ANSI parsing fragility.
     - **Clean Cancellation:** Turns can be aborted cleanly via `turn/cancel` notifications without `SIGKILL` or corrupting half-written files.
     - **Stateful Thread Continuity:** Native thread and turn tracking across multiple conversational steps.

AgentBridge combines **Resource Linking (Junctions)** for skills with **Config Mirroring (`config.toml` / `.mcp.json`)** for MCP servers. This keeps skills and MCPs available in both Codex execution modes (`cli` and `app-server`), as well as across Pi, Claude Code, OpenCode, and Antigravity.

## Delegating to Subagents

When you instruct an agent (such as `pi` or `claude`) to spawn or coordinate subagents:
- The permission ceiling defaults to `full`, meaning subagents can run tools, shell commands, and file edits without being capped at read-only/edit.
- Model names specified for subagents (e.g. `glm-5.3-flash:cloud`) are automatically resolved so the child process maps them to the correct local or remote provider seamlessly.
- You can monitor running subagents and active agent counts in real time via `ab ui`.

## Harness Isolation: MCPs, Skills & Tool Availability

When delegating tasks via `ask_*` or `dispatch_*`, AgentBridge enforces **deterministic process isolation** for safety and stability:

- **The Isolation Mechanism:**
  - **Pi (`pi`):** Runs inside an ephemeral directory (`PI_CODING_AGENT_DIR`), stripping extensions/skills (`-ns -np -ne`) and replacing `mcp.json` with only the `agentbridge` connection. Any MCP server configured in `~/.pi/agent/mcp.json` (such as `rea`) is **hidden by default**.
  - **Claude Code (`claude`):** Invocations pass `--strict-mcp-config --mcp-config <temp>/mcp.json` and `--setting-sources ""`. Workspace `.mcp.json` and user `~/.claude.json` MCPs are **omitted by default**.
  - **Antigravity (`agy`):** Invocations use a disposable profile directory with `.gemini/config/mcp_config.json` restricted strictly to `mcp(agentbridge/*)`.
  - **OpenCode (`opencode`) & Codex (`codex`):** Configurations injected by bridge take precedence, and sandboxes (`read-only`, `plan`) block unauthorized system commands.

- **How to Control MCP & Skills Passthrough:**
  1. **The operator decides what is allowed (the ceiling).** Set it where the AgentBridge bridge is registered (`env` of the `agentbridge` MCP entry):
     - `AGENTBRIDGE_MCP_PASSTHROUGH=rea` (comma list such as `rea,playwright`, or `*` for every stdio server found). Unset means no passthrough at all.
     - `AGENTBRIDGE_MCP_SOURCE_DIR=/path` (dir holding the source `mcp.json`; default `~/.pi/agent`). The project's `.mcp.json` (nearest, up to the git root) is read too.
     - `AGENTBRIDGE_ENABLE_SKILLS=1` turns skills on for every Pi child.
  2. **The caller can only narrow it, per call (`ask_*` / `dispatch_*`):**
     ```json
     { "tool": "ask_pi", "arguments": { "prompt": "Analyze the binary", "permissions": "edit", "mcpPassthrough": ["rea"], "skills": true } }
     ```
     `mcpPassthrough` selects a subset of the operator allowlist (asking for something outside it, or `"*"`, never widens it). `skills: true` makes Pi discover your skills for that run.
  3. **Only stdio servers are passed** (entries with a `command`), always with `"exposure": "direct"` (a `deferred` server never shows its tools to the model). Works for Pi, Claude, OpenCode, Antigravity and Codex (env included).
  4. **Gates that cannot be overridden:**
     - `offline: true` blocks all passthrough.
     - `read-only` / `plan` get no passthrough; use `permissions: "edit"` or `"full"`.
  5. **Skills:** Pi's per-run home is empty, so with `skills: true` the bridge links your `~/.pi/agent/skills` into it (a junction on Windows, removed safely afterwards) and Pi also reads `~/.agents/skills` and the project's `.agents/skills` / `.claude/skills` up to the git root.
  6. **Worktrees (`--worktree`):** project skill folders that are not committed (`.agents/skills`, `.claude/skills`) are copied into the sandbox and kept out of the diff.
  7. **Accounts (`ab account add <agent> <name>`):** new profiles keep their own login and sessions but share your skills, prompts, plugins and, for Codex, your `[mcp_servers.*]` (via junction/symlink, copy as fallback). `--no-share` starts empty; `--copy-current` copies everything including the login.

- **Pre-Delegation Checklist (Verifying MCP & Tool Readiness):**
  - **Verify with `ab doctor`:** Run `ab doctor` to inspect which host MCPs are detected for each installed harness (`claude`, `codex`, `pi`, `opencode`, `agy`).
  - **Probe Tool Readiness:** If unsure whether a subagent can reach a specific tool, send a lightweight diagnostic probe first:
    `ask_pi({ "prompt": "List all your available tools.", "permissions": "read-only" })`
  - **Direct Host Execution:** If a task strictly requires an MCP server that is only present in your primary agent session and cannot be passed through, execute that task directly in the host agent rather than delegating to an isolated subagent.

- **Strict Security Guarantees & Sandboxes:**
  - **Default Permissions & Operator Ceiling:** By default, subagents run under `read-only`. The ceiling (`AGENTBRIDGE_PERMS_CEILING`) can never be widened by `extraArgs` or client options.
  - **Proxy Mode Tool Disablement:** Plain text API proxying automatically enforces `permissions: 'read-only'` and verifiably turns off tools (`--tools ""` for Claude, `--sandbox read-only` for Codex, `-ne -np -ns` for Pi).
  - **Time Machine (Checkpoints) Guard:** `checkpoint_rollback` is strictly forbidden under `read-only` or `plan` permissions and omitted from MCP tools under restricted ceilings. Workspaces are strictly confined to `AGENTBRIDGE_ROOT`. Rollback automatically purges both untracked and post-checkpoint staged files.
  - **Image Proxy SSRF & DNS Rebinding Protection:** Image fetching inspects both IPv4 and IPv6 representations (including mapped hex variants) and resolves hostnames to verified public IPs before connecting.
  - **Dashboard CSRF Protection:** The UI dashboard (`ab ui`) blocks cross-origin POST mutations via strict Origin and `Sec-Fetch-Site` verification.
  - **Worktree Baseline & Untracked Files Sync:** `createSandbox` faithfully replicates local untracked files (such as `.agentbridge/config.json`) into the sandbox baseline and aborts immediately if working tree dirty state application fails, preventing runs on incomplete bases.
  - **Strict `agentRoot` Patch Confinement:** Applying changes (`POST /agent/runs/:id/apply`) validates every modified file against `agentRoot` and origin, rejecting any file escapes or header path traversal (`..`) with `403 Forbidden`.
  - **Concurrent-Safe Sandbox Diffs & Cleanup:** Inspecting active sandbox diffs uses an isolated Git index (`GIT_INDEX_FILE`), avoiding clobbering in-flight agent staging. Sandbox deletion during active runs is rejected with `409 Conflict`.
  - **Streaming Isolation & Budget Enforcement:** `--stream` now fully routes through the worktree sandbox when `--worktree` is specified and enforces real-time aborts via `Budget` limits (`--max-cost`, `--max-tokens`, `--max-time`).
  - **Clean Generator Cleanup Propagation:** Early breaks in async streams propagate `.return()` to inner agent adapters, ensuring subprocesses terminate cleanly.
  - **AutoRepair Memory Bounding:** Test output capture in the AutoRepair loop uses a circular buffer with tail preservation and memory limits, avoiding RAM exhaustion on verbose test suites.

- **Codex App-Server Concurrency & Stability:**
  - **Sequential Turn Serialization:** When multiple concurrent requests target the same Codex daemon, turns are strictly serialized with FIFO ordering to prevent `activeTurn` state collisions and ensure approvals and stream deltas correlate accurately.
  - **Account & Environment Pool Keying:** Codex daemon instances are keyed by workspace path, `CODEX_HOME`, account identity, and API key, preventing cross-profile credential reuse.
  - **Strict RPC Deadlines & Clean Cancellation:** Handshake (`initialize`) and all RPCs enforce deadlines and respect `AbortSignal` without unhandled Promise rejections. Failed turn statuses (`status: failed` or error descriptors) are explicitly caught and propagated as `AGENT_FAILED`.


## Quota checks and fallback

AgentBridge has proactive remaining-percentage readers for Claude Code, Codex, Antigravity (`agy`), and conditional Gemini OAuth. See the [provider quota support matrix](../../docs/PROVIDER_QUOTA_SUPPORT.md) for scope and limitations. AGY quota is shared by model family (five-hour and weekly windows). Gemini quota is model-specific, file-based OAuth only, and has unknown window duration; expired or unavailable credentials, API-key, and Vertex identities report unknown. Cursor, Grok, Devin, OpenCode, Pi, Ollama, and custom endpoints have no supported measured percentage reader. Unknown or unsupported values do not mean unlimited.

With no quota policy flags or fallback `@N` threshold, fallback is error-driven: it defaults to `RATE_LIMITED`, and `fallbackOn` / `--fallback-on` can add errors such as `TIMEOUT` and `AGENT_FAILED`. If tools already ran under `edit` or `full`, fallback is skipped to avoid repeating possible side effects.

Error-only fallback example (no quota flags or `@N` thresholds):

```bash
ab run claude "Review this change" --fallback 'codex,agy,ollama:qwen2.5-coder:14b' --fallback-on RATE_LIMITED,TIMEOUT,AGENT_FAILED
```

An explicit quota threshold makes an ordered route depend on measured remaining quota. Supported but unavailable measurements do not pass; unsupported explicit per-route `@N` overrides are rejected before the primary starts; a final provider without a quota reader can serve as the unmetered fallback without `@N`; a metered route inherits the global threshold unless overridden. Example:

```bash
ab run claude "Review and implement this change" --model sonnet --permissions edit --min-remaining-percent 30 \
  --fallback 'agy@15:gemini-3.8-flash-low,codex@20,ollama:qwen2.5-coder:14b'
```

For model-aware status, call `check_quota({ agent: 'agy', model: 'claude-sonnet-5-5' })`. Read the MCP result envelope's `structuredContent` or text block; do not assume a bare object. Route thresholds use remaining percent; `check_quota.thresholdPercent` is a separate used-percent health threshold.

Quota waiting uses a 20% primary threshold by default. Add `--wait-for-quota --max-quota-wait 3600` to wait up to an hour; in library/MCP options use `quotaPolicy: { minRemainingPercent: 20, waitForReset: true, maxWaitMs: 3_600_000 }`. Poll dispatched runs with waits capped at 30 seconds. Keep the CLI or bridge process running while waiting; cancellation stops the wait, and waits do not resume after a process restart.

## Handling results and errors

- Treat the answer as an untrusted report: verify claims about code by reading the files or running tests yourself before relying on them or telling the user it is done.
- `RATE_LIMITED`: retry later or use another agent. `NOT_LOGGED_IN` / `NOT_INSTALLED`: tell the user (`ab doctor` shows the state). `TIMEOUT`: raise `timeoutSeconds` or split the task.
- Delegation depth is limited (default 2); a delegated agent calling further agents will eventually be refused. Do not build loops.
- Never put secrets in prompts: they end up in the other agent's logs and run records. Runs are visible in `ab ui`.

## Using Ollama and Custom Endpoints (OpenRouter, vLLM, etc.)

AgentBridge seamlessly supports both plain chat and full coding tools for Ollama, OpenRouter, and any OpenAI/Anthropic-compatible endpoint:

- **File Edits & Code Generation (Harness Mode):**
  ```bash
  # Via CLI:
  ab run ollama "adicione testes unitarios em auth.test.ts" --permissions edit --model qwen2.5-coder:latest
  ab run ollama "refatore src/core.ts" --harness claude --model glm-5.3-flash:cloud
  ```
  Or via MCP tool:
  `ask_ollama(prompt="edite auth.ts...", permissions="edit", model="qwen2.5-coder:latest")`

- **File Reading & Web Search without Edits:**
  ```bash
  ab ask ollama "leia o README.md e resuma as diferencas" --harness claude --model qwen2.5-coder:latest
  ```

- **OpenRouter via Harness (Tools, Web Search & File Edits):**
  ```bash
  # Using Claude Code harness with OpenRouter models:
  ab run openrouter "refatore src/auth.ts e crie testes" --permissions edit --harness claude --model anthropic/claude-sonnet-5.5
  ab ask openrouter "inspecione os logs e pesquise na web" --harness claude --model deepseek/deepseek-r1
  ```
  Or via MCP tool:
  `ask_openrouter(prompt="refatore auth.ts...", permissions="edit", model="anthropic/claude-sonnet-5.5")`

- **Fast Plain Chat (Direct API):**
  ```bash
  ab ask ollama "o que e injecao de dependencia?" --model llama3.2
  ab ask openrouter "resuma os principios SOLID" --model meta-llama/llama-3.3-70b-instruct
  ```

## Advanced CLI Workflows for Autonomous Agents

If you have shell execution access, you can run high-level orchestration workflows directly:

- **TDD Auto-Repair Loop (`ab fix`):**
  Runs tests, catches errors in bounded buffers, prompts the agent with edit permissions, and rolls back if failing:
  ```bash
  ab fix claude "npm test" --prompt "Fix token renewal" --max-attempts 3
  ```
- **Multi-Agent Review & Consensus (`ab review`, `ab ensemble`):**
  Implementer codes, reviewer inspects git diff under read-only permissions with structured verdicts:
  ```bash
  ab review codex claude "Implement rate limiter" --max-turns 3
  ab ensemble "Analyze database deadlock" claude codex agy --judge claude
  ```
- **DAG Pipeline Orchestration (`ab pipeline`):**
  Executes topological dependency graphs of multi-agent tasks with checkpoints:
  ```bash
  ab pipeline pipeline.json --checkpoint-each
  ```
- **Shared Project Memory (`ab memory`):**
  Stores and injects repository rules and past decisions:
  ```bash
  ab memory add "Enforce strict TypeScript and zero dependencies"
  ab memory decision "auth" "Use JWT with HMAC-SHA256" --agent claude
  ab memory list
  ```
- **Multiple Accounts Management (`ab account`):**
  Per-profile directory isolation, multi-login, and proactive quota:
  ```bash
  ab account list [agent]
  ab account add claude work --copy-current
  ab account use claude work
  ab account quota claude
  ```
- **Live Visual Time Machine & Dashboard (`ab ui`):**
  Explore runs, tokens, cost, subagent trees, and time-machine checkpoints at `http://127.0.0.1:8788`.

## Provider & Adapter Safety Guarantees (Phase 4 Hardening)

- **Harness-specific permission requests:** AgentBridge applies provider-native flags, modes, tool filters, or prompt guardrails as available. A `read-only` or `plan` request on a generic CLI adapter is not necessarily an OS-level sandbox and does not guarantee that provider configuration, hooks, MCP servers, or subprocesses cannot cause side effects. See [Harness validation](../../docs/HARNESS_VALIDATION.md) for provider-specific behavior and verification scope.
- **Unsupported options:** Adapter-specific unsupported parameters (such as session fork for ephemeral endpoints or images for text-only drivers) are rejected with `AgentError('BAD_OPTION')` where implemented. See [Harness validation](../../docs/HARNESS_VALIDATION.md) for provider-specific compatibility notes.
- **Abort & Timeout Propagation:**
  All adapters check child-process timeout (`r.timedOut`) and abort cancellation (`r.aborted`) after waiting, cleanly raising `TIMEOUT` and `ABORTED` with partial output preserved for telemetry.
- **DAG Pipeline Integrity:**
  In multi-step pipelines (`ab pipeline`), success is strictly determined across all execution steps: if any step fails with `stopOnError: false`, overall success evaluates to `false` and triggers automated rollback if configured, preventing misleading partial deployments.
- **Consensus & Ensemble Integrity:**
  In multi-agent consensus reviews (`ab review`), rejected verdicts take unequivocal precedence over contradictory comments. In ensemble runs (`ab ensemble`), lack of a clear majority results in an explicit tie (`hasConsensus: false`, `consensusMethod: "tie"`) rather than picking an arbitrary winner.
- **Subagent Delegation Discovery:**
  The `SubagentRoster` normalizes full MCP server tool prefixes (such as `mcp__agentbridge__ask_*` and `mcp__agentbridge__dispatch_*`), allowing seamless subagent tree tracking and preventing premature completion of asynchronous background dispatches.

## Telemetry, Context & Quota Reliability Guarantees (Phase 5 Hardening)

- **Loop-Free Compaction & Handoff Maintenance (`MAINTENANCE_POLICY`):**
  Context maintenance routines (`compact` and cross-agent `handoff`) execute with all context policies and hard thresholds strictly suspended (`hardAction: 'none'`), eliminating recursive re-entry loops where a summarizing subagent is terminated by the very limit it was spawned to resolve.
- **Accurate Context Overflow Tracking:**
  Context window limits are never inflated to artificial boundaries (e.g. 1M tokens) when a session exceeds its known capacity. Instead, known windows remain authentic, overflow flags (`overflow: true`) are explicitly set, and percent indicators accurately exceed 100% to trigger warnings and hard boundaries without masking.
- **Fallback Session Continuity & Effective Agent Attribution:**
  When a requested agent triggers a fallback to an alternative model or agent, telemetry and persistent sessions are indexed under `effectiveAgent`. Subsequent continuation requests on the same session key cleanly resume on the effective agent that actually holds the conversational state, preventing mismatched CLI session errors.
- **Multi-Window Proactive Quota & Account Health:**
  `ab account quota` inspects both primary windows (5h/session) and secondary windows (7d/weekly for Codex and Claude). Provider health uses a 95% primary threshold; Claude weekly health uses 98%, while Codex weekly follows the configured health threshold. The newer `quotaPolicy` route gate has its own requested primary remaining-percent threshold and treats an exhausted known secondary window as blocking. Network errors or missing tokens are clearly reported as `error` or `unknown`, never falsified as 0% used.

## Storage, Memory & UI Security Guarantees (Phase 6 Hardening)

- **Root-Walking Discovery (`findProjectRoot`):**
  Config files (`.agentbridge/config.json`) and project memory (`.agentbridge/memory.json`) are resolved by walking up the directory tree until the Git repository root or an `.agentbridge` folder is found. Agents running in monorepos or subfolders therefore share the same rules and central configuration.
- **Atomic File Writing & Explicit Failure Propagation:**
  All writes to config files, account manifests (`accounts.json`) and project memory are atomic: they write a temporary file and swap it in with `renameSync`. Disk-full and permission errors propagate clearly instead of being swallowed by empty `catch` blocks.
- **Cross-Source Memory Consistency:**
  `loadMemory` compares `updatedAt` between the local store (`.agentbridge/memory.json`) and the global fallback store (`~/.agentbridge/memory/<repoHash>.json`), so an agent always works on the most recent state, even after a fallback switch.
- **Auto-Injection of Project Memory:**
  Every run (`ab run`, `runTracked`, `ask`) automatically injects the `[PROJECT CONVENTIONS & MEMORY - PRESERVE THESE RULES]` block into the prompt when the project has saved rules or decisions. No manual injection is needed.
- **Account Directory Path Traversal Prevention:**
  `ab account add` and `ab account remove` validate agent names against known lists and check that the profile directory stays inside the managed profiles root (`.agentbridge/profiles`), preventing arbitrary creation or deletion outside the sandbox.
- **Dashboard UI CSP & Authentication Compliance:**
  The Time Machine in the visual dashboard (`ab ui`) has no inline `style="..."` attributes, using static CSS classes compatible with a strict Content Security Policy. All API calls (`/api/checkpoints`, `/api/checkpoints/:id/diff`, `/api/checkpoints/:id/rollback`) send the `Bearer <token>` authorization header.
- **Strict Token & Request Validation (Proxy API):**
  OpenAI- and Anthropic-compatible endpoints strictly reject invalid or incompatible parameters with `400 Bad Request`, including `max_tokens <= 0` or non-integer values, and the unsupported `previous_response_id` flag.
- **Isolated Proxy Server Stores:**
  Multiple programmatic proxy instances each keep their own isolated `AgentStore` and `sessionStore`, so sessions and active sandboxes never leak between concurrent instances.

## Tooling, Installers & Ecosystem Guarantees (Phase 7 Hardening)

- **Centralized Agent Catalog (`src/core/catalog.ts`):**
  All native agents (`claude`, `codex`, `opencode`, `agy`, `pi`) and account rules are defined in one central catalog (`BUILTIN_AGENTS`, `VALID_ACCOUNT_AGENTS`), so the CLI, proxy, MCP and profile management never drift apart.
- **Universal IDE Compatibility (`process.execPath`):**
  IDE installers (`ab install vscode|cursor|zed|windsurf`) use the canonical `process.execPath` instead of fragile `node` lookups on PATH, preventing `node: command not found` errors when the IDE is launched from a desktop environment with a restricted PATH.
- **Transactional MCP Updates & Corruption Defense:**
  Installing MCP tools for Codex makes a transactional backup of `config.toml` first and restores the previous state if `codex mcp add` fails. For Pi (`~/.pi/agent/mcp.json`), files with invalid JSON or comments are left untouched, and a clear error explains how to configure it manually.
- **Strict Scope Isolation in Setup Wizard (`ab setup` / `ab wizard`):**
  When run with `--scope project`, the setup wizard confines all configuration and skill copies to the target project directory (`flags.cwd` or `process.cwd()`), without touching the user's `~/.agents/skills` or `~/.claude/skills`. A failure for any agent during setup exits with a non-zero code (`process.exitCode = 1`), so CI/CD scripts can detect it.
- **Zero Resource & Timer Leaks (`withTimeout`):**
  All model probes and health checks (`ab doctor`) use `withTimeout`, which clears its timer as soon as the call settles (`clearTimeout`), so leftover 20-second timers never keep the event loop alive.
- **Cross-Platform Diagnostic Precision (`ab doctor`):**
  Credential diagnostics natively support the `CLAUDE_CONFIG_DIR` variable and unify OpenCode config detection across all Windows directories (`%LOCALAPPDATA%`, `%APPDATA%`, `.config`).
- **Strict SemVer & Synchronized Lockfiles:**
  Release automation (`scripts/release.mjs`) strictly validates versions in the official SemVer format and keeps `package-lock.json` in sync with `package.json` via `npm install --package-lock-only`, keeping tags and releases consistent.



