import { ok, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { medications } from "@/server/patientCare";

export const GET = route(async (req) => {
  const session = requireSession(req, ["patient", "clinician"]);
  const patientId = new URL(req.url).searchParams.get("patientId") ?? undefined;
  return ok(await medications(toActor(session), patientId));
});
