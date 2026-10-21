# Telemetry, context policy, hooks

> [!IMPORTANT]
> **100% LOCAL PRIVACY GUARANTEE (Zero Remote Telemetry):**  
> AgentBridge does NOT send any telemetry, usage statistics, logs, prompt content, or operational metrics over the internet. There are zero third-party telemetry integrations (no PostHog, Segment, Google Analytics, Sentry, or cloud trackers). All recorded run summaries, token metrics, context windows, and tool counts are persisted exclusively on your local machine (`~/.agentbridge/telemetry/`). The optional dashboard (`ab ui`) runs on loopback by default (`http://127.0.0.1`); binding it to another host requires the explicit `--allow-non-loopback` flag (see Dashboard below).

Code: `src/telemetry/{stats,context,hooks,track,index}.ts`. Everything is exported from `src/index.ts`; `run()`/`ask()` are untouched.
State lives in `~/.agentbridge/` (override with `AGENTBRIDGE_HOME`): `telemetry/{runs,sessions}/*.json`, `telemetry/stats.json`,
`telemetry/policy.json`, `telemetry/config.json` (window overrides), `handoffs/*.md`, optional `hooks.json`.

## Using it
```js
import { runWithTelemetry, askWithTelemetry, stats, contextOf, setPolicy, handoff, compact, wait } from '@rodolfonobrega/agentbridge';
const r = await askWithTelemetry('claude', { prompt, cwd }, { hooks: { finish: [{ http: 'http://127.0.0.1:9000/done' }] }, policy: { warn: 0.7 } });
stats();                      // global + per agent + per session + per run, persisted to telemetry/stats.json
contextOf(r.sessionId);       // {tokens, exact, source, window, windowSource, pct}
```
`runWithTelemetry(agent, opts, {hooks, policy, env, windows, hookTimeoutMs})` is a generator like `run()`; the Result gains `telemetry`
`{runId, context, level, compaction?, hooks[]}`. Only runs made through the wrapper get tool counts / status; runs from the bridge
registry (`~/.agentbridge/runs`) are merged into `stats()` with partial tool counts (`toolCallsPartial`).

Provider quota readers and their authentication requirements are documented in [Provider quota support](PROVIDER_QUOTA_SUPPORT.md).

## Telemetry (honest numbers)
| agent | context source | exact? |
|---|---|---|
| claude | last assistant `usage` in `~/.claude/projects/*/<sid>.jsonl` (input + cache + output of the last call) | exact |
| codex | last `token_count.last_token_usage` in `~/.codex/sessions/**/rollout-*<sid>.jsonl`; window comes from `model_context_window` in the file | exact |
| opencode | `usage` of the last step event (no session file read) | exact for that step |
| any, after `claude /compact` | size of the compact summary only (chars/4) | estimate |
| fallback | aggregated run usage (upper bound) or chars/4 | estimate |

Every figure carries `exact` and `source`; `global.allExact` says whether the total mixes in estimates. Window per agent/model: built-in table
(`DEFAULT_WINDOWS`), overridable persistently (`setContextWindow('claude','opus',500000)`) or per call (`windows:{claude:{'*':...}}`);
if observed tokens exceed the window (e.g. a 1M variant) the window is widened and marked `+observed>window`. Cost is only reported when the
agent reports it (claude does; codex gives `null`, never invented). Status: run `active` (events within `idleMs`, default 30s) / `idle` (in flight, quiet)
/ `finished` / `error` / `timeout` / `cancelled` / `lost` (owner process died). `stats().global` = total context over sessions touched in `sinceMs` (24h),
with `advice[]` naming sessions >= 70% of their window, i.e. when to compact or hand off.

## Context policy
`setPolicy(scope, limits)`, scope `null` (default) | `{agent}` | `{session}`; precedence default < agent < session < inline `tele.policy`.
Limits `warn`, `compact`, `hard`: number <= 1 is a fraction of the window, > 1 is absolute tokens. Also `autoCompact`, `hardAction:'block'|'handoff'`, `handoffTo`.
Evaluated after each run: warn/compact/hard yields a `raw` event `{abTelemetry:'context-warning'|'context-hard', ...}` and the `context-threshold` hook;
`autoCompact` at >= compact calls `compact()` and yields `{abTelemetry:'context-compact'}`. `hard` refuses to continue that session (`AgentError AGENT_FAILED`, `.reason==='CONTEXT_HARD_LIMIT'`) or, with `hardAction:'handoff'`, hands off first.

## Compaction and handoff
`compact(sessionId, {agent, method:'auto'|'native'|'summarize'})`:
- claude: native `/compact` sent through `--resume` (verified: same session id, summary replaces history). `after` is an estimate until the next model call.
- codex / opencode: no non-interactive compact exists, so summarize-and-continue: HANDOFF from a fork of the session, new session on the same agent (returns the new `sessionId`).

`handoff(sessionId, toAgent, {agent, seed=true})`: asks a **fork** of the source session for Summary / Key facts and decisions / Key files / Open tasks, merges the model's file list
with files actually touched per telemetry, writes `~/.agentbridge/handoffs/*.md`, and (unless `seed:false`) starts a new session on `toAgent` seeded with it. If the source cannot be summarized, a `degraded`
doc is built from recorded telemetry (first prompt, last output, files) and flagged. Verified by the tests: a fact told to claude is recalled by codex and vice versa.

## Hooks
Events `start | finish | error | timeout | context-threshold` (`'*'` = all). Specs: `fn`/bare function `(summary,event)`, `{command,args,timeoutMs}` (JSON summary on stdin, `AB_EVENT/AB_RUN_ID/AB_AGENT/AB_STATUS/AB_SESSION_ID` env, no shell),
`{file:dir}` (writes `<runId>.<event>.json` atomically), `{http:'http://127.0.0.1:PORT/p'}` (POST, loopback only, others are refused). Global config in `~/.agentbridge/hooks.json`, merged with per-call hooks.
The summary: `{event, runId, agent, model, sessionId, status, startedAt, endedAt, elapsedMs, toolCalls, usage, cost, error, resultPreview, files}`.
Safety: per-hook timeout (default 10s; commands are killed, http destroyed, callbacks abandoned), hook errors are captured in `telemetry.hooks[]` and never affect the run; the wrapper awaits all hooks (bounded) before returning, so nothing outlives the call.
`wait(runIdOrSessionId, {timeoutMs, pollMs})` resolves with the summary when the run reaches a terminal state (in-process or from another process via the persisted record); it always resolves within `timeoutMs` (`waitTimedOut:true`), unknown ids give `notFound:true`. `waitAll(ids)`.

Provider quota readers and their authentication requirements are documented in [Provider quota support](PROVIDER_QUOTA_SUPPORT.md).

## Known limits
Tool counts need the wrapper. opencode context has no session-file reader. Codex fork/`exec resume` behavior depends on the installed CLI version.

## Dashboard
`ab ui [--port 8788] [--open] [--token t] [--host 127.0.0.1] [--allow-non-loopback]` starts a small web server (default http://127.0.0.1:8788) that shows the telemetry described above. It reads the same files as `ab stats` (`runLimit` is raised to 5000 runs) and refreshes every 1.5 s while something runs, 3 s otherwise; it pauses in background tabs.

What is recorded: every run made through the **CLI** (`ab run/ask/fanout/race`), the **proxy**, the **MCP bridge** (`ask_*` as origin `bridge-sync`, `dispatch_*` as `bridge`) and `runWithTelemetry`/`runTracked` in the library. Plain `run()`/`ask()` calls from your own code are *not* recorded; use `runTracked(agent, opts, { origin: 'my-app' })` (records only) or `runWithTelemetry` (records plus hooks and context policy).

Honest numbers: success rate is `succeeded / (succeeded + failed)` (running and cancelled runs are excluded); cost is the sum of what agents report (Claude does; others stay empty rather than invented); context sizes marked *est.* are estimates; "rescued" counts runs where a `fallback` agent answered after the primary failed.

Security: read-only (any non-GET is 405), loopback only (a non-loopback host needs `--allow-non-loopback`), `Host` header checked against DNS-rebinding, strict CSP (no inline script, no external requests), all dynamic text is rendered with `textContent`, optional bearer token for `/api/*`. The page shows prompt heads and output tails, so keep it on your machine.

API (stable enough for scripts): `GET /api/stats?since=<ms>` returns `stats()` plus `summary` (totals, per agent, per origin, top tools, timeline); `GET /api/run/<id>` returns one run record.
