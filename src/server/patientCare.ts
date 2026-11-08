import { z } from "zod";
import { deriveReminders, resolveDoseStatus, type DoseStatus, type PatientDoseResponse } from "@/domain/dose";
import type { Actor, CareEvent, Verification } from "@/domain/events";
import { prescriptionStatus, sourceOf, type SourceInfo } from "@/domain/status";
import { listCarePlans } from "./carePlans";
import { HttpError } from "./http";
import { runtime } from "./runtime";
import { envelope, submit } from "./services";

const isPatientSide = (a: Actor) => a.role === "patient" || a.role === "caregiver";
const GRACE_MINUTES = 60; // demo configuration, not a clinical standard

/** Resolve whose record is being read. Patients are pinned to their own; clinicians must name one. */
function resolvePatient(actor: Actor, patientId?: string): string {
  if (isPatientSide(actor)) return actor.patientId ?? "";
  if (actor.role !== "clinician") throw new HttpError(403, "forbidden", "Not allowed");
  if (!patientId) throw new HttpError(400, "validation_failed", "patientId is required");
  return patientId;
}

export interface DoseView {
  planId: string;
  medicationName: string;
  scheduledFor: string;
  status: DoseStatus;
  /** What the status rests on. A taken/not-taken answer is the patient's word, nothing more. */
  statusVerification: Verification | "none";
}

export interface MedicationView {
  planId: string;
  name: string;
  dose: string | null;
  notes: string | null;
  schedule: "ready" | "needs_clarification";
  missing: string[];
  doses: DoseView[];
  source: { carePlanId: string; approvedBy: string | null; approvedAt: string | null };
}

export async function medications(actor: Actor, patientId?: string, now: Date = new Date()): Promise<{ timezone: string; medications: MedicationView[] }> {
  const pid = resolvePatient(actor, patientId);
  const plans = (await listCarePlans({ id: "internal", role: "clinician" }, pid)).filter((p) => p.state === "APPROVED");
  const events = await runtime().store.listByPatient(pid);
  const responses = new Map<string, PatientDoseResponse>();
  for (const e of events.filter((x) => x.type === "dose.reported")) {
    responses.set(`${e.workflowId}|${e.payload.medicationName}|${e.payload.scheduledFor}`, e.payload.response as PatientDoseResponse);
  }

  const out: MedicationView[] = [];
  for (const plan of plans) {
    for (const med of plan.content.medications) {
      const view: MedicationView = {
        planId: plan.planId,
        name: med.name,
        dose: med.dose ?? null,
        notes: med.notes ?? null,
        schedule: "ready",
        missing: [],
        doses: [],
        source: { carePlanId: plan.planId, approvedBy: plan.approvedBy, approvedAt: plan.approvedAt },
      };
      const startMs = med.startDate ? Date.parse(`${med.startDate}T00:00:00Z`) : NaN;
      const horizon = Number.isNaN(startMs) ? 1 : Math.min(90, Math.max(1, Math.ceil((now.getTime() + 2 * 86_400_000 - startMs) / 86_400_000)));
      const derived = deriveReminders(
        { medicationName: med.name, dose: med.dose, times: med.times, startDate: med.startDate, endDate: med.endDate, source: { carePlanVersionId: plan.planId, approvedBy: plan.approvedBy ?? "" } },
        { horizonDays: horizon },
      );
      if (derived.status === "needs_clarification") {
        view.schedule = "needs_clarification";
        view.missing = derived.missing;
      } else {
        const from = now.getTime() - 12 * 3_600_000;
        const to = now.getTime() + 36 * 3_600_000;
        view.doses = derived.reminders
          .filter((r) => Date.parse(r.scheduledFor) >= from && Date.parse(r.scheduledFor) <= to)
          .map((r) => {
            const response = responses.get(`${plan.planId}|${med.name}|${r.scheduledFor}`);
            return {
              planId: plan.planId,
              medicationName: med.name,
              scheduledFor: r.scheduledFor,
              status: resolveDoseStatus({ scheduledFor: r.scheduledFor, now: now.toISOString(), graceMinutes: GRACE_MINUTES, response }),
              statusVerification: response ? ("patient_reported" as const) : ("none" as const),
            };
          });
      }
      out.push(view);
    }
  }
  return { timezone: "UTC (demo: times in an approved plan are read as UTC)", medications: out };
}

export const DoseReportSchema = z.object({
  planId: z.string().min(1),
  medicationName: z.string().min(1),
  scheduledFor: z.string().datetime(),
  response: z.enum(["taken", "not_taken", "unsure"]),
});

/** Patient-reported only. The first answer for a dose stands; repeats are reported as already recorded. */
export async function reportDose(actor: Actor, input: z.infer<typeof DoseReportSchema>, now: Date = new Date()) {
  if (!isPatientSide(actor)) throw new HttpError(403, "forbidden", "Only the patient can report a dose");
  const { medications: meds } = await medications(actor, undefined, now);
  const exists = meds.some((m) => m.planId === input.planId && m.name === input.medicationName && m.doses.some((d) => d.scheduledFor === input.scheduledFor));
  if (!exists) throw new HttpError(400, "validation_failed", "That dose is not on your approved schedule");
  const r = await submit(
    actor,
    envelope(
      actor,
      {
        workflowId: input.planId,
        patientId: actor.patientId ?? "",
        type: "dose.reported",
        idempotencyKey: `dose:${input.planId}:${input.medicationName}:${input.scheduledFor}`,
        correlationId: `corr_${input.planId}`,
      },
      { payload: { medicationName: input.medicationName, scheduledFor: input.scheduledFor, response: input.response } },
    ),
  );
  return { recorded: r.status === "applied", alreadyRecorded: r.status === "duplicate" };
}

export interface NotificationView {
  id: string;
  kind: "care_plan" | "prescription" | "care_team_message";
  title: string;
  important: boolean;
  at: string;
  acknowledged: boolean;
  source: SourceInfo;
}

const IMPORTANT_KINDS = new Set(["prescription.delayed", "prescription.clarification_requested", "prescription.ready", "prescription.rejected", "prescription.failed"]);

async function derive(patientId: string): Promise<{ list: NotificationView[]; events: CareEvent[] }> {
  const events = await runtime().store.listByPatient(patientId);
  const acked = new Set(events.filter((e) => e.type === "notification.acknowledged").map((e) => String(e.payload.notificationId)));
  const list: NotificationView[] = [];
  for (const e of events.filter((x) => x.type === "care_plan.approved")) {
    const planEvents = events.filter((x) => x.workflowId === e.workflowId);
    const title = String((planEvents.find((x) => x.type === "care_plan.submitted")?.payload.content as { title?: string } | undefined)?.title ?? "Care plan");
    list.push({ id: e.eventId, kind: "care_plan", title: `Your care plan is ready: ${title}`, important: true, at: e.recordedAt, acknowledged: acked.has(e.eventId), source: sourceOf(e) });
  }
  const rxIds = [...new Set(events.filter((e) => e.type === "prescription.authorized").map((e) => e.workflowId))];
  for (const id of rxIds) {
    const evs = events.filter((e) => e.workflowId === id);
    const byId = new Map(evs.map((e) => [e.eventId, e]));
    for (const item of prescriptionStatus(evs).timeline) {
      const ev = byId.get(item.source.eventId)!;
      list.push({ id: ev.eventId, kind: "prescription", title: item.label, important: IMPORTANT_KINDS.has(ev.type), at: item.at, acknowledged: acked.has(ev.eventId), source: item.source });
    }
  }
  // Messages a clinician approved after an agent drafted them. Shown as the clinician's message, never as the agent's.
  for (const e of events.filter((x) => x.type === "notification.sent" && x.payload.kind === "care_team_message")) {
    list.push({ id: e.eventId, kind: "care_team_message", title: `Message from your care team: ${String(e.payload.message ?? "")}`, important: true, at: e.recordedAt, acknowledged: acked.has(e.eventId), source: sourceOf(e) });
  }
  list.sort((a, b) => b.at.localeCompare(a.at));
  return { list, events };
}

export async function listNotifications(actor: Actor) {
  if (!isPatientSide(actor)) throw new HttpError(403, "forbidden", "Notifications are patient-facing");
  const { list } = await derive(actor.patientId ?? "");
  return { notifications: list, unread: list.filter((n) => !n.acknowledged).length };
}

export async function acknowledgeNotification(actor: Actor, id: string) {
  if (!isPatientSide(actor)) throw new HttpError(403, "forbidden", "Only the patient can acknowledge");
  const { list, events } = await derive(actor.patientId ?? "");
  const n = list.find((x) => x.id === id);
  const source = events.find((e) => e.eventId === id);
  if (!n || !source) throw new HttpError(404, "not_found", "Notification not found");
  const r = await submit(
    actor,
    envelope(actor, { workflowId: source.workflowId, patientId: source.patientId, type: "notification.acknowledged", idempotencyKey: `ack:${id}`, correlationId: `corr_${source.workflowId}` }, { payload: { notificationId: id } }),
  );
  return { acknowledged: true, alreadyAcknowledged: r.status === "duplicate" };
}
