export type Side = "up" | "down" | "left" | "right";
export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type Position = Side | Corner;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutPane {
  id: string;
  rect: Rect;
}

export interface Layout {
  tabId: string;
  area: Rect;
  panes: LayoutPane[];
}

export interface Plan {
  target: string;
  split: "down" | "right";
  ratio: number;
  swap: boolean;
}

export const POSITION_LABELS: Record<Position, string> = {
  up: "위",
  down: "아래",
  left: "왼쪽",
  right: "오른쪽",
  "top-left": "좌측상단",
  "top-right": "우측상단",
  "bottom-left": "좌측하단",
  "bottom-right": "우측하단",
};

export const ARROW_SIDES: Record<string, Side> = {
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[D": "left",
  "\x1b[C": "right",
  "\x1bOA": "up",
  "\x1bOB": "down",
  "\x1bOD": "left",
  "\x1bOC": "right",
};

export const KEY_POSITIONS: Record<string, Position> = {
  "8": "up",
  "2": "down",
  "4": "left",
  "6": "right",
  "7": "top-left",
  "9": "top-right",
  "1": "bottom-left",
  "3": "bottom-right",
};

export function combine(first: Side, second: Side): Corner | null {
  const sides = new Set([first, second]);
  const vertical = sides.has("up") ? "top" : sides.has("down") ? "bottom" : null;
  const horizontal = sides.has("left") ? "left" : sides.has("right") ? "right" : null;
  if (sides.size !== 2 || vertical === null || horizontal === null) return null;
  return `${vertical}-${horizontal}`;
}

export function isCorner(p: Position | null): p is Corner {
  return p === "top-left" || p === "top-right" || p === "bottom-left" || p === "bottom-right";
}

export type Schedule = (fn: () => void, ms: number) => unknown;
export type Cancel = (handle: unknown) => void;

export class ArrowCombo {
  private pending: Side | null = null;
  private handle: unknown = null;

  constructor(
    private readonly emit: (position: Position) => void,
    private readonly windowMs = 200,
    private readonly schedule: Schedule = (fn, ms) => setTimeout(fn, ms),
    private readonly cancel: Cancel = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  ) {}

  press(side: Side): void {
    if (this.pending === side) return;
    if (this.pending !== null) {
      const corner = combine(this.pending, side);
      this.cancel(this.handle);
      if (corner) {
        this.pending = null;
        this.emit(corner);
        return;
      }
    }
    this.pending = side;
    this.handle = this.schedule(() => {
      const p = this.pending;
      this.pending = null;
      if (p) this.emit(p);
    }, this.windowMs);
  }
}

const WANT_ROWS = 14;
const WANT_COLS = 72;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

function cornerPoint(area: Rect, corner: Corner): [number, number] {
  const right = area.x + area.width - 1;
  const bottom = area.y + area.height - 1;
  if (corner === "top-left") return [area.x, area.y];
  if (corner === "top-right") return [right, area.y];
  if (corner === "bottom-left") return [area.x, bottom];
  return [right, bottom];
}

function ratioFor(extent: number, want: number, usageFirst: boolean): number {
  const share = clamp(want / Math.max(1, extent), 0.15, 0.5);
  return Number((usageFirst ? share : 1 - share).toFixed(3));
}

export interface Scale {
  x: number;
  y: number;
}

export function planPlacement(layout: Layout, anchor: string | null, position: Position, scale: Scale = { x: 1, y: 1 }, rows = WANT_ROWS): Plan | string {
  const panes = layout.panes;
  if (panes.length === 0) return "이 탭에 붙일 다른 pane이 없음";
  if (position === "up" || position === "down" || position === "left" || position === "right") {
    const target =
      panes.find((p) => p.id === anchor) ??
      panes.reduce((a, b) => (b.rect.width * b.rect.height > a.rect.width * a.rect.height ? b : a));
    const vertical = position === "up" || position === "down";
    const usageFirst = position === "up" || position === "left";
    return {
      target: target.id,
      split: vertical ? "down" : "right",
      ratio: ratioFor(vertical ? target.rect.height : target.rect.width, vertical ? rows / scale.y : WANT_COLS / scale.x, usageFirst),
      swap: usageFirst,
    };
  }
  const [x, y] = cornerPoint(layout.area, position);
  const target = panes.find((p) => contains(p.rect, x, y));
  if (!target) return `${POSITION_LABELS[position]} 모서리에 있는 pane을 찾지 못함`;
  const usageFirst = position === "top-left" || position === "top-right";
  return { target: target.id, split: "down", ratio: ratioFor(target.rect.height, rows / scale.y, usageFirst), swap: usageFirst };
}

export type HerdrRun = (...args: string[]) => Promise<unknown>;

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

export function parseLayout(result: unknown): Layout | null {
  const layout = obj(obj(result)["layout"]);
  const area = layout["area"] as Rect | undefined;
  const tabId = layout["tab_id"];
  const raw = layout["panes"];
  if (!area || typeof tabId !== "string" || !Array.isArray(raw)) return null;
  const panes = raw.flatMap((p): LayoutPane[] => {
    const o = obj(p);
    return typeof o["pane_id"] === "string" && o["rect"] ? [{ id: o["pane_id"], rect: o["rect"] as Rect }] : [];
  });
  return { tabId, area, panes };
}

const EDGE_LABELS: Record<Side, string> = { up: "위쪽", down: "아래쪽", left: "왼쪽", right: "오른쪽" };
const STEP_DONE: Record<Side, string> = { up: "한 칸 위로 이동", down: "한 칸 아래로 이동", left: "한 칸 왼쪽으로 이동", right: "한 칸 오른쪽으로 이동" };

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1;
}

function span(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

export function neighbor(layout: Layout, paneId: string, side: Side): LayoutPane | null {
  const u = layout.panes.find((p) => p.id === paneId)?.rect;
  if (!u) return null;
  let best: LayoutPane | null = null;
  let bestOverlap = 0;
  for (const p of layout.panes) {
    if (p.id === paneId) continue;
    const r = p.rect;
    const vertical = side === "up" || side === "down";
    const touch =
      side === "up" ? near(r.y + r.height, u.y) : side === "down" ? near(r.y, u.y + u.height) : side === "left" ? near(r.x + r.width, u.x) : near(r.x, u.x + u.width);
    const overlap = vertical ? span(r.x, r.x + r.width, u.x, u.x + u.width) : span(r.y, r.y + r.height, u.y, u.y + u.height);
    if (touch && overlap > bestOverlap) {
      best = p;
      bestOverlap = overlap;
    }
  }
  return best;
}

export interface Step {
  target: string;
  mode: "stack" | "beside";
  first: boolean;
}

function columnMate(layout: Layout, paneId: string, side: "up" | "down"): boolean {
  const u = layout.panes.find((p) => p.id === paneId)?.rect;
  const n = neighbor(layout, paneId, side);
  return !!u && !!n && near(n.rect.x, u.x) && near(n.rect.width, u.width);
}

export function planStep(layout: Layout, paneId: string, side: Side): Step | string {
  const n = neighbor(layout, paneId, side);
  if (!n) return `이미 ${EDGE_LABELS[side]} 끝`;
  if (side === "up" || side === "down") return { target: n.id, mode: "stack", first: side === "up" };
  if (!columnMate(layout, paneId, "up") && !columnMate(layout, paneId, "down")) return { target: n.id, mode: "beside", first: side === "left" };
  const u = layout.panes.find((p) => p.id === paneId)!.rect;
  const column = (r: Rect) => layout.panes.filter((p) => p.id !== paneId && near(p.rect.x, r.x) && near(p.rect.width, r.width)).sort((a, b) => a.rect.y - b.rect.y);
  const index = column(u).filter((p) => p.rect.y < u.y).length;
  const dest = column(n.rect);
  const top = dest[0];
  if (index === 0 || !top) return { target: (top ?? n).id, mode: "stack", first: true };
  return { target: (dest[Math.min(index, dest.length) - 1] ?? n).id, mode: "stack", first: false };
}

function stepPlan(layout: Layout, step: Step, scale: Scale, rows = WANT_ROWS): Plan | string {
  const target = layout.panes.find((p) => p.id === step.target);
  if (!target) return "옮길 기준 pane이 사라짐";
  const stack = step.mode === "stack";
  return {
    target: target.id,
    split: stack ? "down" : "right",
    ratio: ratioFor(stack ? target.rect.height : target.rect.width, stack ? rows / scale.y : WANT_COLS / scale.x, step.first),
    swap: step.first,
  };
}

async function agentPane(herdr: HerdrRun, tabId: string, exclude: string): Promise<string | null> {
  try {
    const raw = obj(await herdr("list"))["panes"];
    const hit = (Array.isArray(raw) ? raw : []).map(obj).find((p) => p["tab_id"] === tabId && p["pane_id"] !== exclude && typeof p["agent"] === "string");
    return typeof hit?.["pane_id"] === "string" ? hit["pane_id"] : null;
  } catch {
    return null;
  }
}

async function measureScale(herdr: HerdrRun, panes: LayoutPane[]): Promise<Scale> {
  const ratios = await Promise.all(
    panes.map(async (p) => {
      try {
        const rows = obj(obj(obj(await herdr("get", p.id))["pane"])["scroll"])["viewport_rows"];
        return typeof rows === "number" && rows > 0 && p.rect.height > 0 ? rows / p.rect.height : null;
      } catch {
        return null;
      }
    }),
  );
  const sorted = ratios.filter((r): r is number => r !== null).sort((a, b) => a - b);
  const s = sorted[Math.floor(sorted.length / 2)];
  return s === undefined ? { x: 1, y: 1 } : { x: s, y: s };
}

export async function placePane(herdr: HerdrRun, paneId: string, anchor: string | null, requested: Position, relative = false, wantRows = WANT_ROWS): Promise<string> {
  const before = parseLayout(await herdr("layout", "--pane", paneId));
  if (!before) throw new Error("pane 배치 정보를 읽지 못함");
  const others = before.panes.filter((p) => p.id !== paneId);
  const home = others[0];
  if (!home) return "이 탭에 다른 pane이 없어서 옮길 곳이 없음";
  let step: Step | null = null;
  if (relative && !isCorner(requested)) {
    const s = planStep(before, paneId, requested);
    if (typeof s === "string") return s;
    step = s;
  }
  if (anchor === null || !others.some((p) => p.id === anchor)) anchor = await agentPane(herdr, before.tabId, paneId);
  const scale = await measureScale(herdr, others);
  await herdr("move", paneId, "--new-tab", "--no-focus");
  try {
    const layout = parseLayout(await herdr("layout", "--pane", home.id));
    if (!layout) throw new Error("원래 탭 배치 정보를 읽지 못함");
    const plan = step ? stepPlan(layout, step, scale, wantRows) : planPlacement(layout, anchor, requested, scale, wantRows);
    if (typeof plan === "string") throw new Error(plan);
    await herdr("move", paneId, "--tab", before.tabId, "--split", plan.split, "--target-pane", plan.target, "--ratio", String(plan.ratio), "--focus");
    if (plan.swap) await herdr("swap", "--source-pane", paneId, "--target-pane", plan.target);
    return step && !isCorner(requested) ? STEP_DONE[requested] : `${POSITION_LABELS[requested]} 배치 완료`;
  } catch (error) {
    await herdr("move", paneId, "--tab", before.tabId, "--split", "down", "--target-pane", home.id, "--focus").catch(() => undefined);
    throw error;
  }
}
