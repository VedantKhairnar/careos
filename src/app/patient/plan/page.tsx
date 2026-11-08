"use client";

import { LifeBuoy } from "lucide-react";
import { Badge, Card, CardSkeleton, EmptyState, ErrorState, SourceDetails } from "@/components/ui";
import type { CarePlanView } from "@/server/carePlans";
import { formatDate } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import { BRAND } from "@/lib/brand";

export default function PlanPage() {
  const { data, loading, error, reload } = useApi<CarePlanView[]>("/api/care-plans");

  return (
    <>
      <h1 className="text-2xl font-bold">My care plan</h1>
      <p className="text-sm text-muted">Only plans your clinician has reviewed and approved are shown here.</p>

      {loading && <CardSkeleton rows={5} />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {data && data.length === 0 && <EmptyState title="No approved care plan yet" hint="You will be notified when your clinician approves one." />}

      {data?.map((p) => (
        <Card
          key={p.planId}
          title={p.content.title}
          action={<Badge tone="success">Approved{p.approvedAt ? ` ${formatDate(p.approvedAt)}` : ""}</Badge>}
        >
          <p className="text-sm text-muted">{p.content.summary}</p>

          {p.content.instructions.length > 0 && (
            <>
              <h3 className="mt-4 font-semibold">What to do</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {p.content.instructions.map((i, k) => (
                  <li key={k}>{i}</li>
                ))}
              </ul>
            </>
          )}

          {p.content.medications.length > 0 && (
            <>
              <h3 className="mt-4 font-semibold">Medicines in this plan</h3>
              <ul className="mt-1 space-y-1">
                {p.content.medications.map((m, k) => (
                  <li key={k}>
                    <strong>{m.name}</strong>
                    {m.dose && m.times?.length ? `: ${m.dose} at ${m.times.join(", ")}` : ": schedule to be confirmed by your care team"}
                  </li>
                ))}
              </ul>
            </>
          )}

          {p.content.warningSigns.length > 0 && (
            <div className="mt-4 rounded-xl bg-info-bg p-3 text-info">
              <p className="flex items-center gap-2 font-semibold">
                <LifeBuoy aria-hidden className="h-4 w-4" /> When to get help
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {p.content.warningSigns.map((w, k) => (
                  <li key={k}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <SourceDetails source={p.source} />
        </Card>
      ))}

      <p className="rounded-xl bg-surface-2 p-3 text-sm">
        <strong>In an emergency, call your local emergency number.</strong> {BRAND.name} does not assess symptoms and cannot replace medical care.
      </p>
    </>
  );
}
