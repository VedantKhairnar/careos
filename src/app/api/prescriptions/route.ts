import { z } from "zod";
import { ok, parseBody, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { createPrescription, listPrescriptions } from "@/server/services";

const Body = z.object({
  patientId: z.string().min(1),
  medicationReference: z.string().min(1).max(200),
  approvedInstructions: z.string().max(2000).optional(),
});

export const GET = route(async (req) => {
  const session = requireSession(req, ["patient", "clinician"]);
  const patientId = new URL(req.url).searchParams.get("patientId") ?? undefined;
  return ok(await listPrescriptions(toActor(session), patientId));
});

/** Clinician authorizes a prescription; the orchestrator records transmission (simulated). */
export const POST = route(async (req) => {
  const session = requireSession(req, ["clinician"]);
  const body = await parseBody(req, Body);
  const result = await createPrescription(toActor(session), body, req.headers.get("idempotency-key") ?? undefined);
  return ok(result, 201);
});
