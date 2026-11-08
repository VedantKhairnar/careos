import { createHash, randomUUID } from "node:crypto";
import { detectGaps, type CareGap } from "@/domain/careGap";
import type { Actor, CareEvent, EventType } from "@/domain/events";
import { prescriptionStatus } from "@/domain/status";
import { HttpError, rejection } from "./http";
import { nowMs, runtime } from "./runtime";

export const SYSTEM: Actor = { id: "careos-orchestrator", role: "system" };

/** Pharmacy updates the patient must be told about. Each one also records a system `notification.sent`. */
const IMPORTANT_PHARMACY_EVENTS = new Set<EventType>([
  "prescription.delayed",
  "prescription.clarification_requested",
  "prescription.ready",
  "prescription.rejected",
]);

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

export function envelope(
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

export async function submit(actor: Actor, event: ReturnType<typeof envelope>) {
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
export async function createPrescription(
  clinician: Actor,
  input: CreatePrescriptionInput,
  idempotencyKey?: string,
  opts: { simulated?: boolean; sourceSystem?: string } = {},
) {
  const key = idempotencyKey ?? randomUUID();
  const workflowId = `rx_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  const correlationId = `corr_${workflowId}`;
  const base = { workflowId, patientId: input.patientId, correlationId };

  await submit(
    clinician,
    envelope(clinician, { ...base, type: "prescription.authorized", idempotencyKey: `${key}:authorized` }, {
      payload: { medicationReference: input.medicationReference, approvedInstructions: input.approvedInstructions ?? null },
      simulated: opts.simulated,
      sourceSystem: opts.sourceSystem,
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
  if (r.status === "applied" && IMPORTANT_PHARMACY_EVENTS.has(input.type)) {
    // Record that the patient must be told. Unacknowledged ones can later become a care gap.
    await submit(
      SYSTEM,
      envelope(
        SYSTEM,
        {
          workflowId: input.workflowId,
          patientId: existing[0].patientId,
          type: "notification.sent",
          idempotencyKey: `notif:${r.event.eventId}`,
          correlationId: `corr_${input.workflowId}`,
        },
        { payload: { important: true, notificationId: r.event.eventId, kind: input.type }, simulated: true },
      ),
    );
  }
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

export interface PrescriptionSummary {
  workflowId: string;
  patientId: string;
  medicationReference: string;
  state: string;
  text: string;
  simulated: boolean;
  lastUpdated: string;
}

/** Prescriptions the caller may see: a patient their own, a clinician all (optionally one patient). */
export async function listPrescriptions(actor: Actor, patientId?: string): Promise<PrescriptionSummary[]> {
  const patientSide = actor.role === "patient" || actor.role === "caregiver";
  if (!patientSide && actor.role !== "clinician") throw new HttpError(403, "forbidden", "Not allowed");
  const events = patientSide
    ? await runtime().store.listByPatient(actor.patientId ?? "")
    : patientId
      ? await runtime().store.listByPatient(patientId)
      : await runtime().store.listAll();
  const ids = [...new Set(events.filter((e) => e.type === "prescription.authorized").map((e) => e.workflowId))];
  return ids.map((id) => {
    const evs = events.filter((e) => e.workflowId === id);
    const s = prescriptionStatus(evs);
    const auth = evs.find((e) => e.type === "prescription.authorized")!;
    return {
      workflowId: id,
      patientId: auth.patientId,
      medicationReference: String(auth.payload.medicationReference ?? ""),
      state: s.state,
      text: patientSide ? s.patientText : s.clinicianText,
      simulated: auth.simulated,
      lastUpdated: evs.map((e) => e.recordedAt).sort().at(-1) ?? auth.recordedAt,
    };
  });
}

export async function listWorkflows(): Promise<{ workflowId: string; patientId: string; state: string; text: string }[]> {
  const all = await runtime().store.listAll();
  const ids = [...new Set(all.filter((e) => e.type === "prescription.authorized").map((e) => e.workflowId))];
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
  return detectGaps(events, new Date(nowMs()).toISOString());
}
