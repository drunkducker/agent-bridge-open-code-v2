// Age + count pruning for flat directories of small state files (mtime based; never throws).
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export interface PruneResult {
  total: number;
  removed: number;
}

export interface PruneOptions {
  match?: (name: string) => boolean;
  maxAgeMs: number;
  maxCount: number;
  now?: number;
}

export function pruneDir(dir: string, { match = (n) => n.endsWith('.json'), maxAgeMs, maxCount, now = Date.now() }: PruneOptions): PruneResult {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter(match);
  } catch {
    return { total: 0, removed: 0 };
  }
  const items: { f: string; m: number }[] = [];
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      items.push({ f, m: statSync(f).mtimeMs });
    } catch {
      /* raced */
    }
  }
  items.sort((a, b) => b.m - a.m);
  let removed = 0;
  items.forEach((it, i) => {
    if (i >= maxCount || now - it.m > maxAgeMs) {
      try {
        unlinkSync(it.f);
        removed++;
      } catch {
        /* ignore */
      }
    }
  });
  return { total: items.length, removed };
}

/** Positive number from env, else the default. */
export const envNum = (env: NodeJS.ProcessEnv, key: string, dflt: number): number => {
  const n = Number(env[key]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
