import { ok, parseBody, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { listReadings, ReadingInput, recordReading } from "@/server/readings";

/** Patients see and add their own readings; clinicians read a patient's with ?patientId=. */
export const GET = route(async (req) => {
  const session = requireSession(req, ["patient", "clinician"]);
  return ok(await listReadings(toActor(session), new URL(req.url).searchParams.get("patientId") ?? undefined));
});

export const POST = route(async (req) => {
  const session = requireSession(req, ["patient"]);
  return ok(await recordReading(toActor(session), await parseBody(req, ReadingInput)));
});
