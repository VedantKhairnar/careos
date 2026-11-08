import { ok, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { approveCarePlan } from "@/server/carePlans";

/** Explicit, auditable clinician approval. The orchestrator rejects any non-clinician actor. */
export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const session = requireSession(req, ["clinician"]);
  const { id } = await ctx.params;
  return ok(await approveCarePlan(toActor(session), id, req.headers.get("idempotency-key") ?? undefined));
});
