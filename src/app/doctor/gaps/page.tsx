"use client";

import { GAP_LABEL } from "@/components/rx";
import { RxActions } from "@/components/RxActions";
import { Badge, Card, CardSkeleton, EmptyState, ErrorState } from "@/components/ui";
import type { CareGap } from "@/domain/careGap";
import type { PrescriptionSummary } from "@/server/services";
import { patientName } from "@/lib/demoPatients";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/useApi";

export default function GapsPage() {
  const gaps = useApi<{ gaps: CareGap[] }>("/api/care-gaps", { pollMs: 5000 });
  const rx = useApi<PrescriptionSummary[]>("/api/prescriptions", { pollMs: 5000 });
  const list = gaps.data?.gaps ?? [];

  return (
    <>
      <h1 className="text-2xl font-bold">Care gaps</h1>
      <p className="text-sm text-muted">
        A care gap means an expected step has not been recorded by its deadline. It is an administrative flag, not a clinical finding. Gaps close on their own when the missing step is recorded. Deadlines here are demonstration settings.
      </p>

      {gaps.loading && <CardSkeleton rows={3} />}
      {gaps.error && <ErrorState message={gaps.error.message} onRetry={gaps.reload} />}
      {gaps.data && list.length === 0 && <EmptyState title="No open gaps" hint="Everything expected so far has been recorded on time." />}

      <ul className="space-y-3">
        {list.map((g) => {
          const state = rx.data?.find((r) => r.workflowId === g.workflowId)?.state;
          return (
            <li key={g.key}>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">{GAP_LABEL[g.rule] ?? g.rule}</p>
                  <Badge tone="warning">{g.responsible === "clinician" ? "Waiting on you" : "Waiting on patient"}</Badge>
                </div>
                <p className="mt-1 text-sm">{g.description}</p>
                <p className="text-sm text-muted">
                  {patientName(g.patientId)}
                  {rx.data?.find((r) => r.workflowId === g.workflowId) ? ` · ${rx.data.find((r) => r.workflowId === g.workflowId)!.medicationReference}` : ""} · since {timeAgo(g.sinceAt)}
                </p>
                {state && (g.rule === "delay_unaddressed" || g.rule === "clarification_unresolved") && (
                  <div className="mt-3">
                    <RxActions workflowId={g.workflowId} state={state} onDone={() => { void gaps.reload(); void rx.reload(); }} />
                  </div>
                )}
                {g.rule === "pharmacy_ack_overdue" && <p className="mt-2 text-sm text-muted">Waiting on the pharmacy to acknowledge. Nothing for you to record yet.</p>}
              </Card>
            </li>
          );
        })}
      </ul>
    </>
  );
}
