"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { TERMINAL_RX } from "./rx";
import { Button, useToast } from "./ui";

type Action = "resolve_clarification" | "followup_completed" | "cancel";

/** Only offers actions that are valid for the prescription's current state, so nothing here is inert. */
export function RxActions({ workflowId, state, onDone }: { workflowId: string; state: string; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<Action | null>(null);

  async function run(action: Action, message: string) {
    setBusy(action);
    try {
      await api(`/api/prescriptions/${workflowId}/actions`, { body: { action } });
      toast(message);
      onDone();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "That did not work. Please try again.", "danger");
    } finally {
      setBusy(null);
    }
  }

  if (TERMINAL_RX.has(state)) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {state === "CLARIFICATION_REQUIRED" && (
        <Button loading={busy === "resolve_clarification"} disabled={busy !== null} onClick={() => run("resolve_clarification", "Recorded that you answered the pharmacy.")}>
          Resolve pharmacy question
        </Button>
      )}
      {state === "DELAYED" && (
        <Button variant="secondary" loading={busy === "followup_completed"} disabled={busy !== null} onClick={() => run("followup_completed", "Follow-up logged.")}>
          Log follow-up
        </Button>
      )}
      <Button
        variant="danger"
        loading={busy === "cancel"}
        disabled={busy !== null}
        onClick={() => {
          if (window.confirm("Cancel this prescription? This cannot be undone.")) void run("cancel", "Prescription cancelled.");
        }}
      >
        Cancel
      </Button>
    </div>
  );
}
