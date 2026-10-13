// Tiny argv parser
export const BOOL = new Set([
  'json',
  'stream',
  'worktree',
  'all',
  'once',
  'live',
  'keep',
  'help',
  'quiet',
  'no-seed',
  'no-models',
  'allow-non-loopback',
  'force',
  'first',
  'no-agents',
  'no-skill',
  'auto-approve',
  'open',
  'yes',
  'non-interactive',
  'wizard',
  'global',
  'project',
  'auto-rollback',
  'checkpoint-each',
  'strict',
  'purge',
  'copy-current',
  'login',
  'no-share',
  'accept-tos-risk',
  'wait-for-quota',
  'dangerously-skip-permissions',
  'yolo',
]);
const SHORT: Record<string, string> = {
  m: 'model',
  e: 'effort',
  h: 'help',
  j: 'json',
  s: 'stream',
  w: 'worktree',
  t: 'timeout',
  C: 'cwd',
  y: 'yes',
};

export interface ParsedArgs {
  _: string[];
  flags: Record<string, any>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const _: string[] = [],
    flags: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') {
      _.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--') || /^[A-Za-z-]$/.test(a.slice(1)) && a.startsWith('-')) {
      let k: string, v: any;
      const eq = a.indexOf('=');
      if (a.startsWith('--')) {
        if (eq > 0) {
          k = a.slice(2, eq);
          v = a.slice(eq + 1);
        } else {
          k = a.slice(2);
        }
      } else {
        k = SHORT[a.slice(1)] || a.slice(1);
      }
      if (BOOL.has(k)) {
        flags[k] = v === undefined ? true : !/^(0|false|no)$/i.test(v);
      } else {
        if (v === undefined) {
          if (i + 1 >= argv.length) throw new UsageError(`flag --${k} needs a value`);
          v = argv[++i];
        }
        flags[k] = v;
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

export class UsageError extends Error {
  code: string;
  constructor(m: string) {
    super(m);
    this.code = 'USAGE';
  }
}

export const num = (flags: Record<string, any>, k: string, { min = 0, int = false }: { min?: number; int?: boolean } = {}): number => {
  if (flags[k] == null) return undefined as any;
  const n = Number(flags[k]);
  if (!Number.isFinite(n) || n < min || (int && !Number.isInteger(n))) {
    throw new UsageError(`--${k} must be a ${int ? 'integer' : 'number'} >= ${min}`);
  }
  return n;
};

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
