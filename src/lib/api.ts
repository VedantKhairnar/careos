export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const AS_KEY = "careos-as";

/** Which identity this browser TAB acts as (per-tab, so several roles can be open side by side). */
export function actingAs(): string | null {
  try {
    return sessionStorage.getItem(AS_KEY);
  } catch {
    return null;
  }
}

export function setActingAs(key: string | null): void {
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
