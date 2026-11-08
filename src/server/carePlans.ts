import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { applyCarePlanEvent, type CarePlanState } from "@/domain/carePlan";
import type { Actor, CareEvent } from "@/domain/events";
import { sourceOf, type SourceInfo } from "@/domain/status";
import { HttpError } from "./http";
import { runtime } from "./runtime";
import { envelope, submit } from "./services";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const MedicationSchema = z.object({
  name: z.string().min(1).max(120),
  dose: z.string().max(80).optional(),
  times: z.array(z.string().regex(TIME, "use HH:MM")).max(8).optional(),
  startDate: z.string().regex(DATE, "use YYYY-MM-DD").optional(),
  endDate: z.string().regex(DATE, "use YYYY-MM-DD").optional(),
  notes: z.string().max(500).optional(),
});

export const CarePlanContentSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(2000),
  instructions: z.array(z.string().min(1).max(500)).max(30).default([]),
  medications: z.array(MedicationSchema).max(20).default([]),
  followUps: z
    .array(z.object({ description: z.string().min(1).max(300), dueDate: z.string().regex(DATE).optional() }))
    .max(10)
    .default([]),
  warningSigns: z.array(z.string().min(1).max(300)).max(15).default([]),
});
export type CarePlanContent = z.infer<typeof CarePlanContentSchema>;

export interface CarePlanView {
  planId: string;
  patientId: string;
  state: CarePlanState;
  content: CarePlanContent;
  draftedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  simulated: boolean;
  source: SourceInfo | null;
}

const isPatientSide = (a: Actor) => a.role === "patient" || a.role === "caregiver";

function foldPlan(events: CareEvent[]): CarePlanState {
  let state: CarePlanState = "DRAFT";
  for (const e of [...events].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
    const r = applyCarePlanEvent(state, e.type, e.actorRole);
    if (r.ok) state = r.next;
  }
  return state;
}

function toView(events: CareEvent[]): CarePlanView {
  const submitted = events.find((e) => e.type === "care_plan.submitted")!;
  const approved = events.find((e) => e.type === "care_plan.approved");
  const state = foldPlan(events);
  return {
    planId: submitted.workflowId,
    patientId: submitted.patientId,
    state,
    content: CarePlanContentSchema.parse(submitted.payload.content),
    draftedBy: submitted.actorRole,
    approvedBy: approved ? String(approved.payload.approvedBy ?? approved.actorId) : null,
    approvedAt: approved?.recordedAt ?? null,
    simulated: submitted.simulated,
    source: sourceOf(approved ?? submitted),
  };
}

function groupPlans(events: CareEvent[]): CarePlanView[] {
  const ids = [...new Set(events.filter((e) => e.type === "care_plan.submitted").map((e) => e.workflowId))];
  return ids.map((id) => toView(events.filter((e) => e.workflowId === id)));
}

/** A clinician (or, later, the Doctor Agent) submits a plan for review. It is not visible to the patient until approved. */
export async function createCarePlan(
  actor: Actor,
  input: { patientId: string; content: CarePlanContent },
  idempotencyKey?: string,
  opts: { simulated?: boolean; sourceSystem?: string } = {},
): Promise<CarePlanView> {
  const key = idempotencyKey ?? randomUUID();
  const planId = `plan_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  await submit(
    actor,
    envelope(
      actor,
      { workflowId: planId, patientId: input.patientId, type: "care_plan.submitted", idempotencyKey: `${key}:submitted`, correlationId: `corr_${planId}` },
      { payload: { content: input.content }, simulated: opts.simulated, sourceSystem: opts.sourceSystem },
    ),
  );
  return toView(await runtime().store.listByWorkflow(planId));
}

/** Approval is clinician-only and enforced by the orchestrator, not here. */
export async function approveCarePlan(
  actor: Actor,
  planId: string,
  idempotencyKey?: string,
  opts: { simulated?: boolean; sourceSystem?: string } = {},
): Promise<CarePlanView> {
  const events = await runtime().store.listByWorkflow(planId);
  if (events.length === 0) throw new HttpError(404, "not_found", "Care plan not found");
  await submit(
    actor,
    envelope(
      actor,
      { workflowId: planId, patientId: events[0].patientId, type: "care_plan.approved", idempotencyKey: idempotencyKey ?? randomUUID(), correlationId: `corr_${planId}` },
      { payload: { approvedBy: actor.id }, simulated: opts.simulated, sourceSystem: opts.sourceSystem },
    ),
  );
  return getCarePlan(actor, planId);
}

export async function getCarePlan(actor: Actor, planId: string): Promise<CarePlanView> {
  const events = await runtime().store.listByWorkflow(planId);
  if (events.length === 0 || !events.some((e) => e.type === "care_plan.submitted")) {
    throw new HttpError(404, "not_found", "Care plan not found");
  }
  const view = toView(events);
  if (isPatientSide(actor)) {
    // Patients only ever see their own, clinician-approved plans. Same answer as "missing".
    if (actor.patientId !== view.patientId || view.state !== "APPROVED") throw new HttpError(404, "not_found", "Care plan not found");
  } else if (actor.role !== "clinician") {
    throw new HttpError(403, "forbidden", "Not allowed");
  }
  return view;
}

export async function listCarePlans(actor: Actor, patientId?: string): Promise<CarePlanView[]> {
  if (isPatientSide(actor)) {
    const events = await runtime().store.listByPatient(actor.patientId ?? "");
    return groupPlans(events).filter((p) => p.state === "APPROVED");
  }
  if (actor.role !== "clinician") throw new HttpError(403, "forbidden", "Not allowed");
  const events = patientId ? await runtime().store.listByPatient(patientId) : await runtime().store.listAll();
  return groupPlans(events);
}
