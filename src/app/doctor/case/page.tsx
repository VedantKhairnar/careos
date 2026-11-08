"use client";

import { CaseBoard } from "@/components/CaseBoard";

/** The doctor's whole job on one screen: pick a patient, see where the visit stands, do the one next thing. */
export default function DoctorCase() {
  return (
    <>
      <h1 className="text-2xl font-bold">Case board</h1>
      <CaseBoard />
    </>
  );
}
