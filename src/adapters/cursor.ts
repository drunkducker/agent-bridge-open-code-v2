// Cursor CLI adapter.
// Drives the Cursor command line agent using existing local Cursor credentials.

import { cliJsonLinesAdapter } from './cli-json-lines.js'

const MODELS = ['auto', 'gpt-5.3-codex', 'claude-opus-4-8-thinking-high-fast', 'grok-4.7']

const adapter = cliJsonLinesAdapter({
  name: 'cursor',
  cmd: 'cursor-agent',
  models: MODELS,
  defaultModel: 'auto',
  buildArgs(o, prompt) {
    const args: string[] = ['--print', '--output-format', 'stream-json']
    if (o.model) args.push('--model', o.model)
    if (o.permissions === 'full') args.push('--force')
    else if (o.permissions === 'plan') args.push('--mode', 'plan')
    else if (o.permissions === 'read-only') args.push('--mode', 'ask')
    if (o.cwd) args.push('--workspace', o.cwd)
    if (o.extraArgs?.length) args.push(...o.extraArgs.map(String))
    args.push('--', prompt)
    return args
  },
  unsupportedSystemPrompt: true,
  textMatch: (j) => j.type === 'result',
  textOf: (j) => j.result || '',
  sessionOf: (j) => j.session_id,
  toolEvent(j) {
    if (j.type !== 'tool_call' || j.subtype !== 'started') return null
    const call = j.tool_call || {}
    const [name, detail] = (Object.entries(call) as [string, any][])[0] || ['tool', {}]
    return { name, input: detail?.args ?? detail?.input ?? detail }
  },
  errorOf: (j) => j.type === 'error' ? j.message : j.type === 'result' && j.is_error ? j.result : undefined,
  fatalErrorMatch: (j) => j.type === 'result' && j.is_error === true,
  authRe: /auth|login|unauthorized/i,
})

export default adapter
