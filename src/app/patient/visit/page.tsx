"use client";

import Link from "next/link";
import { VisitExplainer } from "@/components/VisitExplainer";
import { VisitStatus } from "@/components/VisitStatus";
import { useMe } from "@/components/session";

/** The patient's last visit at a glance: one status bar for plan, prescription, pharmacy and pickup. */
export default function PatientVisit() {
  const me = useMe();
  return (
    <>
      <h1 className="text-2xl font-bold">Your visit, {me.displayName?.split(" ")[0] ?? "there"}</h1>
      <VisitStatus />
      <VisitExplainer />
      <Link href="/patient/readings" className="inline-flex min-h-11 items-center rounded-xl border border-line bg-surface px-4 text-sm font-semibold text-accent hover:bg-surface-2">
        Add a home reading
      </Link>
    </>
  );
}
