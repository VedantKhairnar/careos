/**
 * The live log of what the agents are doing. Kept in memory per server process (it is a window onto what is
 * happening now); the finished log of each run is also saved inside the draft it produced, so it survives restarts.
 */
export type LogKind = "start" | "think" | "tool" | "handoff" | "review" | "blocked" | "decision" | "gate" | "human" | "system" | "error";

export interface LogEntry {
  n: number;
  at: string;
  agent: string;
  kind: LogKind;
  title: string;
  detail?: string;
  ms?: number;
  ok?: boolean;
}

export interface RunRecord {
  runId: string;
  trigger: string;
  workflowId: string;
  patientId: string;
  startedAt: string;
  endedAt?: string;
  status: "running" | "awaiting_human" | "done" | "failed";
  entries: LogEntry[];
}

const KEY = Symbol.for("careos.runlog");
type G = typeof globalThis & { [KEY]?: RunRecord[] };
const runs = (): RunRecord[] => ((globalThis as G)[KEY] ??= []);
const MAX_RUNS = 30;

export function startRun(r: { runId: string; trigger: string; workflowId: string; patientId: string }): RunRecord {
  const rec: RunRecord = { ...r, startedAt: new Date().toISOString(), status: "running", entries: [] };
  runs().unshift(rec);
  runs().length = Math.min(runs().length, MAX_RUNS);
  return rec;
}

export function logStep(runId: string, e: Omit<LogEntry, "n" | "at">): void {
  const rec = runs().find((r) => r.runId === runId);
  if (!rec) return;
  rec.entries.push({ ...e, n: rec.entries.length + 1, at: new Date().toISOString(), detail: e.detail?.slice(0, 600) });
}

export function endRun(runId: string, status: RunRecord["status"]): void {
  const rec = runs().find((r) => r.runId === runId);
  if (rec) {
    if (rec.status === "done" && status === "awaiting_human") return; // the clinician already decided
    rec.status = status;
    if (status !== "awaiting_human") rec.endedAt = new Date().toISOString();
  }
}

export const listRuns = (): RunRecord[] => runs().map((r) => ({ ...r, entries: [...r.entries] }));
export const clearRuns = (): void => {
  runs().length = 0;
};
