import { AgentError } from './errors.js';

export interface EventSession {
  type: 'session';
  id: string;
}

export interface EventText {
  type: 'text';
  delta: string;
}

export interface EventThinking {
  type: 'thinking';
  delta: string;
}

export interface EventTool {
  type: 'tool';
  name: string;
  input: any;
  output?: any;
}

export interface EventUsage {
  type: 'usage';
  input: number;
  output: number;
  cost?: number;
  incremental?: boolean;
}

export interface EventError {
  type: 'error';
  message: string;
}

export interface EventRaw {
  type: 'raw';
  data: any;
}

export interface EventFallback {
  type: 'fallback';
  from: string;
  to: string;
  code: string;
  message: string;
}

export interface EventQuota {
  type: 'quota';
  phase: 'waiting' | 'ready' | 'skipped';
  agent: string;
  message: string;
  threshold: number;
  remainingPercent?: number;
  resetAt?: number;
  nextCheckAt?: number;
  candidates?: Array<{ agent: string; threshold?: number; remainingPercent?: number; resetAt?: number }>;
}

export type CoreEvent =
  | EventSession
  | EventText
  | EventThinking
  | EventTool
  | EventUsage
  | EventError
  | EventRaw
  | EventFallback
  | EventQuota;

// Normalized event constructors + JSONL splitting.
export const ev = {
  session: (id: string): EventSession => ({ type: 'session', id }),
  text: (delta: string): EventText => ({ type: 'text', delta }),
  thinking: (delta: string): EventThinking => ({ type: 'thinking', delta }),
  tool: (name: string, input: any, output?: any): EventTool =>
    output === undefined ? { type: 'tool', name, input } : { type: 'tool', name, input, output },
  usage: (input = 0, output = 0, cost?: number, incremental = false): EventUsage => ({
    type: 'usage',
    input,
    output,
    ...(cost === undefined ? {} : { cost }),
    ...(incremental ? { incremental: true } : {}),
  }),
  error: (message: unknown): EventError => ({ type: 'error', message: String(message) }),
  raw: (data: any): EventRaw => ({ type: 'raw', data }),
  /** Emitted by run() when a failed attempt is retried on the next agent of options.fallback. */
  fallback: (from: string, to: string, code: string, message: unknown): EventFallback => ({
    type: 'fallback',
    from,
    to,
    code,
    message: String(message),
  }),
  quota: (event: Omit<EventQuota, 'type'>): EventQuota => ({ type: 'quota', ...event }),
};

/** Parse one line as JSON; returns undefined if blank/not JSON. */
export function parseJsonLine(line: string): any | undefined {
  const s = line.trim();
  if (!s || (s[0] !== '{' && s[0] !== '[')) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export interface LineSplitterOptions {
  maxLine?: number;
}

export interface LineSplitter {
  push(chunk: string): string[];
  flush(): string[];
}

/** Stateful linear-time splitter. push(chunk) -> complete lines; flush() -> remainder.
 *  opts.maxLine: max chars in one line (default 16M); exceeding throws AgentError AGENT_FAILED. */
export function createLineSplitter({ maxLine = 16 * 1024 * 1024 }: LineSplitterOptions = {}): LineSplitter {
  let pending: string[] = [], plen = 0;
  const over = () => new AgentError('AGENT_FAILED', `Output line exceeded maxLine (${maxLine} chars)`);
  return {
    push(chunk: string): string[] {
      const out: string[] = [];
      let start = 0;
      for (;;) {
        const i = chunk.indexOf(String.fromCharCode(10), start);
        if (i < 0) break;
        let line = pending.length ? pending.join('') + chunk.slice(start, i) : chunk.slice(start, i);
        pending = []; plen = 0;
        if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
        if (line.length > maxLine) {
          const err = over();
          (err as any).lines = out;
          throw err;
        } // lines completed before the oversized one are attached, not lost
        out.push(line);
        start = i + 1;
      }
      if (start < chunk.length) {
        const rest = start ? chunk.slice(start) : chunk;
        plen += rest.length;
        if (plen > maxLine) {
          const err = over();
          (err as any).lines = out;
          throw err;
        } // lines completed before the overflow are attached, not lost
        pending.push(rest);
      }
      return out;
    },
    flush(): string[] {
      const r = pending.join('');
      pending = [];
      plen = 0;
      return r ? [r] : [];
    },
  };
}
