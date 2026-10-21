// Proxy session registry: key -> CLI session, persisted to <AGENTBRIDGE_HOME>/proxy-sessions.json, with idle TTL, a size cap
// and best-effort deletion of the CLI transcripts the proxy itself created. Keys are already scoped by a credential hash
// (sessionKeyOf); no raw credential is ever stored.
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

export interface SessionEntry {
  agent: string;
  id: string;
  /** Working directory the session was created in (claude resume is cwd-scoped). */
  cwd?: string;
  /** CLAUDE_CONFIG_DIR / CODEX_HOME override that was in effect (per-account pools), if any. */
  configDir?: string;
  created?: number;
  lastUsed?: number;
}

export const DEFAULT_CAP = 500;
export const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const agentbridgeHome = (): string => process.env.AGENTBRIDGE_HOME || path.join(homedir(), '.agentbridge');
export const sessionsFile = (): string => path.join(agentbridgeHome(), 'proxy-sessions.json');
/** Stable working directory for keyed claude sessions, so a persisted session can be resumed after a restart. */
export const proxyCwdDir = (): string => path.join(agentbridgeHome(), 'proxy-cwd');

/** "7d" | "12h" | "30m" | "90s" | "2w" | "0" (forever). A bare number is seconds. Returns ms. */
export function parseDuration(s: string | number): number {
  if (typeof s === 'number') {
    if (!Number.isFinite(s) || s < 0) throw new Error(`invalid duration "${s}"`);
    return s;
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?\s*$/i.exec(String(s));
  if (!m) throw new Error(`invalid duration "${s}" (use e.g. 7d, 12h, 30m, or 0 to keep forever)`);
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[(m[2] || 's').toLowerCase() as 's'];
  return Math.round(Number(m[1]) * unit);
}

// ---------- safe transcript paths ----------
const claudeRoot = (configDir?: string): string =>
  path.join(configDir || process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects');
const codexRoot = (configDir?: string): string =>
  path.join(configDir || process.env.CODEX_HOME || path.join(homedir(), '.codex'), 'sessions');
const slug = (p: string): string => p.replace(/[^a-zA-Z0-9]/g, '-');
const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const inside = (root: string, file: string): boolean => {
  const r = path.resolve(root) + path.sep;
  return path.resolve(file).startsWith(r);
};

/** Exact transcript files this entry owns (claude / codex only). Never returns anything outside the expected root. */
export function transcriptFiles(e: SessionEntry): string[] {
  if (!e?.id || !UUID.test(e.id)) return [];
  if (e.agent === 'claude') {
    if (!e.cwd) return [];
    const root = claudeRoot(e.configDir);
    const f = path.join(root, slug(realOr(e.cwd)), `${e.id}.jsonl`);
    return inside(root, f) ? [f] : [];
  }
  if (e.agent === 'codex') {
    const root = codexRoot(e.configDir);
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const n of names) {
        const f = path.join(dir, n);
        let st;
        try {
          st = lstatSync(f);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (depth < 4) walk(f, depth + 1);
        } else if (st.isFile() && n.startsWith('rollout-') && n.endsWith(`${e.id}.jsonl`) && inside(root, f)) found.push(f);
      }
    };
    walk(root, 0);
    return found;
  }
  return [];
}

/** Delete the transcript(s) of an entry. Returns the files removed (or that would be, with dryRun). */
export function removeTranscript(e: SessionEntry, dryRun = false): string[] {
  const out: string[] = [];
  for (const f of transcriptFiles(e)) {
    try {
      if (!lstatSync(f).isFile()) continue;
      if (!dryRun) rmSync(f, { force: true });
      out.push(f);
    } catch {
      /* best-effort */
    }
  }
  return out;
}

/** Leftover per-request scratch project dirs of old proxies: <claude projects>/<slug of $TMP/agentbridge-proxy-XXXXXX>. */
export function leftoverClaudeProjects(olderThanMs: number, now = Date.now(), configDir?: string): { dir: string; mtime: number }[] {
  const root = claudeRoot(configDir);
  const prefix = slug(path.join(realOr(tmpdir()), 'agentbridge-proxy-'));
  const re = new RegExp(`^${prefix.replace(/[^a-zA-Z0-9-]/g, '\\$&')}[A-Za-z0-9]+$`);
  const res: { dir: string; mtime: number }[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return res;
  }
  for (const n of names) {
    if (!re.test(n)) continue;
    const dir = path.join(root, n);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink() || !inside(root, dir)) continue;
      let mtime = st.mtimeMs;
      for (const f of readdirSync(dir)) mtime = Math.max(mtime, statSync(path.join(dir, f)).mtimeMs);
      if (now - mtime >= olderThanMs) res.push({ dir, mtime });
    } catch {
      /* skip */
    }
  }
  return res;
}

export function removeLeftoverClaudeProjects(olderThanMs: number, dryRun = false, configDir?: string): string[] {
  const hits = leftoverClaudeProjects(olderThanMs, Date.now(), configDir);
  if (!dryRun) for (const h of hits) rmSync(h.dir, { recursive: true, force: true });
  return hits.map((h) => h.dir);
}

// ---------- persisted file ----------
interface FileShape {
  version: 1;
  sessions: Record<string, { agent: string; sessionId: string; cwd?: string; configDir?: string; created: number; lastUsed: number }>;
}

export function readSessionsFile(file = sessionsFile()): [string, SessionEntry][] {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const out: [string, SessionEntry][] = [];
    for (const [k, v] of Object.entries<any>(j?.sessions || {})) {
      if (!v || typeof v.agent !== 'string' || typeof v.sessionId !== 'string') continue;
      out.push([
        k,
        {
          agent: v.agent,
          id: v.sessionId,
          ...(typeof v.cwd === 'string' ? { cwd: v.cwd } : {}),
          ...(typeof v.configDir === 'string' ? { configDir: v.configDir } : {}),
          created: Number(v.created) || 0,
          lastUsed: Number(v.lastUsed) || Number(v.created) || 0,
        },
      ]);
    }
    return out.sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
  } catch {
    return []; // missing or corrupt: start empty
  }
}

export function writeSessionsFile(entries: Iterable<[string, SessionEntry]>, file = sessionsFile()): void {
  const body: FileShape = { version: 1, sessions: {} };
  for (const [k, v] of entries) {
    body.sessions[k] = {
      agent: v.agent,
      sessionId: v.id,
      ...(v.cwd ? { cwd: v.cwd } : {}),
      ...(v.configDir ? { configDir: v.configDir } : {}),
      created: v.created || Date.now(),
      lastUsed: v.lastUsed || Date.now(),
    };
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(body, null, 1), { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/** Prune the persisted map without a running proxy (used by `ab sessions prune`). */
export function pruneSessionsFile(o: { olderThanMs: number; dryRun?: boolean; file?: string; now?: number }): {
  entries: { key: string; entry: SessionEntry; files: string[] }[];
  kept: number;
} {
  const now = o.now ?? Date.now();
  const all = readSessionsFile(o.file);
  const gone: { key: string; entry: SessionEntry; files: string[] }[] = [];
  const keep: [string, SessionEntry][] = [];
  for (const [k, v] of all) {
    if (o.olderThanMs > 0 && now - (v.lastUsed || v.created || 0) >= o.olderThanMs) gone.push({ key: k, entry: v, files: [] });
    else keep.push([k, v]);
  }
  for (const g of gone) {
    const shared = keep.some(([, v]) => v.agent === g.entry.agent && v.id === g.entry.id);
    g.files = shared ? [] : removeTranscript(g.entry, o.dryRun);
  }
  if (!o.dryRun && gone.length) writeSessionsFile(keep, o.file);
  return { entries: gone, kept: keep.length };
}

// ---------- the map ----------
export class SessionMap extends Map<string, SessionEntry> {
  cap = DEFAULT_CAP;
  ttlMs = 0; // 0 = no expiry (default until a proxy attaches)
  private file: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private attached = 0;

  private dispose(e: SessionEntry): void {
    for (const v of super.values()) if (v.agent === e.agent && v.id === e.id) return; // still referenced
    removeTranscript(e);
  }
  private expired(e: SessionEntry, now = Date.now()): boolean {
    return this.ttlMs > 0 && now - (e.lastUsed || e.created || now) >= this.ttlMs;
  }

  get(key: string): SessionEntry | undefined {
    const e = super.get(key);
    if (!e) return e;
    if (this.expired(e)) {
      this.delete(key);
      this.evictedHook(e);
      return undefined;
    }
    e.lastUsed = Date.now();
    this.schedule();
    return e;
  }

  // Evict-oldest cap: rewriting an existing key moves it to the newest position.
  set(key: string, v: SessionEntry): this {
    const now = Date.now();
    const prev = super.get(key);
    super.delete(key);
    const entry: SessionEntry = { ...v, created: v.created ?? (prev && prev.id === v.id ? prev.created : undefined) ?? now, lastUsed: now };
    const out = super.set(key, entry);
    if (prev && (prev.id !== v.id || prev.agent !== v.agent)) this.dispose(prev); // replaced session is orphaned
    this.enforce();
    this.schedule();
    return out;
  }

  delete(key: string): boolean {
    const r = super.delete(key);
    if (r) this.schedule();
    return r;
  }

  private evictedHook(e: SessionEntry): void {
    this.dispose(e);
  }

  /** Drop expired entries, then the oldest beyond the cap; deletes their transcripts (best-effort). */
  enforce(now = Date.now()): number {
    let n = 0;
    for (const [k, v] of [...super.entries()]) {
      if (!this.expired(v, now)) continue;
      super.delete(k);
      this.dispose(v);
      n++;
    }
    while (this.size > this.cap) {
      const oldest = this.entries().next();
      if (oldest.done) break;
      super.delete(oldest.value[0]);
      this.dispose(oldest.value[1]);
      n++;
    }
    if (n) this.schedule();
    return n;
  }

  private schedule(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 500);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.file) return;
    try {
      writeSessionsFile(super.entries(), this.file);
    } catch {
      /* persistence is best-effort */
    }
  }

  /** Load the persisted map and start the periodic sweep. Reference counted so several proxies can share the map. */
  attach(o: { file?: string | false; ttlMs?: number; cap?: number } = {}): void {
    this.attached++;
    if (o.ttlMs !== undefined) this.ttlMs = o.ttlMs;
    if (o.cap !== undefined) this.cap = o.cap;
    if (o.file !== false && !this.file) {
      this.file = o.file || sessionsFile();
      for (const [k, v] of readSessionsFile(this.file)) if (!super.has(k)) super.set(k, v);
    }
    this.enforce();
    if (this.file) this.flush();
    if (!this.sweeper) {
      this.sweeper = setInterval(() => this.enforce(), 10 * 60 * 1000);
      this.sweeper.unref?.();
    }
  }

  detach(): void {
    if (this.attached > 0) this.attached--;
    if (this.attached > 0) return;
    this.flush();
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    this.file = null;
    this.ttlMs = 0;
    this.cap = DEFAULT_CAP;
  }
}
