"use client";

import { ArrowRight, CheckCircle2 } from "lucide-react";
import { useState } from "react";
import type { CareGap } from "@/domain/careGap";
import type { CarePlanView } from "@/server/carePlans";
import type { QuestionView } from "@/server/questions";
import type { PrescriptionSummary } from "@/server/services";
import type { SuggestionView } from "@/server/suggestions";
import { patientName } from "@/lib/demoPatients";
import { useApi } from "@/lib/useApi";
import { AgentSuggestionsCard } from "./AgentSuggestions";
import { AiDraftPanel, QuestionsCard } from "./doctorAi";
import { PlanReview } from "./PlanReview";
import { PrescriptionForm } from "./PrescriptionForm";
import { RxActions } from "./RxActions";
import { CardSkeleton } from "./ui";
import { VisitStatus } from "./VisitStatus";

const iso = (daysFromNow: number) => new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);

/** Good demo content, already in the boxes, so nobody has to type or paste during a demo. Fictional, with explicit doses and times. */
const demoNotes = (name: string) =>
  `Fictional demo visit for ${name}. Recovering well after the procedure, no signs of infection. Rest, keep the area elevated and keep the dressing dry. ` +
  `Demo-Antibiotic: 1 capsule at 9am and 9pm, starting ${iso(0)} until ${iso(4)}. ` +
  `Demo-Analgesic: 1 tablet at 8am, 2pm and 8pm, starting ${iso(0)}. ` +
  `Review visit on ${iso(14)}. Call the clinic if the area becomes very red, hot or swollen, or if there is a fever.`;

interface Summary {
  patient: { id: string; displayName: string };
  plans: CarePlanView[];
  prescriptions: PrescriptionSummary[];
  gaps: CareGap[];
}

/**
 * One screen for the doctor's whole job. Pick a patient; the board shows where their visit stands and puts the
 * ONE thing the doctor needs to do next right here, ready to use. Everything else is a detail, not a destination.
 */
export function CaseBoard() {
  const patients = useApi<{ id: string }[]>("/api/patients", { pollMs: 10000 });
  const [picked, setPicked] = useState<string | null>(null);
  const [prefill] = useState(() => ({ notes: demoNotes, today: iso(0) })); // computed once, when the board opens
  const pid = picked ?? patients.data?.find((p) => p.id === "p_alex")?.id ?? patients.data?.[0]?.id ?? null;
  const summary = useApi<Summary>(pid ? `/api/patients/${pid}` : null, { pollMs: 4000 });
  const sugg = useApi<SuggestionView[]>("/api/agent-suggestions", { pollMs: 3000 });
  const qs = useApi<QuestionView[]>(pid ? `/api/questions?patientId=${pid}` : null, { pollMs: 5000 });

  if (!pid || summary.loading) return <CardSkeleton rows={4} />;
  const s = summary.data;
  if (!s) return null;

  const reload = () => {
    void summary.reload();
    void sugg.reload();
    void qs.reload();
  };
  const pendingPlan = s.plans.find((p) => p.state === "PENDING_REVIEW");
  const hasApproved = s.plans.some((p) => p.state === "APPROVED");
  const rx = [...s.prescriptions].sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated))[0];
  const proposals = (sugg.data ?? []).filter((x) => x.patientId === pid && x.status === "pending");
  const openQuestions = (qs.data ?? []).filter((q) => q.status === "open");
  const rxActive = rx && !["PICKED_UP", "CANCELLED"].includes(rx.state);

  // Everything that needs the doctor, most urgent first. The first is THE next action; the rest sit under "Also waiting".
  type Item = { key: string; title: string; why: string; node: React.ReactNode };
  const items: Item[] = [];
  if (pendingPlan)
    items.push({
      key: "plan",
      title: "Review and approve the care plan",
      why: "A plan is drafted. The patient cannot see it until you approve it.",
      node: (
        <div>
          <p className="font-medium">{pendingPlan.content.title}</p>
          <p className="text-sm text-muted">{pendingPlan.content.summary}</p>
          <PlanReview plan={pendingPlan} onDone={reload} />
        </div>
      ),
    });
  if (rx?.state === "CLARIFICATION_REQUIRED")
    items.push({ key: "clarify", title: "Answer the pharmacy's question", why: "The pharmacy is waiting on you before it can fill this prescription.", node: <RxActions workflowId={rx.workflowId} state={rx.state} onDone={reload} /> });
  if (proposals.length > 0)
    items.push({ key: "proposals", title: "Review what the agents prepared", why: "The pharmacy reported a problem. The agents investigated and drafted a message. Nothing is sent until you decide.", node: <AgentSuggestionsCard /> });
  if (openQuestions.length > 0)
    items.push({ key: "questions", title: "Answer the patient's question", why: "The patient (or their assistant) asked something only a clinician can answer.", node: <QuestionsCard patientId={pid} prefillAnswer="Please keep taking it until your review visit, and call us if anything changes." /> });
  if (rx?.state === "DELAYED")
    items.push({ key: "delay", title: "Follow up on the delayed prescription", why: "The pharmacy reported a delay. Log your follow-up once you have acted on it.", node: <RxActions workflowId={rx.workflowId} state={rx.state} onDone={reload} /> });
  if (items.length === 0 && !hasApproved)
    items.push({ key: "record", title: "Record this visit", why: "Paste your visit notes. The assistant drafts a plan for you to review. It cannot approve it.", node: <AiDraftPanel key={pid} patientId={pid} onCreated={reload} startOpen initialNotes={prefill.notes(patientName(pid))} /> });
  if (items.length === 0 && !rxActive)
    items.push({ key: "send", title: "Send a prescription", why: "The plan is approved. If the patient needs a medicine, authorize it here (simulated pharmacy).", node: <PrescriptionForm key={pid} patientId={pid} onCreated={reload} startOpen initialMedication="Demo-Antibiotic (fictional)" initialInstructions="Take 1 capsule at 9am and 9pm with food until finished. Fictional demo instructions." /> });

  const primary = items[0];
  const rest = items.slice(1);
  const title = primary?.title ?? "Nothing needs you right now";
  const why = primary?.why ?? (rx ? `${rx.medicationReference}: ${rx.text}` : "Everything is up to date.");
  const action = primary?.node ?? null;
  const idle = !primary;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Choose a patient">
        {(patients.data ?? []).map((p) => (
          <button key={p.id} onClick={() => setPicked(p.id)} aria-pressed={p.id === pid} className={`min-h-11 rounded-full border px-4 text-sm font-medium ${p.id === pid ? "border-accent bg-accent text-accent-ink" : "border-line hover:bg-surface-2"}`}>
            {patientName(p.id)}
            {(sugg.data ?? []).some((x) => x.patientId === p.id && x.status === "pending") && <span className="ml-2 rounded-full bg-warning px-1.5 text-xs text-white" aria-label="agent proposal waiting">!</span>}
          </button>
        ))}
      </div>

      <section aria-label="Your next action" className={`rounded-2xl border-2 p-4 ${idle ? "border-line bg-surface" : "border-accent bg-surface"}`}>
        <p className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-accent">
          {idle ? <CheckCircle2 aria-hidden className="h-4 w-4" /> : <ArrowRight aria-hidden className="h-4 w-4" />}
          Your next action
        </p>
        <h2 className="mt-1 text-xl font-bold">{title}</h2>
        <p className="mt-1 text-sm text-muted">{why}</p>
        {action && <div className="mt-3">{action}</div>}
      </section>

      {rest.length > 0 && (
        <section aria-label="Also waiting on you" className="space-y-3">
          <h2 className="text-lg font-bold">Also waiting on you</h2>
          {rest.map((r) => (
            <div key={r.key} className="rounded-2xl border border-line bg-surface p-4">
              <p className="font-semibold">{r.title}</p>
              <p className="mb-2 text-sm text-muted">{r.why}</p>
              {r.node}
            </div>
          ))}
        </section>
      )}

      <VisitStatus patientId={pid} />
    </div>
  );
}

