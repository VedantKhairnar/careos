import { ok, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { listPatients } from "@/server/patients";

export const GET = route(async (req) => {
  const session = requireSession(req, ["clinician"]);
  return ok(await listPatients(toActor(session)));
});
