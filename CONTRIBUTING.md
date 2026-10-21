# Contributing to agentbridge

Thanks for helping! agentbridge is TypeScript (ESM, compiled to `dist/`), Node ≥ 22, with **zero runtime dependencies**. Please keep it that way.

## Setup

```bash
git clone https://github.com/rodolfonobrega/agentbridge.git
cd agentbridge
npm install
npm test            # offline suites: no agent CLI or login needed
```

To run the live suites you need the CLIs you want to test installed and logged in (`claude`, `codex`, `opencode`, `agy`, `pi`, `cursor`, `grok`, `gemini`, `devin`, an ACP agent, Ollama). Suites for missing agents skip themselves.

```bash
node --test --test-concurrency=1 acceptance/core.test.mjs      # one suite
npm run accept                                                  # everything
```

Live suites make **real** model calls and use your subscriptions. Run them one at a time and use small/cheap models (`haiku`, `gemini-3.8-flash-low`, a cloud model through Ollama). Avoid loading large local models on small machines.

## Project layout

```
src/core/       catalog, spawn helpers, errors, events, config, accounts, shared resources
src/adapters/   one module per agent (claude, codex, codex-daemon, opencode, agy, pi, cursor, grok, gemini, devin, acp, endpoint) + the shared cli-json-lines runner
src/bridge/     MCP server, subagent runner, permission ceiling, attestation, run records
src/server/     OpenAI/Anthropic compatible proxy
src/telemetry/  usage tracking, context policy, compaction, handoff, memory retention, hooks
src/quota/      quota readers (Claude, Codex, Antigravity, Gemini), proactive probing and routing
src/extras/     fanout/race, schema, worktree, budget, checkpoints, repair, consensus, pipeline, doctor
src/ui/         the `ab ui` dashboard
src/cli/        the `ab` command (main, args, install, install-ide, setup, accounts, config)
acceptance/     test suites (real agents) + ADAPTER_NOTES.md
docs/           reference and design docs
```

## Rules we hold ourselves to

1. **Real agents are never mocked.** Tests drive the actual CLIs. The only allowed fixtures are protocol-level ones that cannot be provoked on demand (for example a local HTTP server that answers 429).
2. **Assert on facts, not model prose.** Check files on disk, tool events and exit codes. Small models can say anything.
3. **A change is not done until it has a test that fails without it.**
4. **Security-sensitive code gets an independent review** (permissions, the MCP bridge, attestation, anything touching secrets). Authors cannot certify their own work.
5. **Never put secrets on disk or argv.** The attestation key travels only through the process environment.
6. **Document limits honestly** in `acceptance/ADAPTER_NOTES.md` and the [Known limitations](docs/REFERENCE.md#known-limitations) section of docs/REFERENCE.md. If something is unverified, say so.
7. Match the surrounding code: naming, comment density, idiom. No new dependencies without a very good reason.

## Adding a new agent

Read [docs/EXTENDING.md](docs/EXTENDING.md). In short: run `<cli> --help` and one real headless call, implement `src/adapters/<name>.ts` (`run()` async generator, normalized events, `AgentError` codes including `RATE_LIMITED`), register it, add `acceptance/<name>.test.mjs` (basic run, permissions, sessions, timeout/abort cleanup, bridge pairs), and document the limits.

## Pull requests

- Keep PRs focused; describe what changed and **how you verified it** (which suites, which agents).
- Update the docs and `CHANGELOG.md` for user-visible changes.
- Note which platforms you tested on. The suites were developed on Windows 11; macOS/Linux fixes are very welcome.
- Do not commit tokens, session files or `.env` files.

## Reporting bugs

Use the issue templates. Include `ab doctor --json` output (it contains no credentials), the agent and model, the command, and the error code.

## Releases (maintainers)

The package is published to npm as [`@rodolfonobrega/agentbridge`](https://www.npmjs.com/package/@rodolfonobrega/agentbridge) (the unscoped name is blocked by npm's similarity rule against `agent-bridge`). The `ab` and `agentbridge` commands are unchanged.

```bash
npm run release -- patch      # or minor | major | X.Y.Z; --dry-run only validates
git push origin main --follow-tags
```

`npm run release` checks that git is clean, runs typecheck, build and tests, bumps `package.json`, adds a `CHANGELOG.md` entry, commits and tags `vX.Y.Z`. Pushing the tag triggers `.github/workflows/release.yml`, which re-runs the tests, checks that the tag matches `package.json`, publishes to npm with provenance and creates a GitHub Release with the changelog notes. CI (`ci.yml`) runs typecheck, build and tests on Linux, Windows and macOS with Node 22 and 24.

One-time setup: add a repository secret named `NPM_TOKEN` (an npm granular access token with read/write on the package, 2FA bypass enabled).

By contributing you agree your work is released under the MIT license.
