import type { Pace } from "./types";

export function computePace(usedPercent: number, windowMinutes: number | null, resetsAt: Date | null, now: Date): Pace | null {
  if (windowMinutes === null || resetsAt === null) return null;
  const windowMs = windowMinutes * 60_000;
  const elapsedMs = windowMs - (resetsAt.getTime() - now.getTime());
  if (elapsedMs <= 0 || elapsedMs > windowMs) return null;
  const expectedUsedPercent = Math.round((elapsedMs / windowMs) * 100);
  const deltaPercent = Math.round(usedPercent - expectedUsedPercent);
  const projected = (usedPercent / elapsedMs) * windowMs;
  const willLastToReset = projected <= 100;
  const etaSeconds =
    willLastToReset || usedPercent <= 0 ? null : Math.max(0, Math.round((((100 - usedPercent) / usedPercent) * elapsedMs) / 1000));
  return {
    stage: deltaPercent > 0 ? "ahead" : "behind",
    expectedUsedPercent,
    deltaPercent,
    willLastToReset,
    etaSeconds,
    summary: null,
  };
}
