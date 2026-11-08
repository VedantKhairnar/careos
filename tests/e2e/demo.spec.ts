import { expect, test } from "@playwright/test";
import { a11y, checkA11y, checkOverflow, problems, shot, signIn, watch, writeReport } from "./helpers";

/**
 * The live demo, end to end, in a real browser: a doctor, a patient and the pharmacy simulator in THREE TABS OF
 * ONE BROWSER (one shared cookie jar, which is exactly what used to break). Uses the real Gemini API.
 */
// A unique medicine per run: the database keeps state between runs, so a fixed name would find an old prescription.
const RX = `Demo-Rx-${Date.now().toString(36)}`;

test("live demo across three tabs in one browser", async ({ context }) => {
  const doctor = await context.newPage();
  const alex = await context.newPage();
  const pharm = await context.newPage();
  watch(doctor, "doctor");
  watch(alex, "alex");
  watch(pharm, "pharmacy");

  await test.step("everyone signs in, one after another, in the same browser", async () => {
    await signIn(doctor, "Dr. Chen", /\/doctor/);
    await signIn(alex, "Alex Rivera", /\/patient/);
    await signIn(pharm, "Pharmacy simulator", /\/demo\/pharmacy/);
    // The earlier sign-ins must still work after the later ones.
    await doctor.goto("/doctor");
    await expect(doctor.getByRole("heading", { name: "Overview" })).toBeVisible();
    await alex.goto("/patient");
    await expect(alex.getByRole("heading", { name: /Good (morning|afternoon|evening), Alex/ })).toBeVisible();
  });

  await test.step("Start afresh empties the demo, so everything after is created live", async () => {
    await pharm.goto("/demo/pharmacy");
    pharm.once("dialog", (d) => d.accept()); // the confirmation prompt
    await pharm.getByRole("button", { name: "Start afresh" }).click();
    await expect(pharm.getByText(/Cleared \d+ demo events/)).toBeVisible({ timeout: 30_000 });
    await expect(pharm.getByText("No prescriptions have been sent to the pharmacy yet")).toBeVisible();
    await alex.goto("/patient");
    await expect(alex.getByText("No prescriptions yet")).toBeVisible();
    await expect(alex.getByText("Nothing scheduled right now")).toBeVisible();
    await doctor.goto("/doctor/patients");
    await expect(doctor.getByText("0 approved plans").first()).toBeVisible();
    await shot(alex, "00-alex-home-after-start-afresh");
    await checkA11y(alex, "patient home (empty)");
  });

  await test.step("doctor drafts a plan from visit notes with AI, then reviews and approves it", async () => {
    await doctor.goto("/doctor/patients");
    await doctor.getByRole("link", { name: /Alex Rivera/ }).click();
    await expect(doctor.getByRole("heading", { name: "Alex Rivera" })).toBeVisible();
    await doctor.getByRole("button", { name: /Draft from my visit notes/ }).click();
    await doctor.getByLabel("Visit notes").fill("Fictional demo. Rest for a week, keep the dressing dry. Demo-Med-X 1 tablet at 8am and 8pm starting 2026-11-08. Review visit on 2026-11-22.");
    await doctor.getByRole("button", { name: "Create draft for review" }).click();
    await expect(doctor.getByText("Draft created. Review it below before approving.")).toBeVisible({ timeout: 60_000 });
    const pending = doctor.locator("li").filter({ hasText: "Awaiting approval" }).first();
    await expect(pending).toBeVisible();
    await expect(pending.getByText("an AI assistant")).toBeVisible(); // labelled as AI-drafted
    await shot(doctor, "01-doctor-ai-draft-awaiting-approval");
    await pending.getByRole("checkbox", { name: /I have reviewed this plan/ }).check();
    await pending.getByRole("button", { name: "Approve care plan" }).click();
    await expect(doctor.getByText("Approved. The patient can now see this plan.")).toBeVisible();
    await checkOverflow(doctor, "doctor patient detail");
    await checkA11y(doctor, "doctor patient detail");
  });

  await test.step("the patient sees the approved medicines and reports a dose", async () => {
    await alex.goto("/patient/medications");
    await expect(alex.getByText(/Demo-Med-X/i).first()).toBeVisible({ timeout: 30_000 });
    const dose = alex.locator("li").filter({ hasText: /Demo-Med-X/i }).getByRole("button", { name: "Taken" }).first();
    await expect(dose).toBeVisible();
    await dose.click();
    await expect(alex.getByText("You reported: taken").first()).toBeVisible();
    await shot(alex, "02-alex-medications-dose-reported");
    await checkA11y(alex, "patient medications");
  });

  await test.step("doctor authorizes a prescription", async () => {
    await doctor.goto("/doctor/patients/p_alex");
    await doctor.getByRole("button", { name: "New prescription" }).click();
    await doctor.getByLabel("Medication (fictional)").fill(RX);
    await doctor.getByRole("button", { name: "Authorize prescription" }).click();
    await expect(doctor.getByText("Authorized and sent (simulated transmission).")).toBeVisible();
    await expect(doctor.locator("li").filter({ hasText: RX }).first()).toBeVisible();
  });

  const rx = pharm.locator("li").filter({ hasText: RX }).first();
  const press = async (name: string) => {
    const b = rx.getByRole("button", { name });
    await expect(b).toBeVisible({ timeout: 20_000 });
    await b.click();
  };

  await test.step("the pharmacy receives, acknowledges, then reports a delay (a different tab, same browser)", async () => {
    await pharm.goto("/demo/pharmacy");
    await expect(rx).toBeVisible({ timeout: 20_000 });
    await press("Receive prescription");
    await press("Acknowledge");
    await press("Report a delay");
    await expect(rx.getByText("Delayed").first()).toBeVisible();
    await shot(pharm, "03-pharmacy-console-delayed");
    await checkOverflow(pharm, "pharmacy console");
    await checkA11y(pharm, "pharmacy console");
  });

  await test.step("the patient is told truthfully about the delay", async () => {
    await alex.goto("/patient");
    const card = alex.locator("li").filter({ hasText: RX }).first();
    await expect(card.getByText("Delayed")).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText(/reported a delay/i)).toBeVisible();
    await shot(alex, "04-alex-home-delay");
    await alex.goto("/patient/notifications");
    await expect(alex.getByText("Pharmacy reported a delay").first()).toBeVisible();
    await expect(alex.getByText("Important").first()).toBeVisible();
    await checkA11y(alex, "patient updates");
  });

  await test.step("time passes (demo clock), the care gap appears for the doctor and closes when followed up", async () => {
    await pharm.getByRole("button", { name: "+60 min" }).click();
    await doctor.goto("/doctor/gaps");
    const gap = doctor.locator("li").filter({ hasText: "Delay not followed up" }).first();
    await expect(gap).toBeVisible({ timeout: 30_000 });
    await shot(doctor, "05-doctor-care-gap");
    await gap.getByRole("button", { name: "Log follow-up" }).click();
    await expect(doctor.getByText("Follow-up logged.")).toBeVisible();
    await expect(doctor.locator("li").filter({ hasText: "Delay not followed up" })).toHaveCount(0, { timeout: 30_000 });
    await checkA11y(doctor, "doctor care gaps");
  });

  await test.step("the pharmacy asks a question, the doctor answers it, then it is ready and picked up", async () => {
    await press("Start processing");
    await press("Ask clinician a question");
    await expect(rx.getByText("Waiting for the clinician to answer the question.")).toBeVisible();
    await doctor.goto("/doctor");
    const resolve = doctor.getByRole("button", { name: "Resolve pharmacy question" });
    await expect(resolve).toBeVisible({ timeout: 30_000 });
    await shot(doctor, "06-doctor-overview-pharmacy-question");
    await resolve.click();
    await expect(doctor.getByText("Recorded that you answered the pharmacy.")).toBeVisible();
    await press("Mark ready for pickup");
    await press("Confirm pickup");
    await expect(rx.getByText("Picked up").first()).toBeVisible();
    await alex.goto("/patient");
    await expect(alex.locator("li").filter({ hasText: RX }).first().getByText("Picked up").first()).toBeVisible({ timeout: 30_000 });
  });

  await test.step("the patient asks the assistant (real Gemini)", async () => {
    await alex.goto("/patient/ask");
    const send = async (text: string) => {
      await alex.getByLabel("Your question").fill(text);
      await alex.getByRole("button", { name: "Send", exact: true }).click();
    };
    await send("What medicines should I take today?");
    await expect(alex.getByText(/Based on:/).first()).toBeVisible({ timeout: 60_000 });
    // The patient must never be shown an internal code or field name.
    await expect(alex.locator("body")).not.toContainText(/needs_clarification|scheduleConfirmed|stillNeededFromCareTeam|get_[a-z_]+_schedule/);
    await send("I have chest pain");
    await expect(alex.getByText(/CareOS cannot assess symptoms/)).toBeVisible({ timeout: 20_000 });
    await send("Is it okay to stop my antibiotic early?");
    await expect(alex.getByText("Sent to your care team").first()).toBeVisible({ timeout: 60_000 });
    await shot(alex, "07-alex-ask");
    await checkOverflow(alex, "patient ask");
    await checkA11y(alex, "patient ask");
  });

  await test.step("the doctor answers the patient's question and the patient sees the answer", async () => {
    await doctor.goto("/doctor");
    const q = doctor.locator("li").filter({ hasText: /antibiotic/i }).filter({ has: doctor.getByRole("button", { name: "Send answer" }) }).first();
    await expect(q).toBeVisible({ timeout: 30_000 });
    await q.getByLabel("Your answer").fill("Please keep taking it until your review visit.");
    await q.getByRole("button", { name: "Send answer" }).click();
    await expect(doctor.getByText("Answer sent to the patient.")).toBeVisible();
    await alex.goto("/patient/ask");
    await expect(alex.getByText("Please keep taking it until your review visit.").first()).toBeVisible({ timeout: 30_000 });
    await expect(alex.getByText("Answered by your care team").first()).toBeVisible();
  });

  await test.step("analytics and agent activity are real", async () => {
    await doctor.goto("/doctor/analytics");
    await expect(doctor.getByRole("heading", { name: "Analytics" })).toBeVisible();
    await expect(doctor.getByText("Events recorded")).toBeVisible({ timeout: 30_000 });
    await expect(doctor.getByText("Results identical")).toBeVisible();
    await shot(doctor, "08-doctor-analytics");
    await checkOverflow(doctor, "doctor analytics");
    await checkA11y(doctor, "doctor analytics");
    await doctor.goto("/doctor/agents");
    await expect(doctor.getByText("Model calls")).toBeVisible();
    await expect(doctor.getByText("get_medication_schedule").first()).toBeVisible({ timeout: 30_000 });
    await shot(doctor, "09-doctor-agent-activity");
    await checkA11y(doctor, "doctor agent activity");
  });

  await test.step("reset the demo clock", async () => {
    await pharm.getByRole("button", { name: "Reset" }).click();
  });

  writeReport("demo");
  console.log(`\nPROBLEMS (${problems.length}):\n${problems.map((p) => "  " + p).join("\n") || "  none"}`);
  console.log(`\nACCESSIBILITY (${a11y.length}):\n${a11y.map((v) => `  [${v.impact}] ${v.page}: ${v.id} x${v.nodes} - ${v.help}`).join("\n") || "  none"}`);
  expect(problems, "console errors, failed requests or layout overflow").toEqual([]);
});
