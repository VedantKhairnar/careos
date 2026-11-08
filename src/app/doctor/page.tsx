"use client";

import Link from "next/link";
import { GAP_LABEL, RxBadge } from "@/components/rx";
import { RxActions } from "@/components/RxActions";
import { QuestionsCard } from "@/components/doctorAi";
import { Badge, Card, CardSkeleton, EmptyState, ErrorState } from "@/components/ui";
import type { CareGap } from "@/domain/careGap";
import type { CarePlanView } from "@/server/carePlans";
import type { PrescriptionSummary } from "@/server/services";
import { patientName } from "@/lib/demoPatients";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/useApi";

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "warning" }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className={`text-3xl font-bold ${tone === "warning" && Number(value) > 0 ? "text-warning" : ""}`}>{value}</p>
      <p className="mt-1 text-sm text-muted">{label}</p>
    </div>
  );
}

export default function DoctorOverview() {
  const patients = useApi<{ id: string }[]>("/api/patients", { pollMs: 8000 });
  const rx = useApi<PrescriptionSummary[]>("/api/prescriptions", { pollMs: 5000 });
  const plans = useApi<CarePlanView[]>("/api/care-plans", { pollMs: 8000 });
  const gaps = useApi<{ gaps: CareGap[] }>("/api/care-gaps", { pollMs: 5000 });

  const loading = patients.loading || rx.loading || plans.loading || gaps.loading;
  const error = patients.error ?? rx.error ?? plans.error ?? gaps.error;
  const pending = (plans.data ?? []).filter((p) => p.state === "PENDING_REVIEW");
  const questions = (rx.data ?? []).filter((r) => r.state === "CLARIFICATION_REQUIRED");
  const delayed = (rx.data ?? []).filter((r) => r.state === "DELAYED");
  const openGaps = gaps.data?.gaps ?? [];
  const reloadAll = () => {
    void rx.reload();
    void gaps.reload();
  };

  return (
    <>
      <h1 className="text-2xl font-bold">Overview</h1>

      {error && <ErrorState message={error.message} onRetry={() => { void patients.reload(); void rx.reload(); void plans.reload(); void gaps.reload(); }} />}

      {loading ? (
        <CardSkeleton rows={2} />
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Stat label="Patients" value={patients.data?.length ?? 0} />
          <Stat label="Plans awaiting your approval" value={pending.length} tone="warning" />
          <Stat label="Pharmacy questions waiting" value={questions.length} tone="warning" />
          <Stat label="Delayed prescriptions" value={delayed.length} tone="warning" />
          <Stat label="Open care gaps" value={openGaps.length} tone="warning" />
        </div>
      )}

      <QuestionsCard />

      <Card title="Needs your attention">
        {loading ? (
          <CardSkeleton rows={3} />
        ) : pending.length + questions.length + delayed.length + openGaps.length === 0 ? (
          <EmptyState title="Nothing is waiting on you" hint="New items appear here as plans are drafted and pharmacies respond." />
        ) : (
          <ul className="space-y-3">
            {pending.map((p) => (
              <li key={p.planId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3">
                <div>
                  <p className="font-medium">{p.content.title}</p>
                  <p className="text-sm text-muted">{patientName(p.patientId)} · awaiting your approval</p>
                </div>
                <Link href={`/doctor/patients/${p.patientId}`} className="inline-flex min-h-11 items-center rounded-xl bg-accent px-4 text-sm font-semibold text-accent-ink">
                  Review
                </Link>
              </li>
            ))}
            {[...questions, ...delayed].map((r) => (
              <li key={r.workflowId} className="rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-medium">{r.medicationReference}</p>
                    <p className="text-sm text-muted">{patientName(r.patientId)} · {r.text}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {r.simulated && <Badge tone="info">Simulated</Badge>}
                    <RxBadge state={r.state} />
                  </div>
                </div>
                <div className="mt-3">
                  <RxActions workflowId={r.workflowId} state={r.state} onDone={reloadAll} />
                </div>
              </li>
            ))}
            {openGaps.map((g) => (
              <li key={g.key} className="rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{GAP_LABEL[g.rule] ?? g.rule}</p>
                  <Badge tone="warning">{g.responsible === "clinician" ? "Waiting on you" : "Waiting on patient"}</Badge>
                </div>
                <p className="text-sm text-muted">
                  {patientName(g.patientId)}
                  {(rx.data ?? []).find((r) => r.workflowId === g.workflowId) ? ` · ${(rx.data ?? []).find((r) => r.workflowId === g.workflowId)!.medicationReference}` : ""} · {g.description} · since {timeAgo(g.sinceAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
