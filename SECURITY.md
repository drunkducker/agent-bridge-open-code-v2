# Security

## Threat model

agentbridge spawns coding agents that can read files, edit files and run commands **as you**. It adds guard rails but is not a sandbox:

- **Permissions** (`read-only`, `plan`, `edit`, `full`) are mapped to each CLI's own controls where they exist and enforced by agentbridge where they do not (`agy`, `pi`). `edit` is not strictly confined to the working directory for `agy` and `pi`; `pi` has no sandbox at all. Run untrusted work in a container or VM.
- **Agent-to-agent delegation** has a depth limit, a permission ceiling (a subagent never gets more than its caller) and HMAC-attested results. The attestation key is passed only through the process environment, never written to disk or argv.
- **Delegated Codex runs:** to make delegation work headlessly, agentbridge injects `-c mcp_servers.agentbridge_http.default_tools_approval_mode="approve"` (and the same key for every mirrored MCP passthrough server) into the child Codex process. Codex's own interactive per-tool approval prompts are therefore **off** for these servers during delegated runs; the bridge's permission ceiling, depth limit and offline gate are what still constrain them (`src/bridge/mcp.ts`, `src/bridge/subagent.ts`).
- **Project trust:** project-local configuration (extensions, skills, hooks, `.pi/`) is not loaded for `pi`; `agy` runs in a private HOME so your global hooks and MCP servers are not inherited.
- **The proxy** binds to loopback by default and has optional bearer-token auth. Never expose it to other people: it turns your personal logins into a shared service, which providers' terms usually forbid. As a DNS-rebinding guard, a request whose `Host` header is not loopback (or names a different port than the listening one) is answered `403 "bad host"` **before** any auth or routing (`src/server/index.ts`).
- **The `ab ui` dashboard** (read-only) refuses to bind a non-loopback host without `--allow-non-loopback`; it enforces the same `Host` check; `/api/*` routes optionally require a bearer token (timing-safe comparison); every response carries a strict CSP (`default-src 'none'; script-src 'self'`, no external requests, no inline script); non-GET requests are refused with 405 except the single mutating route `POST /api/checkpoints/:id/rollback`, which is CSRF-guarded by same-origin + exact-port checks and can be disabled entirely with the mutation kill-switch; its cwd parameter is confined to `AGENTBRIDGE_ROOT`/the authorized root (`src/ui/server.ts`). Honest caveat: without `--token`, any local process can open the dashboard — which shows prompt heads and output tails.
- **Privacy & Telemetry:** agentbridge does not collect, track, or exfiltrate any remote telemetry, usage metrics, prompt text, or code. All metrics and run histories are strictly stored locally in `~/.agentbridge/telemetry/`. There are zero third-party telemetry services.
- **Credentials:** agentbridge has no login flow and never asks for passwords: adapters rely on each CLI's own local auth. Two exceptions, both local: the quota readers read existing login files (Claude, Codex, Gemini OAuth) to query remaining quota (`src/quota/`), and `ab account add --copy-current` copies a CLI config directory, login files included, into a managed profile (`src/core/accounts.ts`). Nothing is sent anywhere except to the provider the credential belongs to. Two categories of secret are handled, both by explicit opt-in of the end user: HTTP endpoints read `apiKeyEnv` from the environment (never persisted), or an `apiKey` you set in `~/.agentbridge/endpoints.json` — that file stores the key **in plain text**, which is a documented trade-off; either way the key is transmitted only to the endpoint you configured, as `Authorization: Bearer` (OpenAI type) or `x-api-key` (Anthropic type) (`src/adapters/endpoint.ts`).

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's "Report a vulnerability" (private security advisory) on this repository. Include the version, platform, a minimal reproduction and the impact. You will get an acknowledgement within a few days.

## Supported versions

Only the latest release on the default branch receives security fixes.
