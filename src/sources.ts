import { homedir } from "node:os";
import { join } from "node:path";
import { sharedFetch } from "./cache";
import { claudeCooldown, fetchClaude } from "./claude";
import { fetchCodex } from "./codex";
import { fetchSnapshot } from "./codexbar";
import { isObj, str } from "./http";
import type { Snapshot } from "./types";

export const CONFIG_PATH = join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "aiusage", "config.json");

export interface SourceConfig {
  codexAccount: string | null;
  codexbar: boolean;
}

export async function loadConfig(path = CONFIG_PATH): Promise<SourceConfig | string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { codexAccount: null, codexbar: false };
  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    return `설정 파일을 해석할 수 없음: ${path}`;
  }
  if (!isObj(raw)) return `설정 파일 형식이 올바르지 않음: ${path}`;
  return { codexAccount: str(raw["codexAccount"]), codexbar: raw["codexbar"] === true };
}

const DIRECT = new Set(["claude", "codex"]);

export async function fetchAll(cfg: SourceConfig): Promise<Snapshot> {
  const [claude, codex, extra] = await Promise.all([
    fetchClaude(),
    fetchCodex({ account: cfg.codexAccount }),
    cfg.codexbar ? fetchSnapshot() : Promise.resolve(null),
  ]);
  const providers = [claude, codex, ...(extra?.providers.filter((p) => !DIRECT.has(p.provider)) ?? [])];
  return { fetchedAt: new Date(), providers, error: extra?.error ? `codexbar: ${extra.error}` : null };
}

export function fetchShared(cfg: SourceConfig, maxAgeMs: number, cachePath?: string): Promise<Snapshot> {
  const key = JSON.stringify([cfg.codexAccount, cfg.codexbar]);
  const opts = { key, maxAgeMs, cooldown: claudeCooldown };
  return sharedFetch(() => fetchAll(cfg), cachePath === undefined ? opts : { ...opts, path: cachePath });
}
