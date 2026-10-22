// Install / login hints appended to NOT_INSTALLED and NOT_LOGGED_IN messages.
export const INSTALL_HINT: Record<string, string> = {
  claude: 'install Claude Code (npm i -g @anthropic-ai/claude-code), then run `claude` once to log in',
  codex: 'install Codex CLI (npm i -g @openai/codex), then run `codex login`',
  opencode: 'install opencode (npm i -g opencode-ai), then run `opencode auth login`',
  agy: 'install the Antigravity CLI (agy) and sign in with it once',
  pi: 'install pi (npm i -g @earendil-works/pi-coding-agent) and configure a model/provider',
  cursor: 'install Cursor Agent (cursor-agent) and run `cursor-agent login`',
  gemini: 'install Gemini CLI (npm i -g @google/gemini-cli) and sign in once',
  grok: 'install the Grok CLI and set XAI_API_KEY',
  devin: 'install the Devin CLI and sign in once',
};

export const LOGIN_HINT: Record<string, string> = {
  claude: 'run `claude` and log in (or `claude setup-token`)',
  codex: 'run `codex login`',
  opencode: 'run `opencode auth login`',
  agy: 'open `agy` and sign in',
  pi: 'run `pi` and configure a provider (`/login`)',
  cursor: 'run `cursor-agent login` (or set CURSOR_API_KEY)',
  gemini: 'run `gemini` and sign in',
  grok: 'set XAI_API_KEY',
  devin: 'sign in with the Devin CLI',
};

export function hintFor(name: string, code: string): string {
  const h = code === 'NOT_INSTALLED' ? INSTALL_HINT[name] : LOGIN_HINT[name];
  return h ? ` — ${h}` : '';
}
