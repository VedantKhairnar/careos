import { z } from "zod";
import { ok, parseBody, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { CarePlanContentSchema, createCarePlan, listCarePlans } from "@/server/carePlans";

const Body = z.object({ patientId: z.string().min(1), content: CarePlanContentSchema });

/** Clinician submits a plan for review. Patients cannot see it until a clinician approves it. */
export const POST = route(async (req) => {
  const session = requireSession(req, ["clinician"]);
  const body = await parseBody(req, Body);
  return ok(await createCarePlan(toActor(session), body, req.headers.get("idempotency-key") ?? undefined), 201);
});

export const GET = route(async (req) => {
  const session = requireSession(req, ["patient", "clinician"]);
  const patientId = new URL(req.url).searchParams.get("patientId") ?? undefined;
  return ok(await listCarePlans(toActor(session), patientId));
});
