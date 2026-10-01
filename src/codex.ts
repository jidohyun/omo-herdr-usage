import { homedir } from "node:os";
import { join } from "node:path";
import { windowLabel } from "./codexbar";
import { computePace } from "./pace";
import { failedProvider, getJson, isObj, num, str, type FetchLike, type Obj } from "./http";
import type { Credits, ProviderUsage, UsageWindow } from "./types";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEXBAR_ACCOUNTS = join(homedir(), "Library", "Application Support", "CodexBar", "managed-codex-accounts.json");

export interface CodexAuth {
  accessToken: string;
  accountId: string | null;
  email: string | null;
  expiresAt: number | null;
}

function jwtPayload(token: string | null): Obj {
  const part = token?.split(".")[1];
  if (!part) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return isObj(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return await file.json();
  } catch {
    return null;
  }
}

export async function readCodexAuth(home: string): Promise<CodexAuth | string> {
  const raw = await readJsonFile(join(home, "auth.json"));
  const tokens = isObj(raw) && isObj(raw["tokens"]) ? raw["tokens"] : null;
  const accessToken = tokens ? str(tokens["access_token"]) : null;
  if (!tokens || !accessToken) return `Codex 로그인 정보가 없음 (${join(home, "auth.json")})`;
  const exp = num(jwtPayload(accessToken)["exp"]);
  return {
    accessToken,
    accountId: str(tokens["account_id"]),
    email: str(jwtPayload(str(tokens["id_token"]))["email"]),
    expiresAt: exp === null ? null : exp * 1000,
  };
}

export interface ResolveOptions {
  accountsFile?: string;
  defaultHome?: string;
}

export async function resolveCodexHome(account: string | null, opts: ResolveOptions = {}): Promise<string | { error: string }> {
  const defaultHome = opts.defaultHome ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  if (account === null) return defaultHome;
  const managed = await readJsonFile(opts.accountsFile ?? CODEXBAR_ACCOUNTS);
  const accounts = isObj(managed) && Array.isArray(managed["accounts"]) ? managed["accounts"] : [];
  for (const a of accounts) {
    if (isObj(a) && str(a["email"])?.toLowerCase() === account.toLowerCase()) {
      const path = str(a["managedHomePath"]);
      if (path) return path;
    }
  }
  const own = await readCodexAuth(defaultHome);
  if (typeof own !== "string" && own.email?.toLowerCase() === account.toLowerCase()) return defaultHome;
  return { error: `Codex 계정 ${account} 의 로그인 정보를 찾을 수 없음` };
}

function rateWindow(id: string, label: string | null, raw: unknown, now: Date): UsageWindow | null {
  if (!isObj(raw)) return null;
  const usedPercent = num(raw["used_percent"]);
  if (usedPercent === null) return null;
  const seconds = num(raw["limit_window_seconds"]);
  const minutes = seconds === null ? null : Math.round(seconds / 60);
  const resetAt = num(raw["reset_at"]);
  const resetsAt = resetAt === null ? null : new Date(resetAt * 1000);
  return {
    id,
    label: label ?? windowLabel(minutes),
    usedPercent,
    windowMinutes: minutes,
    resetsAt,
    pace: computePace(usedPercent, minutes, resetsAt, now),
  };
}

function limitWindows(prefix: string, label: string | null, limit: unknown, now: Date): UsageWindow[] {
  if (!isObj(limit)) return [];
  return [
    rateWindow(`${prefix}:primary`, label, limit["primary_window"], now),
    rateWindow(`${prefix}:secondary`, label, limit["secondary_window"], now),
  ].filter((w): w is UsageWindow => w !== null);
}

export function parseCodexUsage(raw: unknown, now: Date): Pick<ProviderUsage, "plan" | "account" | "windows" | "credits"> {
  if (!isObj(raw)) return { plan: null, account: null, windows: [], credits: null };
  const windows = limitWindows("main", null, raw["rate_limit"], now);
  const extras = raw["additional_rate_limits"];
  if (Array.isArray(extras)) {
    extras.forEach((e, i) => {
      if (isObj(e)) windows.push(...limitWindows(`extra-${i}`, str(e["limit_name"]) ?? `추가 한도 ${i + 1}`, e["rate_limit"], now));
    });
  }
  windows.push(...limitWindows("review", "코드 리뷰", raw["code_review_rate_limit"], now));
  const c = isObj(raw["credits"]) ? raw["credits"] : null;
  const balance = c && c["has_credits"] === true ? num(c["balance"]) : null;
  const credits: Credits | null = balance === null ? null : { remaining: balance, unit: "Credits" };
  return { plan: str(raw["plan_type"]), account: str(raw["email"]), windows, credits };
}

export interface CodexOptions {
  account?: string | null;
  resolve?: ResolveOptions;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
  auth?: CodexAuth;
  provider?: string;
  expiredMessage?: string;
}

export function emailFromAccessToken(token: string): string | null {
  const profile = jwtPayload(token)["https://api.openai.com/profile"];
  return isObj(profile) ? str(profile["email"]) : null;
}

export async function fetchCodex(opts: CodexOptions = {}): Promise<ProviderUsage> {
  const now = opts.now ?? (() => new Date());
  const account = opts.account ?? null;
  const id = opts.provider ?? "codex";
  const fail = (error: string, auth?: CodexAuth) => failedProvider(id, "Codex", error, { account: auth?.email ?? account });
  let auth: CodexAuth | string;
  if (opts.auth) {
    auth = opts.auth;
  } else {
    const home = await resolveCodexHome(account, opts.resolve);
    if (typeof home !== "string") return fail(home.error);
    auth = await readCodexAuth(home);
  }
  if (typeof auth === "string") return fail(auth);
  const expired = opts.expiredMessage ?? `Codex 토큰 만료 (${auth.email ?? account ?? "기본 계정"}) - CodexBar 앱을 열거나 codex로 다시 로그인하세요`;
  if (auth.expiresAt !== null && auth.expiresAt <= now().getTime()) return fail(expired, auth);
  const headers: Record<string, string> = { Authorization: `Bearer ${auth.accessToken}`, "User-Agent": "codex_cli_rs" };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  const res = await getJson(CODEX_USAGE_URL, headers, opts.fetchImpl ?? fetch, opts.timeoutMs ?? 15_000);
  if (!res.ok) return fail(res.status === 401 ? expired : `Codex 사용량 조회 실패: ${res.message}`, auth);
  const at = now();
  const parsed = parseCodexUsage(res.json, at);
  return {
    provider: id,
    displayName: "Codex",
    plan: parsed.plan,
    account: parsed.account ?? auth.email,
    source: "api",
    updatedAt: at,
    windows: parsed.windows,
    credits: parsed.credits,
    error: null,
  };
}
