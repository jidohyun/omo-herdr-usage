import type { ProviderUsage, RenderOptions, Snapshot, UsageWindow } from "./types";

type Tone = "green" | "yellow" | "red";

const CODES = { bold: "1", dim: "2", green: "32", yellow: "33", red: "31" } as const;
const TOKEN = /\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/gu;

function paint(code: keyof typeof CODES, text: string, color: boolean): string {
  return color && text.length > 0 ? `\x1b[${CODES[code]}m${text}\x1b[0m` : text;
}

function width(text: string): number {
  return Bun.stringWidth(text);
}

function padEnd(text: string, target: number): string {
  return text + " ".repeat(Math.max(0, target - width(text)));
}

function padStart(text: string, target: number): string {
  return " ".repeat(Math.max(0, target - width(text))) + text;
}

function truncate(line: string, max: number, color: boolean): string {
  if (width(line) <= max) return line;
  let out = "";
  let used = 0;
  for (const [token] of line.matchAll(TOKEN)) {
    if (token.startsWith("\x1b[")) {
      out += token;
      continue;
    }
    const w = width(token);
    if (used + w > max - 1) break;
    out += token;
    used += w;
  }
  return out + "…" + (color ? "\x1b[0m" : "");
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "곧";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days >= 1) return `${days}d ${hours}h`;
  if (hours >= 1) return `${hours}h ${minutes % 60}m`;
  return `${Math.max(1, Math.ceil(ms / 60_000))}m`;
}

export function formatPercentColor(p: number): Tone {
  if (p < 60) return "green";
  if (p < 85) return "yellow";
  return "red";
}

function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function untilNext(next: Date, now: Date): string {
  const ms = next.getTime() - now.getTime();
  return ms < 60_000 ? `${Math.max(0, Math.ceil(ms / 1000))}s` : formatCountdown(ms);
}

function header(snapshot: Snapshot | null, opts: RenderOptions): string {
  const parts: string[] = [];
  if (snapshot) parts.push(`갱신 ${clock(snapshot.fetchedAt)}`);
  if (opts.refreshing) parts.push("갱신 중…");
  else if (opts.nextRefreshAt) parts.push(`다음 ${untilNext(opts.nextRefreshAt, opts.now)}`);
  const left = paint("bold", " AI 구독 사용량", opts.color);
  const right = parts.join(" · ");
  if (right.length === 0) return left;
  const gap = opts.width - width(left) - width(right) - 1;
  return left + " ".repeat(Math.max(2, gap)) + paint("dim", right, opts.color);
}

function paceHint(w: UsageWindow, color: boolean): string {
  const pace = w.pace;
  if (!pace) return "";
  if (pace.deltaPercent !== null && pace.deltaPercent < 0) {
    return paint("green", `${Math.round(Math.abs(pace.deltaPercent))}% 여유`, color);
  }
  if (pace.willLastToReset === false && pace.etaSeconds !== null) {
    return paint("red", `${formatCountdown(pace.etaSeconds * 1000)} 후 소진`, color);
  }
  if (pace.deltaPercent !== null && pace.deltaPercent > 0) {
    return paint("yellow", `${Math.round(pace.deltaPercent)}% 초과`, color);
  }
  return "";
}

function windowRow(w: UsageWindow, labelWidth: number, opts: RenderOptions): string {
  const barWidth = Math.min(40, Math.max(10, opts.width - 50));
  const filled = Math.min(barWidth, Math.max(0, Math.round((w.usedPercent / 100) * barWidth)));
  const tone = formatPercentColor(w.usedPercent);
  const bar = paint(tone, "█".repeat(filled), opts.color) + paint("dim", "░".repeat(barWidth - filled), opts.color);
  const pct = paint(tone, padStart(`${Math.round(w.usedPercent)}%`, 4), opts.color);
  const reset = w.resetsAt ? `리셋 ${formatCountdown(w.resetsAt.getTime() - opts.now.getTime())}` : "";
  let row = `   ${padEnd(w.label, labelWidth)}  ${bar} ${pct}  ${padEnd(reset, 12)}`;
  if (opts.width >= 70) row += `  ${paceHint(w, opts.color)}`;
  return row.trimEnd();
}

function providerBlock(p: ProviderUsage, labelWidth: number, opts: RenderOptions): string[] {
  let title = " " + paint("bold", p.displayName, opts.color);
  if (p.plan) title += "  " + p.plan.toUpperCase();
  if (p.account) title += "  " + paint("dim", p.account, opts.color);
  const lines = [title];
  if (p.error) lines.push(paint("red", `   ⚠ ${p.error}`, opts.color));
  for (const w of p.windows) lines.push(windowRow(w, labelWidth, opts));
  if (p.credits) {
    lines.push(`   크레딧 ${p.credits.remaining.toLocaleString("en-US")} ${p.credits.unit}`);
  }
  return lines;
}

function body(snapshot: Snapshot | null, opts: RenderOptions): string[] {
  if (!snapshot) return [" 불러오는 중…"];
  const lines: string[] = [];
  if (snapshot.error) lines.push(paint("red", ` ⚠ ${snapshot.error}`, opts.color));
  if (snapshot.providers.length === 0) {
    if (!snapshot.error) lines.push(" 표시할 구독이 없습니다. CodexBar 앱에서 프로바이더를 켜세요.");
    return lines;
  }
  const labelWidth = Math.max(0, ...snapshot.providers.flatMap((p) => p.windows.map((w) => width(w.label))));
  snapshot.providers.forEach((p, i) => {
    if (i > 0 || lines.length > 0) lines.push("");
    lines.push(...providerBlock(p, labelWidth, opts));
  });
  return lines;
}

export function renderDashboard(snapshot: Snapshot | null, opts: RenderOptions): string[] {
  const lines = [
    header(snapshot, opts),
    paint("dim", " " + "─".repeat(Math.max(0, opts.width - 2)), opts.color),
    ...body(snapshot, opts),
    "",
    paint("dim", opts.footer ?? " q 종료 · r 새로고침", opts.color),
  ];
  return lines.map((line) => truncate(line, opts.width, opts.color));
}
