import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchSnapshot, parseCodexbarJson } from "../src/codexbar";

const FIXTURE = join(import.meta.dir, "fixtures", "codexbar-usage.json");
const fixture = await Bun.file(FIXTURE).json();
const now = new Date("2026-09-30T15:15:00Z");
const dir = mkdtempSync(join(tmpdir(), "aiusage-test-"));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("parseCodexbarJson", () => {
  const snap = parseCodexbarJson(fixture, now);

  test("keeps fetchedAt and both providers", () => {
    expect(snap.error).toBeNull();
    expect(snap.fetchedAt).toBe(now);
    expect(snap.providers.map((p) => p.provider)).toEqual(["codex", "claude"]);
  });

  test("normalizes codex", () => {
    const codex = snap.providers[0]!;
    expect(codex.displayName).toBe("Codex");
    expect(codex.plan).toBe("pro");
    expect(codex.account).toBe("product@example.com");
    expect(codex.windows).toHaveLength(1);
    const weekly = codex.windows[0]!;
    expect(weekly.label).toBe("주간");
    expect(weekly.usedPercent).toBe(89);
    expect(weekly.resetsAt?.toISOString()).toBe("2026-10-03T16:58:38.000Z");
    expect(weekly.pace?.etaSeconds).toBe(41933);
    expect(weekly.pace?.willLastToReset).toBe(false);
    expect(codex.credits).toEqual({ remaining: 62500, unit: "Credits" });
  });

  test("normalizes claude with extra windows", () => {
    const claude = snap.providers[1]!;
    expect(claude.displayName).toBe("Claude");
    expect(claude.windows.map((w) => w.label)).toEqual(["5시간", "주간", "Fable only"]);
    expect(claude.windows.map((w) => w.usedPercent)).toEqual([6, 55, 10]);
    expect(claude.windows[0]!.pace?.deltaPercent).toBe(-82);
    expect(claude.windows[2]!.pace).toBeNull();
    expect(claude.credits).toBeNull();
  });

  test("rejects non-array input", () => {
    const bad = parseCodexbarJson({ nope: true }, now);
    expect(bad.providers).toEqual([]);
    expect(bad.error).toBe("codexbar 출력 형식을 해석할 수 없음");
  });

  test("surfaces per-provider errors", () => {
    const s = parseCodexbarJson(
      [{ provider: "cursor", error: "boom" }, { provider: "gemini", error: { message: "nope" } }],
      now,
    );
    expect(s.providers.map((p) => p.error)).toEqual(["boom", "nope"]);
    expect(s.providers[0]!.displayName).toBe("Cursor");
  });

  test("labels uncommon window lengths", () => {
    const s = parseCodexbarJson(
      [
        {
          provider: "x",
          usage: {
            primary: { usedPercent: 1, windowMinutes: 120 },
            secondary: { usedPercent: 2, windowMinutes: 4320 },
            tertiary: { usedPercent: 3 },
          },
        },
      ],
      now,
    );
    expect(s.providers[0]!.windows.map((w) => w.label)).toEqual(["2시간", "3일", "한도"]);
  });
});

describe("fetchSnapshot", () => {
  test("reports a missing binary", async () => {
    const s = await fetchSnapshot({ bin: "/nonexistent/codexbar" });
    expect(s.providers).toEqual([]);
    expect(s.error).toStartWith("codexbar 실행 실패");
  });

  test("parses stdout of the binary", async () => {
    const bin = script("ok.sh", `cat "${FIXTURE}"`);
    const s = await fetchSnapshot({ bin });
    expect(s.error).toBeNull();
    expect(s.providers).toHaveLength(2);
  });

  test("kills a hanging binary on timeout", async () => {
    const bin = script("slow.sh", "exec sleep 5");
    const s = await fetchSnapshot({ bin, timeoutMs: 300 });
    expect(s.error).toContain("시간 초과");
  });

  test("uses the last stderr line on failure", async () => {
    const bin = script("fail.sh", 'echo "first" >&2; echo "not logged in" >&2; exit 3');
    const s = await fetchSnapshot({ bin });
    expect(s.error).toBe("not logged in");
  });
});
