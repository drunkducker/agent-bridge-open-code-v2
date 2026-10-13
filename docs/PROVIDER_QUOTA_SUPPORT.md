# Provider quota support

AgentBridge separates **proactive remaining-quota measurements** from **error-driven fallback**. A provider's billing balance, historical token totals, or a harness's own request limits do not tell AgentBridge what percentage remains in an OAuth subscription window.

## Measured quota readers

| Provider / route | Measurement | Scope and limits |
|---|---|---|
| Claude Code | Live OAuth usage windows, including session and weekly | Subscription OAuth identity; API-key execution does not expose this subscription quota. |
| Codex | Live ChatGPT account usage windows, including primary and weekly | Subscription account identity; API-key execution does not expose this subscription quota. |
| Antigravity (`agy`) | Native read-only JSON from `agy -p /usage --output-format json` | Requires AGY 1.1.11 or later; currently observed CLI 1.2.16. Reports provider model-family pools with five-hour and weekly windows, not separate per-model budgets. |
| Gemini CLI (conditional) | OAuth Code Assist `retrieveUserQuota` request buckets | Internal Gemini CLI protocol, file-based OAuth credentials only. Buckets must match the selected model. Reported reset is used when present; the endpoint does not identify a window duration, so `windowMinutes` remains 0. |

The AGY CLI's `/usage` command and status-line quota fields are documented by the [AGY CLI changelog](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md), [usage command guide](https://www.agy.dev/docs/cli/commands/usage/), and [status-line reference](https://www.agy.dev/docs/cli/statusline/). Its observed quota is pool-level: selecting a model in that family does not create an independent allowance.

Gemini's reader follows the [Gemini CLI Code Assist server transport](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/server.ts), [request and response types](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/types.ts), and [OAuth implementation](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/oauth2.ts). These are internal, versioned interfaces, not a public stable quota API. The reader only reads the CLI's OAuth credential file and does not refresh or rewrite credentials or access the OS keychain. Missing or expired file credentials, keychain-only login, API-key authentication, and Vertex AI return unknown. The Gemini CLI was not installed for live verification; Gemini reader tests use mocked HTTP responses.

Google's public [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) and [billing](https://ai.google.dev/gemini-api/docs/billing) describe API-project limits and billing. Those values are not a subscription OAuth remaining-percentage reader.

## Not measured for proactive percentages

| Provider / route | Why no percentage is reported | Official reference |
|---|---|---|
| Cursor | Team Admin API and plan/pricing information do not provide a supported per-model remaining OAuth quota percentage for this reader. | [Admin API](https://docs.cursor.com/en/account/teams/admin-api), [pricing](https://docs.cursor.com/account/pricing) |
| Grok / xAI | Subscription usage is presented as plan usage, while API rate limits and Usage Explorer are distinct API/account billing surfaces; no supported subscription remaining-window percentage reader is available here. | [Grok FAQ](https://docs.x.ai/grok/faq), [API rate limits](https://docs.x.ai/developers/rate-limits), [Usage Explorer](https://docs.x.ai/console/usage), [billing](https://docs.x.ai/console/billing) |
| Devin | ACU caps configured for an automation/task are task controls, not an account-wide remaining percentage. | [Devin automation template](https://docs.devin.ai/automation-templates/linear-ticket-implementation) |
| OpenCode | OpenCode is a harness that can route to different underlying providers; its provider configuration does not define one shared remaining-quota pool. | [Providers](https://docs.opencode.ai/docs/providers/), [CLI commands](https://dev.opencode.ai/v2/docs/cli/commands/), [Go limits](https://docs.opencode.ai/docs/go/) |
| Pi | Pi is a harness over underlying provider/model authentication. It has no single shared remaining quota to query across those providers. | [Pi documentation](https://github.com/badlogic/pi-mono) |
| Ollama and custom endpoints | Local endpoints may have no hosted quota; cloud or compatible endpoints have provider-specific policies. Neither fact supplies a common measured percentage. | [Ollama cloud models](https://ollama.com/blog/cloud-models), [transparent pricing](https://ollama.com/blog/transparent-pricing) |

A transient timeout, missing login, or unsupported source produces an unavailable/unknown reading; it does not mean zero used or unlimited. AGY startup can occasionally exceed the query timeout, so a later fresh query may be needed. Unsupported means **unmeasured**, not unlimited. For example, OpenCode at `opencode@20` cannot be used as a percentage-gated route. A supported reader with unavailable credentials or an unavailable measurement is also unknown and cannot satisfy a threshold. A provider without a quota reader can still be configured as the final unmetered fallback without `@N`; a metered route without an override inherits the global threshold.

## Choose quota routing or error fallback

Without `--min-remaining-percent`, `--wait-for-quota`, or a fallback route threshold, AgentBridge does not probe quota; it uses error-driven fallback. The default fallback trigger is `RATE_LIMITED`. `--fallback-on` can add supported error codes such as `TIMEOUT` and `AGENT_FAILED`. Fallback is skipped after the primary has already run tools under `edit` or `full` permissions, to avoid repeating side effects.

When quota routing is enabled, percentages are inclusive remaining-percent gates. An unknown measurement never becomes 100%, and unsupported explicit per-route `@N` thresholds are rejected before the primary starts; a final provider without a quota reader may run as the unmetered fallback without `@N`; a metered route without an override inherits the global threshold. A known exhausted secondary window can block an otherwise eligible route. See [Harness validation](HARNESS_VALIDATION.md) for what was checked locally.

```bash
ab run claude "Review and implement this change" --model sonnet --permissions edit --min-remaining-percent 30 \
  --fallback 'agy@15:gemini-3.8-flash-low,codex@20,ollama:qwen2.5-coder:14b'
```

Here the primary needs at least 30% remaining. AGY and Codex use their own explicit thresholds; Ollama is a final ungated fallback. For `check_quota`, specify the model when a reader is model-specific, for example `check_quota({ agent: 'agy', model: 'claude-sonnet-5-5' })`; read the MCP result envelope's structured content or text block rather than assuming the tool returns a bare object.
