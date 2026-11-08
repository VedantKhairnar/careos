import { z } from "zod";
import { summarizePatientForClinician } from "@/agents/doctorAgent";
import { ok, parseBody, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";

const Body = z.object({ patientId: z.string().min(1) });

export const POST = route(async (req) => {
  const session = requireSession(req, ["clinician"]);
  const { patientId } = await parseBody(req, Body);
  return ok(await summarizePatientForClinician(toActor(session), patientId));
});
