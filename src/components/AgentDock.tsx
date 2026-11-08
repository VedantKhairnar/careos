"use client";

import { Bot, ChevronDown, ChevronUp } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { LogEntry, RunRecord } from "@/agents/runLog";
import { useApi } from "@/lib/useApi";
import { LogView } from "./LogView";

/**
 * A dock that stays on screen in the doctor portal and the pharmacy simulator and shows what the agents are doing,
 * live. Collapsed it is a ticker with the latest real step; open it is the running log of every agent run.
 */
export function AgentDock() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [fast, setFast] = useState(false);
  const runs = useApi<RunRecord[]>("/api/agent-runs", { pollMs: fast ? 1000 : 3000 });
  const end = useRef<HTMLDivElement>(null);

  const running = (runs.data ?? []).some((r) => r.status === "running");
  if (running !== fast) setFast(running); // poll faster while something is running

  const entries: LogEntry[] = (runs.data ?? [])
    .flatMap((r) => r.entries)
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-40);
  const latest = entries.at(-1);

  useEffect(() => {
    if (open) end.current?.scrollIntoView({ block: "end" });
  }, [open, entries.length]);

  if (runs.error || !runs.data || path.startsWith("/doctor/agents")) return null; // the Agent room already shows it in full

  return (
    <section aria-label="Live agent log" className="fixed bottom-3 right-3 z-40 w-[min(34rem,calc(100vw-1.5rem))] rounded-2xl border border-line bg-surface shadow-lg">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-h-11 w-full items-center gap-2 rounded-2xl px-3 py-2 text-left text-sm">
        <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
          {running && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />}
          <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${running ? "bg-success" : "bg-muted"}`} />
        </span>
        <Bot aria-hidden className="h-4 w-4 shrink-0" />
        <span className="font-semibold">{running ? "Agents working" : "Agents idle"}</span>
        <span className="min-w-0 flex-1 truncate text-muted">{latest ? `${latest.agent}: ${latest.title}` : "Waiting for an event. Nothing has happened yet."}</span>
        {open ? <ChevronDown aria-hidden className="h-4 w-4 shrink-0" /> : <ChevronUp aria-hidden className="h-4 w-4 shrink-0" />}
      </button>
      {open && (
        <div className="max-h-[55vh] overflow-y-auto border-t border-line p-2">
          {entries.length === 0 ? <p className="p-2 text-sm text-muted">No agent has run yet. Press Report a delay in the pharmacy tab, or ask the patient assistant something.</p> : <LogView entries={entries} />}
          <div ref={end} />
        </div>
      )}
    </section>
  );
}
