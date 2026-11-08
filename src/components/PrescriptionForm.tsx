"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Button, useToast } from "./ui";

export function PrescriptionForm({ patientId, onCreated, startOpen = false }: { patientId: string; onCreated: () => void; startOpen?: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState(startOpen);
  const [busy, setBusy] = useState(false);
  const [med, setMed] = useState("");
  const [instr, setInstr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/prescriptions", { body: { patientId, medicationReference: med, ...(instr.trim() ? { approvedInstructions: instr } : {}) } });
      toast("Authorized and sent (simulated transmission).");
      setOpen(false);
      setMed("");
      setInstr("");
      onCreated();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Could not create the prescription.", "danger");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        New prescription
      </Button>
    );
  }
  const input = "mt-1 block min-h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm";
  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border border-line p-3">
      <p className="text-sm text-muted">Authorizing sends a <strong>simulated</strong> transmission. No real e-prescribing happens.</p>
      <label className="block text-sm font-medium">
        Medication (fictional)
        <input required maxLength={200} className={input} value={med} onChange={(e) => setMed(e.target.value)} />
      </label>
      <label className="block text-sm font-medium">
        Approved instructions (optional)
        <textarea maxLength={2000} rows={2} className={`${input} py-2`} value={instr} onChange={(e) => setInstr(e.target.value)} />
      </label>
      <div className="flex gap-2">
        <Button type="submit" loading={busy}>
          Authorize prescription
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
