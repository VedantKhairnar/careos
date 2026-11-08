"use client";

import { ClipboardList, Pill, Stethoscope, Store } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, useToast } from "@/components/ui";
import { api, ApiError, setActingAs } from "@/lib/api";
import { BRAND } from "@/lib/brand";

const ROLES = [
  {
    key: "alex",
    title: "Alex Rivera",
    sub: "Patient. Recovering after knee surgery.",
    icon: Pill,
    body: { role: "patient", patientId: "p_alex", displayName: "Alex Rivera" },
    to: "/patient",
  },
  {
    key: "maria",
    title: "Maria Santos",
    sub: "Patient. Two overlapping care plans.",
    icon: ClipboardList,
    body: { role: "patient", patientId: "p_maria", displayName: "Maria Santos" },
    to: "/patient",
  },
  {
    key: "doctor",
    title: "Dr. Chen",
    sub: "Clinician. Reviews and approves care plans.",
    icon: Stethoscope,
    body: { role: "clinician", displayName: "Dr. Chen" },
    to: "/doctor",
  },
  {
    key: "pharmacy",
    title: "Pharmacy simulator",
    sub: "Demo operator. Sends simulated pharmacy events.",
    icon: Store,
    body: { role: "demo_operator", displayName: "Demo operator" },
    to: "/demo/pharmacy",
  },
] as const;

export default function SignIn() {
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  async function enter(r: (typeof ROLES)[number]) {
    setBusy(r.key);
    try {
      const me = await api<{ as: string }>("/api/auth/session", { body: r.body });
      setActingAs(me.as); // this tab now acts as this person, whatever other tabs are signed in as
      await api("/api/demo/seed", { method: "POST" });
      qc.clear(); // drop anything cached for the previous role
      router.push(r.to);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Could not start the demo", "danger");
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-4 py-10">
      <header>
        <p className="text-sm font-semibold uppercase tracking-wide text-accent">{BRAND.name}</p>
        <h1 className="mt-1 text-3xl font-bold sm:text-4xl">{BRAND.tagline}</h1>
        <p className="mt-3 max-w-xl text-muted">
          Doctors, patients and pharmacies on one shared, verifiable record. Every status shows where it came from and whether it was confirmed.
        </p>
      </header>

      <div role="note" className="rounded-xl bg-info-bg p-4 text-sm text-info">
        <strong>Demo sign-in.</strong> {BRAND.demoNotice} Pick a role to explore; there are no passwords because there are no real accounts.
      </div>

      <ul className="grid gap-3 sm:grid-cols-2">
        {ROLES.map((r) => (
          <li key={r.key}>
            <button
              onClick={() => enter(r)}
              disabled={busy !== null}
              className="w-full text-left disabled:opacity-60"
              aria-label={`Continue as ${r.title}`}
            >
              <Card className="h-full transition hover:border-accent">
                <div className="flex items-start gap-3">
                  <r.icon aria-hidden className="mt-0.5 h-6 w-6 text-accent" />
                  <div>
                    <p className="font-semibold">{r.title}</p>
                    <p className="text-sm text-muted">{busy === r.key ? "Loading the demo…" : r.sub}</p>
                  </div>
                </div>
              </Card>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}
