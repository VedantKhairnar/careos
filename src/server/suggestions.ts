import { randomUUID } from "node:crypto";
import type { Actor, CareEvent } from "@/domain/events";
import type { TraceStep } from "@/agents/runner";
import { HttpError } from "./http";
import { runtime } from "./runtime";
import { envelope, submit, SYSTEM } from "./services";

export interface SuggestionView {
  id: string;
  workflowId: string;
  patientId: string;
  medication: string;
  trigger: string;
  patientMessage: string;
  clinicianSummary: string;
  suggestedNextStep: string;
  missingInformation: string[];
  model: string;
  trace: TraceStep[];
  createdAt: string;
  status: "pending" | "sent" | "dismissed";
  reviewedAt: string | null;
}

function build(all: CareEvent[]): SuggestionView[] {
  const reviews = new Map(all.filter((e) => e.type === "agent.suggestion_reviewed").map((e) => [String(e.payload.suggestionId), e]));
  return all
    .filter((e) => e.type === "agent.suggestion_created")
    .map((e) => {
      const p = e.payload as Record<string, unknown>;
      const id = String(p.suggestionId);
      const rev = reviews.get(id);
      const med = all.find((x) => x.workflowId === e.workflowId && x.type === "prescription.authorized")?.payload.medicationReference;
      return {
        id,
        workflowId: e.workflowId,
        patientId: e.patientId,
        medication: String(med ?? "a prescription"),
        trigger: String(p.trigger ?? ""),
        patientMessage: String(p.patientMessage ?? ""),
        clinicianSummary: String(p.clinicianSummary ?? ""),
        suggestedNextStep: String(p.suggestedNextStep ?? ""),
        missingInformation: Array.isArray(p.missingInformation) ? (p.missingInformation as unknown[]).map(String) : [],
        model: String(p.model ?? ""),
        trace: Array.isArray(p.trace) ? (p.trace as TraceStep[]) : [],
        createdAt: e.recordedAt,
        status: rev ? (rev.payload.decision === "approve" ? ("sent" as const) : ("dismissed" as const)) : ("pending" as const),
        reviewedAt: rev?.recordedAt ?? null,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function requireClinician(actor: Actor) {
  if (actor.role !== "clinician") throw new HttpError(403, "forbidden", "Only a clinician can review agent drafts");
}

export async function listSuggestions(actor: Actor): Promise<SuggestionView[]> {
  requireClinician(actor);
  const all = await runtime().store.listAll();
  return build(all.filter((e) => e.type.startsWith("agent.suggestion") || e.type === "prescription.authorized"));
}

/**
 * The clinician decides. Approving records the decision and then tells the patient, using the wording the
 * agent drafted (the clinician can edit it first). Dismissing records the decision and tells nobody.
 */
export async function reviewSuggestion(actor: Actor, id: string, decision: "approve" | "dismiss", editedMessage?: string) {
  requireClinician(actor);
  const s = (await listSuggestions(actor)).find((x) => x.id === id);
  if (!s) throw new HttpError(404, "not_found", "Draft not found");
  if (s.status !== "pending") return { alreadyReviewed: true, status: s.status };
  const message = (editedMessage ?? s.patientMessage).trim();
  if (decision === "approve" && !message) throw new HttpError(400, "validation_failed", "The message to the patient cannot be empty");

  const base = { workflowId: s.workflowId, patientId: s.patientId, correlationId: `corr_${s.workflowId}` };
  const r = await submit(actor, envelope(actor, { ...base, type: "agent.suggestion_reviewed", idempotencyKey: `agent-review:${id}` }, { payload: { suggestionId: id, decision, edited: decision === "approve" && message !== s.patientMessage }, simulated: true }));
  if (r.status !== "applied") return { alreadyReviewed: true, status: s.status };
  if (decision === "approve") {
    const nid = randomUUID();
    await submit(SYSTEM, { ...envelope(SYSTEM, { ...base, type: "notification.sent", idempotencyKey: `notif:agent:${id}` }, { payload: { important: true, notificationId: nid, kind: "care_team_message", message, suggestionId: id }, simulated: true }), eventId: nid });
  }
  return { alreadyReviewed: false, status: decision === "approve" ? "sent" : "dismissed" };
}
