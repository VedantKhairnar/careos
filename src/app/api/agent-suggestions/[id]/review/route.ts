import { z } from "zod";
import { ok, parseBody, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { reviewSuggestion } from "@/server/suggestions";

const Body = z.object({ decision: z.enum(["approve", "dismiss"]), message: z.string().max(600).optional() });

/** Only a clinician can approve (send to the patient) or dismiss an agent's draft. */
export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const session = requireSession(req, ["clinician"]);
  const { id } = await ctx.params;
  const { decision, message } = await parseBody(req, Body);
  return ok(await reviewSuggestion(toActor(session), id, decision, message));
});
