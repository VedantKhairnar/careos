"use client";

import { DoseRow } from "@/components/DoseRow";
import { Badge, Card, CardSkeleton, EmptyState, ErrorState } from "@/components/ui";
import type { CarePlanView } from "@/server/carePlans";
import type { MedicationView } from "@/server/patientCare";
import { formatDate } from "@/lib/format";
import { useApi } from "@/lib/useApi";

export default function MedicationsPage() {
  const meds = useApi<{ timezone: string; medications: MedicationView[] }>("/api/medications", { pollMs: 15000 });
  const plans = useApi<CarePlanView[]>("/api/care-plans");
  const title = (id: string) => plans.data?.find((p) => p.planId === id)?.content.title ?? "Care plan";

  return (
    <>
      <h1 className="text-2xl font-bold">Medications</h1>
      <p className="text-sm text-muted">
        Doses and times come from your approved care plan. What you tell us about taking a dose is recorded as <em>reported by you</em>, not as verified by a clinician.
      </p>

      {meds.loading && <CardSkeleton rows={4} />}
      {meds.error && <ErrorState message={meds.error.message} onRetry={meds.reload} />}
      {meds.data && meds.data.medications.length === 0 && <EmptyState title="No medicines yet" hint="They appear after your care team approves a plan." />}

      {meds.data?.medications.map((m) => (
        <Card
          key={m.planId + m.name}
          title={m.name}
          action={m.schedule === "ready" ? <Badge tone="success">Schedule approved</Badge> : <Badge tone="warning">Schedule not confirmed</Badge>}
        >
          <p className="text-sm text-muted">
            {m.dose ? `Dose: ${m.dose}. ` : ""}From: {title(m.planId)}
            {m.source.approvedAt ? `. Approved ${formatDate(m.source.approvedAt)}` : ""}
          </p>
          {m.notes && <p className="mt-1 text-sm">{m.notes}</p>}

          {m.schedule === "needs_clarification" ? (
            <p className="mt-3 rounded-xl bg-warning-bg p-3 text-sm text-warning">
              Your care team still needs to confirm: <strong>{m.missing.join(", ")}</strong>. We do not show reminders until they do, and we will not guess.
            </p>
          ) : m.doses.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No doses in the next day and a half.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {m.doses.map((d) => (
                <DoseRow key={d.scheduledFor} dose={d} doseLabel={m.dose} onChanged={meds.reload} />
              ))}
            </ul>
          )}
        </Card>
      ))}

      {meds.data && <p className="text-xs text-muted">Times: {meds.data.timezone}</p>}
    </>
  );
}
