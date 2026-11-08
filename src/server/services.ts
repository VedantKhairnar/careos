import { createHash, randomUUID } from "node:crypto";
import { detectGaps, type CareGap } from "@/domain/careGap";
import type { Actor, CareEvent, EventType } from "@/domain/events";
import { prescriptionStatus } from "@/domain/status";
import { HttpError, rejection } from "./http";
import { runtime } from "./runtime";

const SYSTEM: Actor = { id: "careos-orchestrator", role: "system" };

export const PHARMACY_EVENT_TYPES = [
  "prescription.received",
  "prescription.acknowledged",
  "prescription.processing",
  "prescription.delayed",
  "prescription.clarification_requested",
  "prescription.ready",
  "prescription.picked_up",
  "prescription.rejected",
] as const satisfies readonly EventType[];

export const CLINICIAN_ACTIONS = {
  resolve_clarification: "prescription.clarification_resolved",
  followup_completed: "followup.completed",
  cancel: "prescription.cancelled",
} as const satisfies Record<string, EventType>;

function envelope(
  actor: Actor,
  base: { workflowId: string; patientId: string; type: EventType; idempotencyKey: string; correlationId: string },
  extra: { payload?: Record<string, unknown>; simulated?: boolean; sourceSystem?: string } = {},
) {
  const now = new Date().toISOString();
  return {
    eventId: randomUUID(),
    workflowId: base.workflowId,
    patientId: base.patientId,
    type: base.type,
    actorId: actor.id,
    actorRole: actor.role,
    sourceSystem: extra.sourceSystem ?? "careos",
    occurredAt: now,
    recordedAt: now,
    payload: extra.payload ?? {},
    verification: actor.role === "patient" || actor.role === "caregiver" ? ("patient_reported" as const) : ("confirmed" as const),
    simulated: extra.simulated ?? false,
    correlationId: base.correlationId,
    idempotencyKey: base.idempotencyKey,
  };
}

async function submit(actor: Actor, event: ReturnType<typeof envelope>) {
  const r = await runtime().orchestrator.handle(actor, event);
  if (r.status === "rejected") throw rejection(r.code, r.reason);
  return r;
}

export interface CreatePrescriptionInput {
  patientId: string;
  medicationReference: string;
  approvedInstructions?: string;
}

/** Clinician authorizes; the orchestrator then records transmission. Safe to retry with the same key. */
export async function createPrescription(clinician: Actor, input: CreatePrescriptionInput, idempotencyKey?: string) {
  const key = idempotencyKey ?? randomUUID();
  const workflowId = `rx_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  const correlationId = `corr_${workflowId}`;
  const base = { workflowId, patientId: input.patientId, correlationId };

  await submit(
    clinician,
    envelope(clinician, { ...base, type: "prescription.authorized", idempotencyKey: `${key}:authorized` }, {
      payload: { medicationReference: input.medicationReference, approvedInstructions: input.approvedInstructions ?? null },
    }),
  );
  await submit(
    SYSTEM,
    envelope(SYSTEM, { ...base, type: "prescription.transmitted", idempotencyKey: `${key}:transmitted` }, {
      payload: { channel: "simulated-eprescribing" },
      simulated: true,
      sourceSystem: "careos-simulated-transmission",
    }),
  );
  return { workflowId, ...(await prescriptionView(clinician, workflowId)) };
}

async function workflowEvents(actor: Actor, workflowId: string): Promise<CareEvent[]> {
  const events = await runtime().store.listByWorkflow(workflowId);
  if (events.length === 0) throw new HttpError(404, "not_found", "Prescription not found");
  const patientId = events[0].patientId;
  const patientSide = actor.role === "patient" || actor.role === "caregiver";
  if (patientSide && actor.patientId !== patientId) {
    // Same answer as a missing record so ids cannot be probed.
    throw new HttpError(404, "not_found", "Prescription not found");
  }
  if (!patientSide && actor.role !== "clinician") throw new HttpError(403, "forbidden", "Not allowed");
  return events;
}

export async function prescriptionView(actor: Actor, workflowId: string) {
  const events = await workflowEvents(actor, workflowId);
  const s = prescriptionStatus(events);
  const isClinician = actor.role === "clinician";
  return {
    patientId: events[0].patientId,
    state: s.state,
    text: isClinician ? s.clinicianText : s.patientText,
    timeline: s.timeline,
    currentSource: s.currentSource,
  };
}

/** Demo pharmacy simulator. Always flagged as simulated. */
export async function applyPharmacyEvent(
  operator: Actor,
  input: { workflowId: string; type: (typeof PHARMACY_EVENT_TYPES)[number]; idempotencyKey?: string; note?: string },
) {
  const existing = await runtime().store.listByWorkflow(input.workflowId);
  if (existing.length === 0) throw new HttpError(404, "not_found", "Prescription not found");
  const r = await runtime().orchestrator.handle(
    operator,
    envelope(
      operator,
      {
        workflowId: input.workflowId,
        patientId: existing[0].patientId,
        type: input.type,
        idempotencyKey: input.idempotencyKey ?? randomUUID(),
        correlationId: `corr_${input.workflowId}`,
      },
      { payload: input.note ? { note: input.note } : {}, simulated: true, sourceSystem: "pharmacy-simulator" },
    ),
  );
  if (r.status === "rejected") throw rejection(r.code, r.reason);
  return { result: r.status, ...(await prescriptionViewAsSystem(input.workflowId)) };
}

async function prescriptionViewAsSystem(workflowId: string) {
  const events = await runtime().store.listByWorkflow(workflowId);
  const s = prescriptionStatus(events);
  return { patientId: events[0].patientId, state: s.state, text: s.clinicianText };
}

export async function clinicianAction(
  clinician: Actor,
  workflowId: string,
  action: keyof typeof CLINICIAN_ACTIONS,
  idempotencyKey?: string,
) {
  const events = await workflowEvents(clinician, workflowId);
  await submit(
    clinician,
    envelope(clinician, {
      workflowId,
      patientId: events[0].patientId,
      type: CLINICIAN_ACTIONS[action],
      idempotencyKey: idempotencyKey ?? randomUUID(),
      correlationId: `corr_${workflowId}`,
    }),
  );
  return prescriptionView(clinician, workflowId);
}

export async function listWorkflows(): Promise<{ workflowId: string; patientId: string; state: string; text: string }[]> {
  const all = await runtime().store.listAll();
  const ids = [...new Set(all.map((e) => e.workflowId))];
  return ids.map((id) => {
    const evs = all.filter((e) => e.workflowId === id);
    const s = prescriptionStatus(evs);
    return { workflowId: id, patientId: evs[0].patientId, state: s.state, text: s.clinicianText };
  });
}

export async function careGaps(actor: Actor, patientId?: string): Promise<CareGap[]> {
  const patientSide = actor.role === "patient" || actor.role === "caregiver";
  const events = patientSide
    ? await runtime().orchestrator.listEventsFor(actor, actor.patientId ?? "")
    : actor.role === "clinician"
      ? patientId
        ? await runtime().store.listByPatient(patientId)
        : await runtime().store.listAll()
      : [];
  return detectGaps(events, new Date().toISOString());
}
