import { listRuns, type LogEntry, type RunRecord } from "@/agents/runLog";
import type { Actor, CareEvent } from "@/domain/events";
import { patientName } from "@/lib/demoPatients";
import { HttpError } from "./http";
import { runtime } from "./runtime";
import { listSuggestions } from "./suggestions";

/**
 * One timeline of everything that happened: what people did (doctor, patient, pharmacy) and what the system and the
 * agents did. The people-and-system lines come straight from the recorded events (the audit trail), so they are
 * complete and survive a restart. Agent lines come from the live agent log.
 */
type Line = Omit<LogEntry, "n">;

const PHARMACY: Record<string, string> = {
  "prescription.received": "Received the prescription",
  "prescription.acknowledged": "Acknowledged it",
  "prescription.processing": "Started preparing it",
  "prescription.delayed": "Reported a delay",
  "prescription.clarification_requested": "Asked the doctor a question",
  "prescription.ready": "Marked it ready for pickup",
  "prescription.picked_up": "Confirmed the pickup",
  "prescription.rejected": "Could not fill the prescription",
};
const METRIC: Record<string, string> = { heart_rate: "heart rate", blood_pressure: "blood pressure", pain_score: "pain score", temperature: "temperature" };

function line(e: CareEvent, meds: Map<string, string>, planTitles: Map<string, string>): Line | null {
  const at = e.recordedAt;
  const med = meds.get(e.workflowId) ?? "a prescription";
  const who = patientName(e.patientId);
  const human = (agent: "doctor" | "patient" | "pharmacy", title: string, detail?: string): Line => ({ at, agent, kind: "human", title, detail, ok: true });
  const system = (title: string, detail?: string): Line => ({ at, agent: "orchestrator", kind: "system", title, detail, ok: true });
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "care_plan.submitted":
      return e.actorRole === "agent" ? null : human("doctor", "Wrote a care plan", String((p.content as { title?: string } | undefined)?.title ?? ""));
    case "care_plan.approved":
      return human("doctor", "Approved the care plan", `${planTitles.get(e.workflowId) ?? "Care plan"} for ${who}. The patient can see it now.`);
    case "prescription.authorized":
      return human("doctor", "Authorized a prescription", `${med} for ${who}`);
    case "prescription.transmitted":
      return system("Sent the prescription to the pharmacy (simulated)", med);
    case "prescription.clarification_resolved":
      return human("doctor", "Answered the pharmacy's question", med);
    case "prescription.cancelled":
      return human("doctor", "Cancelled a prescription", med);
    case "prescription.pickup_reported":
      return human("patient", "Said they picked it up (not confirmed by the pharmacy)", med);
    case "prescription.failed":
      return { at, agent: "orchestrator", kind: "system", title: "Sending to the pharmacy failed", detail: med, ok: false };
    case "followup.completed":
      return human("doctor", "Logged a follow-up", med);
    case "task.confirmed":
      return human("patient", "Confirmed a task");
    case "notification.sent":
      return system("Told the patient", p.kind === "care_team_message" ? "A message from the care team (approved by the doctor)" : String(p.kind ?? "an update").replace("prescription.", "pharmacy: ").replace(/_/g, " "));
    case "notification.acknowledged":
      return human(e.actorRole === "clinician" ? "doctor" : "patient", "Marked an update as seen");
    case "dose.reported":
      return human("patient", `Reported a dose: ${String(p.response ?? "").replace("_", " ")}`, String(p.medicationName ?? ""));
    case "question.asked":
      return human("patient", "Asked the care team a question", `${String(p.question ?? "")}${p.via === "assistant" ? " (sent by the assistant)" : ""}`);
    case "question.answered":
      return human("doctor", "Answered the patient's question");
    case "reading.recorded":
      return human("patient", "Added a home reading", `${METRIC[String(p.metric)] ?? String(p.metric)}: ${String(p.value)}${p.value2 !== undefined ? `/${String(p.value2)}` : ""}`);
    case "reading.threshold_set":
      return human("doctor", "Set a range to watch", `${METRIC[String(p.metric)] ?? String(p.metric)}${p.min !== undefined ? `, from ${String(p.min)}` : ""}${p.max !== undefined ? `, up to ${String(p.max)}` : ""}`);
    case "gap.resolved":
      return system("Closed a care gap");
    default:
      if (PHARMACY[e.type]) return human("pharmacy", PHARMACY[e.type], med);
      return null; // agent suggestion events are already shown by the agent log
  }
}

export async function listActivity(actor: Actor, role: "clinician" | "demo_operator"): Promise<{ entries: LogEntry[]; running: boolean }> {
  if (actor.role !== "clinician" && actor.role !== "pharmacy_sim") throw new HttpError(403, "forbidden", "Not allowed");
  const events = (await runtime().store.listAll()).filter((e) => e.sourceSystem !== "synthetic-history");
  const meds = new Map<string, string>();
  const planTitles = new Map<string, string>();
  for (const e of events) {
    if (e.type === "prescription.authorized") meds.set(e.workflowId, String(e.payload.medicationReference ?? "a prescription"));
    if (e.type === "care_plan.submitted") planTitles.set(e.workflowId, String((e.payload.content as { title?: string } | undefined)?.title ?? "Care plan"));
  }
  const fromEvents = events.map((e) => line(e, meds, planTitles)).filter((x): x is Line => x !== null);

  const live = listRuns();
  const known = new Set(live.map((r) => r.runId));
  const saved: RunRecord[] =
    role !== "clinician"
      ? []
      : (await listSuggestions(actor)).filter((s) => s.runId && !known.has(s.runId)).map((s) => ({ runId: s.runId, trigger: s.trigger, workflowId: s.workflowId, patientId: s.patientId, startedAt: s.log[0]?.at ?? s.createdAt, status: "done" as const, entries: s.log }));
  // The clinician's decision on a draft is already a recorded event, so it is not shown twice.
  const fromAgents: Line[] = [...live, ...saved].flatMap((r) => r.entries).filter((e) => e.agent !== "clinician").map((e) => ({ at: e.at, agent: e.agent, kind: e.kind, title: e.title, detail: e.detail, ms: e.ms, ok: e.ok }));

  const merged = [...fromEvents, ...fromAgents].sort((a, b) => a.at.localeCompare(b.at)).slice(-160);
  return { entries: merged.map((l, i) => ({ ...l, n: i + 1 })), running: live.some((r) => r.status === "running") };
}
