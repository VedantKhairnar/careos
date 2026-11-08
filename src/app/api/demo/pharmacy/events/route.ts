import { z } from "zod";
import { ok, parseBody, requireDemoMode, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { applyPharmacyEvent, PHARMACY_EVENT_TYPES } from "@/server/services";

const Body = z.object({
  workflowId: z.string().min(1),
  type: z.enum(PHARMACY_EVENT_TYPES),
  idempotencyKey: z.string().min(1).optional(),
  note: z.string().max(500).optional(),
});

/** DEMO ONLY. Emits a clearly simulated pharmacy event. Not available outside demo mode. */
export const POST = route(async (req) => {
  requireDemoMode();
  const session = requireSession(req, ["demo_operator"]);
  const body = await parseBody(req, Body);
  return ok({ simulated: true, ...(await applyPharmacyEvent(toActor(session), body)) });
});
