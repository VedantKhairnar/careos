import { ok, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { acknowledgeNotification } from "@/server/patientCare";

export const POST = route(async (req, ctx: { params: Promise<{ id: string }> }) => {
  const session = requireSession(req, ["patient"]);
  const { id } = await ctx.params;
  return ok(await acknowledgeNotification(toActor(session), id));
});
