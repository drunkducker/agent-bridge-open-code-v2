# Harness permission and compatibility guide

Permission options map to provider-specific CLI controls. Their behavior and limits differ by harness; this guide summarizes the supported mappings and points out where a mode does not provide a strict system-level boundary.

## Permission controls

AgentBridge's `read-only`, `plan`, `edit`, and `full` values are normalized requests. The exact enforcement comes from each harness. A permission ceiling limits what AgentBridge accepts from a caller, but it does not turn every provider into an operating-system sandbox.

| Harness | Requested mode/control | Verification and limits |
|---|---|---|
| Claude Code | `full` maps to `bypassPermissions`; optional `dangerouslySkipPermissions` adds `--dangerously-skip-permissions` and requires explicit `full`. Restricted modes use tool restrictions. | Provider configuration and hooks remain outside a blanket OS isolation guarantee. |
| Codex | Native sandbox modes for restricted/edit runs; `full` uses unrestricted sandbox mode. Optional `yolo: true` / CLI `--yolo` requests native bypass and requires explicit `full`. | `--yolo` is Codex-only. |
| OpenCode | `full` configures native `allow` permissions and answers permission requests once. | Behavior depends on the installed OpenCode version and its configuration. |
| Antigravity (`agy`) | `full` uses `--dangerously-skip-permissions`; restricted execution uses AgentBridge's disposable profile and deny rules. | Project-level MCP/hooks can initialize before the permission rules; restricted runs in affected projects are rejected. |
| Pi | Restricted modes filter tools; `full` allows its tool set. There is no dedicated native YOLO flag. | Tool filtering is not an OS process sandbox. |
| Grok | `full` requests `--permission-mode bypassPermissions`; `plan` requests `plan`, and other non-full modes explicitly request `default` to avoid inheriting a stored bypass. Output uses `--output-format streaming-json`. | `default` does not guarantee strict read-only/edit isolation. |
| Cursor | Uses `cursor-agent --print --output-format stream-json`; `read-only` maps to `--mode ask`, `plan` to `--mode plan`, and `full` to `--force`. | Mappings follow [Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters) and [output formats](https://cursor.com/docs/cli/reference/output-format). |
| Gemini CLI | Uses `--output-format stream-json`; `full` adds `--yolo`, while non-full modes explicitly request `--approval-mode default`. No native `--cwd` or `--system` flag is passed; spawn working directory is supported, and a requested `systemPrompt` is rejected. | Mappings follow [headless mode](https://geminicli.com/docs/cli/headless/), [configuration](https://geminicli.com/docs/reference/configuration/), and the [official non-interactive event snapshot](https://github.com/google-gemini/gemini-cli/blob/main/packages/cli/src/__snapshots__/nonInteractiveCli.test.ts.snap). |
| Devin | Uses `-p` with a positional prompt; `full` adds `--permission-mode dangerous`, other permission levels use `normal`. Output is treated as plain text. Working directory is set through process spawn options rather than a native `--cwd` argument; `systemPrompt` is rejected. | Mappings follow [Devin CLI commands](https://docs.devin.ai/cli/reference/commands) and [permission modes](https://docs.devin.ai/cli/reference/permissions). |

Grok, Gemini, and Devin's non-full permission modes do not provide an AgentBridge-enforced filesystem/process sandbox. Prompt guidance or the provider's native mode/default may reduce actions, but should not be treated as a hard boundary. Cursor's ask/plan modes and the controls in other harnesses are also not a blanket guarantee against side effects from provider configuration, hooks, MCP servers, or subprocesses.

The CLI protocol and feature set can change. Recheck the installed command's help and its official documentation when updating an adapter; do not copy flags between harnesses. In particular, AgentBridge's `--yolo` option remains Codex-only. For quota reader availability and limitations, see [Provider quota support](PROVIDER_QUOTA_SUPPORT.md).
