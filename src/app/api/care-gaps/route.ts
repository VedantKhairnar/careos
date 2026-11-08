import { ok, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { careGaps } from "@/server/services";

/** Administrative workflow gaps (an expected event has not arrived). Not clinical findings. */
export const GET = route(async (req) => {
  const session = requireSession(req, ["patient", "clinician"]);
  const patientId = new URL(req.url).searchParams.get("patientId") ?? undefined;
  return ok({ gaps: await careGaps(toActor(session), patientId) });
});
