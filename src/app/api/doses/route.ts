import { ok, parseBody, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { DoseReportSchema, reportDose } from "@/server/patientCare";

/** Patient-reported adherence. Recorded as patient-reported, never as clinically verified. */
export const POST = route(async (req) => {
  const session = requireSession(req, ["patient"]);
  const body = await parseBody(req, DoseReportSchema);
  return ok(await reportDose(toActor(session), body));
});
