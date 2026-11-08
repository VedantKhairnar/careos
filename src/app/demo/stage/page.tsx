"use client";

import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LogEntry, RunRecord } from "@/agents/runLog";
import { LogView } from "@/components/LogView";
import { Button, useToast } from "@/components/ui";
import { api, ApiError, FRAME_PREFIX, setActingAs } from "@/lib/api";
import { useApi } from "@/lib/useApi";

const WHO = [
  { key: "doctor", label: "Doctor", sub: "Dr. Chen", src: "/doctor/case", body: { role: "clinician", displayName: "Dr. Chen" } },
  { key: "patient", label: "Patient", sub: "Alex Rivera", src: "/patient/visit", body: { role: "patient", patientId: "p_alex", displayName: "Alex Rivera" } },
  { key: "pharmacy", label: "Pharmacy", sub: "Simulator", src: "/demo/pharmacy", body: { role: "demo_operator", displayName: "Demo operator" } },
] as const;

/** Shortcuts shown above each window, so nobody has to hunt for a page inside a small window. */
const SHORTCUTS: Record<string, { label: string; src: string }[]> = {
  doctor: [{ label: "Case board", src: "/doctor/case" }, { label: "Agent room", src: "/doctor/agents" }, { label: "Patients", src: "/doctor/patients" }],
  patient: [{ label: "Visit", src: "/patient/visit" }, { label: "Home", src: "/patient" }, { label: "Medications", src: "/patient/medications" }, { label: "Ask", src: "/patient/ask" }, { label: "Updates", src: "/patient/notifications" }],
  pharmacy: [],
};

const STEPS = [
  { who: "Here", title: "Start afresh", text: "Press Start afresh above. Everything begins empty. Each window has shortcuts for its pages." },
  { who: "Doctor", title: "Record the visit", text: "The doctor's board says Your next action: Record this visit. The visit notes are already filled in. Just press Create draft for review. Watch the log column: the doctor agent runs." },
  { who: "Doctor", title: "A human approves the plan", text: "The next action is now Review and approve the care plan. Tick the box and press Approve care plan. The AI could not do this. The patient window now shows the visit." },
  { who: "Patient", title: "Patient sees the visit", text: "The patient's home shows Your last visit with a status bar. Under Your medicines today, press Taken on a dose." },
  { who: "Doctor", title: "Send a prescription", text: "The next action is Send a prescription. The medicine is already filled in. Just press Authorize prescription. The patient's status bar moves on." },
  { who: "Pharmacy", title: "Pharmacy receives", text: "Press Receive prescription, then Acknowledge. The agents stay asleep: routine events do not wake them." },
  { who: "Pharmacy", title: "Pharmacy reports a delay", text: "Press Report a delay, then watch the log column. The Care Coordinator wakes by itself, investigates, hands off to the Writer, is checked by the Safety Reviewer, and proposes." },
  { who: "Doctor", title: "A human decides", text: "The next action is Review what the agents prepared. Edit the wording if you like, then press Approve and send to patient." },
  { who: "Patient", title: "Patient is told", text: "The patient's status bar shows the delay and what is next, and a message from the care team. Open Ask and try: What is the status of my prescription? Open the trace under the answer." },
  { who: "Pharmacy", title: "Finish (optional)", text: "Press Start processing, Mark ready for pickup, then Confirm pickup. The status bar fills to 6 of 6." },
] as const;


/** One screen for the whole demo: three live windows (each signed in as its own person) and the agents' log. */
export default function Stage() {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [guide, setGuide] = useState(true);
  const [gen, setGen] = useState(0); // bump to reload all windows
  const [busy, setBusy] = useState(false);
  const [src, setSrc] = useState<Record<string, { to: string; n: number }>>({}); // n forces a reload even when the address is the same

  // Sign in as all three people, once. The Stage itself acts as the pharmacy operator (for Start afresh and the log).
  const ready = useQuery({
    queryKey: ["stage-signin"],
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const keys: Record<string, string> = {};
      for (const w of WHO) keys[w.key] = (await api<{ as: string }>("/api/auth/session", { body: w.body })).as;
      setActingAs(keys.pharmacy);
      return keys;
    },
  });

  const runs = useApi<RunRecord[]>(ready.data ? "/api/agent-runs" : null, { pollMs: 1000 });
  const entries: LogEntry[] = (runs.data ?? []).flatMap((r) => r.entries).sort((a, b) => a.at.localeCompare(b.at)).slice(-80);
  const working = (runs.data ?? []).some((r) => r.status === "running");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);

  async function startAfresh() {
    if (!window.confirm("Start afresh? This clears all demo activity (the analytics history is kept).")) return;
    setBusy(true);
    try {
      const r = await api<{ events: number }>("/api/demo/reset", { method: "POST" });
      setGen((g) => g + 1);
      setStep(1);
      toast(`Cleared ${r.events} demo events. Ready for step 2.`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not reset the demo", "danger");
    } finally {
      setBusy(false);
    }
  }

  const s = STEPS[step];
  return (
    <div className="flex h-screen flex-col bg-bg">
      <header className="border-b border-line bg-surface px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-bold text-accent">CareOS · Demo stage</p>
          <Button variant="danger" loading={busy} onClick={startAfresh}>
            Start afresh
          </Button>
          <Button variant="secondary" onClick={() => setGen((g) => g + 1)}>
            Reload windows
          </Button>
          <button onClick={() => setGuide((g) => !g)} aria-expanded={guide} className="ml-auto inline-flex min-h-11 items-center gap-1 rounded-xl px-3 text-sm font-medium hover:bg-surface-2">
            Guide {guide ? <ChevronUp aria-hidden className="h-4 w-4" /> : <ChevronDown aria-hidden className="h-4 w-4" />}
          </button>
        </div>
        {guide && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-info-bg p-2 text-sm text-info">
            <span className="font-semibold">
              Step {step + 1} of {STEPS.length} · {s.who}: {s.title}
            </span>
            <span className="min-w-0 flex-1">{s.text}</span>
            <Button variant="secondary" disabled={step === 0} onClick={() => setStep((n) => n - 1)}>
              Back
            </Button>
            <Button disabled={step === STEPS.length - 1} onClick={() => setStep((n) => n + 1)}>
              Next step
            </Button>
          </div>
        )}
      </header>

      {ready.isError && <p role="alert" className="p-4 text-danger">Could not sign in the demo roles. Is demo mode on?</p>}
      {!ready.data && !ready.isError && <p className="p-4 text-muted">Signing in the doctor, the patient and the pharmacy…</p>}

      {ready.data && (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-y-auto p-2 lg:grid-cols-[1.25fr_1fr_1fr_1fr] lg:overflow-hidden">
          {WHO.map((w) => (
            <section key={w.key + gen} aria-label={`${w.label} window`} className="flex h-[75vh] min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface lg:h-auto">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface-2 px-3 py-1.5 text-sm">
                <span className="font-semibold">
                  {w.label} <span className="font-normal text-muted">· {w.sub}</span>
                </span>
                {SHORTCUTS[w.key].map((c) => (
                  <button key={c.src} onClick={() => setSrc((m) => ({ ...m, [w.key]: { to: c.src, n: (m[w.key]?.n ?? 0) + 1 } }))} className="min-h-8 rounded px-1 text-accent underline">
                    {c.label}
                  </button>
                ))}
              </div>
              <iframe key={src[w.key]?.n ?? 0} name={FRAME_PREFIX + ready.data[w.key]} src={src[w.key]?.to ?? w.src} title={`${w.label} window (${w.sub})`} className="min-h-0 w-full flex-1 bg-bg" />
            </section>
          ))}
          <section aria-label="Live agent log" className="flex h-[75vh] min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-surface lg:h-auto">
            <p className="flex items-center gap-2 border-b border-line bg-surface-2 px-3 py-1.5 text-sm font-semibold">
              <Bot aria-hidden className="h-4 w-4" /> Live agent log
              <span className="relative ml-1 flex h-2.5 w-2.5" aria-hidden>
                {working && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />}
                <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${working ? "bg-success" : "bg-muted"}`} />
              </span>
              <span className="font-normal text-muted">{working ? "agents working" : "idle"}</span>
            </p>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {entries.length === 0 ? <p className="p-2 text-sm text-muted">Nothing yet. Agents wake when something happens: a plan draft, a patient question, or a pharmacy delay.</p> : <LogView entries={entries} />}
              <div ref={end} />
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
