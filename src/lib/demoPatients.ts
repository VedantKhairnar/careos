/** Fictional people used for the demonstration. Pure data so both server and client can import it. */
export const DEMO_PATIENTS = [
  { id: "p_alex", displayName: "Alex Rivera", scenario: "Post-surgery recovery (fictional)" },
  { id: "p_maria", displayName: "Maria Santos", scenario: "Two overlapping conditions (fictional)" },
] as const;

export const patientName = (id: string) => DEMO_PATIENTS.find((p) => p.id === id)?.displayName ?? "Patient";
