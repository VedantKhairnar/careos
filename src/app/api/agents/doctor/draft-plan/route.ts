import { z } from "zod";
import { draftCarePlanFromNotes } from "@/agents/doctorAgent";
import { ok, parseBody, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";

const Body = z.object({ patientId: z.string().min(1), notes: z.string().min(10).max(6000) });

/** Clinician pastes visit notes; the Doctor Agent drafts a plan that waits for the clinician's approval. */
export const POST = route(async (req) => {
  const session = requireSession(req, ["clinician"]);
  const body = await parseBody(req, Body);
  return ok(await draftCarePlanFromNotes(toActor(session), body), 201);
});
