// Devin CLI adapter.
// Drives the Devin CLI agent using existing logins and configurations.

import { cliJsonLinesAdapter } from './cli-json-lines.js'

const MODELS = ['default', 'devin-default']

const adapter = cliJsonLinesAdapter({
  name: 'devin',
  cmd: 'devin',
  models: MODELS,
  defaultModel: 'devin-default',
  buildArgs(o, prompt) {
    const args: string[] = ['--permission-mode', o.permissions === 'full' ? 'dangerous' : 'normal']
    if (o.extraArgs?.length) args.push(...o.extraArgs.map(String))
    args.push('-p', '--', prompt)
    return args
  },
  plainText: true,
  unsupportedSystemPrompt: true,
  authRe: /auth|login|token/i,
  authMessage: (blob) => `Devin CLI authentication missing: ${blob}`,
})

export default adapter
