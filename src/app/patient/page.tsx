"use client";

import { AlertTriangle, CalendarClock } from "lucide-react";
import Link from "next/link";
import { DoseRow } from "@/components/DoseRow";
import { RxBadge, type RxView } from "@/components/rx";
import { useMe } from "@/components/session";
import { Badge, Card, CardSkeleton, EmptyState, ErrorState, SourceDetails } from "@/components/ui";
import type { CarePlanView } from "@/server/carePlans";
import type { MedicationView, NotificationView } from "@/server/patientCare";
import type { PrescriptionSummary } from "@/server/services";
import { formatDate } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import { useNow } from "@/lib/useNow";

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

export default function PatientHome() {
  const me = useMe();
  const meds = useApi<{ timezone: string; medications: MedicationView[] }>("/api/medications", { pollMs: 15000 });
  const rx = useApi<PrescriptionSummary[]>("/api/prescriptions", { pollMs: 10000 });
  const notifs = useApi<{ notifications: NotificationView[]; unread: number }>("/api/notifications", { pollMs: 10000 });
  const plans = useApi<CarePlanView[]>("/api/care-plans");

  const first = me.displayName?.split(" ")[0] ?? "there";
  const attention = (notifs.data?.notifications ?? []).filter((n) => n.important && !n.acknowledged);
  const now = useNow();
  const doses = (meds.data?.medications ?? [])
    .flatMap((m) => m.doses.map((d) => ({ d, label: m.dose })))
    .filter(({ d }) => Math.abs(Date.parse(d.scheduledFor) - now) <= 14 * 3_600_000)
    .sort((a, b) => a.d.scheduledFor.localeCompare(b.d.scheduledFor));
  const needsClarity = (meds.data?.medications ?? []).filter((m) => m.schedule === "needs_clarification");
  const followUps = (plans.data ?? [])
    .flatMap((p) => p.content.followUps.map((f) => ({ ...f, plan: p.content.title })))
    .filter((f) => f.dueDate)
    .sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? ""));

  return (
    <>
      <h1 className="text-2xl font-bold">
        {greeting()}, {first}
      </h1>

      {attention.length > 0 && (
        <Link href="/patient/notifications" className="flex items-start gap-3 rounded-2xl bg-warning-bg p-4 text-warning">
          <AlertTriangle aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
          <span>
            <strong>
              {attention.length} update{attention.length > 1 ? "s" : ""} need your attention.
            </strong>{" "}
            <span className="underline">Review now</span>
          </span>
        </Link>
      )}

      <Card title="Your medicines today">
        {meds.loading ? (
          <CardSkeleton rows={2} />
        ) : meds.error ? (
          <ErrorState message={meds.error.message} onRetry={meds.reload} />
        ) : doses.length === 0 ? (
          <EmptyState title="Nothing scheduled right now" hint="Reminders appear here once your care team has approved a medicine schedule." />
        ) : (
          <ul className="space-y-2">
            {doses.map(({ d, label }) => (
              <DoseRow key={`${d.planId}${d.medicationName}${d.scheduledFor}`} dose={d} doseLabel={label} onChanged={meds.reload} />
            ))}
          </ul>
        )}
        {needsClarity.map((m) => (
          <p key={m.planId + m.name} className="mt-3 rounded-xl bg-warning-bg p-3 text-sm text-warning">
            <strong>{m.name}:</strong> your care team has not yet confirmed how and when to take this. We will not guess a schedule. Please check with them.
          </p>
        ))}
      </Card>

      <Card title="Your prescriptions" action={<Link href="/patient/timeline" className="text-sm font-semibold text-accent underline">See full history</Link>}>
        {rx.loading ? (
          <CardSkeleton rows={2} />
        ) : rx.error ? (
          <ErrorState message={rx.error.message} onRetry={rx.reload} />
        ) : (rx.data ?? []).length === 0 ? (
          <EmptyState title="No prescriptions yet" />
        ) : (
          <ul className="space-y-3">
            {(rx.data ?? []).map((p) => (
              <PrescriptionCard key={p.workflowId} p={p} />
            ))}
          </ul>
        )}
      </Card>

      <Card title="Follow-ups from your care plan">
        {plans.loading ? (
          <CardSkeleton rows={1} />
        ) : followUps.length === 0 ? (
          <EmptyState title="No follow-ups listed" />
        ) : (
          <ul className="space-y-2">
            {followUps.map((f, i) => (
              <li key={i} className="flex items-start gap-3 rounded-xl border border-line p-3">
                <CalendarClock aria-hidden className="mt-0.5 h-5 w-5 text-accent" />
                <div className="flex-1">
                  <p className="font-medium">{f.description}</p>
                  <p className="text-sm text-muted">Target date: {formatDate(`${f.dueDate}T12:00:00Z`)}</p>
                </div>
                <Badge tone="neutral">Booking not confirmed</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function PrescriptionCard({ p }: { p: PrescriptionSummary }) {
  const { data } = useApi<RxView>(`/api/prescriptions/${p.workflowId}/status`, { pollMs: 10000 });
  return (
    <li className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">{p.medicationReference}</p>
        <div className="flex items-center gap-2">
          {p.simulated && <Badge tone="info">Simulated</Badge>}
          <RxBadge state={data?.state ?? p.state} />
        </div>
      </div>
      <p className="mt-1 text-sm text-muted">{data?.text ?? p.text}</p>
      <SourceDetails source={data?.currentSource ?? null} />
    </li>
  );
}
