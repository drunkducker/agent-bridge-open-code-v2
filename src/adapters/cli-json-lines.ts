// Shared runner for the JSON-lines CLI adapters (cursor, devin, gemini, grok).
// These four CLIs are driven the same way: validate options, optionally prefix
// the prompt for permission modes, spawn the binary, stream one JSON event per
// line, then classify the exit (TIMEOUT / ABORTED / NOT_LOGGED_IN / AGENT_FAILED).
// Everything that differs between them -- argv order, model list, auth regex,
// event field names -- is carried by the config below. The dispatch branch order
// mirrors the originals (text, tool when mapped, session, usage, error): the
// type-based branches are mutually exclusive, so only the truthy-`delta` text
// branch ever needs to come first, as it does in every original. Non-JSON lines
// fall through to plain text, and `for await (const line of p.lines)` stays
// inside the generator body so a consumer return/throw finalizes via spawnProc.

import { spawnProc } from '../core/spawn.js'
import { AgentError } from '../core/errors.js'
import { ev, parseJsonLine } from '../core/events.js'
import { validateOptions } from '../index.js'
import { AgentAdapter, AgentEvent, RunOptions, RunResult } from '../types/index.js'

export interface CliJsonLinesAdapterConfig {
  /** Registry name; also the AgentError `agent` extra and the display prefix in messages. */
  name: string
  /** Binary to spawn (resolved on PATH by spawnProc). */
  cmd: string
  /** Model list reported by models(). */
  models: string[]
  /** Result model when o.model is unset. */
  defaultModel: string
  /** Full argument list; `prompt` is the effective prompt (permission prefixes applied). */
  buildArgs(o: RunOptions, prompt: string): string[]
  /** Matched against the failure blob (errMsg + stderr) when the exit is non-zero with no output. */
  authRe?: RegExp
  /** NOT_LOGGED_IN message; default `<Name> CLI is not authenticated: <blob>`. */
  authMessage?(blob: string): string
  /** Text-branch condition (first dispatch branch); default `j.type === 'text' || j.delta`. */
  textMatch?(j: any): boolean
  /** Text-branch delta source; default `j.delta || j.text || ''`. */
  textOf?(j: any): string
  /** Tool-branch mapping; a returned payload emits a tool event, null skips (cursor: types 'tool'/'tool_call'). */
  toolEvent?(j: any): { name: string; input: any } | null
  /** Usage event source fields; default `{ input: j.input, output: j.output, cost: j.cost }`. */
  usageOf?(j: any): { input: number; output: number; cost: any }
  usageMatch?(j: any): boolean
  /** Extract session ID from provider-specific event shapes. */
  sessionOf?(j: any): string | undefined
  /** Extract provider error messages from provider-specific event shapes. */
  errorOf?(j: any): string | undefined
  /** Identify provider events that indicate a failed run even with exit code zero. */
  fatalErrorMatch?(j: any): boolean
  /** Treat each output line as plain text instead of attempting JSONL decoding. */
  plainText?: boolean
  /** Reject `systemPrompt` instead of silently ignoring it. */
  unsupportedSystemPrompt?: boolean
  /** Images rejection message; default `Multimodal images are not supported by <Name> CLI adapter`. */
  imagesMessage?: string
}

export function cliJsonLinesAdapter(cfg: CliJsonLinesAdapterConfig): AgentAdapter {
  const Name = cfg.name[0].toUpperCase() + cfg.name.slice(1)
  return {
    name: cfg.name,
    async models(): Promise<string[]> {
      return [...cfg.models]
    },
    async *run(opts: any): AsyncGenerator<AgentEvent, RunResult, void> {
      const o = validateOptions(opts)
      if (o.session?.mode === 'continue' || o.session?.mode === 'fork') {
        throw new AgentError('BAD_OPTION', `${Name} adapter does not support session mode "${o.session.mode}"`, { agent: cfg.name })
      }
      if (o.offline) {
        throw new AgentError('BAD_OPTION', `Offline mode is not supported by ${Name} CLI adapter`, { agent: cfg.name })
      }
      if (o.systemPrompt && cfg.unsupportedSystemPrompt) {
        throw new AgentError('BAD_OPTION', `${Name} CLI adapter does not support systemPrompt`, { agent: cfg.name })
      }
      if (o.images?.length) {
        throw new AgentError('BAD_OPTION', cfg.imagesMessage ?? `Multimodal images are not supported by ${Name} CLI adapter`, { agent: cfg.name })
      }

      const t0 = Date.now()
      let effectivePrompt = o.prompt
      if (o.permissions === 'read-only') {
        effectivePrompt = `[READ-ONLY MODE: Do NOT edit files or run modifying commands]\n\n${effectivePrompt}`
      } else if (o.permissions === 'plan') {
        effectivePrompt = `[PLAN-ONLY MODE: Formulate a plan only; do NOT edit files]\n\n${effectivePrompt}`
      }
      const args = cfg.buildArgs(o, effectivePrompt)

      const env: NodeJS.ProcessEnv = { ...process.env, ...(o.env || {}) }
      const p = spawnProc(cfg.cmd, args, {
        cwd: o.cwd,
        env,
        timeoutMs: o.timeoutMs,
        signal: o.signal,
        agent: cfg.name,
      })

      const textMatch = cfg.textMatch ?? ((j: any) => j.type === 'text' || j.delta)
      const textOf = cfg.textOf ?? ((j: any) => j.delta || j.text || '')
      const usageOf = cfg.usageOf ?? ((j: any) => ({ input: j.input || 0, output: j.output || 0, cost: j.cost ?? null }))

      let text = '', sessionId: string | undefined
      let usage: any = { input: 0, output: 0, cost: null }
      let errMsg: string | undefined, fatalError: string | undefined

      for await (const line of p.lines) {
        if (cfg.plainText) {
          text += line + '\n'
          yield ev.text(line + '\n') as any
          continue
        }
        const j = parseJsonLine(line)
        if (j) {
          yield ev.raw(j) as any
          const session = cfg.sessionOf?.(j)
          if (session && session !== sessionId) {
            sessionId = session
            yield ev.session(session) as any
          }
          const error = cfg.errorOf?.(j) ?? (j.type === 'error' ? j.message : undefined)
          if (error) {
            errMsg = error || errMsg
            if (cfg.fatalErrorMatch?.(j)) fatalError = error
            yield ev.error(error) as any
          }
          if (textMatch(j)) {
            const delta = textOf(j)
            text += delta
            yield ev.text(delta) as any
          } else {
            const tool = cfg.toolEvent ? cfg.toolEvent(j) : null
            if (tool) {
              yield ev.tool(tool.name, tool.input) as any
            } else if (j.type === 'session') {
              sessionId = j.id
              yield ev.session(j.id) as any
            } else if ((cfg.usageMatch?.(j) ?? j.type === 'usage')) {
              usage = usageOf(j)
              yield ev.usage(usage.input, usage.output) as any
            }
          }
        } else {
          text += line + '\n'
          yield ev.text(line + '\n') as any
        }
      }

      const r = await p.wait()
      if (r.timedOut) {
        throw new AgentError('TIMEOUT', `${Name} CLI timed out after ${o.timeoutMs}ms`, {
          agent: cfg.name,
          partial: text.trim(),
          timedOut: true,
        })
      }
      if (r.aborted) {
        throw new AgentError('ABORTED', `${Name} CLI execution was aborted`, {
          agent: cfg.name,
          partial: text.trim(),
        })
      }

      if (fatalError) {
        throw new AgentError('AGENT_FAILED', `${Name} reported failure: ${fatalError}`, {
          agent: cfg.name,
          exitCode: r.exitCode,
          stderr: r.stderr,
          partial: text.trim(),
        })
      }

      if (r.exitCode !== 0) {
        const blob = `${errMsg || ''}\n${r.stderr}`.trim()
        if (!text && cfg.authRe?.test(blob)) {
          throw new AgentError('NOT_LOGGED_IN', cfg.authMessage ? cfg.authMessage(blob) : `${Name} CLI is not authenticated: ${blob}`, { agent: cfg.name })
        }
        throw new AgentError('AGENT_FAILED', `${Name} exited with code ${r.exitCode}: ${blob}`, {
          agent: cfg.name,
          exitCode: r.exitCode,
          stderr: r.stderr,
          partial: text.trim(),
        })
      }

      return {
        text: text.trim(),
        sessionId,
        usage,
        exitCode: r.exitCode,
        model: o.model || cfg.defaultModel,
        durationMs: Date.now() - t0,
        timedOut: false,
      }
    },
  }
}
