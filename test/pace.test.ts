import { describe, expect, test } from "bun:test";
import { computePace } from "../src/pace";

const now = new Date("2026-10-01T00:00:00Z");
const HOUR = 3_600_000;

describe("computePace", () => {
  test("reports reserve when usage trails elapsed time", () => {
    const p = computePace(10, 300, new Date(now.getTime() + 2.5 * HOUR), now)!;
    expect(p.expectedUsedPercent).toBe(50);
    expect(p.deltaPercent).toBe(-40);
    expect(p.willLastToReset).toBe(true);
    expect(p.etaSeconds).toBeNull();
  });

  test("projects exhaustion when usage runs ahead", () => {
    const p = computePace(80, 300, new Date(now.getTime() + 2.5 * HOUR), now)!;
    expect(p.deltaPercent).toBe(30);
    expect(p.willLastToReset).toBe(false);
    expect(p.etaSeconds).toBe(Math.round((20 / 80) * 2.5 * 3600));
  });

  test("returns null without a usable window", () => {
    expect(computePace(10, null, now, now)).toBeNull();
    expect(computePace(10, 300, null, now)).toBeNull();
    expect(computePace(10, 300, new Date(now.getTime() + 6 * HOUR), now)).toBeNull();
  });
});
