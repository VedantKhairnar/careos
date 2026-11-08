import type { Actor, CareEvent } from "@/domain/events";
import { prescriptionStatus } from "@/domain/status";
import { HttpError } from "./http";
import { runtime } from "./runtime";

export type StepState = "done" | "current" | "upcoming" | "problem";

export interface VisitStep {
  key: string;
  label: string;
  state: StepState;
  at: string | null;
  note?: string;
}

export interface VisitView {
  planTitle: string;
  approvedAt: string;
  draftedWithAi: boolean;
  medicines: string[];
  followUps: { description: string; dueDate?: string }[];
  prescription: { medication: string; state: string; text: string; simulated: boolean } | null;
  steps: VisitStep[];
  progress: { done: number; total: number };
  headline: string;
  next: string;
  openQuestions: number;
  /** What the assistants did, in words that are safe for the patient. Never includes an unapproved draft. */
  agentNotes: { at: string; text: string }[];
  updatedAt: string;
}

const NEXT: Record<string, string> = {
  DRAFT: "Your doctor is preparing the prescription.",
  AUTHORIZED: "The prescription is about to be sent to the pharmacy.",
  TRANSMITTED: "Waiting for the pharmacy to confirm they received it.",
  RECEIVED: "Waiting for the pharmacy to confirm they are working on it.",
  ACKNOWLEDGED: "Waiting for the pharmacy to tell us when it will be ready.",
  PROCESSING: "The pharmacy is preparing it. We will tell you when it is ready.",
  DELAYED: "The pharmacy reported a delay. Your care team has been told and decides what happens next.",
  CLARIFICATION_REQUIRED: "The pharmacy has a question for your doctor. Your doctor needs to answer it.",
  READY_FOR_PICKUP: "Your medicine is ready. Please pick it up.",
  PICKED_UP: "You are all set. Take your medicines as planned.",
  CANCELLED: "This prescription was cancelled. Ask your care team if you have questions.",
  REJECTED: "The pharmacy could not fill it. Your care team has been told.",
  FAILED: "It could not be sent to the pharmacy. Your care team has been told.",
};

/**
 * The single "what is going on with my last visit" view: plan, prescription, pharmacy and pickup, plus what the
 * assistants did. Derived from the same events as everything else, so it can never disagree with the other pages.
 */
export async function lastVisit(actor: Actor, patientIdParam?: string): Promise<VisitView | null> {
  const patientSide = actor.role === "patient" || actor.role === "caregiver";
  if (!patientSide && actor.role !== "clinician") throw new HttpError(403, "forbidden", "Not allowed");
  const patientId = patientSide ? (actor.patientId ?? "") : patientIdParam;
  if (!patientId) throw new HttpError(400, "validation_failed", "patientId is required");
  const events = await runtime().orchestrator.listEventsFor(actor, patientId);

  const approved = events.filter((e) => e.type === "care_plan.approved").sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
  if (!approved) return null;
  const submitted = events.find((e) => e.workflowId === approved.workflowId && e.type === "care_plan.submitted");
  const content = (submitted?.payload.content ?? {}) as { title?: string; medications?: { name?: string }[]; followUps?: { description: string; dueDate?: string }[] };

  const rxIds = [...new Set(events.filter((e) => e.type === "prescription.authorized").map((e) => e.workflowId))];
  const latestRx = rxIds
    .map((id) => ({ id, evs: events.filter((e) => e.workflowId === id) }))
    .sort((a, b) => (b.evs.find((e) => e.type === "prescription.authorized")?.recordedAt ?? "").localeCompare(a.evs.find((e) => e.type === "prescription.authorized")?.recordedAt ?? ""))[0];
  const status = latestRx ? prescriptionStatus(latestRx.evs) : null;
  const at = (type: string, rx = true) => (rx ? latestRx?.evs : events)?.find((e) => e.type === type)?.recordedAt ?? null;
  const first = (types: string[]) => types.map((t) => at(t)).filter((x): x is string => Boolean(x)).sort()[0] ?? null;
  const state = status?.state;

  const pharmacyAt = first(["prescription.received", "prescription.acknowledged", "prescription.processing"]);
  const problem = state === "DELAYED" || state === "CLARIFICATION_REQUIRED" || state === "REJECTED" || state === "FAILED";
  const raw: Omit<VisitStep, "state">[] = [
    { key: "plan_drafted", label: "Visit recorded and care plan drafted", at: submitted?.recordedAt ?? null },
    { key: "plan_approved", label: "Care plan approved by your doctor", at: approved.recordedAt },
    { key: "rx_sent", label: "Prescription sent to the pharmacy", at: at("prescription.transmitted") },
    { key: "pharmacy", label: problem ? (state === "DELAYED" ? "Pharmacy reported a delay" : state === "CLARIFICATION_REQUIRED" ? "Pharmacy asked your doctor a question" : "Pharmacy could not fill it") : "Pharmacy confirmed", at: pharmacyAt ?? first(["prescription.delayed", "prescription.clarification_requested", "prescription.rejected"]) },
    { key: "ready", label: "Ready for pickup", at: at("prescription.ready") },
    { key: "picked_up", label: "Picked up", at: at("prescription.picked_up") },
  ];
  let currentSet = false;
  const steps: VisitStep[] = raw.map((s) => {
    if (s.at && !(s.key === "pharmacy" && problem)) return { ...s, state: "done" as const };
    if (s.key === "pharmacy" && problem) {
      currentSet = true;
      return { ...s, state: "problem" as const };
    }
    if (!currentSet) {
      currentSet = true;
      return { ...s, state: "current" as const };
    }
    return { ...s, state: "upcoming" as const };
  });
  if (!latestRx) for (const s of steps) if (s.key !== "plan_drafted" && s.key !== "plan_approved" && s.state === "upcoming") s.note = "Only if your doctor sends a prescription";

  // Assistant activity in patient-safe words. A draft that a clinician has not approved is never quoted.
  const notes: { at: string; text: string }[] = [];
  if (submitted?.actorRole === "agent") notes.push({ at: submitted.recordedAt, text: "An AI assistant helped draft your care plan from your doctor's visit notes. Your doctor reviewed and approved it." });
  const answered = new Set(events.filter((e) => e.type === "question.answered").map((e) => e.workflowId));
  for (const q of events.filter((e) => e.type === "question.asked" && e.payload.via === "assistant"))
    notes.push({ at: q.recordedAt, text: answered.has(q.workflowId) ? "Your assistant sent a question to your care team, and your care team answered it." : "Your assistant sent a question to your care team. It is waiting for a clinician to answer." });
  const reviewed = new Map(events.filter((e) => e.type === "agent.suggestion_reviewed").map((e) => [String(e.payload.suggestionId), e]));
  for (const s of events.filter((e) => e.type === "agent.suggestion_created")) {
    const r = reviewed.get(String(s.payload.suggestionId));
    notes.push({
      at: (r ?? s).recordedAt,
      text: !r
        ? "Care team assistants noticed a pharmacy update and are preparing a note for your doctor to review. Nothing is sent to you until your doctor approves it."
        : r.payload.decision === "approve"
          ? "Your doctor reviewed a note prepared by the assistants and sent you a message about your prescription."
          : "Your doctor reviewed a note prepared by the assistants.",
    });
  }
  notes.sort((a, b) => b.at.localeCompare(a.at));

  const lastAt = [approved.recordedAt, ...(latestRx?.evs.map((e) => e.recordedAt) ?? []), ...notes.map((n) => n.at)].sort().at(-1)!;
  const open = events.filter((e) => e.type === "question.asked" && !answered.has(e.workflowId)).length;
  return {
    planTitle: content.title ?? "Care plan",
    approvedAt: approved.recordedAt,
    draftedWithAi: submitted?.actorRole === "agent",
    medicines: (content.medications ?? []).map((m) => m.name).filter((n): n is string => Boolean(n)),
    followUps: content.followUps ?? [],
    prescription: status && latestRx ? { medication: String(latestRx.evs.find((e) => e.type === "prescription.authorized")?.payload.medicationReference ?? ""), state: status.state, text: status.patientText, simulated: latestRx.evs.some((e: CareEvent) => e.simulated) } : null,
    steps,
    progress: { done: steps.filter((s) => s.state === "done").length, total: steps.length },
    headline: status ? status.patientText : "Your care plan is approved. Your doctor has not sent a prescription.",
    next: state ? NEXT[state] : "Follow your care plan. Your doctor will add a prescription if you need one.",
    openQuestions: open,
    agentNotes: notes.slice(0, 5),
    updatedAt: lastAt,
  };
}
