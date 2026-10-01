import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, sharedFetch } from "../src/cache";
import type { Snapshot } from "../src/types";

const dir = mkdtempSync(join(tmpdir(), "aiusage-cache-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const t0 = new Date("2026-10-01T01:00:00Z");
let seq = 0;

function counter(at: () => Date) {
  const state = { calls: 0 };
  const fetcher = async (): Promise<Snapshot> => {
    state.calls++;
    return {
      fetchedAt: at(),
      error: null,
      providers: [
        {
          provider: "claude",
          displayName: "Claude",
          plan: null,
          account: null,
          source: "api",
          updatedAt: at(),
          credits: null,
          error: null,
          windows: [{ id: "s", label: "5시간", usedPercent: 10, windowMinutes: 300, resetsAt: new Date(at().getTime() + 3_600_000), pace: null }],
        },
      ],
    };
  };
  return { state, fetcher };
}

function freshPath(): string {
  seq++;
  return join(dir, `case-${seq}`, "snapshot.json");
}

describe("sharedFetch", () => {
  test("reuses a fresh cache across callers and revives dates", async () => {
    const path = freshPath();
    let now = t0;
    const { state, fetcher } = counter(() => now);
    await sharedFetch(fetcher, { path, key: "k", maxAgeMs: 50_000, cooldown: { until: 0 }, now: () => now });
    now = new Date(t0.getTime() + 30_000);
    const second = await sharedFetch(fetcher, { path, key: "k", maxAgeMs: 50_000, cooldown: { until: 0 }, now: () => now });
    expect(state.calls).toBe(1);
    expect(second.fetchedAt).toBeInstanceOf(Date);
    expect(second.providers[0]!.windows[0]!.resetsAt).toBeInstanceOf(Date);
  });

  test("refetches once the cache is older than maxAge", async () => {
    const path = freshPath();
    let now = t0;
    const { state, fetcher } = counter(() => now);
    await sharedFetch(fetcher, { path, key: "k", maxAgeMs: 50_000, cooldown: { until: 0 }, now: () => now });
    now = new Date(t0.getTime() + 51_000);
    await sharedFetch(fetcher, { path, key: "k", maxAgeMs: 50_000, cooldown: { until: 0 }, now: () => now });
    expect(state.calls).toBe(2);
  });

  test("ignores a cache written for a different source config", async () => {
    const path = freshPath();
    const { state, fetcher } = counter(() => t0);
    await sharedFetch(fetcher, { path, key: "a", maxAgeMs: 50_000, cooldown: { until: 0 }, now: () => t0 });
    await sharedFetch(fetcher, { path, key: "b", maxAgeMs: 50_000, cooldown: { until: 0 }, now: () => t0 });
    expect(state.calls).toBe(2);
  });

  test("shares the Claude 429 cooldown through the cache file", async () => {
    const path = freshPath();
    const { fetcher } = counter(() => t0);
    const writer = { until: t0.getTime() + 274_000 };
    await sharedFetch(fetcher, { path, key: "k", maxAgeMs: 50_000, cooldown: writer, now: () => t0 });
    expect((await readCache(path))?.claudeCooldownUntil).toBe(writer.until);
    const reader = { until: 0 };
    await sharedFetch(fetcher, { path, key: "k", maxAgeMs: 50_000, cooldown: reader, now: () => t0 });
    expect(reader.until).toBe(writer.until);
  });

  test("keeps the last good provider data when a new fetch fails", async () => {
    const path = freshPath();
    let now = t0;
    const { fetcher } = counter(() => now);
    await sharedFetch(fetcher, { path, key: "k", maxAgeMs: 50_000, cooldown: { until: 0 }, now: () => now });
    now = new Date(t0.getTime() + 60_000);
    const failing = async (): Promise<Snapshot> => ({
      fetchedAt: now,
      error: null,
      providers: [{ provider: "claude", displayName: "Claude", plan: null, account: null, source: "api", updatedAt: null, credits: null, error: "429", windows: [] }],
    });
    const s = await sharedFetch(failing, { path, key: "k", maxAgeMs: 50_000, cooldown: { until: 0 }, now: () => now });
    expect(s.providers[0]!.error).toBe("429");
    expect(s.providers[0]!.windows).toHaveLength(1);
    expect((await readCache(path))?.snapshot.providers[0]!.windows).toHaveLength(1);
  });

  test("refetches an errored cache once the cooldown has passed", async () => {
    const path = freshPath();
    let now = t0;
    let calls = 0;
    const failing = async (): Promise<Snapshot> => {
      calls++;
      return { fetchedAt: now, error: null, providers: [{ provider: "claude", displayName: "Claude", plan: null, account: null, source: "api", updatedAt: null, credits: null, error: "429", windows: [] }] };
    };
    const cooldown = { until: t0.getTime() + 20_000 };
    await sharedFetch(failing, { path, key: "k", maxAgeMs: 50_000, cooldown, now: () => now });
    now = new Date(t0.getTime() + 15_000);
    await sharedFetch(failing, { path, key: "k", maxAgeMs: 50_000, cooldown, now: () => now });
    expect(calls).toBe(1);
    now = new Date(t0.getTime() + 21_000);
    await sharedFetch(failing, { path, key: "k", maxAgeMs: 50_000, cooldown, now: () => now });
    expect(calls).toBe(2);
  });

  test("serves the stale cache while another process holds the lock", async () => {
    const path = freshPath();
    let now = t0;
    const { state, fetcher } = counter(() => now);
    await sharedFetch(fetcher, { path, key: "k", maxAgeMs: 50_000, cooldown: { until: 0 }, now: () => now });
    mkdirSync(`${path}.lock`);
    now = new Date(t0.getTime() + 60_000);
    const s = await sharedFetch(fetcher, { path, key: "k", maxAgeMs: 50_000, cooldown: { until: 0 }, now: () => new Date() });
    expect(state.calls).toBe(1);
    expect(s.fetchedAt.getTime()).toBe(t0.getTime());
  });
});
