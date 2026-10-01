import { homedir } from "node:os";
import { join } from "node:path";
import { sharedFetch } from "./cache";
import { claudeCooldown, claudeProfile, fetchClaude, readClaudeKeychain, type ClaudeCredentials, type ClaudeProfile } from "./claude";
import { emailFromAccessToken, fetchCodex, readCodexAuth, resolveCodexHome } from "./codex";
import { fetchSnapshot } from "./codexbar";
import { isObj, str } from "./http";
import { readOmoAccounts, type OmoAccounts } from "./omo";
import type { ProviderUsage, Snapshot } from "./types";

export const CONFIG_PATH = join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "aiusage", "config.json");

export interface SourceConfig {
  codexAccount: string | null;
  codexbar: boolean;
  omoAccounts: boolean;
}

export async function loadConfig(path = CONFIG_PATH): Promise<SourceConfig | string> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { codexAccount: null, codexbar: false, omoAccounts: true };
  let raw: unknown;
  try {
    raw = await file.json();
  } catch {
    return `설정 파일을 해석할 수 없음: ${path}`;
  }
  if (!isObj(raw)) return `설정 파일 형식이 올바르지 않음: ${path}`;
  return { codexAccount: str(raw["codexAccount"]), codexbar: raw["codexbar"] === true, omoAccounts: raw["omoAccounts"] !== false };
}

const DIRECT = new Set(["claude", "codex"]);

const omoExpired = (name: string) => `omo 계정 ${name} 토큰 만료 - omo에서 이 계정으로 다시 로그인하세요`;

function same(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

function label(email: string | null, omoName: string | null): string | null {
  if (omoName === null) return email;
  return email ? `${email} · omo ${omoName}` : `omo ${omoName}`;
}

export interface SourceDeps {
  readOmo?: () => Promise<OmoAccounts>;
  readKeychain?: () => Promise<ClaudeCredentials | string>;
  profileOf?: (accessToken: string) => Promise<ClaudeProfile>;
  codexDefaultEmail?: () => Promise<string | null>;
  now?: () => number;
  fetchClaudeImpl?: typeof fetchClaude;
  fetchCodexImpl?: typeof fetchCodex;
}

async function defaultCodexEmail(account: string | null): Promise<string | null> {
  if (account !== null) return account;
  const home = await resolveCodexHome(null);
  if (typeof home !== "string") return null;
  const auth = await readCodexAuth(home);
  return typeof auth === "string" ? null : auth.email;
}

export async function collectAccounts(cfg: SourceConfig, deps: SourceDeps = {}): Promise<ProviderUsage[]> {
  const now = deps.now ?? Date.now;
  const profileOf = deps.profileOf ?? ((t: string) => claudeProfile(t));
  const none: ClaudeProfile = { email: null, plan: null };
  const runClaude = deps.fetchClaudeImpl ?? fetchClaude;
  const runCodex = deps.fetchCodexImpl ?? fetchCodex;
  const omo = cfg.omoAccounts ? await (deps.readOmo ?? readOmoAccounts)() : { claude: [], gpt: [] };
  const live = (expires: number | null) => expires === null || expires > now();

  const keychain = await (deps.readKeychain ?? readClaudeKeychain)();
  const keychainEmail = typeof keychain === "string" || !live(keychain.expiresAt) ? null : (await profileOf(keychain.accessToken)).email;
  const omoClaude = await Promise.all(omo.claude.map(async (a) => ({ a, ...(live(a.expires) ? await profileOf(a.access) : none) })));
  const keychainDup = omoClaude.some((o) => same(o.email, keychainEmail));

  const codexEmail = await (deps.codexDefaultEmail ?? (() => defaultCodexEmail(cfg.codexAccount)))();
  const omoGpt = omo.gpt.map((a) => ({ a, email: emailFromAccessToken(a.access) }));
  const codexDup = omoGpt.some((o) => same(o.email, codexEmail));

  const jobs: Array<Promise<ProviderUsage>> = [];
  if (omoClaude.length === 0 || (!keychainDup && typeof keychain !== "string")) {
    jobs.push(runClaude({ readCredentials: async () => keychain, account: keychainEmail }));
  }
  omoClaude.forEach(({ a, email, plan }) => {
    jobs.push(
      runClaude({
        provider: `claude:omo:${a.name}`,
        account: label(email, a.name),
        expiredMessage: omoExpired(a.name),
        readCredentials: async () => ({ accessToken: a.access, expiresAt: a.expires, plan }),
      }),
    );
  });
  if (!codexDup || omoGpt.length === 0) jobs.push(runCodex({ account: cfg.codexAccount }));
  omoGpt.forEach(({ a, email }) => {
    jobs.push(
      runCodex({
        provider: `codex:omo:${a.name}`,
        expiredMessage: omoExpired(a.name),
        auth: { accessToken: a.access, accountId: a.accountId, email, expiresAt: a.expires },
      }).then((p) => ({ ...p, account: label(p.account ?? email, a.name) })),
    );
  });
  return Promise.all(jobs);
}

export async function fetchAll(cfg: SourceConfig): Promise<Snapshot> {
  const [direct, extra] = await Promise.all([collectAccounts(cfg), cfg.codexbar ? fetchSnapshot() : Promise.resolve(null)]);
  const providers = [...direct, ...(extra?.providers.filter((p) => !DIRECT.has(p.provider)) ?? [])];
  return { fetchedAt: new Date(), providers, error: extra?.error ? `codexbar: ${extra.error}` : null };
}

export function fetchShared(cfg: SourceConfig, maxAgeMs: number, cachePath?: string): Promise<Snapshot> {
  const key = JSON.stringify([cfg.codexAccount, cfg.codexbar, cfg.omoAccounts]);
  const opts = { key, maxAgeMs, cooldown: claudeCooldown };
  return sharedFetch(() => fetchAll(cfg), cachePath === undefined ? opts : { ...opts, path: cachePath });
}
