"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";
import type { DraftResult } from "@/agents/doctorAgent";
import type { QuestionView } from "@/server/questions";
import { api, ApiError } from "@/lib/api";
import { patientName } from "@/lib/demoPatients";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import { Badge, Button, Card, EmptyState, useToast } from "./ui";

const input = "mt-1 block w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm";

function errText(e: unknown) {
  return e instanceof ApiError ? e.message : "That did not work. Please try again.";
}

/** Paste visit notes, get a draft that goes into review. The AI cannot approve it and values not in the notes are removed. */
export function AiDraftPanel({ patientId, onCreated, startOpen = false, initialNotes = "" }: { patientId: string; onCreated: () => void; startOpen?: boolean; initialNotes?: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(startOpen);
  const [notes, setNotes] = useState(initialNotes);
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState<string[]>([]);

  async function draft() {
    setBusy(true);
    setRemoved([]);
    try {
      const r = await api<DraftResult>("/api/agents/doctor/draft-plan", { body: { patientId, notes } });
      setRemoved(r.removed);
      toast("Draft created. Review it below before approving.");
      setNotes("");
      onCreated();
    } catch (e) {
      toast(errText(e), "danger");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Sparkles aria-hidden className="h-4 w-4" /> Draft from my visit notes (AI)
      </Button>
    );
  }
  return (
    <div className="space-y-3 rounded-xl border border-line p-3">
      <p className="text-sm text-muted">
        Paste your own visit notes. The assistant structures them into a draft plan. It uses only what you wrote, leaves out any dose, time or date you did not give, and
        <strong> cannot approve it</strong>. Nothing reaches the patient until you approve.
      </p>
      <label className="block text-sm font-medium">
        Visit notes
        <textarea rows={5} maxLength={6000} className={input} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="flex gap-2">
        <Button loading={busy} disabled={notes.trim().length < 10} onClick={draft}>
          Create draft for review
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      {removed.length > 0 && (
        <div role="note" className="rounded-xl bg-warning-bg p-3 text-sm text-warning">
          <p className="font-semibold">Left out because it was not in your notes:</p>
          <ul className="mt-1 list-disc pl-5">
            {removed.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Administrative summary built from read-only tools. */
export function AiSummaryCard({ patientId }: { patientId: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ summary: string; sources: string[] } | null>(null);

  async function run() {
    setBusy(true);
    try {
      setOut(await api("/api/agents/doctor/summarize", { body: { patientId } }));
    } catch (e) {
      toast(errText(e), "danger");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Status summary" action={<Badge tone="info">AI-generated</Badge>}>
      {out ? (
        <>
          <p className="whitespace-pre-wrap text-sm">{out.summary}</p>
          <p className="mt-2 text-xs text-muted">Built from: {out.sources.join(", ") || "no records"}. Administrative status only, not clinical advice.</p>
        </>
      ) : (
        <p className="text-sm text-muted">A short plain summary of where this patient&apos;s plan, prescriptions and open items stand.</p>
      )}
      <Button className="mt-3" variant="secondary" loading={busy} onClick={run}>
        <Sparkles aria-hidden className="h-4 w-4" /> {out ? "Refresh summary" : "Summarize"}
      </Button>
    </Card>
  );
}

/** Patient questions waiting for a clinician. Only a clinician can answer. */
export function QuestionsCard({ patientId, prefillAnswer = "" }: { patientId?: string; prefillAnswer?: string }) {
  const toast = useToast();
  const q = useApi<QuestionView[]>(`/api/questions${patientId ? `?patientId=${patientId}` : ""}`, { pollMs: 5000 });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const open = (q.data ?? []).filter((x) => x.status === "open");
  const done = (q.data ?? []).filter((x) => x.status === "answered").slice(0, 3);

  async function answer(id: string) {
    setBusy(id);
    try {
      await api(`/api/questions/${id}/answer`, { body: { answer: draft[id] ?? "" } });
      toast("Answer sent to the patient.");
      setDraft((d) => ({ ...d, [id]: "" }));
      await q.reload();
    } catch (e) {
      toast(errText(e), "danger");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title={`Patient questions${open.length ? ` (${open.length} waiting)` : ""}`}>
      {open.length === 0 && done.length === 0 && <EmptyState title="No patient questions" />}
      <ul className="space-y-3">
        {open.map((x) => (
          <li key={x.id} className="rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">{x.question}</p>
              {x.askedVia === "assistant" && <Badge tone="info">Raised by the patient&apos;s assistant</Badge>}
            </div>
            <p className="text-xs text-muted">
              {patientName(x.patientId)} · {timeAgo(x.askedAt)}
            </p>
            <label className="mt-2 block text-sm font-medium">
              Your answer
              <textarea rows={2} maxLength={2000} className={input} value={draft[x.id] ?? prefillAnswer} onChange={(e) => setDraft((d) => ({ ...d, [x.id]: e.target.value }))} />
            </label>
            <Button className="mt-2" loading={busy === x.id} disabled={!(draft[x.id] ?? prefillAnswer).trim()} onClick={() => answer(x.id)}>
              Send answer
            </Button>
          </li>
        ))}
        {done.map((x) => (
          <li key={x.id} className="rounded-xl border border-line p-3 text-sm">
            <p className="font-medium">{x.question}</p>
            <p className="text-muted">Answered: {x.answer}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
