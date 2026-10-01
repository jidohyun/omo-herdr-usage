import { describe, expect, test } from "bun:test";
import { ARROW_SIDES, ArrowCombo, combine, isCorner, KEY_POSITIONS, neighbor, parseLayout, planStep, placePane, planPlacement, type Layout, type Position } from "../src/placement";

const area = { x: 0, y: 0, width: 519, height: 103 };
const layout: Layout = {
  tabId: "t",
  area,
  panes: [
    { id: "agent", rect: { x: 0, y: 0, width: 337, height: 103 } },
    { id: "dag", rect: { x: 337, y: 0, width: 182, height: 103 } },
  ],
};

describe("planPlacement", () => {
  test("puts the pane below or right of the anchor", () => {
    expect(planPlacement(layout, "agent", "down")).toEqual({ target: "agent", split: "down", ratio: 0.85, swap: false });
    expect(planPlacement(layout, "agent", "right")).toEqual({ target: "agent", split: "right", ratio: 0.786, swap: false });
  });

  test("uses a swap with a small first share for up and left", () => {
    expect(planPlacement(layout, "agent", "up")).toEqual({ target: "agent", split: "down", ratio: 0.15, swap: true });
    expect(planPlacement(layout, "agent", "left")).toEqual({ target: "agent", split: "right", ratio: 0.214, swap: true });
  });

  test("still targets the anchor when another pane already sits on that side", () => {
    expect((planPlacement(layout, "agent", "right") as { target: string }).target).toBe("agent");
  });

  test("falls back to the largest pane without a live anchor", () => {
    expect((planPlacement(layout, "gone", "down") as { target: string }).target).toBe("agent");
  });

  test("splits the pane occupying each corner of the tab", () => {
    expect(planPlacement(layout, "agent", "bottom-right")).toEqual({ target: "dag", split: "down", ratio: 0.85, swap: false });
    expect(planPlacement(layout, "agent", "top-right")).toEqual({ target: "dag", split: "down", ratio: 0.15, swap: true });
    expect((planPlacement(layout, "agent", "top-left") as { target: string }).target).toBe("agent");
    expect((planPlacement(layout, "agent", "bottom-left") as { target: string }).target).toBe("agent");
  });

  test("converts real terminal rows and columns into layout units", () => {
    expect(planPlacement(layout, "agent", "down", { x: 0.5, y: 0.43 })).toEqual({ target: "agent", split: "down", ratio: 0.684, swap: false });
    expect(planPlacement(layout, "agent", "right", { x: 0.5, y: 0.43 })).toEqual({ target: "agent", split: "right", ratio: 0.573, swap: false });
  });

  test("clamps the share for small targets and reports empty tabs", () => {
    const small: Layout = { tabId: "t", area, panes: [{ id: "a", rect: { x: 0, y: 0, width: 100, height: 20 } }] };
    expect((planPlacement(small, "a", "down") as { ratio: number }).ratio).toBe(0.5);
    expect(planPlacement({ tabId: "t", area, panes: [] }, null, "down")).toBe("이 탭에 붙일 다른 pane이 없음");
  });
});

describe("keys", () => {
  test("maps arrows and numpad digits", () => {
    expect([ARROW_SIDES["\x1b[A"], ARROW_SIDES["\x1b[B"], ARROW_SIDES["\x1b[D"], ARROW_SIDES["\x1b[C"]]).toEqual(["up", "down", "left", "right"]);
    expect([KEY_POSITIONS["7"], KEY_POSITIONS["9"], KEY_POSITIONS["1"], KEY_POSITIONS["3"]]).toEqual(["top-left", "top-right", "bottom-left", "bottom-right"]);
  });

  test("isCorner tells corners from sides", () => {
    expect(isCorner("down")).toBe(false);
    expect(isCorner(null)).toBe(false);
    expect(isCorner("top-left")).toBe(true);
  });

  test("combine pairs perpendicular arrows in either order", () => {
    expect(combine("up", "right")).toBe("top-right");
    expect(combine("right", "up")).toBe("top-right");
    expect(combine("left", "down")).toBe("bottom-left");
    expect(combine("up", "down")).toBeNull();
    expect(combine("left", "left")).toBeNull();
  });
});

function fakeCombo() {
  const emitted: Position[] = [];
  const timers = new Map<number, () => void>();
  let id = 0;
  const combo = new ArrowCombo(
    (p) => emitted.push(p),
    400,
    (fn) => {
      timers.set(++id, fn);
      return id;
    },
    (h) => timers.delete(h as number),
  );
  const expire = () => {
    const fns = [...timers.values()];
    timers.clear();
    for (const fn of fns) fn();
  };
  return { combo, emitted, timers, expire };
}

const L = (panes: Array<[string, number, number, number, number]>): Layout => ({
  tabId: "t",
  area,
  panes: panes.map(([id, x, y, width, height]) => ({ id, rect: { x, y, width, height } })),
});

describe("planStep", () => {
  const column = L([["omo", 0, 0, 300, 50], ["shell", 0, 50, 300, 40], ["u", 0, 90, 300, 13], ["dag", 300, 0, 219, 103]]);
  const middle = L([["omo", 0, 0, 300, 50], ["u", 0, 50, 300, 13], ["shell", 0, 63, 300, 40], ["dag", 300, 0, 219, 103]]);
  const top = L([["u", 0, 0, 300, 13], ["omo", 0, 13, 300, 50], ["shell", 0, 63, 300, 40], ["dag", 300, 0, 219, 103]]);

  test("up climbs one stacked pane at a time and stops at the top", () => {
    expect(planStep(column, "u", "up")).toEqual({ target: "shell", mode: "stack", first: true });
    expect(planStep(middle, "u", "up")).toEqual({ target: "omo", mode: "stack", first: true });
    expect(planStep(top, "u", "up")).toBe("이미 위쪽 끝");
  });

  test("down steps below the next pane and stops at the bottom", () => {
    expect(planStep(middle, "u", "down")).toEqual({ target: "shell", mode: "stack", first: false });
    expect(planStep(column, "u", "down")).toBe("이미 아래쪽 끝");
  });

  test("sideways keeps a stacked strip on the same top or bottom side of the next column", () => {
    expect(planStep(column, "u", "right")).toEqual({ target: "dag", mode: "stack", first: false });
    expect(planStep(top, "u", "right")).toEqual({ target: "dag", mode: "stack", first: true });
    expect(planStep(column, "u", "left")).toBe("이미 왼쪽 끝");
  });

  test("sideways keeps the same position counted from the top", () => {
    const shot = L([["agent", 0, 0, 300, 20], ["shell", 0, 20, 300, 83], ["top", 300, 0, 219, 40], ["u", 300, 40, 219, 20], ["bottom", 300, 60, 219, 43]]);
    expect(planStep(shot, "u", "left")).toEqual({ target: "agent", mode: "stack", first: false });
    const back = L([["agent", 0, 0, 300, 20], ["u", 0, 20, 300, 15], ["shell", 0, 35, 300, 68], ["top", 300, 0, 219, 50], ["bottom", 300, 50, 219, 53]]);
    expect(planStep(back, "u", "right")).toEqual({ target: "top", mode: "stack", first: false });
    const deep = L([["a", 0, 0, 300, 20], ["b", 0, 20, 300, 20], ["c", 0, 40, 300, 20], ["u", 0, 60, 300, 43], ["dag", 300, 0, 219, 103]]);
    expect(planStep(deep, "u", "right")).toEqual({ target: "dag", mode: "stack", first: false });
  });

  test("sideways steps past the neighbour when the pane is a column", () => {
    const beside = L([["agent", 0, 0, 200, 103], ["u", 200, 0, 80, 103], ["dag", 280, 0, 239, 103]]);
    expect(planStep(beside, "u", "left")).toEqual({ target: "agent", mode: "beside", first: true });
    expect(planStep(beside, "u", "right")).toEqual({ target: "dag", mode: "beside", first: false });
  });

  test("neighbor picks the pane with the largest shared edge", () => {
    const grid = L([["a", 0, 0, 100, 50], ["b", 100, 0, 200, 50], ["u", 50, 50, 200, 53]]);
    expect(neighbor(grid, "u", "up")?.id).toBe("b");
  });
});

describe("ArrowCombo", () => {
  test("a single arrow places on that side once the window passes", () => {
    const { combo, emitted, expire } = fakeCombo();
    combo.press("down");
    expect(emitted).toEqual([]);
    expire();
    expect(emitted).toEqual(["down"]);
  });

  test("two perpendicular arrows inside the window make a corner without a side move", () => {
    const { combo, emitted, timers, expire } = fakeCombo();
    combo.press("down");
    combo.press("right");
    expect(emitted).toEqual(["bottom-right"]);
    expect(timers.size).toBe(0);
    expire();
    expect(emitted).toEqual(["bottom-right"]);
  });

  test("a repeated arrow counts once and an opposite arrow replaces the pending one", () => {
    const { combo, emitted, expire } = fakeCombo();
    combo.press("up");
    combo.press("up");
    expire();
    combo.press("left");
    combo.press("right");
    expire();
    expect(emitted).toEqual(["up", "right"]);
  });

  test("an arrow after the window starts a new press", () => {
    const { combo, emitted, expire } = fakeCombo();
    combo.press("up");
    expire();
    combo.press("left");
    expire();
    expect(emitted).toEqual(["up", "left"]);
  });
});

function herdrLayout(panes: Array<[string, number, number, number, number]>) {
  return { layout: { tab_id: "t", area, panes: panes.map(([pane_id, x, y, width, height]) => ({ pane_id, rect: { x, y, width, height } })) } };
}

describe("placePane", () => {
  test("parks the pane in a new tab, then moves it back next to the target and swaps for top corners", async () => {
    const calls: string[][] = [];
    const herdr = async (...args: string[]) => {
      calls.push(args);
      if (args[0] === "layout" && args[2] === "usage") return herdrLayout([["agent", 0, 0, 337, 77], ["usage", 0, 77, 337, 26], ["dag", 337, 0, 182, 103]]);
      if (args[0] === "layout") return herdrLayout([["agent", 0, 0, 337, 103], ["dag", 337, 0, 182, 103]]);
      return {};
    };
    expect(await placePane(herdr, "usage", "agent", "top-right")).toBe("우측상단 배치 완료");
    expect(calls).toEqual([
      ["layout", "--pane", "usage"],
      ["get", "agent"],
      ["get", "dag"],
      ["move", "usage", "--new-tab", "--no-focus"],
      ["layout", "--pane", "agent"],
      ["move", "usage", "--tab", "t", "--split", "down", "--target-pane", "dag", "--ratio", "0.15", "--focus"],
      ["swap", "--source-pane", "usage", "--target-pane", "dag"],
    ]);
  });

  test("puts the pane back home when the move fails", async () => {
    const calls: string[][] = [];
    const herdr = async (...args: string[]) => {
      calls.push(args);
      if (args[0] === "layout") return herdrLayout([["agent", 0, 0, 337, 77], ["usage", 0, 77, 337, 26]]);
      if (args[0] === "move" && args.includes("--target-pane") && args.includes("right")) throw new Error("boom");
      return {};
    };
    await expect(placePane(herdr, "usage", "agent", "right")).rejects.toThrow("boom");
    expect(calls.at(-1)).toEqual(["move", "usage", "--tab", "t", "--split", "down", "--target-pane", "agent", "--focus"]);
  });

  test("does nothing when the usage pane is alone in its tab", async () => {
    const herdr = async () => herdrLayout([["usage", 0, 0, 519, 103]]);
    expect(await placePane(herdr, "usage", null, "down")).toBe("이 탭에 다른 pane이 없어서 옮길 곳이 없음");
  });

  test("moves relative to the corner the pane actually occupies", async () => {
    const calls: string[][] = [];
    const herdr = async (...args: string[]) => {
      calls.push(args);
      if (args[0] === "layout" && args[2] === "usage") return herdrLayout([["agent", 0, 0, 337, 103], ["dag", 337, 0, 182, 88], ["usage", 337, 88, 182, 15]]);
      if (args[0] === "layout") return herdrLayout([["agent", 0, 0, 337, 103], ["dag", 337, 0, 182, 103]]);
      return {};
    };
    expect(await placePane(herdr, "usage", "agent", "right", true)).toBe("이미 오른쪽 끝");
    expect(calls).toHaveLength(1);
    expect(await placePane(herdr, "usage", "agent", "up", true)).toBe("한 칸 위로 이동");
    expect(calls.find((c) => c[0] === "move" && c.includes("--target-pane"))).toContain("dag");
  });

  test("falls back to the agent pane herdr detected when no anchor is given", async () => {
    const calls: string[][] = [];
    const herdr = async (...args: string[]) => {
      calls.push(args);
      if (args[0] === "list") return { panes: [{ pane_id: "dag", tab_id: "t" }, { pane_id: "shell", tab_id: "t" }, { pane_id: "agent", tab_id: "t", agent: "claude" }, { pane_id: "x", tab_id: "other", agent: "codex" }] };
      if (args[0] === "layout" && args[2] === "usage") return herdrLayout([["shell", 0, 0, 100, 103], ["agent", 100, 0, 237, 103], ["dag", 337, 0, 182, 80], ["usage", 337, 80, 182, 23]]);
      if (args[0] === "layout") return herdrLayout([["shell", 0, 0, 100, 103], ["agent", 100, 0, 237, 103], ["dag", 337, 0, 182, 103]]);
      return {};
    };
    await placePane(herdr, "usage", null, "down");
    expect(calls.find((c) => c[0] === "move" && c.includes("--target-pane"))).toContain("agent");
  });

  test("scales the requested size by a still pane's real rows per layout unit", async () => {
    const calls: string[][] = [];
    const herdr = async (...args: string[]) => {
      calls.push(args);
      if (args[0] === "layout" && args[2] === "usage") return herdrLayout([["agent", 0, 0, 337, 80], ["usage", 0, 80, 337, 23], ["dag", 337, 0, 182, 103]]);
      if (args[0] === "layout") return herdrLayout([["agent", 0, 0, 337, 103], ["dag", 337, 0, 182, 103]]);
      return {};
    };
    const rowsById: Record<string, number> = { agent: 35, dag: 45 };
    const herdrScaled = async (...args: string[]) => (args[0] === "get" ? { pane: { scroll: { viewport_rows: rowsById[args[1] ?? ""] ?? 0 } } } : herdr(...args));
    await placePane(herdrScaled, "usage", "agent", "down");
    expect(calls.find((c) => c[0] === "move" && c.includes("--target-pane"))).toContain("0.689");
  });

  test("parseLayout rejects malformed results", () => {
    expect(parseLayout({})).toBeNull();
  });
});
