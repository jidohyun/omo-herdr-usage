import { describe, expect, test } from "bun:test";
import { parseClaudeProfile, type ClaudeOptions } from "../src/claude";
import { emailFromAccessToken, type CodexOptions } from "../src/codex";
import { parseOmoAuth, type OmoAccounts } from "../src/omo";
import { planPlacement, type Layout } from "../src/placement";
import { collectAccounts, type SourceConfig } from "../src/sources";
import type { ProviderUsage } from "../src/types";

const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
const NOW = 1_790_800_000_000;

describe("parseOmoAuth", () => {
  test("reads the multi-account list and the single-account shape", () => {
    const parsed = parseOmoAuth({
      "anthropic-subscription": {
        access: "placeholder",
        accounts: [
          { name: "default", access: "a1", expires: 1 },
          { name: "work", access: "a2", expires: 2 },
          { name: "broken" },
        ],
      },
      "chatgpt-subscription": { access: "g1", expires: 3, accountId: "acct" },
      devin: { access: "x" },
    });
    expect(parsed.claude.map((a) => a.name)).toEqual(["default", "work"]);
    expect(parsed.gpt).toEqual([{ name: "default", access: "g1", expires: 3, accountId: "acct" }]);
  });

  test("ignores malformed files", () => {
    expect(parseOmoAuth(null)).toEqual({ claude: [], gpt: [] });
    expect(parseOmoAuth({ "anthropic-subscription": "nope" })).toEqual({ claude: [], gpt: [] });
  });
});

describe("profiles and tokens", () => {
  test("parseClaudeProfile pulls email and plan", () => {
    expect(
      parseClaudeProfile({ account: { email: "a@example.com" }, organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" } }),
    ).toEqual({ email: "a@example.com", plan: "max 20x" });
    expect(parseClaudeProfile({})).toEqual({ email: null, plan: null });
  });

  test("emailFromAccessToken reads the OpenAI profile claim", () => {
    expect(emailFromAccessToken(jwt({ "https://api.openai.com/profile": { email: "g@example.com" } }))).toBe("g@example.com");
    expect(emailFromAccessToken("not-a-jwt")).toBeNull();
  });
});

function harness(omo: OmoAccounts, opts: { keychain?: string; keychainEmail?: string; codexEmail?: string | null } = {}) {
  const claudeCalls: ClaudeOptions[] = [];
  const codexCalls: CodexOptions[] = [];
  const emails: Record<string, string> = { kc: opts.keychainEmail ?? "kc@example.com", a1: "one@example.com", a2: "two@example.com" };
  const result = (provider: string, account: string | null): ProviderUsage => ({
    provider,
    displayName: provider.startsWith("claude") ? "Claude" : "Codex",
    plan: null,
    account,
    source: "api",
    updatedAt: null,
    windows: [],
    credits: null,
    error: null,
  });
  const cfg: SourceConfig = { codexAccount: null, codexbar: false, omoAccounts: true };
  const run = (c: SourceConfig = cfg) =>
    collectAccounts(c, {
      now: () => NOW,
      readOmo: async () => omo,
      readKeychain: async () => opts.keychain ?? { accessToken: "kc", expiresAt: null, plan: "max 20x" },
      profileOf: async (t) => ({ email: emails[t] ?? null, plan: "max 20x" }),
      codexDefaultEmail: async () => (opts.codexEmail === undefined ? "product@example.com" : opts.codexEmail),
      fetchClaudeImpl: async (o = {}) => {
        claudeCalls.push(o);
        return result(o.provider ?? "claude", o.account ?? null);
      },
      fetchCodexImpl: async (o = {}) => {
        codexCalls.push(o);
        return result(o.provider ?? "codex", o.auth?.email ?? null);
      },
    });
  return { run, claudeCalls, codexCalls, cfg };
}

const omoAccounts: OmoAccounts = {
  claude: [
    { name: "default", access: "a1", expires: NOW + 3_600_000, accountId: null },
    { name: "work", access: "a2", expires: NOW + 3_600_000, accountId: null },
    { name: "old", access: "a3", expires: NOW - 1, accountId: null },
  ],
  gpt: [{ name: "default", access: jwt({ "https://api.openai.com/profile": { email: "gpt@example.com" } }), expires: NOW + 1, accountId: "acct" }],
};

describe("collectAccounts", () => {
  test("lists the Claude Code login, every omo account and both Codex sources", async () => {
    const { run } = harness(omoAccounts);
    const providers = await run();
    expect(providers.map((p) => [p.provider, p.account])).toEqual([
      ["claude", "kc@example.com"],
      ["claude:omo:default", "one@example.com · omo default"],
      ["claude:omo:work", "two@example.com · omo work"],
      ["claude:omo:old", "omo old"],
      ["codex", null],
      ["codex:omo:default", "gpt@example.com · omo default"],
    ]);
  });

  test("shows an account logged into both Claude Code and omo once, with the omo label", async () => {
    const { run, claudeCalls } = harness(omoAccounts, { keychainEmail: "two@example.com" });
    const providers = await run();
    expect(providers.filter((p) => p.provider === "claude")).toHaveLength(0);
    expect(claudeCalls).toHaveLength(3);
  });

  test("drops the configured Codex account when omo already has the same email", async () => {
    const { run } = harness(omoAccounts, { codexEmail: "GPT@example.com" });
    expect((await run()).filter((p) => p.provider.startsWith("codex")).map((p) => p.provider)).toEqual(["codex:omo:default"]);
  });

  test("skips a missing Claude Code login when omo has Claude accounts", async () => {
    const { run } = harness(omoAccounts, { keychain: "키체인에 없음" });
    expect((await run()).some((p) => p.provider === "claude")).toBe(false);
  });

  test("omoAccounts false keeps only the original two sources", async () => {
    const { run, cfg } = harness(omoAccounts);
    expect((await run({ ...cfg, omoAccounts: false })).map((p) => p.provider)).toEqual(["claude", "codex"]);
  });
});

describe("content-sized placement", () => {
  test("asks for more rows when the dashboard is taller", () => {
    const layout: Layout = { tabId: "t", area: { x: 0, y: 0, width: 519, height: 103 }, panes: [{ id: "agent", rect: { x: 0, y: 0, width: 337, height: 103 } }] };
    expect(planPlacement(layout, "agent", "down", { x: 1, y: 1 }, 14)).toMatchObject({ ratio: 0.85 });
    expect(planPlacement(layout, "agent", "down", { x: 1, y: 1 }, 25)).toMatchObject({ ratio: 0.757 });
  });
});
