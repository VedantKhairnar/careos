"use client";

import { AlertTriangle, Bot, Check, Circle, Loader2 } from "lucide-react";
import Link from "next/link";
import type { VisitView } from "@/server/visit";
import { formatDate, timeAgo } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import { Badge, Card, CardSkeleton, EmptyState, ErrorState } from "./ui";

/**
 * "My last visit" at a glance: one status bar for the whole journey (plan, prescription, pharmacy, pickup),
 * what is happening now, what is next, and what the assistants did. Replaces hunting across pages.
 */
export function VisitStatus({ patientId, timeline = true }: { patientId?: string; timeline?: boolean }) {
  const v = useApi<VisitView | null>(`/api/visit${patientId ? `?patientId=${patientId}` : ""}`, { pollMs: 4000 });
  if (v.loading) return <CardSkeleton rows={3} />;
  if (v.error) return <ErrorState message={v.error.message} onRetry={v.reload} />;
  if (!v.data)
    return (
      <Card title={patientId ? "Last visit" : "Your last visit"}>
        <EmptyState title="No visit recorded yet" hint={patientId ? "Once a care plan is approved, the visit journey appears here." : "After your doctor approves your care plan, you will follow its progress here."} />
      </Card>
    );
  const d = v.data;
  const pct = Math.round((d.progress.done / d.progress.total) * 100);
  const hasProblem = d.steps.some((s) => s.state === "problem");

  return (
    <Card title={patientId ? "Last visit" : "Your last visit"}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-lg font-semibold">{d.planTitle}</p>
          <p className="text-sm text-muted">
            Plan approved {formatDate(d.approvedAt)} · updated {timeAgo(d.updatedAt)}
            {d.medicines.length ? ` · ${d.medicines.join(", ")}` : ""}
          </p>
        </div>
        {d.prescription?.simulated && <Badge tone="info">Simulated pharmacy</Badge>}
      </div>

      <div className="mt-3" role="progressbar" aria-valuemin={0} aria-valuemax={d.progress.total} aria-valuenow={d.progress.done} aria-label={`Visit progress: ${d.progress.done} of ${d.progress.total} steps done`}>
        <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
          <div className={`h-full rounded-full transition-all ${hasProblem ? "bg-warning" : "bg-accent"}`} style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1 text-xs text-muted">
          {d.progress.done} of {d.progress.total} steps done
        </p>
      </div>

      <ol className="mt-3 space-y-2">
        {d.steps.map((s) => (
          <li key={s.key} className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0" aria-hidden>
              {s.state === "done" ? <Check className="h-5 w-5 rounded-full bg-success-bg p-0.5 text-success" /> : s.state === "problem" ? <AlertTriangle className="h-5 w-5 text-warning" /> : s.state === "current" ? <Loader2 className="h-5 w-5 animate-spin text-accent" /> : <Circle className="h-5 w-5 text-muted" />}
            </span>
            <span className="min-w-0">
              <span className={`text-sm ${s.state === "upcoming" ? "text-muted" : "font-medium"} ${s.state === "problem" ? "text-warning" : ""}`}>
                {s.label}
                <span className="sr-only"> ({s.state === "done" ? "done" : s.state === "problem" ? "needs attention" : s.state === "current" ? "in progress" : "not yet"})</span>
              </span>
              <span className="block text-xs text-muted">{s.at ? `${new Date(s.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : (s.note ?? (s.state === "current" ? "Waiting" : ""))}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className={`mt-3 rounded-xl p-3 text-sm ${hasProblem ? "bg-warning-bg text-warning" : "bg-info-bg text-info"}`}>
        <p className="font-semibold">{d.headline}</p>
        <p className="mt-0.5">
          <span className="font-medium">What is next:</span> {d.next}
        </p>
        {d.openQuestions > 0 && <p className="mt-0.5">{d.openQuestions} question{d.openQuestions > 1 ? "s" : ""} waiting for your care team.</p>}
      </div>

      {d.agentNotes.length > 0 && (
        <div className="mt-3">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <Bot aria-hidden className="h-4 w-4" /> What the assistants did
          </p>
          <ul className="mt-1 space-y-1.5">
            {d.agentNotes.map((n, i) => (
              <li key={i} className="text-sm">
                {n.text} <span className="text-xs text-muted">{timeAgo(n.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {timeline && !patientId && (
        <Link href="/patient/timeline" className="mt-3 inline-block text-sm text-accent underline">
          See the full timeline
        </Link>
      )}
    </Card>
  );
}
