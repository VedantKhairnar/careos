import { createHash, randomUUID } from "node:crypto";
import type { Actor, CareEvent } from "@/domain/events";
import { HttpError } from "./http";
import { runtime } from "./runtime";
import { envelope, submit } from "./services";

const isPatientSide = (a: Actor) => a.role === "patient" || a.role === "caregiver";

export interface QuestionView {
  id: string;
  patientId: string;
  question: string;
  /** "assistant" means the patient's AI assistant raised it because the approved plan did not answer it. */
  askedVia: "patient" | "assistant";
  askedAt: string;
  status: "open" | "answered";
  answer: string | null;
  answeredAt: string | null;
  answeredBy: string | null;
}

function toView(events: CareEvent[]): QuestionView {
  const asked = events.find((e) => e.type === "question.asked")!;
  const answered = events.find((e) => e.type === "question.answered");
  return {
    id: asked.workflowId,
    patientId: asked.patientId,
    question: String(asked.payload.question ?? ""),
    askedVia: asked.payload.via === "assistant" ? "assistant" : "patient",
    askedAt: asked.recordedAt,
    status: answered ? "answered" : "open",
    answer: answered ? String(answered.payload.answer ?? "") : null,
    answeredAt: answered?.recordedAt ?? null,
    answeredBy: answered?.actorId ?? null,
  };
}

/** A question for the care team. It is recorded as patient-reported and only a clinician can answer it. */
export async function askQuestion(actor: Actor, text: string, via: "patient" | "assistant" = "patient"): Promise<QuestionView> {
  if (!isPatientSide(actor)) throw new HttpError(403, "forbidden", "Only a patient can ask the care team");
  const question = text.trim();
  if (!question) throw new HttpError(400, "validation_failed", "Please write your question");
  if (question.length > 1000) throw new HttpError(400, "validation_failed", "Please keep the question under 1000 characters");
  const id = `q_${createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16)}`;
  await submit(
    actor,
    envelope(actor, { workflowId: id, patientId: actor.patientId ?? "", type: "question.asked", idempotencyKey: `${id}:asked`, correlationId: `corr_${id}` }, { payload: { question, via } }),
  );
  return toView(await runtime().store.listByWorkflow(id));
}

export async function listQuestions(actor: Actor, patientId?: string): Promise<QuestionView[]> {
  let events: CareEvent[];
  if (isPatientSide(actor)) events = await runtime().store.listByPatient(actor.patientId ?? "");
  else if (actor.role === "clinician") events = patientId ? await runtime().store.listByPatient(patientId) : await runtime().store.listAll();
  else throw new HttpError(403, "forbidden", "Not allowed");
  const ids = [...new Set(events.filter((e) => e.type === "question.asked").map((e) => e.workflowId))];
  return ids.map((id) => toView(events.filter((e) => e.workflowId === id))).sort((a, b) => b.askedAt.localeCompare(a.askedAt));
}

export async function answerQuestion(actor: Actor, id: string, answer: string): Promise<QuestionView> {
  const events = await runtime().store.listByWorkflow(id);
  if (!events.some((e) => e.type === "question.asked")) throw new HttpError(404, "not_found", "Question not found");
  const text = answer.trim();
  if (!text) throw new HttpError(400, "validation_failed", "Please write an answer");
  await submit(
    actor,
    envelope(actor, { workflowId: id, patientId: events[0].patientId, type: "question.answered", idempotencyKey: `${id}:answered`, correlationId: `corr_${id}` }, { payload: { answer: text.slice(0, 2000) } }),
  );
  return toView(await runtime().store.listByWorkflow(id));
}
