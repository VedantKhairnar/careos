"use client";

import { Badge, Card, CardSkeleton, EmptyState, ErrorState } from "@/components/ui";
import { RxBadge } from "@/components/rx";
import { RxActions } from "@/components/RxActions";
import type { PrescriptionSummary } from "@/server/services";
import { patientName } from "@/lib/demoPatients";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/useApi";

export default function PrescriptionsPage() {
  const { data, loading, error, reload } = useApi<PrescriptionSummary[]>("/api/prescriptions", { pollMs: 5000 });
  return (
    <>
      <h1 className="text-2xl font-bold">Prescriptions</h1>
      {loading && <CardSkeleton rows={4} />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {data && data.length === 0 && <EmptyState title="No prescriptions yet" />}
      <ul className="space-y-3">
        {data?.map((r) => (
          <li key={r.workflowId}>
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-semibold">{r.medicationReference}</p>
                  <p className="text-sm text-muted">
                    {patientName(r.patientId)} · updated {timeAgo(r.lastUpdated)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {r.simulated && <Badge tone="info">Simulated</Badge>}
                  <RxBadge state={r.state} />
                </div>
              </div>
              <p className="mt-2 text-sm">{r.text}</p>
              <div className="mt-3">
                <RxActions workflowId={r.workflowId} state={r.state} onDone={reload} />
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
