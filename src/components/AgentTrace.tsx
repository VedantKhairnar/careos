import { Cpu, Wrench } from "lucide-react";
import type { TraceStep } from "@/agents/runner";

/** What an agent actually did, step by step. Real model and tool calls, with real timings. */
/** `labels` maps internal tool names to plain words, for screens a patient sees. Without it the raw names are shown. */
export function AgentTrace({ steps, label = "How the assistant worked this out", labels }: { steps: TraceStep[]; label?: string; labels?: Record<string, string> }) {
  if (steps.length === 0) return null;
  const total = steps.reduce((n, s) => n + s.ms, 0);
  return (
    <details className="mt-2 rounded-lg border border-line bg-surface text-xs">
      <summary className="cursor-pointer select-none px-2 py-1.5 font-medium text-muted">
        {label} · {steps.length} steps · {total} ms
      </summary>
      <ol className="space-y-1 px-2 pb-2 pt-1">
        {steps.map((s, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2">
            {s.kind === "model" ? <Cpu aria-hidden className="h-3.5 w-3.5 shrink-0" /> : <Wrench aria-hidden className="h-3.5 w-3.5 shrink-0" />}
            <span className="font-medium">{s.kind === "model" ? (labels ? "Thinking" : "Gemini call") : labels ? "Checked" : "Tool"}</span>
            {labels && s.kind === "tool" ? <span>{labels[s.name] ?? "looked up your records"}</span> : <code>{labels && s.kind === "model" ? "AI model" : s.name}</code>}
            <span className={s.ok ? "text-muted" : "text-danger"}>{s.ok ? `${s.ms} ms` : labels ? "could not do that" : `refused: ${s.detail ?? "failed"}`}</span>
            {s.ok && s.detail && !labels && <span className="text-muted">· {s.detail}</span>}
          </li>
        ))}
      </ol>
    </details>
  );
}
