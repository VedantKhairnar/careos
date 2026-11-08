import type { Actor } from "@/domain/events";
import { HttpError } from "@/server/http";
import { runAgent, type AgentRun, type TraceStep } from "./runner";
import { PATIENT_TOOLS } from "./tools";

export const URGENT_MESSAGE =
  "This sounds like it could be urgent. Please contact your care team now, or call your local emergency number if you think it is an emergency. CareOS cannot assess symptoms.";

/**
 * Deterministic check that runs BEFORE any model call. It is deliberately simple and over-inclusive:
 * the point is not to triage, it is to send the person to humans immediately. No model is involved.
 */
const URGENT = /\b(chest pain|can'?t breathe|cannot breathe|trouble breathing|difficulty breathing|short(ness)? of breath|severe bleeding|bleeding (a lot|heavily|won'?t stop)|unconscious|passed out|fainted|stroke|seizure|overdos|suicid|kill myself|want to die|allergic reaction|swelling (of|in) (my )?(face|throat|tongue)|emergency)\b/i;

export const isUrgent = (text: string) => URGENT.test(text);

export const PATIENT_SYSTEM = `You are the patient's assistant inside CareOS, a care-coordination app. You help one patient understand and follow their own clinician-approved care plan.

HARD RULES
1. Answer ONLY from tool results. Call the tools you need in a single step (you may call several at once). If the tools do not contain the answer, say you do not have that information. Never fill gaps from general medical knowledge about this patient.
2. You are not a clinician. Never diagnose, prescribe, change a dose or timing, suggest stopping or starting a medicine, or say a symptom is or is not serious.
3. If the patient asks something clinical that the approved plan does not answer, call create_clarification_request with their question, then tell them it has been sent to their care team and that you cannot answer it yourself.
4. A medicine whose scheduleConfirmed is false has no confirmed schedule. Say so in plain words (for example "your care team hasn't confirmed when to take this yet"). Never suggest a schedule.
5. Dose statuses are what the patient reported. 'unconfirmed' means no answer was recorded, NOT that a dose was missed. Never call a dose "missed".
6. Never say a prescription is ready, processed or picked up unless get_prescription_status says so. If a status is unknown, say it is awaiting confirmation. If data is marked simulated, mention it is demonstration data.
7. Never claim a clinician approved or said something unless a tool result shows it.
8. Keep answers short, warm and in plain language, a few sentences at most. Say where an answer comes from (for example "your care plan says").
9. Never quote field names, codes or technical terms from the tool results (for example scheduleConfirmed or state names). Say it the way a caring person would.
10. Use plain text. If you list items, put each on its own line starting with "- ". Do not use markdown symbols such as asterisks or hashes.`;

export interface PatientChatResult {
  answer: string;
  urgent: boolean;
  /** Tools the assistant actually used (evidence, shown to the patient on request). */
  sources: string[];
  askedCareTeam: boolean;
  model: string | null;
  /** Every model call and tool call behind this answer, so it can be shown to the user. */
  trace: TraceStep[];
}

export async function askPatientAgent(actor: Actor, message: string): Promise<PatientChatResult> {
  const text = message.trim();
  if (!text) throw new HttpError(400, "validation_failed", "Please type a question");
  if (text.length > 1000) throw new HttpError(400, "validation_failed", "Please keep your question under 1000 characters");
  if (isUrgent(text)) return { answer: URGENT_MESSAGE, urgent: true, sources: [], askedCareTeam: false, model: null, trace: [{ kind: "tool", name: "urgent-symptom check (no AI used)", ok: true, ms: 0, detail: "Sent straight to your care team" }] };

  const run: AgentRun = await runAgent({ name: "patient", system: PATIENT_SYSTEM, tools: PATIENT_TOOLS, maxModelCalls: 4 }, actor, actor.patientId ?? "", text);
  return {
    answer: run.text,
    urgent: false,
    sources: [...new Set(run.toolsUsed.filter((t) => t.ok).map((t) => t.name))],
    askedCareTeam: run.toolsUsed.some((t) => t.name === "create_clarification_request" && t.ok),
    model: run.model,
    trace: run.trace,
  };
}
