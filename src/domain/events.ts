import { z } from "zod";

/** Who performed an action. "agent" is an LLM agent and has no clinical authority. */
export const ActorRole = z.enum([
  "patient",
  "caregiver",
  "clinician",
  "pharmacy_sim",
  "system",
  "agent",
]);
export type ActorRole = z.infer<typeof ActorRole>;

/** The four information categories from the product spec. Never silently promote one to another. */
export const Verification = z.enum([
  "confirmed",
  "patient_reported",
  "estimated",
  "unverified",
]);
export type Verification = z.infer<typeof Verification>;

export const EventType = z.enum([
  "care_plan.submitted",
  "care_plan.approved",
  "prescription.authorized",
  "prescription.transmitted",
  "prescription.received",
  "prescription.acknowledged",
  "prescription.processing",
  "prescription.delayed",
  "prescription.clarification_requested",
  "prescription.clarification_resolved",
  "prescription.ready",
  "prescription.picked_up",
  "prescription.pickup_reported", // patient-reported; does NOT change prescription state
  "prescription.cancelled",
  "prescription.rejected",
  "prescription.failed",
  "notification.sent",
  "notification.acknowledged",
  "followup.completed",
  "task.confirmed",
  "gap.resolved",
]);
export type EventType = z.infer<typeof EventType>;

/** The event envelope required by the spec. */
export const CareEventSchema = z.object({
  eventId: z.string().min(1),
  workflowId: z.string().min(1),
  patientId: z.string().min(1),
  type: EventType,
  actorId: z.string().min(1),
  actorRole: ActorRole,
  sourceSystem: z.string().min(1),
  occurredAt: z.string().datetime(),
  recordedAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()).default({}),
  verification: Verification,
  simulated: z.boolean(),
  correlationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
});
export type CareEvent = z.infer<typeof CareEventSchema>;

export interface Actor {
  id: string;
  role: ActorRole;
  /** Set for patient/caregiver actors: the only patient they may access. */
  patientId?: string;
}
