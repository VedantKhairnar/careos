"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, ApiError } from "@/lib/api";
import { Button, Card, useToast } from "./ui";

interface MedRow {
  name: string;
  dose: string;
  times: string;
  startDate: string;
  endDate: string;
  notes: string;
}
const blankMed = (): MedRow => ({ name: "", dose: "", times: "", startDate: "", endDate: "", notes: "" });
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const today = () => new Date().toISOString().slice(0, 10);

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}
const input = "mt-1 block min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm";

/** Clinician drafts a plan. It goes to "awaiting approval" and stays hidden from the patient until approved. */
export function CarePlanForm({ patientId, onCreated }: { patientId: string; onCreated: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [instructions, setInstructions] = useState("");
  const [warnings, setWarnings] = useState("");
  const [followUps, setFollowUps] = useState("");
  const [meds, setMeds] = useState<MedRow[]>([blankMed()]);

  const setMed = (i: number, patch: Partial<MedRow>) => setMeds((m) => m.map((x, k) => (k === i ? { ...x, ...patch } : x)));

  function fillExample() {
    setTitle("Recovery plan (fictional demo)");
    setSummary("Demonstration plan for a fictional patient. It is not medical advice.");
    setInstructions("Rest as advised.\nBring your medication list to your next visit.");
    setWarnings("If you feel worse or are worried, contact your care team. For an emergency, call your local emergency number.");
    setFollowUps(`Follow-up visit (fictional) | ${new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)}`);
    setMeds([{ name: "Demo-Medication (fictional)", dose: "1 tablet", times: "08:00, 20:00", startDate: today(), endDate: "", notes: "" }]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const content = {
        title,
        summary,
        instructions: lines(instructions),
        warningSigns: lines(warnings),
        followUps: lines(followUps).map((l) => {
          const [description, dueDate] = l.split("|").map((x) => x.trim());
          return dueDate ? { description, dueDate } : { description };
        }),
        medications: meds
          .filter((m) => m.name.trim())
          .map((m) => ({
            name: m.name.trim(),
            ...(m.dose.trim() ? { dose: m.dose.trim() } : {}),
            ...(m.times.trim() ? { times: m.times.split(",").map((t) => t.trim()).filter(Boolean) } : {}),
            ...(m.startDate ? { startDate: m.startDate } : {}),
            ...(m.endDate ? { endDate: m.endDate } : {}),
            ...(m.notes.trim() ? { notes: m.notes.trim() } : {}),
          })),
      };
      await api("/api/care-plans", { body: { patientId, content } });
      toast("Submitted for review. The patient will not see it until you approve it.");
      setOpen(false);
      setTitle("");
      setSummary("");
      setInstructions("");
      setWarnings("");
      setFollowUps("");
      setMeds([blankMed()]);
      onCreated();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not save the plan.", "danger");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Plus aria-hidden className="h-4 w-4" /> Draft a care plan
      </Button>
    );
  }

  return (
    <Card title="New care plan" action={<Button variant="ghost" onClick={fillExample} type="button">Fill with demo example</Button>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title">
          <input required maxLength={120} className={input} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Summary">
          <textarea required maxLength={2000} rows={2} className={`${input} py-2`} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
        <Field label="Instructions" hint="One per line.">
          <textarea rows={3} className={`${input} py-2`} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        </Field>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Medicines</legend>
          <p className="text-xs text-muted">Reminders are only created when dose, times and start date are all given. Anything missing is shown to the patient as not yet confirmed.</p>
          {meds.map((m, i) => (
            <div key={i} className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-2">
              <Field label="Name">
                <input className={input} value={m.name} onChange={(e) => setMed(i, { name: e.target.value })} />
              </Field>
              <Field label="Dose">
                <input className={input} value={m.dose} onChange={(e) => setMed(i, { dose: e.target.value })} placeholder="1 tablet" />
              </Field>
              <Field label="Times (24-hour, comma separated)">
                <input className={input} value={m.times} onChange={(e) => setMed(i, { times: e.target.value })} placeholder="08:00, 20:00" />
              </Field>
              <Field label="Start date">
                <input type="date" className={input} value={m.startDate} onChange={(e) => setMed(i, { startDate: e.target.value })} />
              </Field>
              <Field label="End date (optional)">
                <input type="date" className={input} value={m.endDate} onChange={(e) => setMed(i, { endDate: e.target.value })} />
              </Field>
              <Field label="Notes (optional)">
                <input className={input} value={m.notes} onChange={(e) => setMed(i, { notes: e.target.value })} />
              </Field>
              {meds.length > 1 && (
                <Button type="button" variant="ghost" className="sm:col-span-2" onClick={() => setMeds((x) => x.filter((_, k) => k !== i))}>
                  <Trash2 aria-hidden className="h-4 w-4" /> Remove medicine
                </Button>
              )}
            </div>
          ))}
          <Button type="button" variant="secondary" onClick={() => setMeds((x) => [...x, blankMed()])}>
            <Plus aria-hidden className="h-4 w-4" /> Add medicine
          </Button>
        </fieldset>

        <Field label="Follow-ups" hint="One per line. Optionally add a date after a bar: Review visit | 2026-03-20">
          <textarea rows={2} className={`${input} py-2`} value={followUps} onChange={(e) => setFollowUps(e.target.value)} />
        </Field>
        <Field label="When to get help (warning-sign instructions you authored)">
          <textarea rows={2} className={`${input} py-2`} value={warnings} onChange={(e) => setWarnings(e.target.value)} />
        </Field>

        <div className="flex gap-2">
          <Button type="submit" loading={busy}>
            Submit for review
          </Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
