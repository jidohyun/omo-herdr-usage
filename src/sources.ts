import { homedir } from "node:os";
import { join } from "node:path";
import { ALL_SOURCES, collectAccounts, type SourceToggles } from "./accounts";
import { sharedFetch } from "./cache";
import { claudeCooldown } from "./claude";
import { fetchSnapshot } from "./codexbar";
import { isObj, str } from "./http";
import type { Snapshot } from "./types";

export const CONFIG_PATH = join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "aiusage", "config.json");

export interface SourceConfig {
  codexbar: boolean;
  sources: SourceToggles;
  hide: string[];
}

export const DEFAULT_CONFIG: SourceConfig = { codexbar: false, sources: ALL_SOURCES, hide: [] };

export function parseConfig(raw: unknown): SourceConfig | null {
  if (!isObj(raw)) return null;
  const s = isObj(raw["sources"]) ? raw["sources"] : {};
  const on = (key: keyof SourceToggles) => s[key] !== false;
  const hide = Array.isArray(raw["hide"]) ? raw["hide"].flatMap((h) => (str(h) ? [str(h)!.toLowerCase()] : [])) : [];
  return {
    codexbar: raw["codexbar"] === true,
    sources: { omo: on("omo") && raw["omoAccounts"] !== false, claudeCode: on("claudeCode"), codexCli: on("codexCli"), codexBar: on("codexBar"), opencode: on("opencode") },
    hide,
  };
}

export async function loadConfig(path = CONFIG_PATH): Promise<SourceConfig | string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return DEFAULT_CONFIG;
  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    return `설정 파일을 해석할 수 없음: ${path}`;
  }
  return parseConfig(raw) ?? `설정 파일 형식이 올바르지 않음: ${path}`;
}

const DIRECT = new Set(["claude", "codex"]);

export async function fetchAll(cfg: SourceConfig): Promise<Snapshot> {
  const [direct, extra] = await Promise.all([collectAccounts(cfg.sources, {}, cfg.hide), cfg.codexbar ? fetchSnapshot() : Promise.resolve(null)]);
  const providers = [...direct, ...(extra?.providers.filter((p) => !DIRECT.has(p.provider)) ?? [])];
  return { fetchedAt: new Date(), providers, error: extra?.error ? `codexbar: ${extra.error}` : null };
}

export function fetchShared(cfg: SourceConfig, maxAgeMs: number, cachePath?: string): Promise<Snapshot> {
  const key = JSON.stringify([cfg.codexbar, cfg.sources, cfg.hide]);
  const opts = { key, maxAgeMs, cooldown: claudeCooldown };
  return sharedFetch(() => fetchAll(cfg), cachePath === undefined ? opts : { ...opts, path: cachePath });
}
