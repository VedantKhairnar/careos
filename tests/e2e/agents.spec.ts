import { expect, test } from "@playwright/test";
import { checkA11y, problems, shot, signIn, watch, writeReport } from "./helpers";

/**
 * The agent moments, in a real browser with the real Gemini API: (1) an event-driven agent that wakes on a
 * pharmacy delay and drafts for the clinician, (2) the trace of what the patient assistant did.
 * Does NOT press Start afresh, so it is safe to run next to a demo in progress.
 */
const RX = `Agent-Rx-${Date.now().toString(36)}`;

test("event-driven agent drafts, clinician approves, patient is told; assistant shows its trace", async ({ context }) => {
  const doctor = await context.newPage();
  const alex = await context.newPage();
  const pharm = await context.newPage();
  watch(doctor, "doctor");
  watch(alex, "alex");
  watch(pharm, "pharmacy");
  await signIn(doctor, "Dr. Chen", /\/doctor/);
  await signIn(alex, "Alex Rivera", /\/patient/);
  await signIn(pharm, "Pharmacy simulator", /\/demo\/pharmacy/);

  await test.step("doctor authorizes a prescription", async () => {
    await doctor.goto("/doctor/patients/p_alex");
    await doctor.getByRole("button", { name: "New prescription" }).click();
    await doctor.getByLabel("Medication (fictional)").fill(RX);
    await doctor.getByRole("button", { name: "Authorize prescription" }).click();
    await expect(doctor.getByText("Authorized and sent (simulated transmission).")).toBeVisible();
  });

  const rx = pharm.locator("li").filter({ hasText: RX }).first();
  const press = async (name: string) => {
    const b = rx.getByRole("button", { name });
    await expect(b).toBeVisible({ timeout: 20_000 });
    await b.click();
  };

  await test.step("pharmacy receives and acknowledges: the agent stays asleep", async () => {
    await pharm.goto("/demo/pharmacy");
    await press("Receive prescription");
    await press("Acknowledge");
    await doctor.goto("/doctor");
    await expect(doctor.locator("li").filter({ hasText: RX }).filter({ hasText: "Draft by agent" })).toHaveCount(0);
  });

  await test.step("pharmacy reports a delay: nobody clicks AI, a draft appears for the doctor", async () => {
    await press("Report a delay");
    const card = doctor.locator("li").filter({ hasText: RX }).filter({ hasText: "Draft by agent" }).first();
    await expect(card).toBeVisible({ timeout: 90_000 });
    await expect(card.getByText("not sent")).toBeVisible();
    await card.getByText(/Agent log/).click();
    await expect(card.getByText("get_prescription_history", { exact: true }).first()).toBeVisible(); // a real tool call
    await expect(card.getByText("Handoff → Writer").first()).toBeVisible();
    await expect(card.getByText(/Approved by the Safety Reviewer/).first()).toBeVisible();
    await shot(doctor, "10-doctor-agent-draft");
    await checkA11y(doctor, "doctor overview with agent draft");

    // Not delivered yet: the patient has no message from the care team.
    await alex.goto("/patient/notifications");
    await expect(alex.getByText(/Message from your care team/)).toHaveCount(0);

    // The doctor edits the wording and approves.
    // The live agent room shows the same run, step by step.
    await doctor.goto("/doctor/agents");
    await expect(doctor.getByText("Woke up: pharmacy delayed").first()).toBeVisible();
    await expect(doctor.getByText("Handoff → Safety Reviewer").first()).toBeVisible();
    await shot(doctor, "13-doctor-agent-room");
    await doctor.goto("/doctor");
    await card.getByLabel(/Message to the patient/).fill("Your pharmacy is running late with this. We are calling them today.");
    await card.getByRole("button", { name: "Approve and send to patient" }).click();
    await expect(doctor.getByText("Sent to the patient.", { exact: true })).toBeVisible();
  });

  await test.step("the patient sees the clinician-approved message", async () => {
    await alex.goto("/patient/notifications");
    await expect(alex.getByText(/Message from your care team: Your pharmacy is running late/).first()).toBeVisible({ timeout: 30_000 });
    await shot(alex, "11-alex-care-team-message");
  });

  await test.step("the patient assistant shows exactly how it answered", async () => {
    await alex.goto("/patient/ask");
    await alex.getByRole("button", { name: "What is the status of my prescription?" }).click();
    await expect(alex.getByText(/Based on:/)).toBeVisible({ timeout: 60_000 });
    const trace = alex.getByText(/How the assistant worked this out/);
    await trace.click();
    await expect(alex.getByText("get_prescription_status").first()).toBeVisible();
    await shot(alex, "12-alex-assistant-trace");
    await checkA11y(alex, "assistant with trace");
  });

  writeReport("agents");
  expect(problems, problems.join("\n")).toEqual([]);
});
