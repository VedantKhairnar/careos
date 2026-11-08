import { ok, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { getCarePlan } from "@/server/carePlans";

export const GET = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const session = requireSession(req, ["patient", "clinician"]);
  const { id } = await ctx.params;
  return ok(await getCarePlan(toActor(session), id));
});
