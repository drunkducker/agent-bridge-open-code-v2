// Google Gemini CLI adapter.
// Drives the installed `gemini` CLI using the local Google authentication.

import { cliJsonLinesAdapter } from './cli-json-lines.js'

const MODELS = [
  'gemini-3.5-flash',
  'gemini-3-pro-preview',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
]

const adapter = cliJsonLinesAdapter({
  name: 'gemini',
  cmd: 'gemini',
  models: MODELS,
  defaultModel: 'gemini-3.5-flash',
  buildArgs(o, prompt) {
    const args: string[] = ['--output-format', 'stream-json']
    if (o.model) args.push('-m', o.model)
    if (o.permissions === 'full') args.push('--yolo')
    else args.push('--approval-mode', 'default')
    if (o.extraArgs?.length) args.push(...o.extraArgs.map(String))
    args.push('-p', prompt)
    return args
  },
  unsupportedSystemPrompt: true,
  imagesMessage: 'Multimodal images are not supported via Gemini CLI arguments',
  textMatch: (j) => j.type === 'message' && j.role === 'assistant' && j.delta === true,
  textOf: (j) => typeof j.content === 'string' ? j.content : Array.isArray(j.content) ? j.content.filter((p: any) => p.type === 'text').map((p: any) => p.text || '').join('') : '',
  sessionOf: (j) => j.type === 'init' ? j.session_id : undefined,
  toolEvent: (j) => j.type === 'tool_use' ? { name: j.tool_name || j.name || 'tool', input: j.parameters ?? j.args } : null,
  usageMatch: (j) => j.type === 'result' && !!j.stats,
  usageOf: (j) => ({ input: j.stats?.input_tokens || 0, output: j.stats?.output_tokens || 0, cost: null }),
  errorOf: (j) => j.type === 'error' ? (j.message || j.error?.message) : j.type === 'result' && j.status === 'error' ? (j.error?.message || j.error || j.message || 'Gemini CLI reported an error') : undefined,
  fatalErrorMatch: (j) => j.type === 'result' && j.status === 'error',
  authRe: /not logged in|login|auth/i,
  authMessage: (blob) => `Gemini CLI is not logged in: ${blob}`,
})

export default adapter
