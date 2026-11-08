import type { LogEntry } from "@/agents/runLog";
import { BRAND } from "@/lib/brand";

const AGENT: Record<string, { label: string; cls: string }> = {
  coordinator: { label: "Coordinator", cls: "bg-info-bg text-info" },
  writer: { label: "Writer", cls: "bg-surface-2 text-ink" },
  reviewer: { label: "Safety Reviewer", cls: "bg-warning-bg text-warning" },
  "safety-check": { label: "Code check", cls: "bg-warning-bg text-warning" },
  "patient-assistant": { label: "Patient assistant", cls: "bg-info-bg text-info" },
  explainer: { label: "Visit explainer", cls: "bg-info-bg text-info" },
  "doctor-agent": { label: "Doctor agent", cls: "bg-info-bg text-info" },
  clinician: { label: "Clinician", cls: "bg-success-bg text-success" },
  doctor: { label: "Doctor", cls: "bg-success-bg text-success" },
  patient: { label: "Patient", cls: "bg-success-bg text-success" },
  pharmacy: { label: "Pharmacy (simulated)", cls: "bg-warning-bg text-warning" },
  orchestrator: { label: `${BRAND.name} (code)`, cls: "bg-surface-2 text-ink" },
};
const KIND: Record<string, string> = { start: "WAKE", think: "THINK", tool: "TOOL", handoff: "HANDOFF", review: "REVIEW", blocked: "BLOCKED", decision: "DECIDE", gate: "WAIT", human: "HUMAN", system: "SYSTEM", error: "ERROR" };

const t = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** A real, timestamped log of what the agents did. Every line is something that actually happened. */
export function LogView({ entries }: { entries: LogEntry[] }) {
  return (
    <ol className="space-y-1.5 font-mono text-xs" aria-label="Activity log">
      {entries.map((e, i) => {
        const a = AGENT[e.agent] ?? { label: e.agent, cls: "bg-surface-2 text-ink" };
        const bad = e.ok === false || e.kind === "blocked" || e.kind === "error";
        return (
          <li key={`${e.at}|${e.agent}|${e.n}|${i}`} className="rounded-lg border border-line bg-surface p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted">{t(e.at)}</span>
              <span className={`rounded px-1.5 py-0.5 font-sans text-[11px] font-semibold ${a.cls}`}>{a.label}</span>
              <span className={`font-semibold ${bad ? "text-danger" : ""}`}>{KIND[e.kind] ?? e.kind}</span>
              <span className={bad ? "text-danger" : ""}>{e.title}</span>
              {e.ms !== undefined && <span className="text-muted">{e.ms} ms</span>}
            </div>
            {e.detail && <p className="mt-1 whitespace-pre-wrap break-words pl-1 text-muted">{e.detail}</p>}
          </li>
        );
      })}
    </ol>
  );
}
