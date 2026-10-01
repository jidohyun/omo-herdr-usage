import { describe, expect, test } from "bun:test";
import { formatCountdown, formatPercentColor, renderDashboard } from "../src/render";
import type { RenderOptions, Snapshot } from "../src/types";

const now = new Date("2026-09-30T15:15:00Z");
const at = (ms: number) => new Date(now.getTime() + ms);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const snapshot: Snapshot = {
  fetchedAt: now,
  error: null,
  providers: [
    {
      provider: "claude",
      displayName: "Claude",
      plan: null,
      account: null,
      source: "claude",
      updatedAt: now,
      credits: null,
      error: null,
      windows: [
        {
          id: "primary",
          label: "5시간",
          usedPercent: 6,
          windowMinutes: 300,
          resetsAt: at(35 * MIN),
          pace: { stage: "farBehind", expectedUsedPercent: 88, deltaPercent: -82, willLastToReset: true, etaSeconds: null, summary: null },
        },
        { id: "claude-weekly-scoped-fable", label: "Fable only", usedPercent: 10, windowMinutes: 10080, resetsAt: at(3 * HOUR + 45 * MIN), pace: null },
      ],
    },
    {
      provider: "codex",
      displayName: "Codex",
      plan: "pro",
      account: "product@example.com",
      source: "codex-cli",
      updatedAt: now,
      credits: { remaining: 62500, unit: "Credits" },
      error: null,
      windows: [
        {
          id: "secondary",
          label: "주간",
          usedPercent: 89,
          windowMinutes: 10080,
          resetsAt: at(3 * DAY + HOUR),
          pace: { stage: "farAhead", expectedUsedPercent: 56, deltaPercent: 33, willLastToReset: false, etaSeconds: 41933, summary: null },
        },
      ],
    },
  ],
};

function opts(width: number, color = false, extra: Partial<RenderOptions> = {}): RenderOptions {
  return { now, width, color, refreshing: false, nextRefreshAt: null, ...extra };
}

describe("formatCountdown", () => {
  test("formats each magnitude", () => {
    expect(formatCountdown(0)).toBe("곧");
    expect(formatCountdown(-5)).toBe("곧");
    expect(formatCountdown(10_000)).toBe("1m");
    expect(formatCountdown(35 * MIN)).toBe("35m");
    expect(formatCountdown(3 * HOUR + 45 * MIN)).toBe("3h 45m");
    expect(formatCountdown(3 * DAY + HOUR)).toBe("3d 1h");
  });
});

describe("formatPercentColor", () => {
  test("uses 60/85 thresholds", () => {
    expect(formatPercentColor(59)).toBe("green");
    expect(formatPercentColor(60)).toBe("yellow");
    expect(formatPercentColor(84)).toBe("yellow");
    expect(formatPercentColor(85)).toBe("red");
  });
});

describe("renderDashboard", () => {
  test("renders providers, gauges, resets and pace", () => {
    const text = renderDashboard(snapshot, opts(100)).join("\n");
    for (const s of ["Claude", "Codex  PRO", "product@example.com", "5시간", "Fable only", "89%", "리셋 35m", "리셋 3d 1h", "82% 여유", "11h 38m 후 소진", "크레딧 62,500 Credits"]) {
      expect(text).toContain(s);
    }
    expect(text).not.toContain("\x1b");
  });

  test("colors only when asked", () => {
    const text = renderDashboard(snapshot, opts(100, true)).join("\n");
    expect(text).toContain("\x1b[31m");
    expect(text).toContain("\x1b[32m");
  });

  test("fits every width", () => {
    for (const width of [40, 60, 80, 120]) {
      for (const color of [true, false]) {
        for (const line of renderDashboard(snapshot, opts(width, color, { nextRefreshAt: at(45_000) }))) {
          expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  test("hides pace hints on narrow screens", () => {
    const text = renderDashboard(snapshot, opts(60)).join("\n");
    expect(text).toContain("89%");
    expect(text).not.toContain("여유");
    expect(text).not.toContain("후 소진");
  });

  test("shows refresh status in the header", () => {
    expect(renderDashboard(snapshot, opts(100, false, { nextRefreshAt: at(45_000) }))[0]).toContain("다음 45s");
    expect(renderDashboard(snapshot, opts(100, false, { refreshing: true }))[0]).toContain("갱신 중…");
  });

  test("shows loading, error and empty states", () => {
    expect(renderDashboard(null, opts(80)).join("\n")).toContain("불러오는 중");
    const failed: Snapshot = { fetchedAt: now, providers: [], error: "codexbar 실행 실패: nope" };
    expect(renderDashboard(failed, opts(80)).join("\n")).toContain("⚠ codexbar 실행 실패: nope");
    const empty: Snapshot = { fetchedAt: now, providers: [], error: null };
    expect(renderDashboard(empty, opts(80)).join("\n")).toContain("표시할 구독이 없습니다");
  });
});
