import { ok, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { listNotifications } from "@/server/patientCare";

export const GET = route(async (req) => {
  const session = requireSession(req, ["patient"]);
  return ok(await listNotifications(toActor(session)));
});
