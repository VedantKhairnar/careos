import { z } from "zod";
import type { Actor } from "@/domain/events";
import { prescriptionStatus } from "@/domain/status";
import { HttpError } from "@/server/http";
import { runtime } from "@/server/runtime";
import { AiUnavailable, getModel } from "./model";

export const PHARMACY_SYSTEM = `You help coordinate prescription fulfilment by turning a verified event history into plain summaries. You are shown the events; you cannot call any tools and you cannot change anything.

HARD RULES
1. Use ONLY the events provided. Never state inventory, stock, quantities, prices or time estimates that are not in them.
2. Never say a prescription is ready or picked up unless the current state says so.
3. Never suggest substituting a medicine, changing a prescription, or any clinical action.
4. Events marked simulated are demonstration data; say so in the clinician summary.
5. If you do not know something, list it under missingInformation instead of guessing.
6. patientMessage: two or three plain sentences a patient would understand. clinicianSummary: one short paragraph.`;

const Output = z.object({
  patientMessage: z.string().min(1).max(600),
  clinicianSummary: z.string().min(1).max(900),
  missingInformation: z.array(z.string().max(200)).max(6).default([]),
});
export type PharmacyDraft = z.infer<typeof Output> & { state: string; model: string; draftOnly: true };

/**
 * Read-only by construction: the agent gets the event history as context and returns two drafts. It has no
 * tool that writes, so it cannot move a workflow or manufacture a confirmation. A human sends anything.
 */
export async function summarizeFulfilment(actor: Actor, workflowId: string): Promise<PharmacyDraft> {
  if (actor.role !== "clinician" && actor.role !== "pharmacy_sim") throw new HttpError(403, "forbidden", "Not allowed");
  const events = await runtime().store.listByWorkflow(workflowId);
  if (!events.some((e) => e.type === "prescription.authorized")) throw new HttpError(404, "not_found", "Prescription not found");

  const status = prescriptionStatus(events);
  const context = {
    currentState: status.state,
    medication: String(events.find((e) => e.type === "prescription.authorized")?.payload.medicationReference ?? "unknown"),
    events: status.timeline.map((t) => ({ what: t.label, at: t.at, by: t.source.actorRole, verification: t.source.verification, simulated: t.source.simulated })),
  };
  const schema = z.toJSONSchema(Output) as Record<string, unknown>;
  delete schema.$schema;

  const startedAt = new Date().toISOString();
  const res = await getModel().generate({
    system: PHARMACY_SYSTEM,
    contents: [{ role: "user", parts: [{ text: `Verified prescription history:\n${JSON.stringify(context, null, 2)}` }] }],
    responseJsonSchema: schema,
    maxOutputTokens: 700,
  });
  await runtime().store.logAgentExecution({ agent: "pharmacy", patientId: events[0].patientId, startedAt, durationMs: res.latencyMs, ok: true, tool: "summarize_fulfilment", model: res.model, inputTokens: res.usage.input, outputTokens: res.usage.output });

  let parsed;
  try {
    parsed = Output.safeParse(JSON.parse(res.text));
  } catch {
    parsed = null;
  }
  if (!parsed?.success) throw new AiUnavailable("bad_output", "The summary could not be read. Please try again.");
  return { ...parsed.data, state: status.state, model: res.model, draftOnly: true };
}
