import { connection } from "next/server";
import { ZodError, type ZodType } from "zod";
import { Forbidden, type RejectCode } from "./orchestrator";
import { getSession, type Session } from "./session";
import { getEnv } from "./env";

/** Consistent error shape for every endpoint: { error: { code, message } }. */
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const ok = <T>(data: T, status = 200) => Response.json({ data }, { status });
export const fail = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message } }, { status });

export function requireSession(req: Request, roles?: Session["role"][]): Session {
  const s = getSession(req);
  if (!s) throw new HttpError(401, "unauthenticated", "Sign in required");
  if (roles && !roles.includes(s.role)) throw new HttpError(403, "forbidden", "Not allowed for this role");
  return s;
}

/** Demo endpoints do not exist outside demo mode. */
export function requireDemoMode(): void {
  if (!getEnv().demoMode) throw new HttpError(404, "not_found", "Not found");
}

export async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be JSON");
  }
  return schema.parse(json);
}

const REJECT_STATUS: Record<RejectCode, number> = {
  invalid_event: 400,
  forbidden: 403,
  invalid_transition: 409,
};
export function rejection(code: RejectCode, reason: string): HttpError {
  return new HttpError(REJECT_STATUS[code], code, reason);
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/** Next.js signals redirects, not-found and prerender bail-outs with errors that carry a `digest`. */
function isNextControlFlow(err: unknown): boolean {
  const digest = (err as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && (digest.startsWith("NEXT_") || digest === "DYNAMIC_SERVER_USAGE");
}

/** `connection()` only exists inside a Next.js request scope; unit tests call handlers directly. */
async function waitForRequest(): Promise<void> {
  try {
    await connection();
  } catch (err) {
    // Only this exact case is safe to ignore (unit tests). Prerender signals must propagate.
    if (err instanceof Error && err.message.includes("outside a request scope")) return;
    throw err;
  }
}

/**
 * Wraps a handler so every failure becomes the standard error shape.
 * Handlers always run at request time, never during build-time prerendering.
 */
export function route<C = unknown>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    await waitForRequest();
    try {
      return await fn(req, ctx);
    } catch (err) {
      if (isNextControlFlow(err)) throw err;
      if (err instanceof HttpError) return fail(err.status, err.code, err.message);
      if (err instanceof Forbidden) return fail(403, "forbidden", err.message);
      // The AI assistant being busy or unconfigured is a 503, never a made-up answer. Matched by name so this
      // module does not import the agents.
      if (err instanceof Error && err.name === "AiUnavailable") {
        return fail(503, `ai_${(err as { reason?: string }).reason ?? "unavailable"}`, err.message);
      }
      if (err instanceof ZodError) {
        return fail(400, "validation_failed", err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
      }
      console.error("Unhandled API error", err); // details stay in server logs
      return fail(500, "internal_error", "Something went wrong");
    }
  };
}
