"use client";

import { ReadingsPanel } from "@/components/ReadingsPanel";

/** Add a home measurement and see how it is changing. Your care team sees the same trend. */
export default function PatientReadings() {
  return (
    <>
      <h1 className="text-2xl font-bold">Home readings</h1>
      <p className="text-sm text-muted">Add a measurement from home. Your care team sees the trend. For anything urgent, contact your care team or your local emergency number.</p>
      <ReadingsPanel />
    </>
  );
}
