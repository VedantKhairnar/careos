import { z } from "zod";
import { askPatientAgent } from "@/agents/patientAgent";
import { ok, parseBody, requireSession, route } from "@/server/http";
import { runtime } from "@/server/runtime";
import { toActor } from "@/server/session";

const Body = z.object({ message: z.string().min(1).max(1000) });

/** Patient asks their assistant. Answers come only from the patient's own data via permissioned tools. */
export const POST = route(async (req) => {
  const session = requireSession(req, ["patient"]);
  const { message } = await parseBody(req, Body);
  const actor = toActor(session);
  const r = await runtime().orchestrator.runAgent("patient", actor.patientId ?? "", () => askPatientAgent(actor, message));
  if (!r.ok) throw r.cause; // keeps the real reason (busy, not configured, ...) and the standard error handling
  return ok(r.value);
});
