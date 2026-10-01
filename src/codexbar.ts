import type { Credits, Pace, ProviderUsage, Snapshot, UsageWindow } from "./types";

type Obj = Record<string, unknown>;

const DISPLAY_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
  copilot: "Copilot",
  openai: "OpenAI",
  opencode: "OpenCode",
  factory: "Factory",
};

const STANDARD_WINDOWS = ["primary", "secondary", "tertiary"] as const;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function date(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function obj(v: unknown): Obj {
  return isObj(v) ? v : {};
}

export function windowLabel(minutes: number | null): string {
  if (minutes === null) return "한도";
  if (minutes === 300) return "5시간";
  if (minutes === 1440) return "일간";
  if (minutes === 10080) return "주간";
  if (minutes === 43200 || minutes === 44640) return "월간";
  if (minutes % 1440 === 0) return `${minutes / 1440}일`;
  if (minutes % 60 === 0) return `${minutes / 60}시간`;
  return `${minutes}분`;
}

function displayName(provider: string): string {
  return DISPLAY_NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

function parsePace(v: unknown): Pace | null {
  if (!isObj(v)) return null;
  return {
    stage: str(v["stage"]) ?? "unknown",
    expectedUsedPercent: num(v["expectedUsedPercent"]),
    deltaPercent: num(v["deltaPercent"]),
    willLastToReset: bool(v["willLastToReset"]),
    etaSeconds: num(v["etaSeconds"]),
    summary: str(v["summary"]),
  };
}

function parseWindow(id: string, label: string | null, raw: unknown, pace: Pace | null): UsageWindow | null {
  if (!isObj(raw)) return null;
  const usedPercent = num(raw["usedPercent"]);
  if (usedPercent === null) return null;
  const windowMinutes = num(raw["windowMinutes"]);
  return {
    id,
    label: label ?? windowLabel(windowMinutes),
    usedPercent,
    windowMinutes,
    resetsAt: date(raw["resetsAt"]),
    pace,
  };
}

function parseError(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (isObj(v)) return str(v["message"]);
  return null;
}

function parseEntry(entry: Obj): ProviderUsage {
  const provider = str(entry["provider"]) ?? "unknown";
  const usage = obj(entry["usage"]);
  const identity = obj(usage["identity"]);
  const paceMap = obj(entry["pace"]);

  const windows: UsageWindow[] = [];
  for (const id of STANDARD_WINDOWS) {
    const w = parseWindow(id, null, usage[id], parsePace(paceMap[id]));
    if (w) windows.push(w);
  }
  const extras = usage["extraRateWindows"];
  if (Array.isArray(extras)) {
    extras.forEach((extra, i) => {
      if (!isObj(extra)) return;
      const id = str(extra["id"]) ?? `extra-${i}`;
      const w = parseWindow(id, str(extra["title"]) ?? id, extra["window"], null);
      if (w) windows.push(w);
    });
  }

  const creditsRaw = obj(entry["credits"]);
  const remaining = num(creditsRaw["remaining"]);
  const credits: Credits | null =
    remaining === null ? null : { remaining, unit: str(obj(usage["providerCost"])["currencyCode"]) ?? "Credits" };

  return {
    provider,
    displayName: displayName(provider),
    plan: str(usage["loginMethod"]) ?? str(identity["loginMethod"]),
    account: str(usage["accountEmail"]) ?? str(identity["accountEmail"]),
    source: str(entry["source"]),
    updatedAt: date(usage["updatedAt"]),
    windows,
    credits,
    error: parseError(entry["error"]),
  };
}

export function parseCodexbarJson(raw: unknown, fetchedAt: Date): Snapshot {
  if (!Array.isArray(raw)) {
    return { fetchedAt, providers: [], error: "codexbar 출력 형식을 해석할 수 없음" };
  }
  return { fetchedAt, providers: raw.filter(isObj).map(parseEntry), error: null };
}

export interface FetchOptions {
  bin?: string;
  timeoutMs?: number;
  args?: string[];
}

function failed(error: string): Snapshot {
  return { fetchedAt: new Date(), providers: [], error };
}

function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  return (lines.at(-1) ?? "").slice(0, 200);
}

export async function fetchSnapshot(opts: FetchOptions = {}): Promise<Snapshot> {
  const bin = opts.bin ?? process.env["CODEXBAR_BIN"] ?? "codexbar";
  const timeoutMs = opts.timeoutMs ?? 60_000;

  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>;
  try {
    proc = Bun.spawn([bin, "usage", "--json", "--no-color", ...(opts.args ?? [])], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return failed(`codexbar 실행 실패: ${e instanceof Error ? e.message : String(e)}`);
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);

  if (timedOut) return failed(`codexbar 응답 시간 초과 (${Math.round(timeoutMs / 1000)}s)`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    if (exitCode !== 0) return failed(lastLine(stderr) || `codexbar 종료 코드 ${exitCode}`);
    return failed("codexbar JSON 파싱 실패");
  }
  return parseCodexbarJson(parsed, new Date());
}
