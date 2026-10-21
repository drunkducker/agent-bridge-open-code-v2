# agentbridge reference

> Complete reference. For an overview and quickstart see the [README](../README.md).

Drive the coding agents you already have installed — **Claude Code**, **Codex**, **OpenCode**, **Antigravity CLI (`agy`)**, **pi**, **Cursor**, **Grok**, **Gemini**, **Devin**, **Agent Client Protocol (`acp`)** and local/remote **HTTP models** — programmatically, using their existing local logins. No API keys.

agentbridge gives you:

1. **A unified library and CLI** (`run`, `ask`, `fanout`, `race`) with the same options and the same event/result shapes for all ten built-in agents.
2. **Agent-to-agent delegation.** Any agent can be a subagent of any other (all 10 built-in caller x callee pairs, plus HTTP endpoints) through a built-in MCP bridge server, with control over model, effort, permissions, working directory, timeout and session mode.
3. **Plain HTTP model endpoints as agents**: **Ollama** (built in) or any OpenAI/Anthropic-compatible base URL (vLLM, LM Studio, LiteLLM, a remote gateway), usable from the CLI, the library and from inside Claude Code / Codex / OpenCode as `ask_<name>`.
4. **One-command Claude Code integration**: `ab install claude` registers the bridge as an MCP server and writes relay subagents, so Claude Code subagents and **dynamic workflows** can call Codex, OpenCode and your Ollama models.
5. **Telemetry and context management**: per-session context size, warn/compact/hard thresholds, automatic compaction, and cross-agent `handoff()`.
6. **An OpenAI-compatible and Anthropic-compatible local HTTP proxy** that exposes the models of your logged-in agents to any SDK or app.

Plain Node ESM: a TypeScript source tree compiled to plain JavaScript in `dist/` for distribution (`npm run build`); no runtime dependencies. Windows, macOS and Linux.

> **Terms of service.** agentbridge drives the CLIs using your consumer/subscription logins. Providers may restrict automated use of those plans. Use it for personal, local use only, never expose the proxy to other people, and use API keys if you need a supported programmatic path. You are responsible for compliance.

---

## Table of contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Verify your setup](#verify-your-setup)
- [Quick start](#quick-start)
- [CLI reference](#cli-reference)
- [Library API](#library-api)
  - [Run options](#run-options)
  - [Events and results](#events-and-results)
  - [Sessions](#sessions)
  - [Permissions and effort mapping](#permissions-and-effort-mapping)
  - [Errors](#errors)
- [Parallel workflows: fanout and race](#parallel-workflows-fanout-and-race)
- [Extras: schema, worktree, budget](#extras-schema-worktree-budget)
- [Git hidden-ref checkpoints](#git-hidden-ref-checkpoints)
- [Process supervision and anti-deadlock safeguards](#process-supervision-and-anti-deadlock-safeguards)
- [New providers (Cursor, Grok, Gemini, Devin, ACP)](#new-providers-cursor-grok-gemini-devin-acp)
- [Agents calling agents (the MCP bridge)](#agents-calling-agents-the-mcp-bridge)
- [Antigravity CLI (`agy`)](#antigravity-cli-agy)
- [pi](#pi)
- [Rate limits and fallback](#rate-limits-and-fallback)
- [Using it from Claude Code (subagents and dynamic workflows)](#using-it-from-claude-code-subagents-and-dynamic-workflows)
- [HTTP endpoints: Ollama and any base URL](#http-endpoints-ollama-and-any-base-url)
- [Telemetry, context policy and handoff](#telemetry-context-policy-and-handoff)
- [Hooks](#hooks)
- [OpenAI / Anthropic compatible proxy](#openai--anthropic-compatible-proxy)
- [Adding more providers](#adding-more-providers)
- [Environment variables](#environment-variables)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Known limitations](#known-limitations)
- [Troubleshooting](#troubleshooting)

---

## Requirements

- **Node.js >= 22**
- At least one of these CLIs installed **and logged in** (each one is optional; use the ones you have):
  - `claude` (Claude Code)
  - `codex` (OpenAI Codex CLI)
  - `opencode` (OpenCode)
  - `agy` (Antigravity CLI; the separate terminal CLI, not the IDE launcher)
  - `pi` (`npm i -g @earendil-works/pi-coding-agent`; any provider/model configured in pi)
- `git` on your `PATH` (only needed for the `--worktree` option)

agentbridge never asks for passwords or API keys and has no login flow of its own. It spawns the CLIs, which use their own local auth. It reads existing CLI login files only for quota measurement (Claude, Codex, Gemini OAuth), and `ab account add --copy-current` copies a CLI config directory, login files included, into a managed profile.

## Installation

Install globally via npm:

```bash
npm install -g @rodolfonobrega/agentbridge
```

Or run the setup wizard directly without installing:

```bash
npx @rodolfonobrega/agentbridge setup
```

Or build and link from source:

```bash
git clone https://github.com/rodolfonobrega/agentbridge.git
cd agentbridge
npm ci
npm run build
npm link             # puts the `agentbridge` and `ab` commands on your PATH
```

Without `npm link` you can run the compiled CLI directly:

```bash
node dist/cli/main.js --help
```

To use it as a library from another project:

```bash
npm install @rodolfonobrega/agentbridge
```

```js
import { ask, run, agents, contextOf, compact, setPolicy } from '@rodolfonobrega/agentbridge';
```

## Interactive Setup Wizard

Run the interactive terminal wizard to auto-detect your CLIs and configure MCP bridges, subagent relays, skills, and permission ceilings:

```bash
ab setup           # or: ab wizard
```

The wizard guides you through:
1. **CLI Probing:** Auto-detects `claude`, `codex`, `opencode`, `pi`, `ollama`, and `agy`.
2. **Target Agents:** Select which agents to connect.
3. **Scope:** Global (`user`: `~/.claude`, `~/.codex`, `~/.pi`) vs local (`project`).
4. **Permissions:** Set ceiling (`read-only`, `plan`, `edit`, `full`).
5. **Skills:** Install the `agentbridge-delegate` skill.
6. **Codex Auto-Approve:** Pre-approve MCP tools to prevent prompt popups.
7. **HTTP Endpoints:** Add local Ollama or OpenRouter.
8. **Health Check:** Offers to run `ab doctor` immediately.

Use `ab setup --yes` for non-interactive / scripted execution.

## Verify your setup

```bash
ab doctor            # checks CLIs, logins, models, Node version, git, cwd, proxy port
ab doctor --live     # additionally makes a tiny real call to each agent
ab doctor --json     # machine-readable
```

Example output:

```
[ ok ] claude: 2.1.288 (Claude Code); logged in; 4 models
[ ok ] codex: codex-cli 0.160.0; logged in; 8 models
[ ok ] opencode: 1.18.31; logged in; 30 models
[ ok ] agy: 1.2.16; login not checkable offline (use --live); 25 models
[ ok ] node: v26.3.0 (need >= 22)
```

## Quick start

### CLI

```bash
# Print only the answer text
ab ask claude "Explain what this repo does" --model haiku

# Stream events as they happen
ab run codex "Refactor utils.js" --permissions edit --stream

# Ask three agents the same question, collect all answers
ab fanout "Find bugs in src/core" claude:haiku codex opencode:opencode-go/glm-5.3-flash

# First good answer wins; the others are cancelled
ab race "Summarize README.md" claude:haiku codex
```

### Library

```js
import { ask, run } from '@rodolfonobrega/agentbridge';

// Run to completion
const result = await ask('claude', {
  prompt: 'List the exported functions in src/index.ts',
  model: 'haiku',
  cwd: process.cwd(),
  permissions: 'read-only',
  timeoutMs: 120_000,
});
console.log(result.text, result.usage, result.sessionId);

// Stream normalized events (the generator's return value is the Result)
const it = run('codex', { prompt: 'Explain src/core/spawn.ts' });
for (;;) {
  const { value, done } = await it.next();
  if (done) { console.log('final:', value.text); break; }
  if (value.type === 'text') process.stdout.write(value.delta);
}
```

---

## CLI reference

The binary is available as `agentbridge` and `ab`.

```
ab run <agent> [prompt|-] [--model][--effort][--permissions][--cwd][--timeout s]
                           [--session new|ephemeral|continue|fork][--session-id id]
                           [--system][--json-schema '<json>'][--stream][--json]
                           [--fallback a[@N][:model],...][--fallback-on RATE_LIMITED,TIMEOUT,...]
                           [--min-remaining-percent N][--wait-for-quota][--max-quota-wait seconds][--yolo]
                           [--harness auto|claude|pi|none][--dangerously-skip-permissions]
                           [--worktree][--max-cost][--max-tokens][--max-time s]
ab ask <agent> [prompt|-] [same flags]           # prints only the result text
ab fanout "<prompt>" agent[:model] ...           # run all, collect all
ab race   "<prompt>" agent[:model] ...           # first accepted wins, rest cancelled
ab fix <agent> "<test-cmd>" [--prompt p] [--max-attempts 3]  # TDD auto-repair loop with rollback
ab review <coder> <reviewer> "<task>" [--max-turns 3]        # Multi-agent review loop with diffs
ab ensemble "<task>" <a1> <a2> ... [--judge j]               # Multi-agent consensus voting & synthesis
ab pipeline <pipeline.json> [--checkpoint-each][--auto-rollback]    # DAG task orchestrator with waves & rollback
ab quota [agent] [--threshold %]                             # Proactive quota checking
ab account list [agent] | add <agent> <name> [--copy-current][--login] | use <agent> <name> | remove <agent> <name> | quota
ab checkpoint create [message] | list | rollback <id> | diff <id>   # git hidden-ref snapshots
ab memory add "<rule>" | decision "<topic>" "<decision>" [--agent a] | list [--json] | clear
ab sessions | ab ps | ab top [--once] | ab stats
ab ui [--port 8788] [--open] [--token t]       # live web dashboard & time-machine UI
ab context <session> [--agent a]
ab handoff <session> --to <agent>
ab watch <run> | ab wait <run> | ab cancel <run>
ab serve [--port][--host][--token][--allow-non-loopback][--fallback agent[@N][:model],...]
         [--config file.json][--agent-root dir][--agent-max-permission read-only|plan|edit|full][--agent-max-runs N (default 8, 0 = unlimited)][--agent-run-ttl minutes (default 30)][--log file.jsonl]
         [--min-remaining-percent N][--wait-for-quota][--max-quota-wait seconds][--accounts file.json --accept-tos-risk]
ab bridge                                        # stdio MCP server
ab sweep                                         # delete expired bridge run records; prints {total, removed}
ab doctor [--live][--json]
ab setup | ab wizard [--yes]
ab install <claude|codex|opencode|agy|pi|cursor|vscode|zed|windsurf|claude-desktop|all> [--scope project|user] [--force]
ab endpoint [list] | add <name> <baseUrl> [--type openai|anthropic] [--model m] [--api-key-env VAR] | remove <name>
```

Notes:

- `--dangerously-skip-permissions` (Claude only) adds Claude's literal flag; it requires `--permissions full` and is rejected as root. `--yolo` (Codex only) likewise requires `--permissions full`. `--harness` selects which CLI executes an HTTP endpoint (`none` = plain chat); it is chosen automatically when tools or non-read-only permissions are requested.
- Exit codes: 2 for usage errors and `BAD_OPTION`, 1 for every other failure. `--session-id` alone implies `--session continue`. A `default-agent` config key lets `ab run` omit the agent.
- `ab install codex|opencode|agy|pi` register the same MCP bridge in those CLIs (Codex: `codex mcp add`, global `~/.codex/config.toml`; Antigravity: `agy mcp add`, global; OpenCode: the `mcp` block of `opencode.json` in the project, or of the global file with `--scope user`; a config that is not plain JSON is refused untouched) and put the skill in `.agents/skills/` (or `~/.agents/skills/` with `--scope user`), the shared folder those CLIs read. `ab install all` does every CLI that is installed. pi: `pi mcp add agentbridge --exposure direct` (global `~/.pi/agent/mcp.json`, so the `ask_*` tools are declared to the model) plus the same `.agents/skills/` folder pi reads; verified that pi connects to the bridge and lists its tools (a model call through pi was not verified: no model is configured in this pi). Verified live: OpenCode and Antigravity saw the skill and called the bridge tools; for Codex only the registration was verified (its usage limit was exhausted during the check).
- `ab install codex --auto-approve` sets `default_tools_approval_mode = "approve"` on the bridge server in Codex's config. Without it, interactive Codex asks once per tool and `codex exec` fails with "MCP tool call requires approval".
- Codex MCP server deadlines use its native `tool_timeout_sec` setting in seconds. `ab install codex --timeout N` writes that key; legacy `timeout` entries for AgentBridge are migrated when the installer updates the Codex config. Temporary HTTP bridges injected for Codex use 300 seconds.
- `ab install claude` registers the MCP server, writes the relay subagents (`--no-agents` to skip) and installs the `agentbridge-delegate` skill under `.claude/skills/` (project/local scope) or `~/.claude/skills/` (user scope); `--no-skill` skips it. The skill teaches Claude when to delegate, which tool to use (`ask_*` vs `dispatch_*`), permissions, fallback and how to treat results. Source: `skills/agentbridge-delegate/SKILL.md`.
- `<agent>` is a built-in (`claude`, `codex`, `opencode`, `agy`, `pi`, `cursor`, `grok`, `gemini`, `devin`, `acp`), `ollama` or any [endpoint](#http-endpoints-ollama-and-any-base-url) you configured. Targets for `fanout`/`race` can include a model: `claude:haiku`, `opencode:provider/model`.
- Pass `-` as the prompt to read it from stdin.
- `--json` prints the full Result as JSON; `--stream` prints text as it arrives.
- `ab top` is a live view of active runs and sessions; `ab stats` prints persisted aggregates.

## Library API

Everything is exported from the package root (`src/index.ts`, compiled to `dist/index.js`):

| Export | Purpose |
|---|---|
| `agents` | Lazy adapter registry: `agents.builtin` (list), one getter per built-in agent (`agents.claude`, `agents.codex`, `agents.opencode`, `agents.agy`, `agents.pi`, `agents.cursor`, `agents.grok`, `agents.gemini`, `agents.devin`, `agents.acp`), plus `agents.names`, `agents.get(name)`, `agents.models(name)` |
| `run(agent, opts)` | Async generator of normalized events; returns the Result |
| `ask(agent, opts)` | Runs to completion and returns the Result |
| `validateOptions(opts)` | Validates and normalizes run options (throws `BAD_OPTION`) |
| `AgentError` | Error class with a `.code` |
| `loadEndpoints`, `endpointNames`, `saveEndpoint`, `endpointsFile` | Manage HTTP endpoint agents (`agents.names` includes them) |
| `fanout`, `race`, `parseTarget`, `execOne` | Parallel workflows |
| `askWithSchema`, `validateSchema`, `extractJson` | Structured JSON output with validation and retries |
| `withWorktree`, `runInWorktree`, `createSandbox` | Isolated git worktree runs |
| `Budget`, `runBudgeted` | Cost/token/time budgets |
| `doctor` | Environment checks |
| `runWithTelemetry`, `askWithTelemetry`, `stats`, `contextOf`, `setContextWindow`, `setPolicy`, `getPolicy`, `handoff`, `compact`, `wait`, `waitAll` | Telemetry, context policy, handoff |

`agent` can be a name (`'claude' | 'codex' | 'opencode' | 'agy' | 'pi' | 'cursor' | 'grok' | 'gemini' | 'devin' | 'acp'`, or an endpoint name) or a custom adapter object exposing `run(opts)`.

### Run options

| Option | Type | Description |
|---|---|---|
| `prompt` | string (required) | The prompt |
| `model` | string | Model name; invalid models raise an error rather than being ignored |
| `effort` | `low\|medium\|high\|xhigh\|max` | Reasoning effort, mapped per agent |
| `permissions` | `read-only\|edit\|full\|plan` | Default `read-only` |
| `cwd` | string | Working directory for the agent |
| `timeoutMs` | number | Kills the agent and throws `TIMEOUT` |
| `signal` | `AbortSignal` | Abort and kill the agent process tree (throws `ABORTED`) |
| `session` | `{mode, id?}` | See [Sessions](#sessions) |
| `systemPrompt` | string | System prompt addition |
| `mcpServers` | `{name: {command, args, env}}` | Extra MCP servers for the agent |
| `env` | object | Extra environment for the agent process |
| `jsonSchema` | object | Request structured output |
| `extraArgs` | string[] | Raw extra CLI arguments, passed through |
| `isolated` | boolean | Run the agent without your local config/plugins/slash commands where supported |
| `harness` | `auto\|claude\|pi\|none` | Execution harness for HTTP endpoints (Ollama, OpenRouter, etc.). Default `auto`. |

Unknown options raise `BAD_OPTION`. Anything an agent cannot do raises `BAD_OPTION` as well; options are never silently ignored.

### Permissions & Sandboxing Architecture: How Edits are Blocked vs Allowed

AgentBridge applies the requested permission level through each adapter's available controls. The default requested permission is `read-only`. Enforcement varies by harness: some use native sandboxes or tool exclusion, while generic adapters may rely on prompt guidance or provider defaults. These labels do not create a universal OS-level sandbox.

| Permission | Read Files | Web Search | Edit/Write Files | Run Bash/Commands | Enforced By |
|---|---|---|---|---|---|
| `full` | Yes | Provider-specific | **YES** | **YES** | Native full-access control where available |
| `edit` | Yes | Provider-specific | **YES** | Provider-specific | Native tool/sandbox controls where available |
| `plan` | Yes | Provider-specific | Requested off | Provider-specific | Native plan mode, tool filtering, or prompt guidance |
| `read-only` *(default)* | Yes | Provider-specific | Requested off | Provider-specific | Native sandbox, tool filtering, deny rules, or prompt guidance |

The table describes the normalized request, not a uniform capability guarantee. In particular, `read-only`/`plan` on Grok, Gemini CLI, and Devin do not provide an AgentBridge-enforced filesystem/process sandbox. Provider hooks, MCP configuration, and subprocesses are not covered by a blanket isolation guarantee. See [Harness validation](HARNESS_VALIDATION.md).

#### How each adapter prevents edits (when restricted):
1. **Claude Code (`claude`):**
   - In `read-only` and `plan`, AgentBridge passes `--tools Read,Glob,Grep,WebFetch,WebSearch` and `--permission-mode default|plan`. The tools `Write`, `Edit`, `Bash`, `NotebookEdit`, and `KillShell` are **completely omitted from the tool definitions**. The LLM prompt literally receives zero write schemas.
   - External MCP servers are isolated (`--mcp-config {"mcpServers":{}} --strict-mcp-config`).
   - In `edit`, AgentBridge passes `--permission-mode acceptEdits`, unlocking `Write` and `Edit`.
   - In `full`, it passes `--permission-mode bypassPermissions`.
2. **OpenAI Codex (`codex`):**
   - In `read-only` and `plan`, AgentBridge passes `--sandbox read-only`. Codex CLI runs inside an OS-level container sandbox where filesystem mutations are denied by kernel/sandbox restrictions.
   - In `edit`, Codex passes `--sandbox workspace-write` (strictly restricted to the workspace directory, excluding temp directories).
   - In `full`, it passes `--sandbox danger-full-access`.
3. **OpenCode (`opencode`):**
   - In `read-only` / `plan`, AgentBridge generates an inline runtime policy: `permission: { edit: 'deny', bash: 'deny', webfetch: 'allow' }`. Any tool invocation attempting filesystem modification is denied by OpenCode's policy engine.
   - In `full`, all tools including `bash` and file writes are allowed.
4. **Antigravity (`agy`):**
   - `agy` has no built-in read-only flag. When restricted, AgentBridge creates a disposable, private HOME with generated `.gemini/antigravity-cli/settings.json` specifying explicit deny rules: `deny: ['command(*)', 'unsandboxed(*)', 'write_file(*)']` (`execute_url(*)` is added only when the run also passes `offline: true`).
   - In `full`, `--dangerously-skip-permissions` is passed.
5. **Pi (`pi`):**
   - Runs in an ephemeral sandbox directory (`PI_CODING_AGENT_DIR`), stripping user packages and skills (`-ns -np -ne`).
   - In `read-only` and `plan`, AgentBridge passes `--exclude-tools bash,powershell,edit,write,codemode`. Pi completely unregisters those tools from its active runtime.
   - In `edit`, `bash` and `powershell` are excluded, allowing only file read/write.
   - In `full`, no tools are excluded; full shell and file capabilities are active.
   - **MCP Exposure in Pi:** If third-party MCP servers (e.g. `rea`) are registered in `~/.pi/agent/mcp.json`, their exposure must be `"direct"`. Pi's `"deferred"` mode does not present tool schemas to the model at session start.
6. **Additional CLI adapters (Cursor, Grok, Gemini CLI, Devin):**
   - Each adapter uses the provider's current CLI protocol and native permission controls where available. Restricted modes on Grok, Gemini CLI, and Devin are not an AgentBridge-enforced filesystem/process sandbox. See [Harness validation](HARNESS_VALIDATION.md) for exact flags, unsupported options, and local readiness.
7. **Endpoints (Ollama, OpenRouter, vLLM):**
   - When running with a coding harness (`--harness claude|pi`), the model inherits the exact tool allowlists and sandboxes described above.
   - When running without a harness (`--harness none` or plain question), it makes a direct HTTP API call with no filesystem tools attached.
8. **Subagent MCP Isolation & Passthrough Policy:**
   - **Isolation by Default:** When delegating to subagents via `ask_*` or `dispatch_*`, AgentBridge isolates external MCP servers to prevent prompt injection or exfiltration loops.
   - **Host MCP Inspection with `ab doctor`:** Running `ab doctor` automatically detects and lists host MCP servers declared in `~/.pi/agent/mcp.json`, `.mcp.json`, `~/.codex/config.toml`, and `.gemini/config/mcp_config.json`.
   - **Allowed MCP Passthrough:** the operator sets the ceiling with `AGENTBRIDGE_MCP_PASSTHROUGH` (names, or `*`; unset = none) and `AGENTBRIDGE_MCP_SOURCE_DIR`; the project `.mcp.json` is also read. A call's `mcpPassthrough` can only select a subset of that ceiling. Only stdio servers are passed, always `exposure: "direct"`, for every harness (Codex gets them as `-c mcp_servers.*` including env).
   - **Offline Gate:** When `offline: true` is passed to a run, external MCP passthrough is **strictly disabled** regardless of configuration. It is also disabled under `read-only` and `plan`.
   - **Skills:** `skills: true` / `AGENTBRIDGE_ENABLE_SKILLS=1` drops Pi's `-ns` and links `~/.pi/agent/skills` into the per-run home (junction on Windows, removed before the home is deleted, so the real folder is never touched). Project skill roots (`.agents/skills`, `.claude/skills`) are resolved up to the git root; untracked ones are copied into `--worktree` sandboxes without appearing in the diff.
   - **Account profiles:** `ab account add` links skills/prompts/plugins/hooks/`AGENTS.md` (never credentials, sessions or history) and mirrors Codex `[mcp_servers.*]` into the new profile; `--no-share` disables it, `--copy-current` copies everything. `ab account remove --purge` unlinks before deleting.
9. **MCP Bridge Ceiling (`AGENTBRIDGE_PERMS`) & How to Change It:**
   - When AgentBridge runs as an MCP server, child runs can never exceed the install-time permission ceiling.
   - **Default Ceiling is `full`:** The agent has full power to use terminal commands, shell, and file editing.
   - **Restricted Ceilings:** If you installed with a lower ceiling (`ab install <agent> --permissions edit`), child runs are restricted to at most `edit`.
   - **Permission Exceeded Error:** If a subagent asks for `full` while the configured ceiling is `edit` or `read-only`, AgentBridge throws:
     `permissions "full" exceeds the configured permission ceiling "<ceiling>" (increase ceiling or configure permission)`
   - **Altering / Updating Permissions with `ab`:** You can change the ceiling at any time simply by re-running:
     ```bash
     ab install all --permissions full    # unlock full access for all installed agents
     ab install codex --permissions edit  # set Codex ceiling to edit
     ab setup                             # interactive wizard to reconfigure
     ```

### Events and results

Events yielded by `run()`:

```
{type:'session', id}
{type:'text', delta}
{type:'thinking', delta}
{type:'tool', name, input, output?}
{type:'usage', input, output, cost?, incremental?}
{type:'error', message}
{type:'raw', data}
```

Result:

```
{ text, sessionId, usage:{input, output, cost?}, exitCode, model, durationMs, timedOut }
```

`cost` is only reported when the agent reports it (Claude does; Codex does not, and it is never invented).

For usage events, `incremental: true` means `input`, `output`, and `cost` are deltas to add to the current attempt's totals. When `incremental` is absent or false, the event is a snapshot of the current totals; replace the previous snapshot instead of adding it. Some agents do not emit usage events. The returned `Result.usage` contains the aggregate for the final attempt, so do not add it again to that attempt's usage events. Budget tracking keeps usage from earlier fallback attempts and can stop a run early when usage events show that a limit has been reached.

### Sessions

| Mode | Behavior |
|---|---|
| `new` | Fresh persisted session |
| `ephemeral` | Nothing persisted |
| `continue` | Append to a session (`id`, or the most recent one in `cwd` if omitted; for claude the id-less form only sees sessions started by this process unless `session.adoptForeign: true` adopts the newest on-disk session for the folder) |
| `fork` | New session branching from the given session's history; the original is untouched |

`id` is not allowed with `new` or `ephemeral`. All adapters expose the same semantics, with one nuance: claude's id-less `continue`/`fork` only considers sessions started by the current process; set `session.adoptForeign: true` to adopt the newest on-disk session for that cwd. OpenCode additionally rejects concurrent `continue` calls on the same session with `BAD_OPTION 'session busy'`.

```js
const a = await ask('claude', { prompt: 'Remember the number 42', session: { mode: 'new' } });
const b = await ask('claude', { prompt: 'What number?', session: { mode: 'continue', id: a.sessionId } });
const c = await ask('claude', { prompt: 'Try a different approach', session: { mode: 'fork', id: a.sessionId } });
```

### Permissions and effort mapping

`permissions` and `effort` are mapped to each CLI's native concepts (sandbox modes, permission modes, reasoning effort). The default is `read-only`; the permission ceiling defaults to `full`. In the bridge, a child agent can never receive permissions above its caller ceiling.

### Web Search, Tools, and Network Permissions Across Agents & Modes

By design, AgentBridge prioritizes safety and least privilege by default. Depending on the agent CLI and the requested permission mode, certain tools (especially web search, web fetch, external network access, and shell execution) may be enabled, sandboxed, or restricted.

Permission labels are normalized requests, not identical guarantees across all providers. Native sandboxing and tool exclusion are available in some harnesses; generic adapters may use prompt guidance or provider defaults. In particular, `read-only` and `plan` do not universally isolate the filesystem, hooks, MCP servers, or subprocesses. See [Harness validation](HARNESS_VALIDATION.md) for controls and verification scope.

The table below summarizes tool availability and network access across adapters and modes:

| Agent | `read-only` / `plan` | `edit` | `full` | Web Search / Network Access | How to Grant Full Network / Web Access |
|---|---|---|---|---|---|
| **Claude Code** (`claude`) | `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch` | All Claude built-in tools (`acceptEdits`), edits auto-accepted | Unrestricted (`bypassPermissions`) | Native `WebSearch` and `WebFetch` active across all modes. When MCP servers are connected, built-in tools are preserved. | Web search works out of the box in `read-only` and `edit`. For full shell and plugin freedom, use `--permissions full`. |
| **OpenAI Codex** (`codex`) | Sandbox `read-only` (read files only) | Sandbox `workspace-write` (edits confined to repo) | Sandbox `danger-full-access` (unrestricted) | Codex sandbox blocks outgoing network connections in `read-only` and `workspace-write` modes. | Set `--permissions full` (or pass Codex network flags via `extraArgs: ['-c', 'sandbox_mode="danger-full-access"']`). |
| **OpenCode** (`opencode`) | Read files, search codebase, `webfetch`, `websearch`. `bash` denied. | File edits allowed. `bash` denied, `webfetch` and `websearch` allowed. | Unrestricted (`edit`, `bash`, `webfetch`, `websearch`). | Web fetch and search tools (`webfetch`, `websearch`) are permitted in all modes. Direct shell commands (`bash`) require `full`. | Use `--permissions full` if the model needs to run terminal curl/pip/npm commands. |
| **Antigravity** (`agy`) | Read files, `execute_url` (web fetch/search). Shell command execution denied. | File edits allowed, `execute_url` allowed. Shell command execution denied. | Unrestricted (`--dangerously-skip-permissions`). | Web URL inspection and searches (`execute_url`) are allowed across all modes. Arbitrary terminal commands require `full`. | Use `--permissions full` if the model needs terminal shell execution (`command(*)`) or unsandboxed tools. |
| **Pi** (`pi`) | Read files, search tools (`tool_search`). Shell/edit denied. | File edits allowed, `tool_search` allowed. Shell denied. | All tools allowed without exclusion. | Pi connects to network APIs and tools by default. Telemetry and version checks stay suppressed for speed. | Use `--permissions full` or pass community skills/extensions via `--permissions full` or `extraArgs`. |
| **Cursor, Gemini, Devin, Grok** | Provider-specific modes/guardrails; see validation notes. Do not assume a universal OS sandbox. | Provider-specific; see validation notes. | Native full/bypass controls are requested where available. | Behavior depends on each CLI's own mode and configuration. | See [Harness validation](HARNESS_VALIDATION.md) for exact flags and limits. |
| **HTTP Endpoints** (`ollama`, OpenRouter, etc.) | **Plain chat HTTP mode**: No tools or web search by default (direct LLM API completion). | Requires harness (`--harness claude` or `--harness pi`) to edit files. | Unrestricted harness mode. | Plain chat endpoints have NO tool runner. For tools or web search, an execution harness is **required**. | Specify `--harness claude` (or `--harness pi`) to wrap the model in a tool-enabled environment. |
| **Proxy Server** (`ab serve`) | Client-defined function calling supported. | Client-defined function calling supported. | Client-defined function calling supported. | Client function tools are supported. **Hosted server tools** (`type: "web_search"` in OpenAI/Anthropic format) are NOT supported because they require proprietary server-side execution. | Define a client-side search function tool (e.g. `web_search`) executed by your client, or use the MCP Bridge / CLI directly. |

#### How to unlock tools and web access:

1. **For models that need to run live web searches or external commands in Codex:**
   Codex defaults to isolated filesystem sandboxes where network sockets are locked down. Use `--permissions full` to enable internet and unrestrained tool access:
   ```bash
   ab ask codex "Search the web for latest Node 26 release notes" --permissions full
   ```

2. **For local Ollama or custom HTTP endpoints:**
   Plain HTTP endpoints (`/v1/chat/completions`) have no built-in browser or tool engine. Pass `--harness claude` or `--harness pi` to give your local/remote models full tool execution and web capabilities:
   ```bash
   ab ask ollama "Fetch https://example.com and summarize" --model qwen2.5-coder:32b --harness claude
   ```

3. **In the MCP Bridge (`ask_*` and `dispatch_*` tools):**
   Subagents cannot exceed the caller's permission ceiling. If the parent agent has ceiling `edit` or `full`, pass `"permissions": "full"` in the MCP tool call arguments to grant the subagent full network and shell tools.

4. **In the OpenAI / Anthropic Compatible Proxy (`ab serve`):**
   Clients connecting to `http://127.0.0.1:8787/v1` can supply standard function tools (`tools: [{ type: "function", function: { ... } }]`). If your frontend (e.g., Cursor, Continue, LibreChat) attempts to request proprietary cloud-hosted tools (like OpenAI's native server-side web search), configure the client to use a client-side search tool instead.

#### How to block tools, web searches, and network access:

If you are working in sensitive, private, corporate, or air-gapped environments and want to **strictly forbid** web searching, external network calls, or dangerous tools:

1. **Unified Offline Mode (`--offline` / `offline: true`):**
   AgentBridge provides a cross-adapter offline switch that disables web tools across all supported engines in one command:
   ```bash
   # CLI: completely disallow web access
   ab run claude "Analyze this local codebase" --offline
   ab ask pi "Review this file" --offline
   ab run opencode "Check syntax" --offline
   ```
   From the TypeScript / JavaScript library:
   ```js
   await ask('claude', { prompt: 'Local audit only', offline: true });
   ```
   In the MCP bridge (`ask_*` tools):
   ```json
   {
     "prompt": "Inspect codebase without internet",
     "offline": true
   }
   ```
   **What `--offline` does under the hood:**
   - **Claude Code:** Strips `WebFetch` and `WebSearch` from the tool allowlist (leaving only local file readers `Read`, `Glob`, `Grep`).
   - **Pi:** Injects `PI_OFFLINE=1` into the process environment.
   - **OpenCode:** Sets `webfetch: 'deny'` and `websearch: 'deny'` in the security guard.
   - **Antigravity:** Adds `execute_url(*)` to the sandbox deny rules.
   - **Codex:** Retains strict socket isolation in filesystem sandboxes.

2. **Request Read-Only Behavior:**
   Use `--permissions read-only` (the default) or `--permissions plan`. The strength of that restriction depends on the selected harness; consult the permission architecture above and [Harness validation](HARNESS_VALIDATION.md). Do not treat generic adapters as a guaranteed filesystem/process sandbox.

### Execution Transports: CLI vs Persistent App-Server Mode

AgentBridge features **Dual-Mode Execution** for OpenAI Codex:

```bash
# Batch CLI mode (default)
ab run codex "Run unit tests" --permissions edit

# Persistent App-Server mode (JSON-RPC 2.0 daemon)
ab run codex "Run unit tests" --permissions edit --transport app-server
```

Via the programmatic library:
```js
import { ask } from '@rodolfonobrega/agentbridge';

const res = await ask('codex', {
  prompt: 'Analyze codebase',
  transport: 'app-server', // or 'cli' (default)
  permissions: 'read-only',
});
```

#### What You Gain with `transport: "app-server"`:
1. **Zero Cold-Start (Warm Process):**
   - Standard CLI mode spawns a brand new `codex exec` binary process on each invocation, paying process startup, configuration loading, and auth bootstrapping costs every time.
   - `app-server` keeps a long-lived background daemon warm via JSON-RPC 2.0 stdio frames. Subsequent conversation turns and instructions dispatch instantly without startup lag.
2. **Real-Time Bidirectional Security Approvals:**
   - In CLI mode, subagent automation must either bypass approvals completely or risk hanging in an unmonitored terminal prompt.
   - In `app-server` mode, the Codex daemon actively asks AgentBridge before taking actions:
     - `item/commandExecution/requestApproval`
     - `item/fileChange/requestApproval`
     - `item/permissions/requestApproval`
   - AgentBridge programmatically responds to these requests based on the session's active permissions (`read-only` and `plan` reject with `{ denied: { rejection: ... } }`; `edit` and `full` approve), enforcing safety with zero interactive delays.
3. **Structured Streaming & Event Delivery:**
   - Text deltas (`item/agentMessage/delta`), reasoning (`item/reasoning/delta`), tool items (`item/completed`, surfaced as `shell`/`file_change` tool events) and usage updates (`thread/tokenUsage/updated`, `turn/completed`) arrive as normalized events from standardized JSON-RPC 2.0 frames instead of fragile ANSI log parsing or stdout scraping.
4. **Clean Protocol Cancellation:**
   - Instead of abruptly sending `SIGKILL` / `taskkill` to an active process (which can leave incomplete file edits or lock contention), AgentBridge sends a `turn/interrupt` notification. The model halts immediately while preserving daemon state.
5. **Stateful Multi-Turn Sessions:**
   - Native thread continuity (`threadId`, `turnId`) without having to persist and reload entire conversational context trees from disk.

#### Resource Linking & Config Mirroring
AgentBridge supports both batch CLI and daemon workflows by linking shared resources and mirroring configuration:
- **Resource Linking (Junctions / Symlinks):** Transparently exposes shared skills into isolated sandboxes and subagent directories without copying or polluting repository git history.
- **Config Mirroring (`config.toml` / `.mcp.json`):** Mirrors MCP definitions into configuration structures.

**Why this matters:**
Your MCP servers and skills work seamlessly and identically across **both** batch CLI mode (`codex exec`) and daemon mode (`codex app-server`), as well as across Pi, Claude Code, OpenCode, and Antigravity, without locking you into a single execution mode or requiring brittle memory rewrites.

### Errors

All failures throw `AgentError` with a `code`:

`NOT_INSTALLED`, `NOT_LOGGED_IN`, `TIMEOUT`, `ABORTED`, `BAD_OPTION`, `AGENT_FAILED`.

```js
try { await ask('codex', { prompt: 'hi', timeoutMs: 5000 }); }
catch (e) { if (e.code === 'TIMEOUT') { /* ... */ } }
```

Abort and timeout kill the whole process tree, including grandchildren. `run()` settles even if a tool left a detached background process holding the agent's pipes.

---

## Parallel workflows: fanout and race

Workflows are plain JavaScript: decide targets, branch on results, loop, and combine the primitives however you like.

```js
import { fanout, race } from '@rodolfonobrega/agentbridge';

// Same prompt to many agents/models; never rejects because one agent failed
const { results, budget } = await fanout(
  ['claude:haiku', 'codex', { agent: 'opencode', model: 'opencode-go/glm-5.3-flash' }],
  { prompt: 'Review src/core/spawn.ts' },
  { concurrency: 2, budget: { maxCost: 0.5, maxTokens: 200_000, maxTimeMs: 300_000 } },
);
for (const r of results) console.log(r.agent, r.ok, r.durationMs, r.text.slice(0, 100));

// First accepted answer wins; every loser is aborted and awaited (no leftover processes)
const { winner, losers } = await race(
  ['claude:haiku', 'codex'],
  { prompt: 'One-line summary of README.md' },
  { accept: (e) => e.text.length > 20 },
);
console.log(winner?.agent, winner?.text);
```

A shared budget covers all runs together: once exceeded, running ones are aborted and unstarted ones are skipped.

## Extras: schema, worktree, budget

```js
import { askWithSchema, runInWorktree, Budget, runBudgeted } from '@rodolfonobrega/agentbridge';

// Structured output: extracts JSON, validates against the schema, retries on invalid output
const r = await askWithSchema('claude', { prompt: 'Return {"name": string, "age": number} for Ada Lovelace' },
  { schema: { type: 'object', required: ['name', 'age'], properties: { name: { type: 'string' }, age: { type: 'number' } } }, retries: 2 });

// Run in a throwaway git worktree so edits cannot touch your working tree
await runInWorktree('codex', { prompt: 'Add tests', permissions: 'edit', cwd: '/path/to/repo' });
```

From the CLI: `ab run codex "..." --worktree --max-cost 0.5 --max-tokens 100000 --max-time 300`.

---

## Git hidden-ref checkpoints

AgentBridge provides atomic git checkpointing without branch pollution or touching the user's `.git/index`.
Checkpoints are stored in custom git references under `refs/agentbridge/checkpoints/<session>/<id>` using low-level git plumbing (`write-tree`, `commit-tree`, `update-ref`) with an isolated temporary index file (`GIT_INDEX_FILE` in `os.tmpdir()`).

### CLI Usage
```bash
# Create a checkpoint
ab checkpoint create "Before risky refactor"

# List checkpoints
ab checkpoint list

# Inspect differences against working tree
ab checkpoint diff <checkpoint-id>

# Roll back to checkpoint (restores modified and tracked files, cleans untracked files safely)
ab checkpoint rollback <checkpoint-id>
```

### Library API
```js
import { createCheckpoint, listCheckpoints, rollbackCheckpoint, diffCheckpoint } from '@rodolfonobrega/agentbridge';

const cp = createCheckpoint(process.cwd(), { message: 'pre-edit snapshot' });
console.log(cp.id, cp.ref);

// List checkpoints
const list = listCheckpoints(process.cwd());

// Rollback if something went wrong
rollbackCheckpoint(process.cwd(), cp.id);
```

### MCP Tools
Agents calling the bridge have native access to:
- `checkpoint_create`: `{ message?, sessionId?, cwd? }`
- `checkpoint_rollback`: `{ id: string, cwd? }`
- `checkpoint_diff`: `{ id: string, cwd? }` — unified diff between the working tree and a checkpoint
- `checkpoint_list`: `{ sessionId?, cwd? }`

---

## Process supervision and anti-deadlock safeguards

- **Bounded Stderr Tail Buffer:** Standard OS pipe buffers range from 4 to 64 KiB. If a child agent outputs massive debug logs to `stderr`, standard streaming pipes can deadlock. AgentBridge streams stdout while retaining a circular 8 KiB ring buffer (`STDERR_TAIL_MAX_CHARS = 8192`) on stderr, guaranteeing deadlock-free execution while retaining full tail diagnostics on failure.
- **Cross-Platform Tree Escalation:** When an agent times out or is aborted:
  - On POSIX, escalates through process groups (`-pid` SIGTERM, followed by SIGKILL after a short grace; a plain SIGKILL of the leader if there is no process group).
  - On Windows, uses `taskkill.exe /pid <pid> /T /F`, degrading to a SIGKILL of the leader alone if taskkill is missing or fails.
  - Exposes `handle.pid` on spawn handles for real process supervision.

---

## MCP Delegation Results and Timeouts

MCP calls return standard result objects, typically `{ content: [{ type: "text", text: "..." }], structuredContent?, isError? }`; callers must not assume a string result. Normalize by accepting strings or filtering `content` to text blocks that do not start with `[agentbridge] `, then joining their text with newlines. Use `structuredContent` when present; some clients omit it, so parse JSON from normalized text as a fallback. Treat `isError: true` as failure, and do not present the attestation line as answer text.

For tasks expected to take longer than 30 seconds, call `dispatch_<agent>` and then poll `wait_run(id, timeoutSeconds: 30)` until state is `done`, `error`, `lost`, or `cancelled`. Each `wait_run` call is capped at 30 seconds. If capped, `requestedTimeoutSeconds`, `waitTimeoutSeconds`, and `waitCapped` describe the request and effective wait. A wait timeout does not terminate the run; continue waiting or use `check_run`. `check_run` includes bounded recent event snippets and an additive `lastTool` field. If a call errors or returns no useful run id/state, handle it as a failed delegation.

The task timeout on `ask_*` or `dispatch_*` controls the run lifetime; for example, `timeoutSeconds: 600`, always in seconds (only the legacy `timeout` alias reads values at least 1000 as milliseconds). The MCP transport deadline belongs to the client and its configuration; installers commonly configure 300 seconds, but there is no universal 60- or 300-second cap. A synchronous tool call cannot outlast a fixed client deadline, and server progress/streaming cannot guarantee extending it. Dispatch and bounded polling allow the caller to resume while the run continues. Structured errors report the observed code, message, and cause. Synchronous request cancellation retains code `ABORTED` with detail cause `REQUEST_CANCELLED`; a waiter may report `REQUEST_CANCELLED`. `TIMEOUT` and `AGENT_FAILED` remain distinct. The server cannot promise delivery of a transport failure after the client disconnects.

The optional `subdelegation` argument on `ask_*` and `dispatch_*` defaults to `true` for compatibility. Set it to `false` to instruct and enforce that the child does not spawn more AgentBridge runs; monitoring tools remain available.

The `timeout` field on child MCP server configurations (`mcpServers.<name>.timeout`) is validated and forwarded to supported harnesses; Codex receives its native `tool_timeout_sec` field in seconds.

## Universal Open Agent Skills (`.agents/skills`) & Conflict Prevention

The modern coding agent ecosystem (Pi, Codex, OpenCode, Antigravity, and recent versions of Claude Code) natively searches for **Open Agent Skills** in `.agents/skills/`.

### 1. One Install Covers All Harnesses
When you install the `agentbridge-delegate` skill, it is placed in `.agents/skills/agentbridge-delegate/SKILL.md`.
- Pi discovers it automatically.
- Codex discovers it automatically.
- OpenCode and Antigravity discover it automatically.
- There is **no need** to install separate copies into `.claude/skills` or repeat the installation per harness.

### 2. Duplicate-install behavior (per-process dedup, global identical-content skip, `--force`)
Pi scans both your workspace root (`./.agents/skills/`) and your global home (`~/.agents/skills/`). If the skill exists in both scopes, Pi auto-prefers one and marks the other skipped — that is Pi's own collision handling, and with AgentBridge it never even happens, because the redundant copy is not written in the first place.
**What `ab install` actually does (`src/cli/install.ts`):**
- `ab install all` deduplicates writes in-memory: each skill destination is written at most once per run (`writeSkill`).
- When the destination is a project/other scope (`<cwd>/.agents/skills`) and the global skill (`~/.agents/skills/agentbridge-delegate/SKILL.md`) exists **and is byte-identical** to the copy that would be written, the project write is skipped with a message (`skill identical to global ... skipped duplicate copy`).
- `--force` writes the project copy even when it is identical to the global one.
- Writing the global skill itself (`--scope user` → `~/.agents/skills`) always writes normally; a differing (outdated) global skill also never blocks a project write.

---

## Multiple accounts and managed profiles (`ab account`)

AgentBridge provides isolated profile directories ("Managed Homes") for each account, eliminating credential collisions, session leaks, and multi-tenant token conflicts.

### Architecture & Isolation
Each account is assigned an isolated directory under `~/.agentbridge/profiles/<agent>/<accountName>/`:
- **Claude Code:** Automatically sets `CLAUDE_CONFIG_DIR = profileDir` and strips conflicting global environment variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`).
- **Codex:** Automatically sets `CODEX_HOME = profileDir`.
- **Pi:** Automatically sets `PI_CODING_AGENT_DIR = profileDir`.
- **OpenCode:** Sets `OPENCODE_DATA_DIR = profileDir` and `XDG_DATA_HOME = parentDir`.
- **Antigravity:** Sets `ANTIGRAVITY_CONFIG_DIR = profileDir`.

### CLI Usage
```bash
# List all registered accounts with status and active indicators
ab account list [agent] [--json]

# Add an account copying your existing system login (zero re-authentication friction)
ab account add claude work --copy-current

# Add an account and immediately launch interactive login into the isolated folder
ab account add claude personal --login

# Switch default active account for an agent
ab account use claude work          # or: ab account switch claude work

# Remove an account (pass --purge to also delete its profile directory)
ab account remove claude temp --purge

# Proactively inspect quota across all accounts registered for an agent
ab account quota claude
```

### Library API
```js
import {
  listAccounts,
  addAccount,
  setActiveAccount,
  getActiveAccount,
  removeAccount,
  getAccountEnv,
  getAccountsAsPool,
} from '@rodolfonobrega/agentbridge';

// Add new isolated account
const acc = addAccount('claude', 'work', { copyCurrent: true });

// Get env for running a process under that account
const env = getAccountEnv('claude', 'work');

// Convert all accounts directly to an AccountPool config
const poolConfig = getAccountsAsPool();
```

---

## Configuration and safe permission defaults (`ab config`)

AgentBridge adopts a **Least Privilege by Default** architecture by separating the **Permission Ceiling** from the **Default Execution Permission**:
- **Permission Ceiling:** Defaults to `full`. Agents and users can request permissions up to `full` without being blocked.
- **Default Execution Permission:** Defaults to **`read-only`** for safety. If an agent or human runs a command without specifying `--permissions`, the agent cannot modify files or execute destructive shell commands.
- **Explicit Modification:** To allow editing, simply pass `--permissions edit` or `--permissions full`, or configure a persistent default.

### CLI Usage
```bash
# View active configuration and effective defaults
ab config list [--json]

# Change default execution permission to edit (project or global)
ab config set default-permissions edit            # for this project (.agentbridge/config.json)
ab config set default-permissions edit --global   # for your user (~/.agentbridge/config.json)

# Check active value
ab config get default-permissions

# Reset setting back to system default
ab config reset default-permissions

# Set permission ceiling (if you want to strictly restrict all subagents)
ab config set permissions-ceiling edit
```

### Environment Variables
- `AGENTBRIDGE_DEFAULT_PERMS` (or `AGENTBRIDGE_DEFAULT_PERMISSIONS`): Overrides the default permission level (`read-only`, `plan`, `edit`, `full`).
- `AGENTBRIDGE_PERMS_CEILING` (or `AGENTBRIDGE_PERMS`): Overrides the permission ceiling.

---

## TDD auto-repair loop (`ab fix`)

`ab fix` runs an autonomous Test-Driven Development (TDD) repair loop. If your tests fail, AgentBridge takes a git checkpoint, feeds the test failure output to the agent under `edit` permissions, verifies the fix, and automatically retries. If attempts are exhausted without passing, it automatically rolls back your workspace.

### CLI Usage
```bash
# Run tests and let Claude automatically fix any failures
ab fix claude "npm test" --prompt "Fix token renewal expiration bug" --max-attempts 3

# Machine-readable execution history and checkpoints
ab fix claude "pytest" --json
```

### Options:
- `<agent>`: Agent name (`claude`, `codex`, `opencode`, etc.).
- `"<test-command>"`: Shell command that executes tests and exits with code 0 on success.
- `--prompt`: Optional high-level guidance or bug description for the agent.
- `--max-attempts N`: Maximum repair attempts before giving up (default: 3).
- `--json`: Output machine-readable JSON execution history and checkpoints.
- Rollback policy: if every attempt fails, `ab fix` automatically restores the initial git checkpoint (reported as `rolledBack`). There is no CLI flag to disable it; when calling the library `autoRepair()` directly you can pass `autoRollback: false` to keep the edits.

### Library API
```js
import { autoRepair } from '@rodolfonobrega/agentbridge';

const result = await autoRepair({
  agent: 'claude',
  testCommand: 'npm test',
  prompt: 'Fix failing unit tests in auth.test.ts',
  maxAttempts: 3,
  autoRollback: true,
  cwd: process.cwd(),
});

console.log(result.success, result.attempts, result.rolledBack);
```

---

## Multi-agent review loop and consensus (`ab review`, `ab ensemble`)

Cross-model peer verification and ensemble voting for high-assurance tasks.

### 1. Two-Agent Review Loop (`ab review`)
One agent writes the code with `edit` permissions while a second agent acts as reviewer under `read-only` permissions, inspecting generated git diffs and issuing structured `APPROVED` / `REJECTED` verdicts.

```bash
ab review codex claude "Implement sliding window rate limiter in src/limiter.ts" --max-turns 3 --strict
```
- `<coder>`: Agent implementing the solution (`codex`, `claude`, etc.).
- `<reviewer>`: Agent inspecting the diffs (`claude`, `codex`, etc.).
- `--max-turns N`: Maximum implement-and-review feedback cycles (default: 3).
- `--strict`: Requires explicit machine-readable JSON approval verdict.

### 2. Multi-Agent Ensemble Voting & Synthesis (`ab ensemble`)
Runs multiple agents in parallel on the same prompt and computes consensus via plurality voting or a synthesizer judge model.

```bash
# Plurality voting across 3 models
ab ensemble "Analyze database deadlock in query X" claude codex agy

# With a judge in synthesize mode (the judge merges the best of every reply
# into a single unified answer)
ab ensemble "Propose migration architecture" claude codex agy --judge claude --judge-mode synthesize

# With a judge in select mode (the judge picks the single best reply)
ab ensemble "Pick the best migration plan" claude codex agy --judge claude --judge-mode select
```

`--judge-mode` accepts `auto` (default heuristics: select if one candidate is clearly superior, synthesize otherwise), `select` or `synthesize`; the same `judgeMode` (`'auto'` default | `'select'` | `'synthesize'`) is also a `runEnsemble` library option.

### Library API
```js
import { runReviewLoop, runEnsemble } from '@rodolfonobrega/agentbridge';

const review = await runReviewLoop({
  implementer: 'codex',
  reviewer: 'claude',
  task: 'Add retry-with-backoff to the fetch logic',
  maxTurns: 3,
});

const consensus = await runEnsemble({
  prompt: 'What causes EADDRINUSE on port 8080 during reload?',
  agents: ['claude', 'codex', 'agy'],
  judge: 'claude',
  judgeMode: 'synthesize',
});
```

---

## DAG pipeline task orchestrator (`ab pipeline`)

Executes complex multi-agent workflows defined as Directed Acyclic Graphs (DAGs) with topological wave scheduling and dependency resolution.

### Pipeline Definition (`pipeline.json`)
```json
{
  "name": "Feature Implementation Pipeline",
  "steps": [
    {
      "id": "spec",
      "agent": "claude",
      "prompt": "Write architectural spec for cache invalidation",
      "permissions": "plan"
    },
    {
      "id": "impl",
      "agent": "codex",
      "prompt": "Implement cache based on spec: {{steps.spec.output}}",
      "permissions": "edit",
      "dependsOn": ["spec"]
    },
    {
      "id": "tests",
      "agent": "claude",
      "prompt": "Write tests for implementation: {{steps.impl.output}}",
      "permissions": "edit",
      "dependsOn": ["impl"]
    }
  ]
}
```

Only `name` and `steps` are recognized; other JSON keys (e.g. `concurrency`) are silently ignored. `{{steps.<id>.output}}` is the only templating form, and a reference to an unknown or failed step interpolates as an empty string.

### CLI Usage
```bash
ab pipeline pipeline.json [--checkpoint-each] [--auto-rollback] [--cwd path] [--json]
```

### Library API
```js
import { runPipeline } from '@rodolfonobrega/agentbridge';

const result = await runPipeline(pipelineDefinition, {
  cwd: process.cwd(),
  checkpointEach: true, // create a git checkpoint after each wave
  // autoRollback: true, // restore the initial checkpoint when a step fails
});
console.log(result.success, result.durationMs, result.stepResults, result.failedStepId, result.rolledBack);
```

---

## Shared project memory (`ab memory`)

Stores project-specific conventions, rules, and architectural decisions directly in `<cwd>/.agentbridge/memory.json` (with automatic fallback to `~/.agentbridge/memory/<repoHash>.json`). AgentBridge automatically formats and injects these conventions into agent prompts.

### CLI Usage
```bash
# Add an architectural rule
ab memory add "Always use strict TypeScript with zero runtime dependencies"

# Record a technical decision
ab memory decision "database" "Use SQLite with WAL mode" --agent claude

# List current project rules and decisions
ab memory list [--json]

# Clear stored conventions
ab memory clear
```

### Library API
```js
import { loadMemory, addRule, addDecision, formatMemoryForPrompt } from '@rodolfonobrega/agentbridge';

addRule('Do not modify package.json dependencies without confirmation');
addDecision('state-management', 'Adopt Zustand for UI state', 'claude');

// Injects [PROJECT CONVENTIONS & MEMORY] into prompt:
const promptHeader = formatMemoryForPrompt(process.cwd());
```

---

## Proactive quota probing (`ab quota` & `check_quota` MCP tool)

AgentBridge can read a supported provider's remaining quota before dispatch, or wait for a measured reset. This is distinct from error-driven fallback. If no quota flag or fallback threshold is set, AgentBridge does not probe quota; ordinary fallback defaults to `RATE_LIMITED` and can be configured with `--fallback-on RATE_LIMITED,TIMEOUT,AGENT_FAILED`.

### Readers and measurement limits

Proactive percentage measurements cover Claude Code, Codex, Antigravity (`agy`), and conditional Gemini OAuth. AGY's native read-only `/usage` reports model-family pools with five-hour and weekly windows; it does not report individual model budgets. Gemini uses the CLI's internal Code Assist quota protocol and exact model `REQUESTS` buckets. Its window duration is unknown (`windowMinutes: 0`); reset time is included only when returned. Gemini requires an unexpired file-based OAuth credential. Expired or absent OAuth, keychain-only login, API-key auth, and Vertex AI are unknown; credentials are not refreshed or rewritten. Full endpoint details and limitations for all providers are in the [provider quota support matrix](PROVIDER_QUOTA_SUPPORT.md).

Cursor, Grok, Devin, OpenCode, Pi, Ollama, and custom endpoints currently have no supported measured remaining-percentage reader. Usage totals, task caps, API billing credits, and local execution do not establish a remaining OAuth percentage. Explicit unsupported per-route `@N` thresholds are rejected before the primary starts; a final provider without a quota reader can serve as the unmetered fallback without `@N`; a metered route inherits the global threshold unless overridden. A supported provider whose measurement is unavailable is unknown and cannot pass a threshold. Unknown is never treated as 100% remaining.

### Quota-aware CLI routing

```bash
ab run claude "Review and implement this change" --model sonnet --min-remaining-percent 30 \
  --fallback 'agy@15:gemini-3.8-flash-low,codex@20,ollama:qwen2.5-coder:14b'
```

The primary needs at least 30% remaining; AGY and Codex use their own explicit thresholds. Ollama is an ungated explicit fallback. Thresholds are inclusive, and percentages are compared without rounding. A known exhausted secondary window blocks a route. `--wait-for-quota` waits for a measured reset and defaults the primary threshold to 20%; `--max-quota-wait` bounds the wait. A waiting run is not a durable scheduled job and does not resume after its CLI or bridge process restarts.

Fallback triggers default to `RATE_LIMITED`; use `--fallback-on` to include other supported error codes such as `TIMEOUT` or `AGENT_FAILED`. AgentBridge skips fallback if tools have already run under `edit` or `full` permissions, avoiding a repeat of possible side effects.

`check_quota` reports `usedPercent`, `remainingPercent`, `windowMinutes`, and reset fields (epoch milliseconds or `null`), plus `measured`, `supported`, and `source`. Percentage fields can be `null`. Supply `model` for model-aware readers, for example `check_quota({ agent: 'agy', model: 'claude-sonnet-5-5' })`. The MCP tool returns a result envelope; inspect its `structuredContent` or text block, not a bare object assumption. Its `thresholdPercent` is a used-percent health threshold (default 95%; Claude weekly health uses 98%), distinct from route policy's remaining-percent threshold.

```js
dispatch_claude({
  prompt: "Review and implement this change",
  model: "sonnet",
  permissions: "edit",
  fallback: [
    { agent: "agy", model: "gemini-3.8-flash-low", minRemainingPercent: 15 },
    { agent: "codex", minRemainingPercent: 20 },
    { agent: "ollama", model: "qwen2.5-coder:14b" },
  ],
  quotaPolicy: { minRemainingPercent: 30 },
});
```

## Zero-friction IDE & CLI MCP installers (`ab install <target>`)

Registers the AgentBridge MCP server across all supported editors and CLIs with atomic JSON merging preserving existing settings.

### Supported Targets
```bash
ab install cursor         # .cursor/mcp.json and ~/.cursor/mcp.json
ab install vscode         # .vscode/mcp.json and User mcp.json
ab install claude-desktop # claude_desktop_config.json
ab install zed            # ~/.config/zed/settings.json
ab install windsurf       # ~/.codeium/windsurf/mcp_config.json
ab install claude         # claude mcp add-json or workspace .mcp.json
ab install codex          # ~/.codex/config.toml ([mcp_servers.agentbridge])
ab install pi             # ~/.pi/agent/mcp.json
ab install opencode       # opencode.json
ab install agy            # Antigravity CLI agents
ab install all            # Detects and configures all present CLIs on PATH
```

---

## New providers (Cursor, Grok, Gemini, Devin, ACP)

AgentBridge supports an extended roster of modern AI agents and protocols. Current CLI argument mappings and local readiness status for the additional harnesses are recorded in [Harness validation](HARNESS_VALIDATION.md).

| Provider | Identifier | Command | Supported Models |
|---|---|---|---|
| **Cursor CLI** | `cursor` | `cursor-agent --print ...` | `auto`, `gpt-5.3-codex`, `claude-opus-4-8-thinking-high-fast`, `grok-4.7` |
| **xAI Grok** | `grok` | `grok ...` | `grok-4.7`, `grok-4`, `grok-3` |
| **Google Gemini CLI** | `gemini` | `gemini ...` | `gemini-3.5-flash`, `gemini-3-pro-preview`, `gemini-3.1-flash-lite`, `gemini-2.5-flash`, `gemini-2.5-pro` |
| **Devin CLI** | `devin` | `devin run ...` | `default`, `devin-default` |
| **Generic ACP** | `acp` | Configurable ACP stdio | Agent Client Protocol JSON-RPC 2.0 |


---

## Agents calling agents (the MCP bridge)

The bridge is a dependency-free stdio MCP server (`ab bridge`, or `src/bridge/mcp.ts`) that exposes your agents as tools to any other agent:

- `ask_claude`, `ask_codex`, `ask_opencode`, `ask_agy`, `ask_pi`, `ask_cursor`, `ask_grok`, `ask_gemini`, `ask_devin`, `ask_acp` (plus `ask_ollama` and `ask_<endpoint>` for each [HTTP endpoint](#http-endpoints-ollama-and-any-base-url)) — synchronous delegation
- `dispatch_<agent>` for each of those — start asynchronously, get a run id
- `wait_run`, `check_run`, `cancel_run`, `list_runs`, `retain_run`, `release_run` — manage async runs
- `send_message`, `check_messages` — simple inbox between runs/agents

Each `ask_*`/`dispatch_*` tool accepts `prompt`, `model`, `effort`, `permissions`, `cwd`, `timeoutSeconds` (seconds, default 300), `session`, `systemPrompt`, `fallback`, `fallbackOn`, `quotaPolicy`, `offline`, `mcpPassthrough`, `skills`, `transport`, `harness`, `subdelegation`, `yolo` and `dangerouslySkipPermissions`. `dispatch_*` also takes `idempotencyKey` (a repeated key returns the existing run instead of starting a second one). The legacy `timeout` alias treats values of 1000 or more as milliseconds; prefer `timeoutSeconds`. `check_quota` is also exposed. The authoritative schema is whatever `tools/list` returns from `ab bridge`.

The bridge refuses to start more than `AGENTBRIDGE_MAX_PROCS` agent processes at once (default 24); extra calls fail with `RATE_LIMITED`.

### Programmatic subagent

```js
import { runAsSubagent } from '@rodolfonobrega/agentbridge';

// Codex is the caller; it delegates to Claude through the bridge.
const r = await runAsSubagent({
  caller: 'codex',
  callee: 'claude',
  task: 'What is 2+2? Reply with the number only.',   // passed verbatim as the prompt of the ask_claude tool call
  calleeModel: 'haiku',                                // enforced server-side by the bridge
  permissions: 'read-only',
  cwd: process.cwd(),
  timeoutMs: 180_000,
  // also: model, effort (for the caller), depth, maxDepth, childCwd, onEvent
});
console.log(r.delegated, r.meta, r.text);   // r.meta is the server-attested proof that delegation really happened
```

`runAsSubagent` launches the caller with the bridge attached, instructs it to call `ask_<callee>` with your `task`, and verifies an HMAC attestation from the bridge, so a callee that merely *says* it delegated cannot fake it.

### Attaching the bridge to an agent manually

```js
import { ask, mcpConfigFor } from '@rodolfonobrega/agentbridge';

await ask('claude', {
  prompt: 'Use ask_codex to ask codex for a haiku about Node.js, then show me its answer.',
  mcpServers: mcpConfigFor('claude', { depth: 0, maxDepth: 2, permissions: 'read-only', models: { codex: 'gpt-5.6-luna' } }),
});
```

`mcpConfigFor(caller, opts)` options: `depth`, `maxDepth`, `permissions`, `models` (per-callee model enforced server-side, so the calling model cannot override it), `home`, `root`, `childCwd` (forces the callee's cwd), `defaultTimeoutS`.

### Safety rules enforced by the bridge

- **Recursion guard:** `AGENTBRIDGE_MAX_DEPTH` (default 2) limits delegation chains.
- **No permission escalation:** a child may never receive permissions above its parent's (`read-only < plan < edit < full`).
- **Server-side model/cwd pinning** so a delegating LLM cannot widen scope.
- **Attestation:** results carry an HMAC the callee cannot forge; the key is delivered through process environment only, never written to disk or argv.
- **Process-tree cleanup** on abort/timeout.

Run records live in `~/.agentbridge/runs` (override with `AGENTBRIDGE_HOME`).

---

## pi

[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (`npm i -g @earendil-works/pi-coding-agent`) is driven in `--mode json`, with any provider/model it has configured (Ollama, cloud models, API providers):

```bash
ab ask pi "Explain src/core/spawn.ts" --model ollama/glm-5.3-flash:cloud
ab ask pi "Review this" --model anthropic/claude-sonnet-4 --effort high   # effort maps to pi's --thinking level
```

- **Configuration** is read from `PI_CODING_AGENT_DIR` (default `~/.pi/agent`: `models.json`, `auth.json`). Every run gets a private copy of that directory with the MCP servers and settings agentbridge needs; it is deleted afterwards. Set `PI_BIN` if `pi` is not on PATH.
- **Permissions** are enforced with pi's tool denylist (`--exclude-tools`); `read-only`/`plan` remove write, edit and shell tools. Project trust is off (`--no-approve`, no extensions, skills, prompt templates or themes from the working directory), so a hostile `.pi/` folder cannot run code.
- **Sessions** are native (`continue`, `fork`, latest-for-cwd, `ephemeral`) and live in `<AGENTBRIDGE_HOME>/pi-store`. An unknown id fails with `BAD_OPTION`.
- pi can be a caller too (it reaches `ask_*` through its built-in MCP support), and every other agent can call `ask_pi`.
- Caveats: pi has **no sandbox**: `edit` is not confined to the working directory and `plan` is the same as `read-only`. Small local models often ignore tool results, so assert on tool events, not on their prose. Running big local models can exhaust RAM; cloud models avoid that.

## Rate limits and fallback

When an agent runs out of tokens or is throttled (HTTP 429/529, "usage limit", "quota exceeded", "credit balance too low", "overloaded", ...) agentbridge fails with the error code `RATE_LIMITED` (with `retryAfterMs` when the provider says how long) instead of a generic `AGENT_FAILED`. Pass a chain and the task moves on to the next agent:

```bash
ab ask claude "Refactor X" --fallback codex,opencode:opencode-go/glm-5.3-flash --fallback-on RATE_LIMITED,TIMEOUT
```

```js
const r = await ask('claude', { prompt, fallback: ['codex', { agent: 'pi', model: 'ollama/glm-5.3-flash:cloud' }] });
r.fallback // { used: 'codex', attempts: [{ agent: 'claude', code: 'RATE_LIMITED', ... }], contextLost: true }
```

- Entries are `agent`, `agent:model` (split at the first colon), `agent@N:model` (per-route inclusive remaining quota threshold), or `{ agent, model, minRemainingPercent? }`. `fallbackOn` defaults to `RATE_LIMITED`.
- A fallback starts a **new session** with its own model; effort and `extraArgs` are not carried over (they are agent-specific), and the result says so with `contextLost`.
- **Side-effect guard:** if the failed attempt already ran tools under `edit`/`full` permissions, the chain stops instead of re-running the task on a half-changed tree.
- Works in the library, the CLI (`--fallback`, also on `ab serve`), the MCP `ask_*` tools (`fallback` argument) and the proxy (which answers 429 with `retry-after`). Telemetry and context policy are attributed to the agent that actually answered.
- Limitation: the exact wording of each vendor's real limit message could not be provoked live; classification is tested with the vendors' documented messages plus a real HTTP 429 fixture.

## Antigravity CLI (`agy`)

`agy` is driven in headless mode (`--input-format stream-json --output-format stream-json`) with the same options as the other agents:

```bash
ab ask agy "Explain src/core/spawn.ts" --model gemini-3.8-flash-low
ab ask agy "Review this" --model gemini-3.8-flash --effort high    # base model + effort
agy models                                                         # lists the available models (Gemini, Claude, GPT-OSS)
```

Things worth knowing (details and evidence in `acceptance/ADAPTER_NOTES.md`):

- **Permissions are enforced by agentbridge.** agy itself has no flag that stops file writes (even `--mode plan` and `--sandbox` do not), so every run gets a private, throw-away HOME with deny rules: `read-only` and `plan` allow no file writes and no commands; `edit` allows file writes but no commands; `full` allows everything. Your own global agy settings, hooks and MCP servers are never touched or used, and your agy login keeps working because it is not stored under HOME. **Project-level config is a different story:** agy starts the MCP servers in `<cwd>/.agents/mcp_config.json` (and reads `.agents/hooks.json`) before any rule applies, so a non-`full` run is **refused** (`BAD_OPTION`) in a directory that has one, and `edit` cannot create it.
- **Sessions** are shared between runs through a persistent store (`<AGENTBRIDGE_HOME>/agy-store`), so `continue` works across processes. `fork` is **not supported** (agy rejects copied conversations) and throws `BAD_OPTION`; `handoff()` and `compact()` therefore summarize an agy session by appending the summary request to it.
- **Models:** a slug ending in `-low`, `-medium` or `-high` already includes its effort. Use the base slug (`gemini-3.8-flash`) together with `effort`, or the suffixed slug alone; combining them throws `BAD_OPTION`.
- `systemPrompt` is delivered through agy's global rules file (`GEMINI.md`) inside the private home, which the model obeys reliably (a prefix in the user message did not). `jsonSchema` is native.
- agy can be a caller too: it reaches the bridge's `ask_*` tools, and the other agents can call `ask_agy`.
- Open items: URL reads are not denied in `read-only` (as with the other agents' web tools), and subagent activity inside agy emits no tool events.
- Caveats: `edit` cannot be strictly confined to the working directory (agy decides its own workspace boundary); in `full` the commands agy runs see the isolated HOME (no global git config); verified on Windows only.

## Using it from Claude Code (subagents and dynamic workflows)

Claude Code subagents and workflow-spawned agents inherit the MCP tools of the main session. So once the agentbridge bridge is registered as an MCP server in Claude Code, anything running inside it (a subagent, or an agent started by a [dynamic workflow](https://code.claude.com/docs/en/workflows.md)) can call `mcp__agentbridge__ask_codex`, `ask_opencode`, `ask_ollama`, etc.

```bash
cd /path/to/your/project
ab install claude                          # project scope: writes .mcp.json and .claude/agents/*.md
ab install claude --scope user             # all projects: registers in your user config, agents in ~/.claude/agents
ab install claude --permissions edit      # let delegated agents edit files (the ceiling itself defaults to full)
ab install claude --max-depth 1            # limit how deep delegation chains can go
```

What it does:

1. Registers an MCP server named `agentbridge` (`claude mcp add-json`) that runs `ab bridge`, with a **permission ceiling** (`AGENTBRIDGE_PERMS`, default `full`) and a **default execution permission** (`AGENTBRIDGE_DEFAULT_PERMS`, default `read-only`): delegated runs get `read-only` unless they explicitly ask for more, and can never exceed the ceiling.
2. Writes relay subagents `codex-agent`, `opencode-agent`, `agy-agent`, `ollama-agent` (and one per extra endpoint you configured). Each one is a thin Haiku-powered relay whose only job is to forward the task to the matching `ask_*` tool and return the answer verbatim.

Project-scope MCP servers need a one-time approval the first time you open Claude Code in that folder. Restart Claude Code afterwards.

Using it:

```text
> Use the codex-agent subagent to review src/auth.ts, and the ollama-agent (model qwen3:14b) to summarize it.
```

In a dynamic workflow (`.claude/workflows/*.js`), spawned agents can call the same tools, for example by telling an agent to use `mcp__agentbridge__ask_codex` in its prompt, or by running the relay subagents. Because delegation goes through the bridge, you keep the safety rules below (depth limit, no permission escalation, attested results).

Verified live: a Claude Code session delegating through the installed `codex-agent` produced a new Codex session containing the forwarded prompt, and `ollama-agent` produced a server-attested `ask_ollama` result. Dynamic workflows themselves were not run end to end in this project's tests; the documented behavior that workflow agents inherit MCP tools is what this relies on.

---

## HTTP endpoints: Ollama and any base URL

Besides the built-in coding-agent CLIs, agentbridge can talk to any **chat-model HTTP endpoint** that speaks the OpenAI (`/chat/completions`) or Anthropic (`/v1/messages`) protocol: Ollama, vLLM, LM Studio, LiteLLM, OpenRouter, or a model server on another machine. Each endpoint becomes a named agent that works everywhere an agent name works.

`ollama` exists out of the box (`http://127.0.0.1:11434/v1`, or `OLLAMA_HOST` if set). Add others:

```bash
ab endpoint add lab_gpu http://192.168.1.50:11434/v1 --model qwen3:14b          # Ollama on another machine
ab endpoint add vllm https://models.example.com/v1 --api-key-env VLLM_KEY       # key read from an env var
ab endpoint add gateway https://gw.example.com --type anthropic --model my-model
ab endpoint list
ab endpoint remove lab_gpu
```

Or edit `~/.agentbridge/endpoints.json` directly:

```json
{
  "lab_gpu": { "baseUrl": "http://192.168.1.50:11434/v1", "defaultModel": "qwen3:14b" },
  "vllm":    { "baseUrl": "https://models.example.com/v1", "apiKeyEnv": "VLLM_KEY" },
  "gateway": { "type": "anthropic", "baseUrl": "https://gw.example.com", "headers": { "x-team": "ai" } }
}
```

Fields: `baseUrl` (required, http/https), `type` (`openai` default, or `anthropic`), `defaultModel`, `apiKeyEnv` (name of an env var; preferred) or `apiKey` (stored in plain text), `headers`. Names start with a lowercase letter and contain at most 32 lowercase letters, digits and `_` (`^[a-z][a-z0-9_]{0,31}$`), and cannot be any of the ten built-in agent names (`claude`, `codex`, `opencode`, `agy`, `pi`, `cursor`, `grok`, `gemini`, `devin`, `acp`).

Use them like any agent:

```bash
ab ask ollama "Explain monads in two sentences" --model qwen3:14b
ab fanout "Review this function" claude:haiku codex ollama:qwen3:14b lab_gpu
```

```js
import { ask, fanout } from '@rodolfonobrega/agentbridge';
const r = await ask('lab_gpu', { prompt: 'Hello', model: 'qwen3:14b', session: { mode: 'new' } });
```

From inside Claude Code, Codex or OpenCode (through the bridge) they appear as `ask_ollama`, `dispatch_ollama`, `ask_lab_gpu`, ... Run `ab install claude` again after adding endpoints to get matching relay subagents.

What endpoints support:

- Streaming text (and `thinking` for reasoning models), usage from the server, `model` (omitted = `defaultModel`, else the first model the server lists), `systemPrompt`, `timeoutMs`, `signal`, `jsonSchema` (openai type), `effort`.
- **Sessions are emulated locally**: the history is stored in `~/.agentbridge/endpoint-sessions/` and replayed each call. `new`, `ephemeral`, `continue` (with or without id) and `fork` behave like the other agents.
- **Execution Harnesses for Tools and File Edits:** When `--permissions edit`, `--permissions full`, or `--harness <auto|claude|pi>` is passed, AgentBridge automatically drives the endpoint through an installed coding agent harness:
  - `--harness auto`: picks `claude` for Anthropic-compatible endpoints (`type: anthropic`, ollama, openrouter, or a base URL containing ollama/openrouter) when Claude Code is installed; anything else (OpenAI-type: vLLM, LM Studio, custom gateways) falls back to `pi`, and with neither harness CLI installed the run fails with `NOT_INSTALLED`.
  - `--harness claude`: runs via Claude Code CLI (`claude -p`), passing the endpoint as `ANTHROPIC_BASE_URL`, enabling all of Claude Code's file editing and execution tools for the model.
  - `--harness pi`: runs via the Pi CLI configured for the model.
  - `--harness none`: enforces direct HTTP API calls (plain chat without filesystem tools, maximum speed).

```bash
# Run Ollama using Claude Code harness to edit files:
ab run ollama "Fix auth bug in src/auth.ts" --permissions edit --harness claude --model glm-5.3-flash:cloud

# Run Ollama with auto harness selection:
ab run ollama "Create hello.txt with greeting" --permissions edit --model qwen2.5-coder:latest
```

### OpenRouter Integration Guide

OpenRouter (`https://openrouter.ai`) gives you access to hundreds of AI models (Claude 3.5 Sonnet, DeepSeek R1, Qwen 2.5 Coder, GPT-4o, Llama 3.3, Gemini 2.0 Flash) through a single unified account and API key.

AgentBridge supports OpenRouter in both direct chat mode and full coding harness mode:

#### 1. Setup OpenRouter Endpoint
Register OpenRouter in your AgentBridge endpoint registry:
```bash
# Add endpoint with default model and key read from environment:
ab endpoint add openrouter https://openrouter.ai/api/v1 --api-key-env OPENROUTER_API_KEY --model anthropic/claude-sonnet-5.5

# Set your API key in your environment:
export OPENROUTER_API_KEY="sk-or-v1-..."        # Linux/macOS
$env:OPENROUTER_API_KEY = "sk-or-v1-..."        # Windows PowerShell
```

#### 2. Fast Direct API Mode (Plain Chat)
Use direct API when you want fast answers, code reviews, or JSON schemas without spawning local CLI harnesses:
```bash
ab ask openrouter "Explique como funciona o algoritmo Raft" --model deepseek/deepseek-r1
ab ask openrouter "Escreva um benchmark em Go" --model qwen/qwen-2.5-coder-32b-instruct
```

#### 3. Agent Harness Mode (Tools, File Reads, Web Search & File Edits)
When you want the OpenRouter model to act as a **full coding agent** with tool execution:
- **With Claude Code Harness (`--harness claude`):**
  AgentBridge configures Claude Code to route requests through OpenRouter's Anthropic Messages API (`https://openrouter.ai/api/v1/messages`), injecting your `OPENROUTER_API_KEY` and target model. The OpenRouter model receives Claude Code's tools (`Read`, `Glob`, `Grep`, `WebSearch`, and `Edit` when permitted):
  ```bash
  # Read files and search web (read-only):
  ab ask openrouter "Revise src/core/spawn.ts e pesquise por memory leaks" --harness claude --model anthropic/claude-sonnet-5.5

  # Edit and refactor files:
  ab run openrouter "Refatore src/auth.ts e adicione testes" --permissions edit --harness claude --model anthropic/claude-sonnet-5.5
  ```
- **With Pi Harness (`--harness pi`):**
  AgentBridge automatically prefixes the model as `openrouter/<model>` and drives Pi with tool execution:
  ```bash
  ab run openrouter "Create the file config.json" --permissions edit --harness pi --model deepseek/deepseek-chat
  ```

#### 4. Delegating via MCP
Once added, `openrouter` is automatically available to Claude Code, Codex, and OpenCode via MCP:
- `mcp__agentbridge__ask_openrouter(prompt="...", permissions="edit", model="deepseek/deepseek-r1")`
- `mcp__agentbridge__dispatch_openrouter(prompt="...", permissions="read-only", model="qwen/qwen-2.5-coder-32b-instruct")`

---

## Telemetry, context policy and handoff

Wrap runs with telemetry to track context size, tool counts, cost (when reported), and run status.

```js
import { askWithTelemetry, stats, contextOf, setPolicy, compact, handoff } from '@rodolfonobrega/agentbridge';

const r = await askWithTelemetry('claude', { prompt: 'Work on the task', cwd }, {
  hooks: { finish: [{ http: 'http://127.0.0.1:9000/done' }] },
  policy: { warn: 0.7 },
});

contextOf(r.sessionId);   // {tokens, exact, source, window, windowSource, pct}
stats();                  // global + per agent + per session + per run
```

### Context policy (controlling auto-compact)

Thresholds `warn`, `compact`, `hard`: a number `<= 1` is a fraction of the context window, `> 1` is absolute tokens. Policies resolve in this order (later wins):

`defaults < global < per-agent < per-session < inline (policy option)`

| Key | Meaning |
|---|---|
| `warn` | Emit a context-warning event/hook (default `0.7`) |
| `compact` | Threshold at which `autoCompact` triggers |
| `hard` | Refuse to continue the session (`AGENT_FAILED`, `.reason === 'CONTEXT_HARD_LIMIT'`) |
| `autoCompact` | `true` to compact automatically at `compact` (default `false`) |
| `hardAction` | `'block'` (default) or `'handoff'` to hand off to another agent at `hard` |
| `handoffTo` | Target agent for `hardAction: 'handoff'` |

```js
setPolicy(null, { warn: 0.6, compact: 0.8, autoCompact: true });                     // global default
setPolicy({ agent: 'codex' }, { compact: 0.7, hard: 0.9, hardAction: 'handoff', handoffTo: 'claude' });
setPolicy({ session: 'abc123' }, { autoCompact: false });                            // one session only
```

Auto-compact is **off by default**; you opt in explicitly.

### Compaction

`compact(sessionId, { agent, method: 'auto' | 'native' | 'summarize' })`

- **claude:** native `/compact` through `--resume` (same session id). Because the summary alone understates real size, one tiny follow-up call measures the true size.
- **codex / opencode:** no non-interactive compact exists, so agentbridge does summarize-and-continue: it asks a **fork** of the session for a handoff document and seeds a new session on the same agent (the original is untouched). The new `sessionId` is returned.

### Cross-agent handoff

```js
const h = await handoff(sessionId, 'codex', { agent: 'claude' });
console.log(h.path, h.newSessionId);   // markdown doc in ~/.agentbridge/handoffs/, plus a new codex session seeded with it
```

The handoff document contains Summary, Key facts and decisions, Key files and Open tasks. Files are merged from the model's own list and the files actually touched per telemetry. If the source session cannot be summarized, a clearly flagged `degraded` document is built from recorded telemetry.

CLI: `ab context <session>`, `ab handoff <session> --to codex`, `ab stats`, `ab top`.

State is stored in `~/.agentbridge/` (override with `AGENTBRIDGE_HOME`). More detail: [TELEMETRY.md](TELEMETRY.md).

## Hooks

Events: `start`, `finish`, `error`, `timeout`, `context-threshold` (`'*'` for all). Hook specs:

- a function `(summary, event) => {}`
- `{ command, args, timeoutMs }` — JSON summary on stdin and `AB_EVENT`, `AB_RUN_ID`, `AB_AGENT`, `AB_STATUS`, `AB_SESSION_ID` env vars; no shell
- `{ file: dir }` — writes `<runId>.<event>.json` atomically
- `{ http: 'http://127.0.0.1:PORT/path' }` — POST; loopback only

Global hooks can live in `~/.agentbridge/hooks.json` and are merged with per-call hooks. Hook failures never affect the run, and every hook has a timeout (default 10s).

```js
import { wait } from '@rodolfonobrega/agentbridge';
const summary = await wait(runIdOrSessionId, { timeoutMs: 60_000 });   // works across processes
```

---

## OpenAI / Anthropic compatible proxy

Serve your logged-in agents' models as a local API.

```bash
ab serve --port 8787                       # or: node dist/server/index.js --port 8787
ab serve --port 8787 --token SECRET        # require a bearer token
```

```js
// OpenAI SDK
import OpenAI from 'openai';
const openai = new OpenAI({ baseURL: 'http://127.0.0.1:8787/v1', apiKey: 'SECRET-or-anything' });
const res = await openai.chat.completions.create({ model: 'claude/haiku', messages: [{ role: 'user', content: 'Hello' }] });

// Anthropic SDK
import Anthropic from '@anthropic-ai/sdk';
const anthropic = new Anthropic({ baseURL: 'http://127.0.0.1:8787', apiKey: 'SECRET-or-anything' });
const msg = await anthropic.messages.create({ model: 'codex/gpt-5.6-luna', max_tokens: 256, messages: [{ role: 'user', content: 'Hello' }] });
```

Programmatic start: `import { startProxy } from '@rodolfonobrega/agentbridge'; const p = await startProxy({ port: 0 });`

| Route | Notes |
|---|---|
| `POST /v1/chat/completions` | Streaming (SSE) and non-streaming |
| `POST /v1/responses` | Streaming and non-streaming |
| `POST /v1/messages` | Anthropic Messages, full event sequence |
| `POST /v1/messages/count_tokens` | Estimate only (~chars/4) |
| `GET /v1/models` | OpenAI list, or Anthropic list when Anthropic headers are present |

**Model routing:** `claude/<model>`, `codex/<model>`, `agy/<model>`, `pi/<provider>/<model>`, `opencode/<provider>/<model>`, `cursor|grok|gemini|devin|acp/<model>` when that CLI is installed, and `<endpoint>/<model>` for any configured HTTP endpoint (e.g. `ollama/qwen3:14b`). Bare names are routed by heuristic: the claude aliases `sonnet`, `haiku`, `opus`, `opusplan`, `best` and `claude-*` go to claude; `gpt-*`, `o1`/`o3`/`o4`, `codex*` and `chatgpt*` go to codex; anything containing `/` goes to opencode; when Ollama is configured, `glm-*`, `qwen*`, `llama*`, `deepseek*` and names with a `:cloud`/`:latest`/`:Nb` suffix go to the `ollama` endpoint; otherwise 404.

**Also in the proxy:** client tool calling (claude via an MCP bridge, other agents via validated prompt emulation), an isolated-worktree **agent mode** (`agent/` prefix or `/agent/v1`, needs `--agent-root` and a token, returns a diff, `apply` is explicit), `max_tokens`/`stop` enforcement with real `finish_reason`, `x-ab-session` resume, a hot-reloaded `--config` (aliases, payload rules), an opt-in account pool (`--accounts` + `--accept-tos-risk`) and `/admin/status`, `/admin/usage`, `--log`.

**Important limits:** without `x-ab-session` multi-turn messages are flattened into one prompt (each request is stateless); `temperature`, `top_p`, `seed` are ignored (listed in `x-agentbridge-ignored`); tool-mode replies are buffered; images reach only claude, codex and opencode (others get a placeholder and a warning header); the server binds to `127.0.0.1` only unless you pass `--allow-non-loopback`. Full list in [PROXY.md](PROXY.md).

---

## Adding more providers

- **Anything with an OpenAI- or Anthropic-compatible HTTP API** (Ollama, vLLM, LM Studio, LiteLLM, OpenRouter, a company gateway): no code, just `ab endpoint add <name> <baseUrl>`.
- **A new agent CLI**: write an adapter (about 200 to 600 lines, built on the shared `spawnProc` helper) and register it in a handful of files. It is feasible only if the CLI has a headless mode with structured output, ideally resumable sessions, and local login reuse.

The full guide, with the checklist, a code skeleton, the files to register in and the tests to write, is in [EXTENDING.md](EXTENDING.md).

## Environment variables

| Variable | Purpose |
|---|---|
| `AGENTBRIDGE_HOME` | State directory (default `~/.agentbridge`) |
| `AGY_BIN` | Full path to the `agy` executable if it is not on PATH |
| `AGENTBRIDGE_TOKEN` | Bearer token for the proxy (same as `--token`) |
| `OLLAMA_HOST` | Base address for the built-in `ollama` endpoint (e.g. `192.168.1.50:11434`) |
| `AGENTBRIDGE_MAX_DEPTH` | Max delegation depth in the bridge (default `2`) |
| `AGENTBRIDGE_DEPTH` | Current depth (set by the bridge) |
| `AGENTBRIDGE_PERMS` | Caller permission ceiling (set by the bridge) |
| `AGENTBRIDGE_MODEL_<AGENT>` | Pins the callee model server-side (e.g. `AGENTBRIDGE_MODEL_CODEX`) |
| `AGENTBRIDGE_CHILD_CWD` | Forces callee working directory |
| `AGENTBRIDGE_DEFAULT_TIMEOUT_S` | Default bridge call timeout (default `300`) |
| `AGENTBRIDGE_ROOT`, `AGENTBRIDGE_ATTEST_BIND`, `AGENTBRIDGE_ATTEST_KEY` | Run-tree root and attestation. Set by the bridge for subagents; `AGENTBRIDGE_ROOT` also bounds which working directories the checkpoint tools and dashboard accept. Do not set manually |
| `AGENTBRIDGE_MAX_PROCS` | Maximum agent processes alive at once in one AgentBridge process (default 24, `0` = unlimited). Beyond it a spawn fails with `RATE_LIMITED` (HTTP 429 in the proxy) |
| `AGENTBRIDGE_RUN_MAX_AGE_MS`, `AGENTBRIDGE_RUN_MAX_COUNT` | Retention for bridge run records (default 7 days, 500) |
| `AGENTBRIDGE_ACCEPT_TOS_RISK` | Same as `--accept-tos-risk` for the proxy account pool |

## Testing

Acceptance tests run **real** agents (never mocked) and therefore need the CLIs installed and logged in; some tests make many live calls and can take several minutes.

```bash
npm run accept                       # runs the acceptance suite (acceptance/run.mjs)
node --test acceptance/core.test.mjs # a single file
```

Test files: `core`, `claude`, `codex`, `opencode`, `pi`, `fallback`, `agy` (adapter, permissions, sessions, bridge, proxy, telemetry, handoff and 7 caller x callee pairs), `bridge`, `pairs` (all 9 caller x callee combinations), `registry`, `keydelivery`, `proxy`, `cli`, `extras`, `telemetry`, `context`, `hooks`, `endpoint` (real Ollama; skipped with a message if it is not running). Honest notes about residual limitations are in `acceptance/ADAPTER_NOTES.md`.

## Project layout

```
src/                TypeScript source; compiled to dist/ for publishing on npm
  index.ts          public API
  core/             errors, normalized events, hardened process spawning, checkpointing, config
  adapters/         claude.ts, codex.ts, opencode.ts, agy.ts, pi.ts, endpoint.ts (Ollama / any HTTP base URL), cursor.ts, grok.ts, gemini.ts, devin.ts, acp.ts
  bridge/           MCP bridge server, attach helper, subagent runner, run registry
  extras/           parallel (fanout/race), schema, worktree, budget, doctor, pipeline, consensus (review/ensemble), repair
  telemetry/        stats, context policy/compact/handoff, hooks, tracking, project memory
  quota/            proactive quota probing (Anthropic OAuth usage, Codex usage backend)
  server/           OpenAI + Anthropic compatible proxy
  ui/               `ab ui` local dashboard server
  types/            shared option/event/result types
  cli/              `agentbridge` / `ab` command (+ install.ts, install-ide.ts, setup.ts, accounts.ts)
docs/                PROXY.md, TELEMETRY.md, EXTENDING.md
acceptance/          real-agent acceptance tests and notes
CONTRACT.md          the binding spec for adapters, options, events and errors
```

## Known limitations

- **Codex has no incremental streaming** in its `--json` mode, so `text` arrives in large chunks rather than token by token. This is a CLI limitation, documented rather than faked.
- **OpenCode latency varies** with the backend model/provider; use generous timeouts for slow models. A stall detector aborts a run that makes no progress.
- **Quota probing is provider-specific:** see [Proactive quota probing](#proactive-quota-probing-ab-quota--check_quota-mcp-tool) and the [provider quota support matrix](PROVIDER_QUOTA_SUPPORT.md). Unsupported and unavailable measurements do not count as available quota.
- **Compaction for codex/opencode is summarize-and-continue** (a new session), not in-place compaction.
- **Proxy:** tool-mode replies are buffered; stateless requests without `x-ab-session`; ignored sampling parameters (see above).
- Codex fork/`exec resume` behavior depends on the installed CLI version.
- **pi**: no sandbox (`edit` is not confined to cwd, `plan` = `read-only`); tests were run against a cloud model through Ollama.
- **Rate limits**: `RATE_LIMITED` is detected from error text/HTTP status; a vendor changing its wording would fall back to `AGENT_FAILED` (add the pattern to `src/core/errors.ts`).
- **agy**: no `fork`, `edit` is not strictly confined to cwd, `systemPrompt` goes through the rules file rather than a true system role, and quota/rate-limit errors surface as `AGENT_FAILED` with agy's own message. Its login could only be checked on a logged-in Windows machine.
- **HTTP endpoints are plain chat by default**: no tools/MCP/file access unless a harness (`--harness claude|pi`) drives them, and locally emulated sessions (they are exposed through the proxy as `<endpoint>/<model>` when configured). Context telemetry for their sessions falls back to run-usage aggregates.
- **Claude Code relay subagents** depend on a small model following the "just forward it" instruction; the installed prompt makes it strict (and it reports `AGENTBRIDGE TOOL UNAVAILABLE` rather than answering itself), but you can always call `mcp__agentbridge__ask_*` directly.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `NOT_INSTALLED` | The CLI is not on `PATH`. Run `ab doctor`. |
| `NOT_LOGGED_IN` | Log in with the CLI itself (`claude`, `codex login`, `opencode auth login`, `agy`, `pi` + `/login`), then re-run `ab doctor`. |
| `TIMEOUT` on OpenCode | Raise `timeoutMs`; the backend model may be slow. |
| `BAD_OPTION 'session busy'` | Another call is using that OpenCode session; wait or use a different/forked session. |
| `Recursion guard` error in the bridge | Delegation exceeded `AGENTBRIDGE_MAX_DEPTH`; raise it deliberately if needed. |
| Child requests higher permissions | Permissions cannot exceed the caller's; raise the top-level `permissions`. |
| `Cannot reach ollama at ...` | Start the server (`ollama serve` or the Ollama app), or fix `OLLAMA_HOST` / the endpoint `baseUrl`. |
| Endpoint says model not found (`BAD_OPTION`) | Check `ollama list` (or the server's `/v1/models`) and pass the exact name with `--model`. |
| Claude Code does not show the agentbridge tools | Restart Claude Code; for project scope approve the server on first open (`claude mcp get agentbridge`). |
| Relay subagent answers by itself instead of delegating | Re-run `ab install claude` to refresh the agent files, or call `mcp__agentbridge__ask_<name>` directly. |
| Proxy returns 401 | Missing/wrong bearer token (`Authorization: Bearer` or `x-api-key`). |
| Proxy returns 400 `tools_not_supported` | Only `function` tools are supported (hosted tools like `web_search` are not), and client tools cannot be combined with agent mode. |
| Proxy returns 403 `agent_mode_disabled` / `agent_mode_needs_token` | Start the proxy with `--agent-root <dir>` and a `--token` to use `agent/` models. |
| `--worktree` fails | Ensure `git` is installed and `cwd` is inside a git repository. |

## License

[MIT](LICENSE)
