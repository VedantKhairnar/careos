"use client";

import { VisitStatus } from "@/components/VisitStatus";
import { useMe } from "@/components/session";

/** The patient's last visit at a glance: one status bar for plan, prescription, pharmacy and pickup. */
export default function PatientVisit() {
  const me = useMe();
  return (
    <>
      <h1 className="text-2xl font-bold">Your visit, {me.displayName?.split(" ")[0] ?? "there"}</h1>
      <VisitStatus />
    </>
  );
}
