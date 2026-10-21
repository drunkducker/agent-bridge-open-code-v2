// Proxy configuration: aliases, payload rules, agent mode limits, account pool.
import { readFileSync, watch, FSWatcher } from 'node:fs';

const PERMS = ['read-only', 'plan', 'edit', 'full'] as const;
export type Permission = (typeof PERMS)[number];
export const permRank = (p: string): number => PERMS.indexOf(p as Permission);

export interface PayloadRule {
  match: string;
  defaults?: Record<string, any>;
  override?: Record<string, any>;
}

export interface ProxyConfig {
  aliases: Record<string, string>;
  payload: PayloadRule[];
  agentRoot: string | null;
  /** Max agent sandboxes holding work at once (0 = unlimited). */
  agentMaxRuns: number;
  /** Minutes an idle agent run is kept. */
  agentRunTtlMinutes: number;
  maxPermission: Permission;
  historyBudgetTokens: number;
  accounts: Record<string, any> | null;
}

export const DEFAULTS: Readonly<ProxyConfig> = Object.freeze({
  aliases: {},
  payload: [],
  agentRoot: null,
  agentMaxRuns: 8,
  agentRunTtlMinutes: 30,
  maxPermission: 'full' as Permission,
  historyBudgetTokens: 0,
  accounts: null,
});

const isObj = (v: any): boolean => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Validate + normalize a raw config object. Throws Error with a readable message. */
export function normalizeConfig(raw: any = {}): ProxyConfig {
  if (!isObj(raw)) throw new Error('config must be a JSON object');
  const c = { ...DEFAULTS, ...raw };
  if (!isObj(c.aliases) || Object.values(c.aliases).some((v) => typeof v !== 'string')) {
    throw new Error('config.aliases must map names to model strings');
  }
  if (!Array.isArray(c.payload)) throw new Error('config.payload must be an array');
  for (const r of c.payload) {
    if (!isObj(r) || typeof r.match !== 'string') {
      throw new Error('config.payload entries need a string "match" glob');
    }
  }
  if (c.agentRoot != null && typeof c.agentRoot !== 'string') throw new Error('config.agentRoot must be a string');
  if (!(Number.isInteger(c.agentMaxRuns) && c.agentMaxRuns >= 0)) throw new Error('config.agentMaxRuns must be an integer >= 0 (0 = unlimited)');
  if (!(Number.isFinite(c.agentRunTtlMinutes) && c.agentRunTtlMinutes > 0)) throw new Error('config.agentRunTtlMinutes must be a number > 0');
  if (!PERMS.includes(c.maxPermission)) throw new Error(`config.maxPermission must be one of ${PERMS.join('|')}`);
  if (!(Number.isFinite(c.historyBudgetTokens) && c.historyBudgetTokens >= 0)) {
    throw new Error('config.historyBudgetTokens must be a number >= 0');
  }
  if (c.accounts != null && !isObj(c.accounts)) throw new Error('config.accounts must be an object');
  return c;
}

/** Glob with `*` wildcards (matches across `/`), case-insensitive. */
export function globMatch(glob: string, s: string): boolean {
  const re = new RegExp(
    '^' + glob.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
    'i'
  );
  return re.test(s);
}

export interface ConfigHolder {
  get: () => ProxyConfig;
  set: (next: any) => void;
  reload: () => Error | null;
  watch: (onError?: (err: Error) => void) => void;
  close: () => void;
}

/** Holder with an atomically swapped, immutable config snapshot. */
export function createConfig(initial: any = {}, { file }: { file?: string } = {}): ConfigHolder {
  let cur: ProxyConfig = Object.freeze(normalizeConfig(initial));
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  const h: ConfigHolder = {
    get: () => cur,
    set(next: any) {
      cur = Object.freeze(normalizeConfig(next));
    },
    /** Reload from `file`; on a parse/validation error the previous snapshot is kept and the error returned. */
    reload() {
      if (!file) return null;
      try {
        cur = Object.freeze(normalizeConfig({ ...initial, ...JSON.parse(readFileSync(file, 'utf8')) }));
        return null;
      } catch (e: any) {
        return e;
      }
    },
    watch(onError?: (err: Error) => void) {
      if (!file || watcher) return;
      try {
        watcher = watch(file, () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            const e = h.reload();
            if (e && onError) onError(e);
          }, 150);
        });
        watcher.on('error', () => {});
        watcher.unref?.();
      } catch {
        /* file watching is best-effort */
      }
    },
    close() {
      clearTimeout(timer);
      watcher?.close();
      watcher = undefined;
    },
  };
  if (file) {
    const e = h.reload();
    if (e) throw new Error(`cannot load config ${file}: ${e.message}`);
  }
  return h;
}
