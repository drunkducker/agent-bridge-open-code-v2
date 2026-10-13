// xAI Grok CLI adapter.
// Supports Grok agent CLI and ACP stdio mode.

import { cliJsonLinesAdapter } from './cli-json-lines.js'

const MODELS = ['grok-4.7', 'grok-4', 'grok-3']

const adapter = cliJsonLinesAdapter({
  name: 'grok',
  cmd: 'grok',
  models: MODELS,
  defaultModel: 'grok-4.7',
  buildArgs(o, prompt) {
    // Grok takes the prompt positionally, before every other flag.
    const args: string[] = ['-p', prompt, '--output-format', 'streaming-json']
    if (o.model) args.push('-m', o.model)
    const permissionMode = o.permissions === 'full' ? 'bypassPermissions' : o.permissions === 'plan' ? 'plan' : 'default'
    args.push('--permission-mode', permissionMode)
    if (o.cwd) args.push('--cwd', o.cwd)
    if (o.extraArgs?.length) args.push(...o.extraArgs.map(String))
    return args
  },
  textMatch: (j) => j.type === 'text',
  textOf: (j) => j.data || '',
  sessionOf: (j) => (j.type === 'end' ? j.sessionId : undefined),
  authRe: /auth|login|api[-_]?key/i,
  authMessage: (blob) => `Grok CLI authentication missing: ${blob}`,
})

export default adapter
