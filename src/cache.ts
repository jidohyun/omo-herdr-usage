import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Cooldown } from "./claude";
import type { ProviderUsage, Snapshot } from "./types";

export const CACHE_PATH = join(process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "aiusage", "snapshot.json");

const DATE_KEYS = new Set(["fetchedAt", "updatedAt", "resetsAt"]);
const LOCK_STALE_MS = 30_000;

interface CacheFile {
  version: 1;
  key: string;
  snapshot: Snapshot;
  claudeCooldownUntil: number;
}

function revive(key: string, value: unknown): unknown {
  if (DATE_KEYS.has(key) && typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return value;
}

export async function readCache(path: string): Promise<CacheFile | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const parsed = JSON.parse(await file.text(), revive) as Partial<CacheFile>;
    if (parsed.version !== 1 || !parsed.snapshot || !(parsed.snapshot.fetchedAt instanceof Date)) return null;
    return { version: 1, key: parsed.key ?? "", snapshot: parsed.snapshot, claudeCooldownUntil: parsed.claudeCooldownUntil ?? 0 };
  } catch {
    return null;
  }
}

function writeCache(path: string, data: CacheFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path);
}

function acquireLock(lock: string, nowMs: number): boolean {
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(lock);
    return true;
  } catch {
    try {
      if (nowMs - statSync(lock).mtimeMs < LOCK_STALE_MS) return false;
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock);
      return true;
    } catch {
      return false;
    }
  }
}

export interface SharedOptions {
  path?: string;
  key: string;
  maxAgeMs: number;
  cooldown: Cooldown;
  now?: () => Date;
}

function keepLastGood(prev: ProviderUsage | undefined, next: ProviderUsage): ProviderUsage {
  if (next.error === null || next.windows.length > 0 || !prev || prev.windows.length === 0) return next;
  return { ...prev, error: next.error };
}

export function mergeSnapshots(prev: Snapshot | null, next: Snapshot): Snapshot {
  if (prev === null) return next;
  if (next.error !== null && next.providers.length === 0 && prev.providers.length > 0) return { ...prev, error: next.error };
  const old = new Map(prev.providers.map((p) => [p.provider, p]));
  return { ...next, providers: next.providers.map((p) => keepLastGood(old.get(p.provider), p)) };
}

const ERROR_RETRY_MS = 10_000;

export async function sharedFetch(fetcher: () => Promise<Snapshot>, opts: SharedOptions): Promise<Snapshot> {
  const path = opts.path ?? CACHE_PATH;
  const now = opts.now ?? (() => new Date());
  const stored = await readCache(path);
  if (stored) opts.cooldown.until = Math.max(opts.cooldown.until, stored.claudeCooldownUntil);
  const cached = stored?.key === opts.key ? stored : null;
  if (cached) {
    const age = now().getTime() - cached.snapshot.fetchedAt.getTime();
    const hasError = cached.snapshot.error !== null || cached.snapshot.providers.some((p) => p.error !== null);
    const retryError = hasError && age >= ERROR_RETRY_MS && opts.cooldown.until <= now().getTime();
    if (age < opts.maxAgeMs && !retryError) return cached.snapshot;
  }
  const lock = `${path}.lock`;
  if (!acquireLock(lock, now().getTime())) {
    if (cached) return cached.snapshot;
    return fetcher();
  }
  try {
    const snapshot = mergeSnapshots(cached?.snapshot ?? null, await fetcher());
    writeCache(path, { version: 1, key: opts.key, snapshot, claudeCooldownUntil: opts.cooldown.until });
    return snapshot;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
