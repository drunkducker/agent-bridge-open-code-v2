# AgentBridge

![AgentBridge connecting coding agents](docs/img/hero.png)

A uniform interface to the coding-agent CLIs you already have installed and logged in to: Claude Code, Codex, OpenCode, Antigravity (`agy`), pi, Cursor, Grok, Gemini, Devin, any Agent Client Protocol agent, and HTTP models such as Ollama.

AgentBridge spawns the real CLI, normalizes its events, results, errors, sessions and permissions, and exposes the result as a command line, a TypeScript library, an MCP server, and an OpenAI/Anthropic-compatible HTTP proxy. It uses each tool's own login. It does not need API keys and has no runtime dependencies.

```bash
ab ask claude "Review src/auth.ts for security bugs"
ab ask codex  "Write tests for it" --permissions edit
ab ask claude "Large refactor" --fallback codex,pi      # next agent takes over on a rate limit
ab race "Fix the flaky test" claude:haiku codex opencode # first accepted answer wins
```

Node.js 22 or newer. Linux, macOS and Windows. MIT licensed.

> **Coding agent reading this repository?** Read [README_AI.md](README_AI.md) for operational instructions.

## Contents

- [Why it exists](#why-it-exists)
- [Install](#install)
- [Quickstart](#quickstart)
- [Core concepts](#core-concepts)
- [Agents calling agents (MCP bridge)](#agents-calling-agents-mcp-bridge)
- [Fallback and quota-aware routing](#fallback-and-quota-aware-routing)
- [Harness proxy (`ab serve`)](#harness-proxy-ab-serve)
- [Other features](#other-features)
- [Supported agents](#supported-agents)
- [Security and privacy](#security-and-privacy)
- [Documentation](#documentation)
- [Development](#development)

## Why it exists

Each coding-agent CLI has its own flags, configuration directories, session model, permission model and output format. Combining them means maintaining shell glue, and when one hits a usage limit mid-task you start over in another tool.

AgentBridge puts one contract in front of all of them, so that:

- one command, library call or MCP tool drives any agent with the same options (`model`, `effort`, `permissions`, `session`, `timeoutMs`, `cwd`);
- an agent can delegate to another agent as a subagent, with permissions that can only narrow;
- a task can move to the next agent in a chain when the first one is rate limited or out of quota;
- existing applications that speak the OpenAI or Anthropic API can use an agent harness as their backend.

## Install

```bash
npm install -g @rodolfonobrega/agentbridge     # provides `ab` and `agentbridge`
# or, without installing:
npx @rodolfonobrega/agentbridge setup
```

From source:

```bash
git clone https://github.com/rodolfonobrega/agentbridge.git
cd agentbridge
npm ci && npm run build && npm link
```

You need at least one supported agent CLI installed and logged in (`claude`, `codex`, `opencode`, `agy`, `pi`, ...) or a reachable Ollama server. Missing agents are skipped, not errors.

**Updating.** `npm update -g @rodolfonobrega/agentbridge` updates the package but not copies of the `agentbridge-delegate` skill already installed into agent skill directories. Run `ab setup` and choose the skill option to refresh them. AgentBridge warns on stderr, in interactive use, when an installed copy is stale; it never updates skills or agent configuration on its own.

## Quickstart

```bash
ab setup            # detects installed agents, installs the MCP bridge and skill, sets a permission ceiling
ab doctor           # checks each CLI, login and model list; add --live for one tiny real call per agent
ab ask claude "Reply with exactly: PONG"
ab run opencode "Explain main.js" --stream
```

From code:

```js
import { ask, run, fanout, race } from '@rodolfonobrega/agentbridge';

const r = await ask('claude', { prompt: 'Say hi', model: 'haiku' });
console.log(r.text, r.usage, r.sessionId);

const { winner } = await race(['claude:haiku', 'codex', 'opencode'], { prompt: 'Name three primes' });
const { results } = await fanout(['claude:haiku', 'codex'], { prompt: 'Review src/auth.ts' });
```

## Core concepts

**One option set.** `model`, `effort` (`low` to `max`, mapped per agent), `permissions`, `cwd`, `timeoutMs`, `systemPrompt`, `jsonSchema`, `session`, `mcpServers`, `env`, `extraArgs`, `fallback`. Each adapter maps them onto the CLI's own flags; options an agent cannot honor are rejected or reported, not silently dropped.

**Normalized output.** Streaming events (`text`, `tool`, `usage`, `fallback`, ...) and a final result (`text`, `sessionId`, `usage`, `model`, `structured`, `fallback`). Failures are typed: `NOT_INSTALLED`, `NOT_LOGGED_IN`, `TIMEOUT`, `ABORTED`, `BAD_OPTION`, `RATE_LIMITED`, `AGENT_FAILED`. `jsonSchema` output is validated and repaired with one retry.

**Permissions.** `read-only` (default), `plan`, `edit`, `full`. AgentBridge requests the level through each harness's own controls (Claude permission modes, Codex sandbox modes, OpenCode/pi/agy tool rules). Enforcement strength differs by agent, and generic adapters may rely on prompt guidance, so `read-only` is not an operating-system sandbox. `edit` allows file changes but no shell commands; use `full` for tasks that must run commands. An operator-set ceiling bounds everything, including subagents. See [harness validation](docs/HARNESS_VALIDATION.md).

**Sessions.** `new`, `ephemeral`, `continue` (by id, or latest for the working directory) and `fork` where the agent supports it. The agent's own session store is used, so sessions are visible in that tool's resume list.

**Telemetry.** Runs, tokens, cost and context pressure are recorded locally under `~/.agentbridge/` and shown by `ab ps`, `ab top`, `ab stats` and the dashboard (`ab ui`). See [docs/TELEMETRY.md](docs/TELEMETRY.md).

![Dashboard](docs/img/dashboard.png)

<sub>`ab ui`, shown with sample data from `scripts/demo-data.mjs`.</sub>

## Agents calling agents (MCP bridge)

`ab install <target>` registers an MCP server (`ab bridge`) with Claude Code, Codex, OpenCode, Antigravity, pi, Cursor, VS Code, Zed, Windsurf or Claude Desktop (`ab install all` for every installed one). The host agent then gets `ask_<agent>` (blocking) and `dispatch_<agent>` (returns a run id) tools, plus `wait_run`, `check_run`, `cancel_run`, `list_runs`, `retain_run`, `release_run`, `send_message`, `check_messages` and checkpoint tools.

- Install scope defaults to the current project; pass `--scope user` for a global install.
- Delegation depth is capped by `AGENTBRIDGE_MAX_DEPTH` (default 2). A subagent can never exceed its caller's permissions.
- Results carry an HMAC attestation line (`[agentbridge] ...`); filter it from answer text.
- `wait_run` blocks at most 30 seconds per call. A wait timeout does not stop the run. There is no completion push: poll until `done`, `error`, `lost` or `cancelled`.
- `send_message`/`check_messages` are a mailbox, not prompt injection into a running agent.
- Subagents do not inherit the host's MCP servers or skills by default; see [README_AI.md](README_AI.md#6-harness-isolation-mcps-skills--tool-readiness-check).

The bundled `agentbridge-delegate` skill teaches host agents how to use these tools.

## Fallback and quota-aware routing

```bash
# Error-driven: on RATE_LIMITED, try the next agent
ab ask codex "Refactor the auth flow" --fallback claude,pi,ollama:qwen2.5-coder:14b

# Quota-aware: require 30% remaining on the primary, 15% on agy, 20% on codex
ab run claude "Implement the change" --permissions edit --min-remaining-percent 30 \
  --fallback 'agy@15:gemini-3.8-flash-low,codex@20,ollama:qwen2.5-coder:14b'

# Wait up to 45 minutes for a measured quota reset
ab run claude "Review the release" --wait-for-quota --max-quota-wait 2700
```

- HTTP 429/529 and provider quota errors map to `RATE_LIMITED` (with `retryAfterMs` when known). Change the triggering codes with `--fallback-on`.
- Measured quota percentages exist for Claude, Codex, Antigravity and, conditionally, Gemini OAuth. Unknown or unsupported measurements never count as available quota. See the [provider support matrix](docs/PROVIDER_QUOTA_SUPPORT.md).
- Without a quota flag or `@N` threshold, quota is not checked and only errors trigger fallback.
- A run is not retried on another agent after tools have already run under `edit` or `full`, because the work may have been partially applied. The result reports `fallback: { used, attempts, contextLost }`.
- The same policy is available in the library (`quotaPolicy`), MCP dispatch tools and the proxy.

## Harness proxy (`ab serve`)

```bash
ab serve --port 8787 --token "$TOKEN"
```

`ab serve` exposes the agent CLIs as an OpenAI-compatible (`/v1/chat/completions`, `/v1/responses`) and Anthropic-compatible (`/v1/messages`) HTTP server. Select the harness with the model name: `claude/haiku`, `codex/gpt-5`, `agy/gemini-3.8-flash-low`, `pi/<provider>/<model>`, `opencode/<provider>/<model>`, `ollama/<model>`.

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local")
client.chat.completions.create(model="claude/haiku", messages=[{"role": "user", "content": "Hello"}])
```

### A harness proxy, not a provider proxy

LiteLLM, OpenRouter-style gateways and similar tools are **provider proxies**: they translate one API into many providers' HTTP APIs and need an API key per provider. The unit they route to is a model endpoint.

AgentBridge's proxy is a **harness proxy**: the unit it routes to is an installed coding-agent CLI (Claude Code, Codex, ...), authenticated by the login that CLI already has. Each request is executed by spawning that CLI, not by calling the vendor's HTTP API. This exists for cases a provider proxy cannot cover:

- **Subscription logins.** Claude and Codex plans are usable through their CLIs but not through the raw API. A provider proxy cannot use them; a harness proxy can. This may conflict with a provider's terms for consumer plans; read [Terms of service](#terms-of-service) before use.
- **Harness behavior.** Each CLI brings its own agent loop, tools, sandbox and session handling. Agent mode (`/agent/v1`) lets the harness edit files in an isolated git worktree and returns a diff you apply explicitly. Callers that already isolate their own work (an optimizer running one evaluation per folder, for example) can send `x-ab-sandbox: none` to run the harness directly in the folder instead.
- **One surface for existing software.** Tools that only speak the OpenAI or Anthropic protocol (SDKs, notebooks, evaluation and optimization frameworks, editors) can use any installed harness, with the same fallback and quota policy as the CLI.

What follows from this design, stated plainly:

- Latency includes CLI start-up (seconds).
- The default API mode is plain chat with the CLI's tools off, but it is still the CLI executing the request, so `temperature`, `top_p`, `seed` and penalties are accepted and ignored (listed in the `x-agentbridge-ignored` response header). `max_tokens` and `stop` are enforced by the proxy approximately.
- Token usage comes from the CLI when it reports it and is estimated otherwise.
- Client tool calling works (natively for Claude, emulated for the other harnesses), but replies are buffered rather than streamed.

If you have API keys and want a high-throughput gateway to model endpoints, use a provider proxy. If you want to use the harnesses you are logged in to from software that expects an API, use this. Full reference: [docs/PROXY.md](docs/PROXY.md).

## Other features

| Feature | Command | Notes |
|---|---|---|
| Parallel runs | `ab fanout`, `ab race` | All answers, or first accepted answer with the rest cancelled |
| Isolated worktree | `--worktree` | Run an agent in a temporary git worktree |
| Budgets | `--max-cost`, `--max-tokens`, `--max-time` | Enforced per run |
| Checkpoints | `ab checkpoint create\|list\|diff\|rollback` | Snapshots under `refs/agentbridge/checkpoints/`, using a temporary git index; no branches created, your index untouched |
| Test-driven repair | `ab fix <agent> "<test cmd>"` | Loops agent edits against a test command; rolls back if attempts run out |
| Review and consensus | `ab review`, `ab ensemble` | Cross-agent review loop; multi-agent voting with a judge |
| Pipelines | `ab pipeline` | DAG of agent steps run in parallel waves, optional checkpoint and rollback per wave |
| HTTP endpoints | `ab endpoint add <name> <url>` | Any OpenAI- or Anthropic-compatible base URL becomes `ask_<name>`; Ollama is built in |
| Accounts | `ab account ...` | Isolated config directories per login (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, ...), optional pool for the proxy |
| Project memory | `ab memory ...` | Conventions and decisions stored in `.agentbridge/memory.json` and injected into prompts |
| Handoff | `ab handoff <session> --to <agent>` | Continue a conversation in a different agent |
| Hooks and diagnostics | `ab doctor` | Lifecycle hooks and install/login checks |

Command and option details: [docs/REFERENCE.md](docs/REFERENCE.md).

## Supported agents

| Agent | Permissions enforced by | Sessions | Network and web tools |
|---|---|---|---|
| Claude Code | CLI permission modes | new, continue, fork, ephemeral | `WebSearch`/`WebFetch` available in all modes |
| Codex | CLI sandbox modes | new, continue, fork, ephemeral | Network blocked in `read-only` and `edit`; `full` unrestricts |
| OpenCode | AgentBridge and CLI | new, continue, fork, ephemeral | `webfetch`/`websearch` in all modes; shell needs `full` |
| Antigravity (`agy`) | AgentBridge (private HOME, deny rules) | new, continue, ephemeral | Web fetch in all modes; shell needs `full` |
| pi | AgentBridge (tool denylist) | new, continue, fork, ephemeral | Enabled by default |
| HTTP endpoints | Plain chat, or a harness (`--harness claude\|pi`) for tools | emulated | None unless a harness is used |
| Proxy | Client function calling | per request or `x-ab-session` | Client-defined tools only |

Cursor, Grok, Gemini, Devin and generic ACP agents are supported through their CLIs when installed. Pass `--offline` (or `offline: true`) to disable network tools where the harness allows. Details and caveats: [docs/REFERENCE.md](docs/REFERENCE.md#web-search-tools-and-network-permissions-across-agents--modes).

## Security and privacy

- **Local only.** There is no remote analytics. Run history, stats and checkpoints are stored under `~/.agentbridge/` and in your repository. The only network traffic is what the agent CLIs and configured endpoints themselves send to their providers.
- **Dashboard and proxy bind to loopback**, check the `Host` header against DNS rebinding, and accept an optional bearer token (`--token` or `AGENTBRIDGE_TOKEN`). Agent mode refuses to start without a token.
- **Credentials.** The attestation key reaches subagents through the process environment only, never on disk or in argv.
- **Defaults are conservative.** Permissions default to `read-only`; widening is explicit.
- **Process supervision.** Agent stderr is held in a bounded ring buffer, and on timeout or abort the whole process tree is killed (process groups on POSIX, `taskkill /T /F` on Windows).

Threat model and reporting: [SECURITY.md](SECURITY.md).

### Terms of service

AgentBridge drives the CLIs with your own logins. Providers may restrict automated use of consumer or subscription plans. Use it for personal, local work, do not expose the proxy to other people, and use API keys where your provider requires them. The account pool (`--accept-tos-risk`) is off by default and is your responsibility.

## Documentation

| Document | Contents |
|---|---|
| [docs/REFERENCE.md](docs/REFERENCE.md) | Every CLI command, option, event, error code, agent and environment variable |
| [docs/PROXY.md](docs/PROXY.md) | Harness proxy: routes, parameter mapping, sessions, agent mode, tool calling, limits |
| [docs/TELEMETRY.md](docs/TELEMETRY.md) | Telemetry, dashboard, context policy, compaction, handoff |
| [docs/PROVIDER_QUOTA_SUPPORT.md](docs/PROVIDER_QUOTA_SUPPORT.md) | Which providers expose measurable quota |
| [docs/HARNESS_VALIDATION.md](docs/HARNESS_VALIDATION.md) | Per-harness permission controls and limits |
| [docs/EXTENDING.md](docs/EXTENDING.md) | Adding an agent CLI or HTTP provider |
| [README_AI.md](README_AI.md) | Operational guide for coding agents |
| [CONTRACT.md](CONTRACT.md) | The adapter contract |
| [acceptance/ADAPTER_NOTES.md](acceptance/ADAPTER_NOTES.md) | Verified quirks of each CLI |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Development

```bash
npm ci
npm run build
npm test            # offline suites; no agent or login required
npm run accept      # drives the real, logged-in CLIs you have installed; others are skipped
```

Contributions, especially new adapters, are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), which also describes the release process, and [docs/EXTENDING.md](docs/EXTENDING.md).

## License

[MIT](LICENSE)
