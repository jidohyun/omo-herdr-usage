import { describe, expect, test } from "bun:test";
import { parseClaudeProfile } from "../src/claude";
import { emailFromAccessToken } from "../src/codex";
import { parseOmoAuth } from "../src/omo";
import { planPlacement, type Layout } from "../src/placement";

const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

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

describe("content-sized placement", () => {
  test("asks for more rows when the dashboard is taller", () => {
    const layout: Layout = { tabId: "t", area: { x: 0, y: 0, width: 519, height: 103 }, panes: [{ id: "agent", rect: { x: 0, y: 0, width: 337, height: 103 } }] };
    expect(planPlacement(layout, "agent", "down", { x: 1, y: 1 }, 14)).toMatchObject({ ratio: 0.85 });
    expect(planPlacement(layout, "agent", "down", { x: 1, y: 1 }, 25)).toMatchObject({ ratio: 0.757 });
  });
});
