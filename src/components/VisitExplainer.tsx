"use client";

import { Sparkles } from "lucide-react";
import { useState } from "react";
import type { VisitExplanation } from "@/agents/explainer";
import { api, ApiError } from "@/lib/api";
import { Button, Card, useToast } from "./ui";

/** "What happened in my visit?" in everyday words, built only from the approved plan. */
export function VisitExplainer() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [e, setE] = useState<VisitExplanation | null>(null);

  async function run() {
    setBusy(true);
    try {
      setE(await api<VisitExplanation>("/api/visit/explain", { method: "POST", body: {} }));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "That did not work. Please try again.", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Your visit in plain words">
      {!e && <p className="text-sm text-muted">Get your last visit explained in everyday words. It uses only the plan your doctor approved.</p>}
      <Button className="mt-2" variant={e ? "secondary" : "primary"} loading={busy} onClick={run}>
        <Sparkles aria-hidden className="h-4 w-4" /> {e ? "Explain it again" : "Explain my visit"}
      </Button>
      {e && (
        <div className="mt-3 space-y-3 text-sm">
          <p>{e.summary}</p>
          {e.whatToDo.length > 0 && (
            <div>
              <p className="font-semibold">What to do</p>
              <ul className="list-disc space-y-1 pl-5">{e.whatToDo.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}
          {e.medicines.length > 0 && (
            <div>
              <p className="font-semibold">Your medicines</p>
              <ul className="space-y-1">{e.medicines.map((m, i) => <li key={i}><strong>{m.name}:</strong> {m.how}</li>)}</ul>
            </div>
          )}
          {e.followUps.length > 0 && (
            <div>
              <p className="font-semibold">Coming up</p>
              <ul className="list-disc space-y-1 pl-5">{e.followUps.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}
          {e.whenToCall.length > 0 && (
            <div className="rounded-xl bg-warning-bg p-3 text-warning">
              <p className="font-semibold">Contact your care team if</p>
              <ul className="list-disc space-y-1 pl-5">{e.whenToCall.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          )}
          {e.words.length > 0 && (
            <div>
              <p className="font-semibold">Words explained</p>
              <ul className="space-y-1">{e.words.map((w, i) => <li key={i}><strong>{w.term}:</strong> {w.meaning}</li>)}</ul>
            </div>
          )}
          <p className="text-xs text-muted">
            Written by an AI assistant from your approved care plan only{e.removed ? `; ${e.removed} line${e.removed > 1 ? "s were" : " was"} removed because the plan did not support ${e.removed > 1 ? "them" : "it"}` : ""}. It is not medical advice. For anything urgent, contact your care team.
          </p>
        </div>
      )}
    </Card>
  );
}
