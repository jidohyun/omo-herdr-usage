import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_USAGE_URL, fetchCodex, parseCodexUsage, resolveCodexHome } from "../src/codex";
import type { FetchLike } from "../src/http";

const fixture = await Bun.file(join(import.meta.dir, "fixtures", "codex-wham-usage.json")).json();
const now = new Date("2026-10-01T01:15:55Z");
const dir = mkdtempSync(join(tmpdir(), "aiusage-codex-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: unknown) => `h.${b64(payload)}.s`;

function home(name: string, email: string, expSec: number): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "auth.json"),
    JSON.stringify({ tokens: { access_token: jwt({ exp: expSec }), id_token: jwt({ email }), account_id: `acct-${name}` } }),
  );
  return path;
}

const validExp = Math.floor(now.getTime() / 1000) + 3600;
const productHome = home("product", "product@example.com", validExp);
const defaultHome = home("default", "gpt@example.com", validExp);
const expiredHome = home("expired", "old@example.com", Math.floor(now.getTime() / 1000) - 60);
const accountsFile = join(dir, "accounts.json");
writeFileSync(
  accountsFile,
  JSON.stringify({ accounts: [{ email: "product@example.com", managedHomePath: productHome }, { email: "old@example.com", managedHomePath: expiredHome }] }),
);
const resolve = { accountsFile, defaultHome };

function respond(status: number, body: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}

describe("parseCodexUsage", () => {
  test("maps the weekly window, plan, account and credits", () => {
    const p = parseCodexUsage(fixture, now);
    expect(p.plan).toBe("pro");
    expect(p.account).toBe("product@example.com");
    expect(p.credits).toEqual({ remaining: 62500, unit: "Credits" });
    expect(p.windows).toHaveLength(1);
    const w = p.windows[0]!;
    expect(w.label).toBe("주간");
    expect(w.usedPercent).toBe(94);
    expect(w.windowMinutes).toBe(10080);
    expect(w.resetsAt?.getTime()).toBe(1791046718 * 1000);
    expect(w.pace?.willLastToReset).toBe(false);
  });

  test("adds named extra limits and code review limits", () => {
    const p = parseCodexUsage(
      {
        rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1791000000 } },
        additional_rate_limits: [{ limit_name: "gpt-reserve", rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604800 } } }],
        code_review_rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604800 } },
        credits: { has_credits: false, balance: "0" },
      },
      now,
    );
    expect(p.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["5시간", 10],
      ["gpt-reserve", 0],
      ["코드 리뷰", 5],
    ]);
    expect(p.credits).toBeNull();
  });
});

describe("resolveCodexHome", () => {
  test("finds CodexBar managed accounts by email", async () => {
    expect(await resolveCodexHome("Product@example.com", resolve)).toBe(productHome);
  });

  test("falls back to the default home when its login matches", async () => {
    expect(await resolveCodexHome("gpt@example.com", resolve)).toBe(defaultHome);
    expect(await resolveCodexHome(null, resolve)).toBe(defaultHome);
  });

  test("reports unknown accounts", async () => {
    expect(await resolveCodexHome("nobody@example.com", resolve)).toEqual({ error: "Codex 계정 nobody@example.com 의 로그인 정보를 찾을 수 없음" });
  });
});

describe("fetchCodex", () => {
  test("queries usage as the selected account", async () => {
    const { fetchImpl, calls } = respond(200, fixture);
    const p = await fetchCodex({ account: "product@example.com", resolve, fetchImpl, now: () => now });
    expect(calls[0]!.url).toBe(CODEX_USAGE_URL);
    expect(calls[0]!.headers["ChatGPT-Account-Id"]).toBe("acct-product");
    expect(p.error).toBeNull();
    expect(p.account).toBe("product@example.com");
    expect(p.windows[0]!.usedPercent).toBe(94);
  });

  test("reports an expired token without calling the API", async () => {
    const { fetchImpl, calls } = respond(200, fixture);
    const p = await fetchCodex({ account: "old@example.com", resolve, fetchImpl, now: () => now });
    expect(calls).toHaveLength(0);
    expect(p.error).toContain("Codex 토큰 만료 (old@example.com)");
  });

  test("maps 401 and network failures", async () => {
    const unauthorized = await fetchCodex({ account: "product@example.com", resolve, fetchImpl: respond(401, {}).fetchImpl, now: () => now });
    expect(unauthorized.error).toContain("토큰 만료");
    const offline: FetchLike = async () => {
      throw new TypeError("connect ECONNREFUSED");
    };
    const down = await fetchCodex({ account: "product@example.com", resolve, fetchImpl: offline, now: () => now });
    expect(down.error).toBe("Codex 사용량 조회 실패: 네트워크 오류: connect ECONNREFUSED");
  });

  test("surfaces an unknown account", async () => {
    const p = await fetchCodex({ account: "nobody@example.com", resolve, fetchImpl: respond(200, fixture).fetchImpl, now: () => now });
    expect(p.error).toContain("찾을 수 없음");
  });
});
