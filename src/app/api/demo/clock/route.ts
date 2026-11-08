import { z } from "zod";
import { ok, parseBody, requireDemoMode, requireSession, route } from "@/server/http";
import { runtime } from "@/server/runtime";

const view = () => ({ offsetMinutes: Math.round(runtime().clock.offsetMs / 60_000), simulated: true });

export const GET = route(async (req) => {
  requireDemoMode();
  requireSession(req, ["demo_operator", "clinician"]);
  return ok(view());
});

const Body = z.object({ advanceMinutes: z.number().int().min(1).max(7 * 24 * 60) }).or(z.object({ reset: z.literal(true) }));

/** DEMO ONLY. Moves the care-gap engine's clock forward so time-based gaps can be shown live. */
export const POST = route(async (req) => {
  requireDemoMode();
  requireSession(req, ["demo_operator"]);
  const body = await parseBody(req, Body);
  runtime().clock.offsetMs = "reset" in body ? 0 : runtime().clock.offsetMs + body.advanceMinutes * 60_000;
  return ok(view());
});
