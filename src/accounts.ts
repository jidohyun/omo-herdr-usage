import { homedir } from "node:os";
import { join } from "node:path";
import { claudeProfile, fetchClaude, readClaudeKeychain, type ClaudeProfile } from "./claude";
import { CODEXBAR_ACCOUNTS, emailFromAccessToken, fetchCodex, readCodexAuth } from "./codex";
import { isObj, num, str, type Obj } from "./http";
import { readOmoAccounts } from "./omo";
import type { ProviderUsage } from "./types";

export type Kind = "claude" | "codex";

export interface Candidate {
  kind: Kind;
  origin: string;
  token: string;
  expires: number | null;
  accountId: string | null;
  email: string | null;
  relogin: string;
}

export interface SourceToggles {
  omo: boolean;
  claudeCode: boolean;
  codexCli: boolean;
  codexBar: boolean;
  opencode: boolean;
}

export const ALL_SOURCES: SourceToggles = { omo: true, claudeCode: true, codexCli: true, codexBar: true, opencode: true };

export const OPENCODE_AUTH = join(process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), "opencode", "auth.json");

async function readJson(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return await file.json();
  } catch {
    return null;
  }
}

function jwtClaims(token: string): Obj {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return isObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function chatgptAccountId(token: string): string | null {
  const auth = jwtClaims(token)["https://api.openai.com/auth"];
  return isObj(auth) ? str(auth["chatgpt_account_id"]) : null;
}

export async function omoCandidates(): Promise<Candidate[]> {
  const omo = await readOmoAccounts();
  const relogin = "omo에서 이 계정으로 다시 로그인하세요";
  return [
    ...omo.claude.map((a): Candidate => ({ kind: "claude", origin: `omo ${a.name}`, token: a.access, expires: a.expires, accountId: null, email: null, relogin })),
    ...omo.gpt.map((a): Candidate => ({ kind: "codex", origin: `omo ${a.name}`, token: a.access, expires: a.expires, accountId: a.accountId, email: emailFromAccessToken(a.access), relogin })),
  ];
}

export async function claudeCodeCandidates(): Promise<Candidate[]> {
  const creds = await readClaudeKeychain();
  if (typeof creds === "string") return [];
  return [{ kind: "claude", origin: "Claude Code", token: creds.accessToken, expires: creds.expiresAt, accountId: null, email: null, relogin: "Claude Code를 한 번 실행하세요" }];
}

async function codexHomeCandidate(home: string, origin: string, relogin: string): Promise<Candidate[]> {
  const auth = await readCodexAuth(home);
  if (typeof auth === "string") return [];
  return [{ kind: "codex", origin, token: auth.accessToken, expires: auth.expiresAt, accountId: auth.accountId, email: auth.email, relogin }];
}

export function codexCliCandidates(home = process.env["CODEX_HOME"] ?? join(homedir(), ".codex")): Promise<Candidate[]> {
  return codexHomeCandidate(home, "codex CLI", "codex login 으로 다시 로그인하세요");
}

export async function codexBarCandidates(accountsFile = CODEXBAR_ACCOUNTS): Promise<Candidate[]> {
  const raw = await readJson(accountsFile);
  const accounts = isObj(raw) && Array.isArray(raw["accounts"]) ? raw["accounts"] : [];
  const homes = accounts.flatMap((a) => (isObj(a) && str(a["managedHomePath"]) ? [str(a["managedHomePath"]) as string] : []));
  const found = await Promise.all(homes.map((h) => codexHomeCandidate(h, "CodexBar", "CodexBar 앱을 열면 갱신됩니다")));
  return found.flat();
}

export async function opencodeCandidates(path = OPENCODE_AUTH): Promise<Candidate[]> {
  const raw = await readJson(path);
  if (!isObj(raw)) return [];
  const relogin = "opencode auth login 으로 다시 로그인하세요";
  const out: Candidate[] = [];
  const anthropic = isObj(raw["anthropic"]) ? raw["anthropic"] : null;
  const anthropicToken = anthropic && anthropic["type"] === "oauth" ? str(anthropic["access"]) : null;
  if (anthropic && anthropicToken) {
    out.push({ kind: "claude", origin: "OpenCode", token: anthropicToken, expires: num(anthropic["expires"]), accountId: null, email: null, relogin });
  }
  const openai = isObj(raw["openai"]) ? raw["openai"] : null;
  const openaiToken = openai && openai["type"] === "oauth" ? str(openai["access"]) : null;
  if (openai && openaiToken) {
    out.push({
      kind: "codex",
      origin: "OpenCode",
      token: openaiToken,
      expires: num(openai["expires"]),
      accountId: str(openai["accountId"]) ?? chatgptAccountId(openaiToken),
      email: emailFromAccessToken(openaiToken),
      relogin,
    });
  }
  return out;
}

export interface Account {
  kind: Kind;
  email: string | null;
  plan: string | null;
  origins: string[];
  use: Candidate;
  live: boolean;
}

export function groupAccounts(cands: Array<Candidate & { plan?: string | null }>, now: number): Account[] {
  const groups = new Map<string, Array<Candidate & { plan?: string | null }>>();
  cands.forEach((c, i) => {
    const key = c.email ? `${c.kind}:${c.email.toLowerCase()}` : `${c.kind}:#${i}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  });
  const alive = (c: Candidate) => c.expires === null || c.expires > now;
  return [...groups.values()].map((g) => {
    const live = g.filter(alive).sort((a, b) => (b.expires ?? Infinity) - (a.expires ?? Infinity));
    const use = live[0] ?? g[0]!;
    return {
      kind: use.kind,
      email: g.find((c) => c.email)?.email ?? null,
      plan: g.find((c) => c.plan)?.plan ?? null,
      origins: [...new Set(g.map((c) => c.origin))],
      use,
      live: live.length > 0,
    };
  });
}

export interface CollectDeps {
  sources?: Partial<Record<keyof SourceToggles, () => Promise<Candidate[]>>>;
  profileOf?: (token: string) => Promise<ClaudeProfile>;
  now?: () => number;
  fetchClaudeImpl?: typeof fetchClaude;
  fetchCodexImpl?: typeof fetchCodex;
}

const DEFAULT_SOURCES: Record<keyof SourceToggles, () => Promise<Candidate[]>> = {
  omo: omoCandidates,
  claudeCode: claudeCodeCandidates,
  codexCli: () => codexCliCandidates(),
  codexBar: () => codexBarCandidates(),
  opencode: () => opencodeCandidates(),
};

function providerId(a: Account): string {
  return `${a.kind}:${a.email?.toLowerCase() ?? a.use.origin}`;
}

function label(a: Account): string {
  return a.email ? `${a.email} · ${a.origins.join(", ")}` : a.origins.join(", ");
}

export async function collectAccounts(toggles: SourceToggles, deps: CollectDeps = {}, hide: string[] = []): Promise<ProviderUsage[]> {
  const now = deps.now ?? Date.now;
  const profileOf = deps.profileOf ?? ((t: string) => claudeProfile(t));
  const runClaude = deps.fetchClaudeImpl ?? fetchClaude;
  const runCodex = deps.fetchCodexImpl ?? fetchCodex;
  const sources = { ...DEFAULT_SOURCES, ...deps.sources };
  const keys = (Object.keys(sources) as Array<keyof SourceToggles>).filter((k) => toggles[k]);
  const found = (await Promise.all(keys.map((k) => sources[k]().catch(() => [] as Candidate[])))).flat();
  const enriched = await Promise.all(
    found.map(async (c) => {
      if (c.kind !== "claude" || (c.expires !== null && c.expires <= now())) return c;
      const p = await profileOf(c.token);
      return { ...c, email: c.email ?? p.email, plan: p.plan };
    }),
  );
  const accounts = groupAccounts(enriched, now()).filter((a) => !a.email || !hide.includes(a.email.toLowerCase()));
  const claude = accounts.filter((a) => a.kind === "claude");
  const codex = accounts.filter((a) => a.kind === "codex");
  const expired = (a: Account) => `토큰 만료 (${a.use.origin}) - ${a.use.relogin}`;
  return Promise.all([
    ...claude.map((a) =>
      runClaude({
        provider: providerId(a),
        account: label(a),
        expiredMessage: expired(a),
        readCredentials: async () => ({ accessToken: a.use.token, expiresAt: a.use.expires, plan: a.plan }),
      }),
    ),
    ...codex.map((a) =>
      runCodex({
        provider: providerId(a),
        expiredMessage: expired(a),
        auth: { accessToken: a.use.token, accountId: a.use.accountId, email: a.email, expiresAt: a.use.expires },
      }).then((p) => ({ ...p, account: label(a) })),
    ),
  ]);
}
