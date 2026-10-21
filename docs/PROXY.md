# AgentBridge harness proxy

This is a **harness proxy**, not a provider proxy. Gateways such as LiteLLM translate one API into many providers' HTTP APIs and need a key per provider. `ab serve` instead executes each request by **spawning an installed agent CLI** (Claude Code, Codex, ...) that is already logged in. The only exceptions are configured HTTP endpoints (Ollama, OpenRouter, any base URL), which are called directly over HTTP.

Consequences you should know before relying on it: latency includes CLI start-up; sampling parameters (`temperature`, `top_p`, `seed`) are ignored for CLI-backed models; token usage is whatever the CLI reports (it includes the CLI's own overhead, so a one-word prompt can report thousands of input tokens) or an estimate; each concurrent request is a separate OS process (see [Concurrency limits](#concurrency-limits)).

Serves the models of your locally installed and logged-in agent CLIs (`claude`, `codex`, `opencode`, `agy`, `pi`, plus `cursor`/`grok`/`gemini`/`devin`/`acp` when that CLI is present) and any configured HTTP endpoints (Ollama built in, or any OpenAI/Anthropic-compatible base URL) as an
OpenAI-compatible and Anthropic-compatible HTTP API. Point an app's base URL at it; no API keys needed.

```bash
ab serve --port 8787 [--token SECRET]
# OpenAI SDK:    baseURL = http://127.0.0.1:8787/v1
# Anthropic SDK: baseURL = http://127.0.0.1:8787
```
Programmatic: `import { startProxy } from '@rodolfonobrega/agentbridge'; const p = await startProxy({ port: 0 });`

## WARNING: terms of service
This routes requests made with your **subscription logins** (Claude, ChatGPT/Codex, etc.) through a local proxy.
Providers may consider that a violation of their terms (automated/programmatic use of consumer plans, account
sharing, third-party harnesses). Use it for **personal, local use only**. Never expose it to other people or the
network, do not resell or share access, and use API keys if you need a supported programmatic path. You are
responsible for compliance.

## Endpoints
| Route | Notes |
|---|---|
| `POST /v1/chat/completions` | stream (SSE, `[DONE]`, `stream_options.include_usage`) and non-stream |
| `POST /v1/responses` | stream (`response.*` events) and non-stream; `instructions`, `reasoning.effort`, `text.format` |
| `POST /v1/messages` | Anthropic; full event sequence `message_start, content_block_start, ping, content_block_delta*, content_block_stop, message_delta, message_stop` |
| `POST /v1/messages/count_tokens` | estimate only (~chars/4) |
| `GET /v1/models` | OpenAI list, or Anthropic list when `anthropic-version`/`x-api-key` header is present |

---

## Ready-to-Run Code Examples

Start the proxy server first:
```bash
ab serve --port 8787
```

### 1. Python — Official `openai` SDK (Streaming)
```python
from openai import OpenAI

# Connect to AgentBridge proxy (no API key required)
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local-proxy")

response = client.chat.completions.create(
    model="claude/haiku",  # Or codex/gpt-5.6-luna, agy/gemini-3.8-flash-low, ollama/qwen3
    messages=[
        {"role": "system", "content": "You are an expert software engineer."},
        {"role": "user", "content": "Explain how epoll works in Linux kernel."},
    ],
    stream=True,
)

for chunk in response:
    content = chunk.choices[0].delta.content
    if content:
        print(content, end="", flush=True)
print()
```

### 2. Python — Official `anthropic` SDK
```python
import anthropic

# Connect to AgentBridge proxy (base URL without /v1 for Anthropic SDK)
client = anthropic.Anthropic(base_url="http://127.0.0.1:8787", api_key="local-proxy")

message = client.messages.create(
    model="haiku",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Write a clean debounce function in TypeScript."}],
)

print(message.content[0].text)
```

### 3. TypeScript / Node.js — Official `openai` SDK
```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8787/v1',
  apiKey: 'local-proxy',
});

async function main() {
  const stream = await client.chat.completions.create({
    model: 'codex/gpt-5.6-luna',
    messages: [{ role: 'user', content: 'Generate a binary search implementation with tests.' }],
    stream: true,
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content || '';
    process.stdout.write(text);
  }
}

main();
```

### 4. TypeScript / Node.js — Official `@anthropic-ai/sdk`
```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  baseURL: 'http://127.0.0.1:8787',
  apiKey: 'local-proxy',
});

async function main() {
  const message = await client.messages.create({
    model: 'haiku',
    max_tokens: 1000,
    messages: [{ role: 'user', content: 'List 3 security best practices for JWT.' }],
  });

  console.log(message.content[0].text);
}

main();
```

### 5. cURL (Terminal Direct Call)
```bash
# OpenAI format
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude/haiku",
    "messages": [{"role": "user", "content": "Say hello in 5 languages"}],
    "stream": true
  }'

# Anthropic format
curl http://127.0.0.1:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "haiku",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "What is WebAssembly?"}]
  }'
```

### 6. LangChain (Python) Integration
```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="local-proxy",
    model="claude/haiku",
    streaming=True,
)

response = llm.invoke("Design a REST API for a task manager")
print(response.content)
```

### 7. Agent Mode — Isolated Worktree Code Editing & Diff
To let an AI agent safely modify code in an isolated git sandbox without risking your repository:
```bash
# Start proxy with agent root enabled
ab serve --port 8787 --token my-secret --agent-root /path/to/projects
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/agent/v1", api_key="my-secret")

# Triggers an isolated git worktree run:
res = client.chat.completions.create(
    model="agent/claude/sonnet",
    messages=[{"role": "user", "content": "Refactor src/db.ts to use connection pooling"}],
    extra_headers={
        "x-ab-cwd": "/path/to/projects/my-repo",
        "x-ab-permissions": "edit"
    }
)

# Inspect the changes: the proxy returns unified diff and filesChanged!
# Then apply to the real working tree:
# POST http://127.0.0.1:8787/agent/runs/<runId>/apply
```

---

## Model routing
`claude/<model>`, `codex/<model>`, `agy/<model>`, `pi/<provider>/<model>`, `opencode/<provider>/<model>`, `cursor|grok|gemini|devin|acp/<model>` when that CLI is installed, and `<endpoint>/<model>` for configured HTTP endpoints (e.g. `ollama/qwen3:14b`). Bare names by heuristics: `sonnet|haiku|opus|opusplan|best|claude-*`
-> claude; `gpt-*|o1/o3/o4|codex*|chatgpt*` -> codex; anything containing a `/` -> opencode; when Ollama is configured, `glm-*|qwen*|llama*|deepseek*` or names with a `:cloud`/`:latest`/`:Nb` suffix -> the `ollama` endpoint. Otherwise 404
(`model_not_found` / Anthropic `not_found_error`).

## Parameter mapping
- `system`/`developer` messages, Anthropic `system`, Responses `instructions` -> agent `systemPrompt`.
- `reasoning_effort`, `reasoning.effort`, `output_config.effort`, Anthropic `thinking.budget_tokens`, or a model suffix
  (`claude/sonnet(high)`, `codex/gpt-5(16384)`) -> `effort` (if the agent/model rejects it, it is dropped and the request retried once).
- `response_format`/`text.format` `json_schema` -> `jsonSchema` (agent permitting); `json_object` -> instruction.
- `max_tokens` / `max_output_tokens` and `stop` are **enforced by the proxy** (about chars/4 for tokens): the CLI is stopped and the
  reply ends with `finish_reason: length` / `stop_reason: max_tokens` / `stop_sequence`. `temperature`, `top_p`, `seed` and penalties are
  accepted and ignored (never rejected); the ignored names are listed in the `x-agentbridge-ignored` response header.
- Usage and `stop_reason` come from the CLI when it reports them (claude does), else they are estimated.
- Sessions: send `x-ab-session: <id>` and the proxy resumes the CLI session (claude/codex) and sends only the new turns. The key is
  scoped to your credential. Without it every request is stateless (the history is flattened into one prompt, trimmed to
  `historyBudgetTokens` of the config).
- Client disconnect -> `AbortSignal` -> the CLI process is killed.
- Errors: OpenAI `{error:{message,type,param,code}}`; Anthropic `{type:"error",error:{type,message}}`. Status:
  400 bad request/option, 401 bad token or agent not logged in, 403 agent mode refused / cwd outside the agent root / permissions above the ceiling / bad host, 404 unknown model, 405 method not allowed, 409 run or sandbox busy / patch conflict on apply, 413 request body too large (20 MB cap), 429 rate limited, 499 request aborted, 500 sandbox failure, 502 agent failure, 503 CLI not installed, 504 timeout. Mid-stream failures are sent as an SSE error event.

## Config file (`--config file.json`, hot reloaded)
```json
{ "aliases": { "fast": "claude/haiku" },
  "payload": [{ "match": "codex/*", "defaults": { "effort": "medium" }, "override": { "temperature": 0.2 } }],
  "agentRoot": "C:/work", "agentMaxRuns": 8, "agentRunTtlMinutes": 30, "maxPermission": "edit", "historyBudgetTokens": 0 }
```
Payload-rule keys: `defaults` fills a key only when the request leaves it unset; `override` forces it. The config file can also carry a top-level `accounts` object (same shape as the `--accounts` file) to set up the pool inline; like the pool file, it is read at startup and never hot-reloaded (and still needs `--accept-tos-risk`). A bad reload keeps the previous config. Requests in flight keep the config they started with.

## Two modes
**API mode** (default): plain chat. This is an API *shape*, not a direct API call: for `claude/*`, `codex/*`, `agy/*`, `pi/*` and `opencode/*` the request is still executed by the CLI (for Claude: `claude -p` with `--tools ''`, no MCP servers, no hooks, no `CLAUDE.md`, and your system prompt replacing Claude Code's default, wrapped in an instruction not to use tools). It runs read-only in a shared throw-away temp directory (recreated if removed) with the agent's own tools off. Only `<endpoint>/<model>` routes (Ollama, OpenRouter, custom base URLs) go straight to an HTTP API, with real usage numbers when the server reports them.

**Agent mode**: the agent edits files. Select it with the model prefix `agent/` (`agent/claude/sonnet`) or the base path
`/agent/v1`. It works in an **isolated copy** (git worktree, or a temp copy of a non-git folder), never in your folder:
- Off unless the server was started with `--agent-root <dir>` **and** a token. Always loopback.
- `x-ab-cwd`: folder to work on, inside the agent root; anything resolving outside it is a 403.
- `x-ab-permissions`: `read-only|plan|edit|full`, never above `--agent-max-permission` (default `full`).
- `x-ab-session`: reuse the same sandbox and CLI session across requests.
- The reply carries `agentbridge: { runId, filesChanged, diff }` (and the header `x-agentbridge-run`). Routes: `GET /agent/runs`,
  `GET /agent/runs/:id`, `GET /agent/runs/:id/diff`, `POST /agent/runs/:id/apply` (git apply into the real folder; 409 on conflict),
  `DELETE /agent/runs/:id`. Nothing touches your folder until you call `apply`. Idle runs expire after `--agent-run-ttl` minutes
  (config `agentRunTtlMinutes`, default 30); a run is dropped about 2 minutes after its changes were applied.
- Sandbox cap: `--agent-max-runs N` (config `agentMaxRuns`, default 8, `0` = unlimited). Running sandboxes and sandboxes with
  unapplied changes count; applied and deleted ones free their slot. When the proxy is full, a request that would need a new sandbox
  gets **429** `agent_runs_limit` with a `retry-after` header; apply or `DELETE` finished runs to make room. Runs holding an unapplied
  diff are never evicted; idle runs known to have no changes and no `x-ab-session` are recycled first. A request with an existing
  `x-ab-session` reuses its sandbox and never counts as new; concurrent first requests of one session share a single sandbox.
- Sandboxes are created and diffed asynchronously, so a large copy does not stall other requests or streams.
- Cleanup after a crash: each sandbox (`<tmp>/ab-wt-XXXXXX`) holds a `.agentbridge-sandbox` marker (pid, origin). On startup (with
  `--agent-root`) the proxy removes sandboxes older than the TTL whose marker pid is dead, then runs `git worktree prune` in the
  recorded repo. Only exact-name directories directly in the temp dir, owned by you and carrying a valid marker are touched;
  anything else (including sandboxes from older versions without a marker) is left alone.
- Client `tools` are refused in agent mode (the agent has its own).

## Tool calling
Whenever a request carries `tools` (OpenAI `tools`/`tool_choice`, Responses `function` tools, Anthropic `tools`), the proxy answers with
`tool_calls` / `function_call` items / `tool_use` blocks, and accepts the tool results on the next request.
- **claude**: the schemas are served to the CLI through a small MCP stub; when it calls one, the proxy stops the CLI and hands the call to you.
- **codex, opencode, agy, pi, endpoints**: prompt emulation (`<tool_call>{...}</tool_call>`), validated against your JSON schema, one corrective
  retry. If the output still cannot be parsed it is returned as plain text with `x-agentbridge-warning`. Best effort; quality varies by model.
- Replies are buffered in tool mode (no live token streaming), and a fallback chain is not used with claude's bridge. Hosted tools
  (`web_search` ...) are a 400 `tools_not_supported`.

## Account pool (off by default, at your own risk)
`--accounts accounts.json --accept-tos-risk` (or `AGENTBRIDGE_ACCEPT_TOS_RISK=1`) spreads requests over several logins of **your own**,
each one a CLI config dir. Without the second flag the server refuses to start. Rotating accounts can violate a provider's terms of
service; that is your decision and risk. Nothing is hidden or faked toward the provider. Remove the flag to turn it off.
```json
{ "strategy": "round-robin",
  "claude": [{ "name": "work", "env": { "CLAUDE_CONFIG_DIR": "C:/cfg/work" } }, { "name": "home", "env": { "CLAUDE_CONFIG_DIR": "C:/cfg/home" } }],
  "codex":  [{ "name": "a", "env": { "CODEX_HOME": "C:/cfg/codex-a" } }] }
```
Strategies: `round-robin`, `fill-first`, `sticky` (per `x-ab-session`). A `RATE_LIMITED` account goes into cooldown (its `retry-after`, else
30 min for quota, 60 s for rate, 30 s for overloaded) and the request moves to the next account before any fallback agent.
When every account is cooling down the answer is 429. The pool is read at startup (no hot reload).

## Observability
`GET /admin/status` (pool and cooldowns, no secrets) and `GET /admin/usage` (requests, tokens, latency per agent/model/account/mode).
Without a token they are only served on loopback. `--log file.jsonl` appends one line per run (no prompts or replies).

## What is written to disk
- **Stateless requests** (no `x-ab-session`): nothing persists in the agent. Claude runs with `--no-session-persistence`, Codex with `--ephemeral`, OpenCode sessions are deleted after the run. The OpenAI `user` field does not create a session.
- **Requests with `x-ab-session`**: the first request for a key creates one real CLI session (for Claude, a transcript under `~/.claude/projects/` in the proxy's temp working directory, so it appears only in the all-projects view of `claude --resume`; Codex: `~/.codex/sessions`; OpenCode: its database). Later requests with the same key resume it and send only the new turns. Different keys create different sessions, and **nothing prunes them**: a client that invents a key per chat will accumulate one transcript per chat. Use a small, stable set of keys, or delete old sessions with the agent's own tooling.
- **The key-to-session map lives in memory** (max 500 keys, oldest evicted) and is lost on restart. After a restart or eviction the same key starts a fresh CLI session; the old transcript remains on disk.
- **Continuing a conversation yourself:** the session is a normal CLI session, so `claude -p --resume <session-uuid>` works from any directory. The transcript is named by the session uuid and titled by its first prompt; find it in the all-projects view of `claude --resume`. The proxy does not detect edited or regenerated history: if the client rewrites earlier turns, the resumed CLI session keeps the original ones.
- **Always written:** one JSON record per request under `~/.agentbridge/telemetry/runs/` (pruned to the newest 500 when the proxy starts and when the dashboard lists runs), plus `--log` JSONL if enabled (append-only, no rotation; no prompts or replies).
- **Agent mode** also leaves a worktree or copy under the system temp dir for up to 30 minutes per run, and the agent's own session transcripts.

## Concurrency limits
Every in-flight request is a separate agent process. AgentBridge refuses to run more than `AGENTBRIDGE_MAX_PROCS` agent processes at once (default 24, `0` disables the cap). Beyond that, requests fail fast with `RATE_LIMITED`, which the proxy answers as HTTP 429 with `retry-after`. The default request timeout is 300 seconds. When a client disconnects, the CLI and its child processes are killed.

## Limits (honest list)
- Tool mode is buffered; emulated tool calls depend on the model. Usage is an estimate when the CLI had to be stopped early.
- `max_tokens` is approximate (chars/4). `n` must be 1. Assistant prefill is rejected.
- Images (data: or public http(s) URLs, up to 8 x 10 MB, png/jpeg/gif/webp) reach **claude, codex and opencode**; URLs are fetched with an SSRF guard (private, loopback and link-local addresses refused, redirects re-checked). Other agents get a `[image]` placeholder and an `x-agentbridge-warning: images_not_supported` header. With a resumed session the images of the request are sent again.
- `count_tokens` is always an estimate.
- Streaming granularity depends on the CLI (some emit large chunks). Latency is CLI start-up time (seconds).
- Binds `127.0.0.1` only; other hosts are refused unless `allowNonLoopback` / `--allow-non-loopback`.
  Optional bearer token (`Authorization: Bearer` or `x-api-key`), `--token` or `AGENTBRIDGE_TOKEN`.

## Rate limits
A `RATE_LIMITED` failure is answered with HTTP 429 and a `retry-after` header (seconds) in both the OpenAI and Anthropic shapes. `ab serve --fallback a,b` applies a fallback chain to every request. A limit hit after text was already streamed cannot be re-routed and ends the stream with the error (the first ~160 chars / 1.5 s are held back when a chain exists, so early limits still fall back cleanly).

## Missing or unconfigured agents

Nothing fails silently. When `ab serve` starts it prints which agent CLIs it found (`[ok]` / `[missing]` with the install command). A request for an agent that is not installed returns HTTP 503 `agent_not_installed`, one that is not logged in returns 401, both with the fix in the message. `/v1/models` only lists agents that are installed. `ab doctor` checks installs and logins in one go.

## Connecting Claude Code directly to Ollama Models

Ollama exposes an Anthropic-compatible `/v1/messages` endpoint at `http://127.0.0.1:11434`. You can point Claude Code directly at it to orchestrate local models with full filesystem and tool execution capabilities:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:11434 ANTHROPIC_AUTH_TOKEN=ollama ANTHROPIC_API_KEY= claude -p --model glm-5.3-flash:cloud "Your prompt"
```

- **`ANTHROPIC_BASE_URL`**: points to Ollama's native `/v1/messages`.
- **`ANTHROPIC_AUTH_TOKEN`**: any non-empty string satisfies the Claude client check.
- **`ANTHROPIC_API_KEY=`**: empty string suppresses reading API keys from environment.

> **Key Distinction:**
> - `ab ask ollama`: delegates to Ollama as a **plain chat completion** endpoint without tools.
> - `claude` with `ANTHROPIC_BASE_URL`: runs the full Claude Code agent engine (with file editing, bash, grep, and git) powered by the Ollama model backend.

