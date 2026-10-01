import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CLAUDE_USAGE_URL, fetchClaude, parseClaudeUsage, planFrom, type ClaudeCredentials } from "../src/claude";
import type { FetchLike } from "../src/http";

const fixture = await Bun.file(join(import.meta.dir, "fixtures", "claude-usage.json")).json();
const now = new Date("2026-10-01T01:15:55Z");
const creds: ClaudeCredentials = { accessToken: "tok", expiresAt: now.getTime() + 3_600_000, plan: "max 20x" };

function respond(status: number, body: unknown): { fetchImpl: FetchLike; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}

describe("parseClaudeUsage", () => {
  test("maps limits to session, weekly and model-scoped windows", () => {
    const windows = parseClaudeUsage(fixture, now);
    expect(windows.map((w) => w.label)).toEqual(["5시간", "주간", "Fable 전용"]);
    expect(windows.map((w) => w.usedPercent)).toEqual([24, 10, 10]);
    expect(windows.map((w) => w.windowMinutes)).toEqual([300, 10080, 10080]);
    expect(windows[0]!.resetsAt?.toISOString()).toBe("2026-10-01T01:50:00.221Z");
    expect(windows[0]!.pace?.expectedUsedPercent).toBe(89);
    expect(windows[0]!.pace?.willLastToReset).toBe(true);
  });

  test("falls back to five_hour / seven_day without limits", () => {
    const windows = parseClaudeUsage(
      { five_hour: { utilization: 3, resets_at: "2026-10-01T02:00:00Z" }, seven_day: { utilization: 40, resets_at: null } },
      now,
    );
    expect(windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["5시간", 3],
      ["주간", 40],
    ]);
  });

  test("ignores malformed input", () => {
    expect(parseClaudeUsage(null, now)).toEqual([]);
    expect(parseClaudeUsage({ limits: [{ kind: "session" }, 5] }, now)).toEqual([]);
  });
});

describe("planFrom", () => {
  test("combines subscription type and tier", () => {
    expect(planFrom({ subscriptionType: "max", rateLimitTier: "default_claude_max_20x" })).toBe("max 20x");
    expect(planFrom({ subscriptionType: "pro" })).toBe("pro");
    expect(planFrom({})).toBeNull();
  });
});

describe("fetchClaude", () => {
  test("calls the usage endpoint with the OAuth token", async () => {
    const { fetchImpl, calls } = respond(200, fixture);
    const p = await fetchClaude({ readCredentials: async () => creds, fetchImpl, now: () => now });
    expect(calls[0]!.url).toBe(CLAUDE_USAGE_URL);
    expect(calls[0]!.headers["Authorization"]).toBe("Bearer tok");
    expect(p.error).toBeNull();
    expect(p.plan).toBe("max 20x");
    expect(p.windows).toHaveLength(3);
  });

  test("reports an expired token without calling the API", async () => {
    const { fetchImpl, calls } = respond(200, fixture);
    const p = await fetchClaude({ readCredentials: async () => ({ ...creds, expiresAt: now.getTime() - 1 }), fetchImpl, now: () => now });
    expect(calls).toHaveLength(0);
    expect(p.error).toContain("토큰 만료");
  });

  test("maps 401 to the expiry message and other failures to HTTP status", async () => {
    const unauthorized = await fetchClaude({ readCredentials: async () => creds, fetchImpl: respond(401, {}).fetchImpl, now: () => now });
    expect(unauthorized.error).toContain("토큰 만료");
    const broken = await fetchClaude({ readCredentials: async () => creds, fetchImpl: respond(500, {}).fetchImpl, now: () => now });
    expect(broken.error).toBe("Claude 사용량 조회 실패: HTTP 500");
  });

  test("honors Retry-After on 429 and skips calls during the cooldown", async () => {
    const calls: string[] = [];
    const limited: FetchLike = async (url) => {
      calls.push(url);
      return new Response("{}", { status: 429, headers: { "retry-after": "274" } });
    };
    const cooldown = { until: 0 };
    const first = await fetchClaude({ readCredentials: async () => creds, fetchImpl: limited, now: () => now, cooldown });
    expect(first.error).toMatch(/^Claude 요청 제한 \(429\) - \d\d:\d\d:\d\d 이후 다시 조회$/);
    expect(cooldown.until).toBe(now.getTime() + 274_000);
    const later = new Date(now.getTime() + 74_000);
    const second = await fetchClaude({ readCredentials: async () => creds, fetchImpl: limited, now: () => later, cooldown });
    expect(second.error).toBe(first.error);
    expect(calls).toHaveLength(1);
    const after = new Date(now.getTime() + 275_000);
    const third = await fetchClaude({ readCredentials: async () => creds, fetchImpl: respond(200, fixture).fetchImpl, now: () => after, cooldown });
    expect(third.error).toBeNull();
  });

  test("surfaces missing credentials", async () => {
    const p = await fetchClaude({ readCredentials: async () => "no login" });
    expect(p.error).toBe("no login");
    expect(p.windows).toEqual([]);
  });
});
