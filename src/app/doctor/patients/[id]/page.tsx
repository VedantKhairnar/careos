"use client";

import { useParams } from "next/navigation";
import { CarePlanForm } from "@/components/CarePlanForm";
import { AiDraftPanel, AiSummaryCard, QuestionsCard } from "@/components/doctorAi";
import { PlanReview } from "@/components/PlanReview";
import { PrescriptionForm } from "@/components/PrescriptionForm";
import { VisitStatus } from "@/components/VisitStatus";
import { GAP_LABEL, RxBadge } from "@/components/rx";
import { RxActions } from "@/components/RxActions";
import { Badge, Card, CardSkeleton, EmptyState, ErrorState } from "@/components/ui";
import type { CareGap } from "@/domain/careGap";
import type { CarePlanView } from "@/server/carePlans";
import type { MedicationView } from "@/server/patientCare";
import type { PrescriptionSummary } from "@/server/services";
import { formatDate, formatTime } from "@/lib/format";
import { useApi } from "@/lib/useApi";

interface Summary {
  patient: { id: string; displayName: string; scenario: string };
  plans: CarePlanView[];
  prescriptions: PrescriptionSummary[];
  gaps: CareGap[];
}

const DOSE_LABEL: Record<string, string> = {
  scheduled: "Scheduled",
  taken: "Patient reported: taken",
  not_taken: "Patient reported: not taken",
  unsure: "Patient reported: unsure",
  unconfirmed: "No response (unconfirmed)",
};

export default function PatientDetail() {
  const { id } = useParams<{ id: string }>();
  const summary = useApi<Summary>(`/api/patients/${id}`, { pollMs: 5000 });
  const meds = useApi<{ medications: MedicationView[] }>(`/api/medications?patientId=${id}`, { pollMs: 10000 });

  if (summary.loading) return <CardSkeleton rows={6} />;
  if (summary.error) return <ErrorState message={summary.error.message} onRetry={summary.reload} />;
  const s = summary.data!;
  const medicineOf = (workflowId: string) => {
    const m = s.prescriptions.find((r) => r.workflowId === workflowId)?.medicationReference;
    return m ? ` Medicine: ${m}.` : "";
  };
  const reload = () => {
    void summary.reload();
    void meds.reload();
  };

  return (
    <>
      <div>
        <h1 className="text-2xl font-bold">{s.patient.displayName}</h1>
        <p className="text-sm text-muted">{s.patient.scenario}</p>
      </div>

      <VisitStatus patientId={id} />

      <Card title="Care plans">
        {s.plans.length === 0 && <EmptyState title="No care plans yet" />}
        <ul className="space-y-3">
          {s.plans.map((p) => (
            <li key={p.planId} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{p.content.title}</p>
                <div className="flex items-center gap-2">
                  {p.simulated && <Badge tone="info">Simulated</Badge>}
                  {p.state === "APPROVED" ? <Badge tone="success">Approved{p.approvedAt ? ` ${formatDate(p.approvedAt)}` : ""}</Badge> : <Badge tone="warning">Awaiting approval</Badge>}
                </div>
              </div>
              <p className="mt-1 text-sm text-muted">{p.content.summary}</p>
              {p.state === "PENDING_REVIEW" && <PlanReview plan={p} onDone={reload} />}
            </li>
          ))}
        </ul>
        <div className="mt-4 space-y-3">
          <AiDraftPanel patientId={s.patient.id} onCreated={reload} />
          <CarePlanForm patientId={s.patient.id} onCreated={reload} />
        </div>
      </Card>

      <AiSummaryCard patientId={s.patient.id} />

      <QuestionsCard patientId={s.patient.id} />

      <Card title="Prescriptions">
        {s.prescriptions.length === 0 && <EmptyState title="No prescriptions yet" />}
        <ul className="space-y-3">
          {s.prescriptions.map((r) => (
            <li key={r.workflowId} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{r.medicationReference}</p>
                <div className="flex items-center gap-2">
                  {r.simulated && <Badge tone="info">Simulated</Badge>}
                  <RxBadge state={r.state} />
                </div>
              </div>
              <p className="mt-1 text-sm text-muted">{r.text}</p>
              <div className="mt-3">
                <RxActions workflowId={r.workflowId} state={r.state} onDone={reload} />
              </div>
            </li>
          ))}
        </ul>
        <div className="mt-4">
          <PrescriptionForm patientId={s.patient.id} onCreated={reload} />
        </div>
      </Card>

      <Card title="Care gaps">
        <p className="mb-3 text-sm text-muted">Administrative only: an expected step has not been recorded by its deadline. These are not clinical findings.</p>
        {s.gaps.length === 0 ? (
          <EmptyState title="No open gaps" />
        ) : (
          <ul className="space-y-2">
            {s.gaps.map((g) => (
              <li key={g.key} className="rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{GAP_LABEL[g.rule] ?? g.rule}</p>
                  <Badge tone="warning">{g.responsible === "clinician" ? "Waiting on you" : "Waiting on patient"}</Badge>
                </div>
                <p className="text-sm text-muted">
                  {g.description}
                  {medicineOf(g.workflowId)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Medicine schedule and patient-reported doses">
        {meds.loading ? (
          <CardSkeleton rows={2} />
        ) : (meds.data?.medications ?? []).length === 0 ? (
          <EmptyState title="No approved medicines yet" />
        ) : (
          <ul className="space-y-3">
            {meds.data!.medications.map((m) => (
              <li key={m.planId + m.name} className="rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    {m.name}
                    {m.dose ? ` · ${m.dose}` : ""}
                  </p>
                  {m.schedule === "ready" ? <Badge tone="success">Schedule approved</Badge> : <Badge tone="warning">Needs clarification: {m.missing.join(", ")}</Badge>}
                </div>
                {m.doses.length > 0 && (
                  <ul className="mt-2 space-y-1 text-sm">
                    {m.doses.map((d) => (
                      <li key={d.scheduledFor} className="flex justify-between gap-2">
                        <span>{formatTime(d.scheduledFor)}</span>
                        <span className="text-muted">{DOSE_LABEL[d.status]}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">Dose answers are the patient&apos;s own report. They are never shown as clinically verified.</p>
      </Card>
    </>
  );
}
