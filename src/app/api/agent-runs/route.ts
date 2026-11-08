import { listRuns, type RunRecord } from "@/agents/runLog";
import { ok, requireSession, route } from "@/server/http";
import { toActor } from "@/server/session";
import { listSuggestions } from "@/server/suggestions";

/** The live log of agent runs. Runs from before a restart are rebuilt from the drafts they produced. */
export const GET = route(async (req) => {
  const session = requireSession(req, ["clinician", "demo_operator"]);
  const actor = toActor(session);
  const live = listRuns();
  const known = new Set(live.map((r) => r.runId));
  const saved: RunRecord[] = (session.role !== "clinician" ? [] : await listSuggestions(actor))
    .filter((s) => s.runId && !known.has(s.runId))
    .map((s) => ({ runId: s.runId, trigger: s.trigger, workflowId: s.workflowId, patientId: s.patientId, startedAt: s.log[0]?.at ?? s.createdAt, endedAt: s.reviewedAt ?? undefined, status: s.status === "pending" ? "awaiting_human" : "done", entries: s.log }));
  return ok([...live, ...saved].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 15));
});
