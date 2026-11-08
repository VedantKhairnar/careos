import { z } from "zod";
import type { Actor } from "@/domain/events";
import { listCarePlans } from "@/server/carePlans";
import { listNotifications, medications } from "@/server/patientCare";
import { patientSummary } from "@/server/patients";
import { askQuestion, listQuestions } from "@/server/questions";
import { careGaps, listPrescriptions } from "@/server/services";
import type { ToolDecl } from "./model";

/**
 * Every tool runs as the person the agent is acting for, through the same services the API uses,
 * so authorization is enforced server-side exactly as it is for a human. A tool that is not in an
 * agent's allowlist cannot be called at all (see runner.ts).
 */
export interface ToolDef {
  name: string;
  description: string;
  args: z.ZodType;
  run(actor: Actor, args: never): Promise<unknown>;
}

const NoArgs = z.object({});

export function declOf(t: ToolDef): ToolDecl {
  const schema = z.toJSONSchema(t.args) as Record<string, unknown>;
  delete schema.$schema;
  return { name: t.name, description: t.description, parametersJsonSchema: schema };
}

const defineTool = <S extends z.ZodType>(t: { name: string; description: string; args: S; run: (actor: Actor, args: z.infer<S>) => Promise<unknown> }): ToolDef => t as unknown as ToolDef;

/* ---------------- Patient agent tools ---------------- */

export const getApprovedCarePlan = defineTool({
  name: "get_approved_care_plan",
  description: "The patient's clinician-approved care plans: instructions, medicines, follow-ups and warning-sign guidance.",
  args: NoArgs,
  run: async (actor) =>
    (await listCarePlans(actor)).map((p) => ({
      planId: p.planId,
      title: p.content.title,
      summary: p.content.summary,
      instructions: p.content.instructions,
      medications: p.content.medications,
      followUps: p.content.followUps,
      warningSigns: p.content.warningSigns,
      approvedAt: p.approvedAt,
    })),
});

export const getMedicationSchedule = defineTool({
  name: "get_medication_schedule",
  description:
    "Medicines and today's doses from approved plans. A medicine whose scheduleConfirmed is false has NO confirmed schedule yet; stillNeededFromCareTeam says what is missing. Dose statuses are what the patient reported.",
  args: NoArgs,
  run: async (actor) => {
    const { medications: meds } = await medications(actor);
    return meds.map((m) => ({
      name: m.name,
      dose: m.dose,
      notes: m.notes,
      scheduleConfirmed: m.schedule === "ready",
      stillNeededFromCareTeam: m.missing.map((x) => ({ dose: "the dose", times: "the times", startDate: "the start date", "valid times": "valid times", "valid endDate": "a valid end date" })[x] ?? x),
      doses: m.doses.map((d) => ({ scheduledFor: d.scheduledFor, status: d.status })),
    }));
  },
});

export const getPrescriptionStatus = defineTool({
  name: "get_prescription_status",
  description: "Prescriptions and their verified status. 'simulated' is true for demonstration data.",
  args: NoArgs,
  run: async (actor) =>
    (await listPrescriptions(actor)).map((p) => ({ medication: p.medicationReference, state: p.state, statusText: p.text, simulated: p.simulated, lastUpdated: p.lastUpdated })),
});

export const getUpcomingAppointments = defineTool({
  name: "get_upcoming_appointments",
  description: "Follow-ups listed in approved plans. Booking is NOT confirmed by this system; only target dates are known.",
  args: NoArgs,
  run: async (actor) =>
    (await listCarePlans(actor)).flatMap((p) => p.content.followUps.map((f) => ({ description: f.description, targetDate: f.dueDate ?? null, bookingConfirmed: false, plan: p.content.title }))),
});

export const getCareTimeline = defineTool({
  name: "get_care_timeline",
  description: "Recent events in the patient's care, newest first.",
  args: NoArgs,
  run: async (actor) =>
    (await listNotifications(actor)).notifications.slice(0, 15).map((n) => ({ what: n.title, at: n.at, important: n.important, seenByPatient: n.acknowledged, simulated: n.source.simulated })),
});

export const createClarificationRequest = defineTool({
  name: "create_clarification_request",
  description:
    "Send a question to the patient's care team. Use this whenever the approved plan does not answer a clinical question. It does not answer the question itself.",
  args: z.object({ question: z.string().min(3).max(1000).describe("The patient's question, in their words") }),
  run: async (actor, args) => {
    const q = await askQuestion(actor, args.question, "assistant");
    return { questionId: q.id, status: q.status };
  },
});

export const PATIENT_TOOLS: ToolDef[] = [
  getApprovedCarePlan,
  getMedicationSchedule,
  getPrescriptionStatus,
  getUpcomingAppointments,
  getCareTimeline,
  createClarificationRequest,
];

/* ---------------- Doctor agent tools (read-only) ---------------- */

export const getPatientSummary = defineTool({
  name: "get_patient_summary",
  description: "A patient's plans, prescriptions and open care gaps.",
  args: z.object({ patientId: z.string().min(1) }),
  run: async (actor, args) => {
    const s = await patientSummary(actor, args.patientId);
    return {
      patient: s.patient.displayName,
      plans: s.plans.map((p) => ({ title: p.content.title, state: p.state, draftedBy: p.draftedBy, medicines: p.content.medications.map((m) => m.name) })),
      prescriptions: s.prescriptions.map((r) => ({ medication: r.medicationReference, state: r.state, simulated: r.simulated })),
      openGaps: s.gaps.map((g) => ({ rule: g.rule, responsible: g.responsible, description: g.description })),
    };
  },
});

export const getPendingClarifications = defineTool({
  name: "get_pending_clarifications",
  description: "Patient questions still waiting for an answer, and prescriptions where the pharmacy is waiting on the clinician.",
  args: z.object({ patientId: z.string().optional() }),
  run: async (actor, args) => ({
    patientQuestions: (await listQuestions(actor, args.patientId)).filter((q) => q.status === "open").map((q) => ({ id: q.id, question: q.question, askedAt: q.askedAt, askedVia: q.askedVia })),
    pharmacyQuestions: (await listPrescriptions(actor, args.patientId)).filter((r) => r.state === "CLARIFICATION_REQUIRED").map((r) => ({ medication: r.medicationReference, workflowId: r.workflowId })),
  }),
});

export const getCareGapSummary = defineTool({
  name: "get_care_gap_summary",
  description: "Open administrative care gaps (an expected step was not recorded by its deadline). Not clinical findings.",
  args: z.object({ patientId: z.string().optional() }),
  run: async (actor, args) => (await careGaps(actor, args.patientId)).map((g) => ({ rule: g.rule, responsible: g.responsible, description: g.description, sinceAt: g.sinceAt })),
});

export const DOCTOR_TOOLS: ToolDef[] = [getPatientSummary, getPendingClarifications, getCareGapSummary];
