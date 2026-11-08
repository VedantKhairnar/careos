import { z } from "zod";
import { ok, parseBody, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { clinicianAction, CLINICIAN_ACTIONS } from "@/server/services";

const Body = z.object({ action: z.enum(Object.keys(CLINICIAN_ACTIONS) as [keyof typeof CLINICIAN_ACTIONS, ...(keyof typeof CLINICIAN_ACTIONS)[]]) });

/** Clinician-only workflow actions (resolve a pharmacy clarification, log a follow-up, cancel). */
export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const session = requireSession(req, ["clinician"]);
  const { id } = await ctx.params;
  const { action } = await parseBody(req, Body);
  return ok(await clinicianAction(toActor(session), id, action, req.headers.get("idempotency-key") ?? undefined));
});
