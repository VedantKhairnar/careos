"use client";

import { useState } from "react";
import type { LogEntry } from "@/agents/runLog";
import { LogView } from "./LogView";

/** Everything that happened, with a filter: all, only the agents' work, or only what people and the system did. */
export interface Activity {
  entries: LogEntry[];
  running: boolean;
}

const AGENTS = new Set(["coordinator", "writer", "reviewer", "safety-check", "patient-assistant", "doctor-agent", "explainer"]);
const FILTERS = [
  { key: "all", label: "All" },
  { key: "agents", label: "Agents" },
  { key: "people", label: "People and system" },
] as const;

export function ActivityList({ entries, empty }: { entries: LogEntry[]; empty: string }) {
  const [f, setF] = useState<(typeof FILTERS)[number]["key"]>("all");
  const shown = entries.filter((e) => (f === "all" ? true : f === "agents" ? AGENTS.has(e.agent) : !AGENTS.has(e.agent)));
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5" role="group" aria-label="Filter the activity">
        {FILTERS.map((x) => (
          <button key={x.key} onClick={() => setF(x.key)} aria-pressed={f === x.key} className={`min-h-9 rounded-full border px-3 text-xs font-medium ${f === x.key ? "border-accent bg-accent text-accent-ink" : "border-line hover:bg-surface-2"}`}>
            {x.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? <p className="p-2 text-sm text-muted">{empty}</p> : <LogView entries={shown} />}
    </div>
  );
}
