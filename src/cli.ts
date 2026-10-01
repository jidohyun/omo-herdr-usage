#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { mergeSnapshots } from "./cache";
import { claudeCooldown } from "./claude";
import { parseCodexbarJson } from "./codexbar";
import { renderDashboard } from "./render";
import { herdrPane } from "./herdr";
import { ARROW_SIDES, ArrowCombo, KEY_POSITIONS, placePane, type Position } from "./placement";
import { CONFIG_PATH, fetchShared, loadConfig, type SourceConfig } from "./sources";
import type { Snapshot } from "./types";

const USAGE = `aiusage - 구독 중인 AI 사용량 대시보드 (Claude·Codex 사용량 API 직접 조회)

사용법: aiusage [옵션]

옵션:
  --once                   한 번 출력하고 종료
  --interval <초>          라이브 모드 갱신 주기 (기본 60, 최소 15)
  --codexbar               codexbar CLI로 Cursor 등 다른 프로바이더도 함께 표시 (느림)
  --fixture <경로>         codexbar JSON 파일로 렌더 (네트워크 없이 확인용)
  --close-pane <id>        이 뷰어가 도는 herdr pane id. 종료할 때 닫고, 배치 키를 켬 (omo 확장이 사용)
  --anchor <id>            방향키 배치의 기준 pane id (omo 확장이 에이전트 pane을 넘김)
  --no-color               색상 끄기 (NO_COLOR 환경변수도 지원)
  -h, --help               도움말

키: q / Ctrl-C 종료, r 즉시 새로고침
herdr pane 안에서: 방향키 하나 = 그 방향으로 한 칸 이동(옆 pane 하나를 건넘), 방향키 두 개를 0.2초 안에 연달아(↑→ 등) = 탭의 그 모서리
                   숫자 8 2 4 6 = 에이전트 pane의 위·아래·왼쪽·오른쪽, 7 9 1 3 = 탭의 모서리
설정 파일: ${CONFIG_PATH}  예) {"sources": {"opencode": false}, "hide": ["old@example.com"]}
계정 출처: omo, Claude Code, codex CLI(~/.codex), CodexBar, OpenCode. 같은 이메일은 한 줄로 합침
환경변수: CODEX_HOME (기본 Codex 로그인 위치), CODEXBAR_BIN (codexbar 실행 파일 경로)
`;

interface Config {
  once: boolean;
  intervalSec: number;
  fixture: string | null;
  color: boolean;
  sources: SourceConfig;
  closePane: string | null;
  anchor: string | null;
}

function parseConfig(argv: string[], file: SourceConfig): Config {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        once: { type: "boolean", default: false },
        interval: { type: "string" },
        fixture: { type: "string" },
        codexbar: { type: "boolean" },
        "close-pane": { type: "string" },
        anchor: { type: "string" },
        "no-color": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (e) {
    process.stderr.write(`오류: ${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    process.exit(2);
  }
  const v = parsed.values;
  if (v.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  let intervalSec = 60;
  if (v.interval !== undefined) {
    const n = Number(v.interval);
    if (!Number.isFinite(n)) {
      process.stderr.write(`오류: --interval 은 숫자여야 합니다: ${v.interval}\n\n${USAGE}`);
      process.exit(2);
    }
    intervalSec = Math.max(15, n);
  }
  const color = !v["no-color"] && process.env["NO_COLOR"] === undefined && process.stdout.isTTY === true;
  const sources: SourceConfig = { ...file, codexbar: v.codexbar ?? file.codexbar };
  return { once: v.once === true, intervalSec, fixture: v.fixture ?? null, color, sources, closePane: v["close-pane"] ?? null, anchor: v.anchor ?? null };
}

const MANUAL_MAX_AGE_MS = 15_000;

async function loadSnapshot(cfg: Config, maxAgeMs: number): Promise<Snapshot> {
  if (cfg.fixture === null) return fetchShared(cfg.sources, maxAgeMs);
  try {
    const text = await Bun.file(cfg.fixture).text();
    return parseCodexbarJson(JSON.parse(text), new Date());
  } catch (e) {
    return { fetchedAt: new Date(), providers: [], error: `fixture 읽기 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function failed(snapshot: Snapshot): boolean {
  const anyData = snapshot.providers.some((p) => p.windows.length > 0);
  return !anyData && (snapshot.error !== null || snapshot.providers.some((p) => p.error !== null));
}

async function runOnce(cfg: Config): Promise<number> {
  const snapshot = await loadSnapshot(cfg, MANUAL_MAX_AGE_MS);
  const lines = renderDashboard(snapshot, {
    now: new Date(),
    width: process.stdout.columns || 100,
    color: cfg.color,
    refreshing: false,
    nextRefreshAt: null,
  });
  process.stdout.write(lines.join("\n") + "\n");
  return failed(snapshot) ? 1 : 0;
}

function runLive(cfg: Config): void {
  const out = process.stdout;
  const stdin = process.stdin;
  let snapshot: Snapshot | null = null;
  let fetching = false;
  let nextRefreshAt: Date | null = null;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let restored = false;
  let placing = false;
  let renderedLines = 0;
  let notice: { text: string; until: number } | null = null;
  const baseFooter = cfg.closePane === null ? " q 종료 · r 새로고침" : " q 종료 · r 새로고침 · 방향키 한 칸 이동 · 두 방향 연달아(↑→) 모서리";

  const restore = () => {
    if (restored) return;
    restored = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    if (tickTimer) clearInterval(tickTimer);
    out.removeListener("resize", draw);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    out.write("\x1b[?25h\x1b[?1049l");
  };

  const quit = (code: number) => {
    restore();
    if (cfg.closePane !== null) Bun.spawnSync(["herdr", "pane", "close", cfg.closePane], { stdout: "ignore", stderr: "ignore" });
    process.exit(code);
  };

  function draw() {
    const rows = out.rows || 40;
    const all = renderDashboard(snapshot, {
      now: new Date(),
      width: out.columns || 100,
      color: cfg.color,
      refreshing: fetching,
      nextRefreshAt: fetching ? null : nextRefreshAt,
      footer: notice && notice.until > Date.now() ? `${baseFooter} · ${notice.text}` : baseFooter,
    });
    renderedLines = all.length;
    const lines = all.length > rows ? [...all.slice(0, Math.max(0, rows - 1)), all[all.length - 1] ?? ""] : all;
    out.write("\x1b[H" + lines.map((l) => l + "\x1b[K").join("\r\n") + "\x1b[J");
  }

  const refresh = async (manual: boolean) => {
    if (fetching || restored) return;
    fetching = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    draw();
    const next = await loadSnapshot(cfg, manual ? MANUAL_MAX_AGE_MS : Math.max(MANUAL_MAX_AGE_MS, cfg.intervalSec * 1000 - 5000));
    fetching = false;
    if (restored) return;
    snapshot = mergeSnapshots(snapshot, next);
    const intervalMs = cfg.intervalSec * 1000;
    const cooldownMs = claudeCooldown.until - Date.now();
    const delay = cooldownMs > 0 && cooldownMs < intervalMs ? Math.max(5000, cooldownMs + 1000) : intervalMs;
    nextRefreshAt = new Date(Date.now() + delay);
    refreshTimer = setTimeout(() => void refresh(false), delay);
    draw();
  };

  const place = async (position: Position, relative: boolean) => {
    if (cfg.closePane === null || placing || restored) return;
    placing = true;
    notice = { text: "옮기는 중…", until: Date.now() + 10_000 };
    draw();
    try {
      notice = { text: await placePane(herdrPane, cfg.closePane, cfg.anchor, position, relative, Math.max(14, renderedLines + 1)), until: Date.now() + 4000 };
    } catch (error) {
      notice = { text: `⚠ ${error instanceof Error ? error.message : String(error)}`, until: Date.now() + 8000 };
    }
    placing = false;
    draw();
  };

  const combo = new ArrowCombo((position) => void place(position, true));

  process.on("SIGINT", () => quit(0));
  process.on("SIGTERM", () => quit(0));
  process.on("uncaughtException", (e) => {
    restore();
    process.stderr.write(`${e.stack ?? String(e)}\n`);
    process.exit(1);
  });
  process.on("unhandledRejection", (e) => {
    restore();
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });

  out.write("\x1b[?1049h\x1b[?25l\x1b[2J");
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    for (const [key] of chunk.matchAll(/\x1b\[[A-D]|\x1bO[A-D]|[\s\S]/g)) {
      if (key === "q" || key === "Q" || key === "\u0003") quit(0);
      else if (key === "r" || key === "R") void refresh(true);
      else if (ARROW_SIDES[key] && cfg.closePane !== null) combo.press(ARROW_SIDES[key]);
      else if (KEY_POSITIONS[key]) void place(KEY_POSITIONS[key], false);
    }
  });
  stdin.on("end", () => quit(0));
  stdin.resume();

  out.on("resize", draw);
  tickTimer = setInterval(draw, 1000);
  draw();
  void refresh(false);
}

const fileConfig = await loadConfig();
if (typeof fileConfig === "string") {
  process.stderr.write(`오류: ${fileConfig}\n`);
  process.exit(2);
}
const cfg = parseConfig(process.argv.slice(2), fileConfig);
if (cfg.once || !process.stdout.isTTY) {
  process.exit(await runOnce(cfg));
} else {
  runLive(cfg);
}
