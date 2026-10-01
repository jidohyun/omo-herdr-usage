import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_SOURCES, codexBarCandidates, collectAccounts, groupAccounts, opencodeCandidates, type Candidate } from "../src/accounts";
import type { ClaudeOptions } from "../src/claude";
import type { CodexOptions } from "../src/codex";
import { parseConfig } from "../src/sources";
import type { ProviderUsage } from "../src/types";

const NOW = 1_790_800_000_000;
const dir = mkdtempSync(join(tmpdir(), "aiusage-accounts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

const cand = (kind: "claude" | "codex", origin: string, email: string | null, expires: number | null, token = origin): Candidate => ({
  kind,
  origin,
  token,
  expires,
  accountId: null,
  email,
  relogin: `re ${origin}`,
});

describe("source readers", () => {
  test("opencode reads Anthropic and OpenAI OAuth logins", async () => {
    const path = join(dir, "opencode.json");
    const access = jwt({ "https://api.openai.com/profile": { email: "oc@example.com" }, "https://api.openai.com/auth": { chatgpt_account_id: "acct-oc" } });
    writeFileSync(path, JSON.stringify({ anthropic: { type: "oauth", access: "ant", expires: 5 }, openai: { type: "oauth", access, expires: 6 }, other: { type: "api", key: "x" } }));
    const found = await opencodeCandidates(path);
    expect(found.map((c) => [c.kind, c.origin, c.email, c.accountId, c.expires])).toEqual([
      ["claude", "OpenCode", null, null, 5],
      ["codex", "OpenCode", "oc@example.com", "acct-oc", 6],
    ]);
    expect(await opencodeCandidates(join(dir, "missing.json"))).toEqual([]);
  });

  test("CodexBar lists every managed home that has a login", async () => {
    const home = join(dir, "home1");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: jwt({ exp: 100 }), id_token: jwt({ email: "cb@example.com" }), account_id: "a1" } }));
    const accounts = join(dir, "accounts.json");
    writeFileSync(accounts, JSON.stringify({ accounts: [{ managedHomePath: home }, { managedHomePath: join(dir, "nohome") }] }));
    const found = await codexBarCandidates(accounts);
    expect(found.map((c) => [c.origin, c.email, c.expires, c.accountId])).toEqual([["CodexBar", "cb@example.com", 100_000, "a1"]]);
  });
});

describe("groupAccounts", () => {
  test("merges the same email across sources and uses the longest-lived valid token", () => {
    const [a] = groupAccounts(
      [cand("codex", "codex CLI", "g@example.com", NOW + 10, "cli"), cand("codex", "CodexBar", "G@example.com", NOW - 1, "bar"), cand("codex", "OpenCode", "g@example.com", NOW + 99, "oc")],
      NOW,
    );
    expect(a!.origins).toEqual(["codex CLI", "CodexBar", "OpenCode"]);
    expect(a!.use.token).toBe("oc");
    expect(a!.live).toBe(true);
  });

  test("keeps unknown-email logins apart and reports an all-expired account", () => {
    const groups = groupAccounts([cand("claude", "OpenCode", null, NOW - 5), cand("claude", "omo old", null, NOW - 1)], NOW);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.live)).toBe(true);
  });
});

function harness(found: Partial<Record<keyof typeof ALL_SOURCES, Candidate[]>>) {
  const result = (provider: string, account: string | null, error: string | null = null): ProviderUsage => ({
    provider,
    displayName: provider.startsWith("claude") ? "Claude" : "Codex",
    plan: null,
    account,
    source: "api",
    updatedAt: null,
    windows: [],
    credits: null,
    error,
  });
  const claudeCalls: ClaudeOptions[] = [];
  const codexCalls: CodexOptions[] = [];
  const emails: Record<string, string> = { kc: "two@example.com", a1: "one@example.com", a2: "two@example.com" };
  const sources = Object.fromEntries(Object.keys(ALL_SOURCES).map((k) => [k, async () => found[k as keyof typeof ALL_SOURCES] ?? []]));
  const run = (toggles = ALL_SOURCES, hide: string[] = []) =>
    collectAccounts(
      toggles,
      {
        sources,
        now: () => NOW,
        profileOf: async (t) => ({ email: emails[t] ?? null, plan: "max 20x" }),
        fetchClaudeImpl: async (o = {}) => {
          claudeCalls.push(o);
          return result(o.provider ?? "claude", o.account ?? null);
        },
        fetchCodexImpl: async (o = {}) => {
          codexCalls.push(o);
          return result(o.provider ?? "codex", null);
        },
      },
      hide,
    );
  return { run, claudeCalls, codexCalls };
}

const live = NOW + 3_600_000;
const sample = {
  omo: [cand("claude", "omo default", null, live, "a1"), cand("claude", "omo product2", null, live, "a2"), cand("codex", "omo default", "product@example.com", live, "g-omo")],
  claudeCode: [cand("claude", "Claude Code", null, live, "kc")],
  codexCli: [cand("codex", "codex CLI", "gpt@example.com", live, "g-cli")],
  codexBar: [cand("codex", "CodexBar", "product@example.com", live + 5, "g-bar"), cand("codex", "CodexBar", "gpt@example.com", NOW - 1, "g-bar2")],
  opencode: [cand("claude", "OpenCode", null, NOW - 1, "oc-ant")],
};

describe("collectAccounts", () => {
  test("shows one row per account across every source, labelled with all of its origins", async () => {
    const { run, claudeCalls, codexCalls } = harness(sample);
    const providers = await run();
    expect(providers.map((p) => [p.provider, p.account])).toEqual([
      ["claude:one@example.com", "one@example.com · omo default"],
      ["claude:two@example.com", "two@example.com · omo product2, Claude Code"],
      ["claude:OpenCode", "OpenCode"],
      ["codex:product@example.com", "product@example.com · omo default, CodexBar"],
      ["codex:gpt@example.com", "gpt@example.com · codex CLI, CodexBar"],
    ]);
    expect(codexCalls.map((c) => c.auth?.accessToken)).toEqual(["g-bar", "g-cli"]);
    expect(claudeCalls[2]!.expiredMessage).toBe("토큰 만료 (OpenCode) - re OpenCode");
  });

  test("respects disabled sources and hidden emails", async () => {
    const { run } = harness(sample);
    const providers = await run({ ...ALL_SOURCES, opencode: false, codexCli: false }, ["one@example.com"]);
    expect(providers.map((p) => p.provider)).toEqual(["claude:two@example.com", "codex:product@example.com", "codex:gpt@example.com"]);
    expect(providers.at(-1)!.account).toBe("gpt@example.com · CodexBar");
  });
});

describe("config", () => {
  test("parses source toggles, hide list and the old omoAccounts switch", () => {
    expect(parseConfig({ sources: { opencode: false }, hide: ["A@example.com", 3], omoAccounts: false })).toEqual({
      codexbar: false,
      sources: { omo: false, claudeCode: true, codexCli: true, codexBar: true, opencode: false },
      hide: ["a@example.com"],
    });
    expect(parseConfig({ codexAccount: "x@example.com" })?.sources).toEqual(ALL_SOURCES);
    expect(parseConfig("nope")).toBeNull();
  });
});
