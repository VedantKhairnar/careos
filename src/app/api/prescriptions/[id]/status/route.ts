import { ok, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { prescriptionView } from "@/server/services";

export const GET = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const session = requireSession(req, ["patient", "clinician"]);
  const { id } = await ctx.params;
  return ok(await prescriptionView(toActor(session), id));
});
