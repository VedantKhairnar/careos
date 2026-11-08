export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const AS_KEY = "careos-as";
export const FRAME_PREFIX = "careos-as:";

/** True inside a Demo stage window. */
export const inStage = () => typeof window !== "undefined" && window.name.startsWith(FRAME_PREFIX);

/** Which identity this browser TAB acts as (per-tab, so several roles can be open side by side). */
export function actingAs(): string | null {
  // A window opened by the Demo stage is pinned to one identity through its name, so several roles can live in one tab.
  if (typeof window !== "undefined" && window.name.startsWith(FRAME_PREFIX)) return window.name.slice(FRAME_PREFIX.length);
  try {
    return sessionStorage.getItem(AS_KEY);
  } catch {
    return null;
  }
}

export function setActingAs(key: string | null): void {
  if (typeof window !== "undefined" && window.name.startsWith(FRAME_PREFIX)) return; // pinned
  try {
    if (key) sessionStorage.setItem(AS_KEY, key);
    else sessionStorage.removeItem(AS_KEY);
  } catch {
    /* storage unavailable: falls back to the last sign-in */
  }
}

/** Calls our own API. Unwraps { data } and turns { error } into an ApiError with a safe message. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...(actingAs() ? { "x-careos-as": actingAs()! } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "network", "Could not reach the server. Check your connection and try again.");
  }
  let json: { data?: T; error?: { code: string; message: string } } | null = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok || !json || json.error) {
    throw new ApiError(res.status, json?.error?.code ?? "error", json?.error?.message ?? "Something went wrong");
  }
  return json.data as T;
}
