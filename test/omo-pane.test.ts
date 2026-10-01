import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneConfig } from "../omo/extension.mjs";
import { PANE_LABEL, UsagePane, shellCommand } from "../omo/pane.mjs";

const dir = mkdtempSync(join(tmpdir(), "aiusage-pane-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Pane = { pane_id: string; tab_id: string; label?: string };

function fakeHerdr(initial: Pane[]) {
  const panes = [...initial];
  const calls: string[][] = [];
  let next = 1;
  const herdr = async (...args: string[]) => {
    calls.push(args);
    if (args[0] === "list") return { panes };
    if (args[0] === "split") {
      const parent = panes.find((p) => p.pane_id === args[2])!;
      const pane = { pane_id: `new${next++}`, tab_id: parent.tab_id };
      panes.push(pane);
      return { pane };
    }
    if (args[0] === "rename") panes.find((p) => p.pane_id === args[1])!.label = args[2] ?? "";
    return {};
  };
  return { herdr, calls, panes };
}

let seq = 0;
function make(initial: Pane[]) {
  const fake = fakeHerdr(initial);
  const pane = new UsagePane({
    herdr: fake.herdr,
    parentPane: "p1",
    socket: "/sock",
    stateDir: join(dir, `state-${++seq}`),
    cwd: "/proj",
    command: (id: string) => `run ${id}`,
  });
  return { pane, ...fake };
}

describe("UsagePane.ensure", () => {
  test("splits below the agent pane, labels it and runs the viewer", async () => {
    const { pane, calls } = make([{ pane_id: "p1", tab_id: "t1" }]);
    expect(await pane.ensure(false)).toEqual({ paneId: "new1", opened: true });
    expect(calls).toEqual([
      ["list"],
      ["split", "--pane", "p1", "--direction", "down", "--ratio", "0.75", "--cwd", "/proj", "--no-focus"],
      ["rename", "new1", PANE_LABEL],
      ["run", "new1", "run new1"],
    ]);
  });

  test("reuses a usage pane already open in the same tab", async () => {
    const { pane, calls } = make([
      { pane_id: "p1", tab_id: "t1" },
      { pane_id: "u9", tab_id: "t1", label: PANE_LABEL },
    ]);
    expect(await pane.ensure(false)).toEqual({ paneId: "u9", opened: false });
    expect(calls).toEqual([["list"]]);
  });

  test("ignores usage panes in other tabs", async () => {
    const { pane } = make([
      { pane_id: "p1", tab_id: "t1" },
      { pane_id: "u9", tab_id: "t2", label: PANE_LABEL },
    ]);
    expect((await pane.ensure(false)).opened).toBe(true);
  });

  test("keeps a pane the user closed closed until forced", async () => {
    const { pane, panes, calls } = make([{ pane_id: "p1", tab_id: "t1" }]);
    await pane.ensure(false);
    panes.splice(panes.findIndex((p) => p.pane_id === "new1"), 1);
    expect(await pane.ensure(false)).toEqual({ paneId: null, opened: false });
    expect(calls.filter((c) => c[0] === "split")).toHaveLength(1);
    expect(await pane.ensure(true)).toEqual({ paneId: "new2", opened: true });
  });
});

describe("helpers", () => {
  test("shellCommand quotes every argument", () => {
    expect(shellCommand(["/a b/bun", "it's.ts", "--close-pane", "wV:p1"])).toBe(`'/a b/bun' 'it'\\''s.ts' '--close-pane' 'wV:p1'`);
  });

  test("paneConfig reads overrides and falls back to defaults", () => {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ pane: { autoOpen: false, direction: "right", ratio: 0.6 } }));
    expect(paneConfig(path)).toEqual({ autoOpen: false, direction: "right", ratio: 0.6 });
    writeFileSync(path, JSON.stringify({ pane: { ratio: 5, direction: "up" } }));
    expect(paneConfig(path)).toEqual({ autoOpen: true, direction: "down", ratio: 0.75 });
    expect(paneConfig(join(dir, "missing.json"))).toEqual({ autoOpen: true, direction: "down", ratio: 0.75 });
  });
});
