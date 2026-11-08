import { randomUUID } from "node:crypto";
import type { AgentSpec } from "./runner";
import { endRun, logStep, startRun } from "./runLog";

type OnStep = NonNullable<AgentSpec["onStep"]>;

/**
 * Puts any agent run on the live log: it starts a run, records every model call and tool call as it happens,
 * and closes the run (finished or failed). Used for the patient assistant and the doctor agents; the Care
 * Coordinator logs richer steps of its own.
 */
export async function loggedRun<T>(
  meta: { agent: string; trigger: string; patientId: string; workflowId?: string; start: string },
  fn: (onStep: OnStep, runId: string) => Promise<T>,
  finish: (r: T) => string,
): Promise<T> {
  const runId = randomUUID();
  startRun({ runId, trigger: meta.trigger, workflowId: meta.workflowId ?? "-", patientId: meta.patientId });
  logStep(runId, { agent: meta.agent, kind: "start", title: meta.start });
  const onStep: OnStep = (s) => {
    if (s.kind === "model") logStep(runId, { agent: meta.agent, kind: "think", title: "Gemini call", detail: [s.text, s.detail].filter(Boolean).join(" · "), ms: s.ms, ok: true });
    else if (s.kind === "blocked") logStep(runId, { agent: meta.agent, kind: "blocked", title: s.name, detail: s.detail, ms: s.ms, ok: false });
    else logStep(runId, { agent: meta.agent, kind: "tool", title: s.name, detail: `args: ${JSON.stringify(s.args ?? {})}\nresult: ${s.detail}`, ms: s.ms, ok: true });
  };
  try {
    const r = await fn(onStep, runId);
    logStep(runId, { agent: meta.agent, kind: "decision", title: "Answered", detail: finish(r), ok: true });
    endRun(runId, "done");
    return r;
  } catch (err) {
    logStep(runId, { agent: meta.agent, kind: "error", title: "Run stopped", detail: err instanceof Error ? err.message : "failed", ok: false });
    endRun(runId, "failed");
    throw err;
  }
}
