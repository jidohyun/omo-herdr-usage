import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupAccounts, isHidden, type Candidate } from "../src/accounts";
import { Picker, pickerItems, renderPicker } from "../src/picker";
import { saveHide } from "../src/sources";

const NOW = 1_790_800_000_000;
const dir = mkdtempSync(join(tmpdir(), "aiusage-picker-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cand = (kind: "claude" | "codex", origin: string, email: string | null, expires: number | null): Candidate => ({
  kind,
  origin,
  token: origin,
  expires,
  accountId: null,
  email,
  relogin: "",
});

const accounts = groupAccounts(
  [cand("claude", "omo default", "a@example.com", NOW + 1), cand("claude", "OpenCode", null, NOW - 1), cand("codex", "codex CLI", "g@example.com", NOW + 1)],
  NOW,
);

describe("hiding", () => {
  test("matches an email or an account id, including accounts without an email", () => {
    expect(isHidden(accounts[0]!, ["A@example.com"])).toBe(true);
    expect(isHidden(accounts[1]!, ["claude:opencode"])).toBe(true);
    expect(isHidden(accounts[2]!, ["claude:opencode"])).toBe(false);
  });
});

describe("Picker", () => {
  test("marks hidden accounts, moves with wrap-around and toggles", () => {
    const picker = new Picker(pickerItems(accounts, ["a@example.com"]));
    expect(picker.items.map((i) => [i.id, i.shown, i.live])).toEqual([
      ["claude:a@example.com", false, true],
      ["claude:opencode", true, false],
      ["codex:g@example.com", true, true],
    ]);
    picker.move(-1);
    expect(picker.cursor).toBe(2);
    picker.toggle();
    picker.move(1);
    picker.toggle();
    expect(picker.items.map((i) => i.shown)).toEqual([true, true, false]);
  });

  test("nextHide replaces entries for listed accounts and keeps the rest", () => {
    const picker = new Picker(pickerItems(accounts, ["a@example.com", "off-source@example.com"]));
    picker.move(1);
    picker.toggle();
    expect(picker.nextHide(["a@example.com", "off-source@example.com"])).toEqual(["off-source@example.com", "claude:a@example.com", "claude:opencode"]);
  });

  test("renders checkboxes, cursor and expiry within the width", () => {
    const picker = new Picker(pickerItems(accounts, ["a@example.com"]));
    const lines = renderPicker(picker, { width: 60, color: false, status: null });
    expect(lines).toContain(" > [ ] Claude  a@example.com · omo default");
    expect(lines).toContain("   [x] Claude  OpenCode  (만료)");
    expect(lines.every((l) => Bun.stringWidth(l) <= 60)).toBe(true);
    expect(renderPicker(null, { width: 60, color: false, status: "계정 찾는 중…" })).toContain(" 계정 찾는 중…");
  });
});

describe("saveHide", () => {
  test("writes the hide list and keeps other settings", async () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ pane: { ratio: 0.7 }, hide: ["old@example.com"] }));
    await saveHide(["claude:opencode"], path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ pane: { ratio: 0.7 }, hide: ["claude:opencode"] });
    const fresh = join(dir, "sub", "config.json");
    await saveHide(["x"], fresh);
    expect(JSON.parse(readFileSync(fresh, "utf8"))).toEqual({ hide: ["x"] });
  });
});
