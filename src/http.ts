import type { ProviderUsage } from "./types";

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export type JsonResult =
  | { ok: true; json: unknown }
  | { ok: false; status: number | null; message: string; retryAfterSec?: number };

export async function getJson(url: string, headers: Record<string, string>, fetchImpl: FetchLike, timeoutMs: number): Promise<JsonResult> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") return { ok: false, status: null, message: `응답 시간 초과 (${Math.round(timeoutMs / 1000)}s)` };
    return { ok: false, status: null, message: `네트워크 오류: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) {
    const retryAfterSec = num(res.headers.get("retry-after"));
    return retryAfterSec === null
      ? { ok: false, status: res.status, message: `HTTP ${res.status}` }
      : { ok: false, status: res.status, message: `HTTP ${res.status}`, retryAfterSec };
  }
  try {
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false, status: res.status, message: "응답 JSON 파싱 실패" };
  }
}

export function failedProvider(provider: string, displayName: string, error: string, extra: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    provider,
    displayName,
    plan: null,
    account: null,
    source: "api",
    updatedAt: null,
    windows: [],
    credits: null,
    error,
    ...extra,
  };
}

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function isoDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
