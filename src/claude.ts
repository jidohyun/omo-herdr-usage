import { computePace } from "./pace";
import { failedProvider, getJson, isObj, isoDate, num, str, type FetchLike, type Obj } from "./http";
import type { ProviderUsage, UsageWindow } from "./types";

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const EXPIRED = "Claude 토큰 만료 - Claude Code를 한 번 실행하면 갱신됩니다";

export interface ClaudeCredentials {
  accessToken: string;
  expiresAt: number | null;
  plan: string | null;
}

const KINDS: Record<string, { label: string; minutes: number }> = {
  session: { label: "5시간", minutes: 300 },
  weekly_all: { label: "주간", minutes: 10080 },
};

const GROUP_MINUTES: Record<string, number> = { session: 300, weekly: 10080 };

export function planFrom(oauth: Obj): string | null {
  const tier = str(oauth["rateLimitTier"])?.match(/(\d+x)$/)?.[1];
  const type = str(oauth["subscriptionType"]);
  if (!type) return null;
  return tier ? `${type} ${tier}` : type;
}

export async function readClaudeKeychain(): Promise<ClaudeCredentials | string> {
  const proc = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return "키체인에 Claude Code 로그인 정보가 없음 - Claude Code에 로그인하세요";
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    return "키체인의 Claude 로그인 정보를 해석할 수 없음";
  }
  const oauth = isObj(parsed) && isObj(parsed["claudeAiOauth"]) ? parsed["claudeAiOauth"] : null;
  const accessToken = oauth ? str(oauth["accessToken"]) : null;
  if (!oauth || !accessToken) return "키체인에 Claude OAuth 토큰이 없음 - Claude Code에 로그인하세요";
  return { accessToken, expiresAt: num(oauth["expiresAt"]), plan: planFrom(oauth) };
}

function window(id: string, label: string, usedPercent: number, minutes: number | null, resetsAt: Date | null, now: Date): UsageWindow {
  return { id, label, usedPercent, windowMinutes: minutes, resetsAt, pace: computePace(usedPercent, minutes, resetsAt, now) };
}

export function parseClaudeUsage(raw: unknown, now: Date): UsageWindow[] {
  if (!isObj(raw)) return [];
  const limits = raw["limits"];
  if (Array.isArray(limits)) {
    return limits.flatMap((l, i): UsageWindow[] => {
      if (!isObj(l)) return [];
      const percent = num(l["percent"]);
      if (percent === null) return [];
      const kind = str(l["kind"]) ?? `limit-${i}`;
      const scope = isObj(l["scope"]) ? l["scope"] : {};
      const model = isObj(scope["model"]) ? str(scope["model"]["display_name"]) : null;
      const known = KINDS[kind];
      const label = known?.label ?? (model ? `${model} 전용` : kind);
      const minutes = known?.minutes ?? GROUP_MINUTES[str(l["group"]) ?? ""] ?? null;
      return [window(model ? `${kind}:${model}` : kind, label, percent, minutes, isoDate(l["resets_at"]), now)];
    });
  }
  const legacy: Array<[string, string, number]> = [
    ["five_hour", "5시간", 300],
    ["seven_day", "주간", 10080],
  ];
  return legacy.flatMap(([key, label, minutes]): UsageWindow[] => {
    const w = raw[key];
    const percent = isObj(w) ? num(w["utilization"]) : null;
    if (!isObj(w) || percent === null) return [];
    return [window(key, label, percent, minutes, isoDate(w["resets_at"]), now)];
  });
}

export interface Cooldown {
  until: number;
}

export interface ClaudeOptions {
  readCredentials?: () => Promise<ClaudeCredentials | string>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
  cooldown?: Cooldown;
}

export const claudeCooldown: Cooldown = { until: 0 };

function rateLimited(untilMs: number): string {
  return `Claude 요청 제한 (429) - ${new Date(untilMs).toLocaleTimeString("en-GB", { hour12: false })} 이후 다시 조회`;
}

export async function fetchClaude(opts: ClaudeOptions = {}): Promise<ProviderUsage> {
  const now = opts.now ?? (() => new Date());
  const cooldown = opts.cooldown ?? claudeCooldown;
  const creds = await (opts.readCredentials ?? readClaudeKeychain)();
  if (typeof creds === "string") return failedProvider("claude", "Claude", creds);
  const base = { plan: creds.plan };
  if (creds.expiresAt !== null && creds.expiresAt <= now().getTime()) return failedProvider("claude", "Claude", EXPIRED, base);
  if (cooldown.until > now().getTime()) return failedProvider("claude", "Claude", rateLimited(cooldown.until), base);
  const res = await getJson(
    CLAUDE_USAGE_URL,
    { Authorization: `Bearer ${creds.accessToken}`, "anthropic-beta": "oauth-2025-04-20" },
    opts.fetchImpl ?? fetch,
    opts.timeoutMs ?? 15_000,
  );
  if (!res.ok && res.status === 429) {
    cooldown.until = now().getTime() + (res.retryAfterSec ?? 60) * 1000;
    return failedProvider("claude", "Claude", rateLimited(cooldown.until), base);
  }
  if (!res.ok) return failedProvider("claude", "Claude", res.status === 401 ? EXPIRED : `Claude 사용량 조회 실패: ${res.message}`, base);
  const at = now();
  return {
    provider: "claude",
    displayName: "Claude",
    plan: creds.plan,
    account: null,
    source: "api",
    updatedAt: at,
    windows: parseClaudeUsage(res.json, at),
    credits: null,
    error: null,
  };
}
