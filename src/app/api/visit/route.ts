import { ok, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { lastVisit } from "@/server/visit";

/** The last visit at a glance. Patients see their own; clinicians pass ?patientId=. */
export const GET = route(async (req) => {
  const session = requireSession(req, ["patient", "clinician"]);
  return ok(await lastVisit(toActor(session), new URL(req.url).searchParams.get("patientId") ?? undefined));
});
