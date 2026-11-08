"use client";

import { Send, ShieldAlert, UserRound } from "lucide-react";
import { useRef, useState } from "react";
import { AgentTrace } from "@/components/AgentTrace";
import { RichText } from "@/components/RichText";
import { Badge, Button, Card, EmptyState, useToast } from "@/components/ui";
import type { PatientChatResult } from "@/agents/patientAgent";
import type { QuestionView } from "@/server/questions";
import { api, ApiError } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useApi } from "@/lib/useApi";
import { BRAND } from "@/lib/brand";

type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; sources?: string[]; urgent?: boolean; askedCareTeam?: boolean; trace?: PatientChatResult["trace"] }
  | { role: "unavailable"; text: string; original: string };

const SOURCE_LABEL: Record<string, string> = {
  get_approved_care_plan: "your care plan",
  get_medication_schedule: "your medicine schedule",
  get_prescription_status: "your prescription status",
  get_upcoming_appointments: "your follow-ups",
  get_care_timeline: "your care timeline",
  create_clarification_request: "a question sent to your care team",
  "urgent-symptom check (no AI used)": "a check for urgent symptoms (no AI used)",
  "treatment-change check (no AI used)": "a check on questions about changing medicines (no AI used)",
};

const STARTERS = ["What medicines should I take today?", "What is the status of my prescription?", "When is my next follow-up?"];

export default function AskPage() {
  const toast = useToast();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const questions = useApi<QuestionView[]>("/api/questions", { pollMs: 8000 });

  const scroll = () => setTimeout(() => end.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 50);

  async function ask(text: string) {
    const q = text.trim();
    if (!q || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text: q }]);
    setBusy(true);
    scroll();
    try {
      const r = await api<PatientChatResult>("/api/agents/patient/chat", { body: { message: q } });
      setMsgs((m) => [...m, { role: "assistant", text: r.answer, sources: r.sources, urgent: r.urgent, askedCareTeam: r.askedCareTeam, trace: r.trace }]);
      if (r.askedCareTeam) void questions.reload();
    } catch (e) {
      const aiDown = e instanceof ApiError && e.code.startsWith("ai_");
      setMsgs((m) => [
        ...m,
        aiDown
          ? { role: "unavailable", text: `${e.message} You can still send your question straight to your care team.`, original: q }
          : { role: "assistant", text: e instanceof ApiError ? e.message : "Something went wrong. Please try again." },
      ]);
    } finally {
      setBusy(false);
      scroll();
    }
  }

  async function sendToTeam(question: string) {
    try {
      await api("/api/questions", { body: { question } });
      toast("Sent to your care team.");
      setMsgs((m) => [...m, { role: "assistant", text: "Your question has been sent to your care team. They will answer it themselves." }]);
      void questions.reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not send. Please try again.", "danger");
    }
  }

  return (
    <>
      <h1 className="text-2xl font-bold">Ask {BRAND.name}</h1>
      <div role="note" className="flex items-start gap-3 rounded-xl bg-info-bg p-3 text-sm text-info">
        <ShieldAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          This assistant only uses your approved care plan and records. It cannot give medical advice. For anything urgent, contact your care team or call your local emergency number.
        </p>
      </div>

      <Card>
        <div className="min-h-40 space-y-3" aria-live="polite">
          {msgs.length === 0 && (
            <div>
              <p className="text-sm text-muted">Try one of these, or type your own question.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {STARTERS.map((s) => (
                  <button key={s} onClick={() => ask(s)} className="min-h-11 rounded-full border border-line px-3 text-sm hover:bg-surface-2">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {msgs.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="ml-8 rounded-2xl rounded-br-sm bg-accent px-3 py-2 text-accent-ink">
                {m.text}
              </div>
            ) : (
              <div key={i} className={`mr-8 rounded-2xl rounded-bl-sm px-3 py-2 ${m.role === "assistant" && m.urgent ? "bg-danger-bg text-danger" : "bg-surface-2"}`}>
                <RichText text={m.text} />
                {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                  <p className="mt-1 text-xs text-muted">Based on: {m.sources.map((s) => SOURCE_LABEL[s] ?? s).join(", ")}</p>
                )}
                {m.role === "assistant" && m.trace && <AgentTrace steps={m.trace} labels={SOURCE_LABEL} />}
                {m.role === "assistant" && m.askedCareTeam && <div className="mt-2"><Badge tone="info">Sent to your care team</Badge></div>}
                {m.role === "unavailable" && (
                  <Button className="mt-2" variant="secondary" onClick={() => sendToTeam(m.original)}>
                    Send to my care team
                  </Button>
                )}
              </div>
            ),
          )}
          {busy && <p className="mr-8 rounded-2xl bg-surface-2 px-3 py-2 text-sm text-muted">Looking at your records…</p>}
          <div ref={end} />
        </div>

        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
        >
          <label className="sr-only" htmlFor="ask-input">
            Your question
          </label>
          <input
            id="ask-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={1000}
            placeholder="Ask about your plan, medicines or prescriptions"
            className="min-h-11 flex-1 rounded-xl border border-line bg-surface px-3 text-sm"
          />
          <Button type="submit" disabled={!input.trim()} loading={busy} aria-label="Send">
            <Send aria-hidden className="h-4 w-4" />
          </Button>
        </form>
        <button
          onClick={() => void sendToTeam(input.trim())}
          disabled={!input.trim()}
          className="mt-2 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-accent underline disabled:cursor-not-allowed disabled:opacity-50"
        >
          <UserRound aria-hidden className="h-4 w-4" /> Send this to my care team instead
        </button>
      </Card>

      <Card title="Your questions to the care team">
        {(questions.data ?? []).length === 0 ? (
          <EmptyState title="No questions yet" hint="Anything the assistant cannot answer from your plan is sent here for a clinician to answer." />
        ) : (
          <ul className="space-y-3">
            {questions.data!.map((q) => (
              <li key={q.id} className="rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">{q.question}</p>
                  {q.status === "answered" ? <Badge tone="success">Answered by your care team</Badge> : <Badge tone="warning">Waiting for your care team</Badge>}
                </div>
                <p className="text-xs text-muted">
                  Sent {timeAgo(q.askedAt)}
                  {q.askedVia === "assistant" ? " by your assistant" : ""}
                </p>
                {q.answer && <p className="mt-2 rounded-lg bg-surface-2 p-2 text-sm">{q.answer}</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
