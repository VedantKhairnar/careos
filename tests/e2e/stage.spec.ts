import { expect, test } from "@playwright/test";
import { problems, shot, watch, writeReport } from "./helpers";

/**
 * The whole demo from ONE tab: the Demo stage shows doctor, patient and pharmacy as live windows next to the agents' log.
 * Uses real Gemini. Presses Start afresh, so it clears the demo data of whatever server it runs against.
 */
const RX = "Demo-Antibiotic";
test.use({ viewport: { width: 1920, height: 1080 } });

test("the whole care cycle from one screen, with the agents' log beside it", async ({ page }) => {
  watch(page, "stage");
  await page.goto("/demo/stage");
  const doctor = page.frameLocator('iframe[title^="Doctor window"]');
  const patient = page.frameLocator('iframe[title^="Patient window"]');
  const pharm = page.frameLocator('iframe[title^="Pharmacy window"]');
  const log = page.getByRole("region", { name: "Live agent log" });

  await test.step("three people are signed in at once, in one tab", async () => {
    await expect(doctor.getByRole("heading", { name: "Case board" })).toBeVisible({ timeout: 90_000 });
    await expect(patient.getByRole("heading", { name: /Your visit, Alex/ })).toBeVisible({ timeout: 90_000 });
    await expect(pharm.getByRole("heading", { name: "Pharmacy simulator" })).toBeVisible({ timeout: 90_000 });
  });

  await test.step("Start afresh", async () => {
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Start afresh" }).click();
    await expect(page.getByText(/Cleared \d+ demo events/)).toBeVisible({ timeout: 30_000 });
    await expect(patient.getByText("No visit recorded yet")).toBeVisible({ timeout: 60_000 });
  });

  await test.step("doctor: AI draft from visit notes, then a human approves", async () => {
    await expect(doctor.getByText("Record this visit")).toBeVisible({ timeout: 30_000 }); // the board tells the doctor what to do
    await expect(doctor.getByLabel("Visit notes")).toHaveValue(/Fictional demo visit for Alex Rivera.*Demo-Antibiotic.*9am and 9pm/); // pre-filled: nothing to type
    await doctor.getByRole("button", { name: "Create draft for review" }).click();
    await expect(log.getByText("Clinician asked for a care-plan draft from visit notes").first()).toBeVisible({ timeout: 60_000 });
    await expect(doctor.getByText("Review and approve the care plan")).toBeVisible({ timeout: 60_000 });
    await doctor.getByRole("checkbox", { name: /I have reviewed this plan/ }).check();
    await doctor.getByRole("button", { name: "Approve care plan" }).click();
    await expect(doctor.getByText("Approved. The patient can now see this plan.")).toBeVisible();
    await expect(patient.getByText("Your last visit")).toBeVisible({ timeout: 30_000 });
  });

  await test.step("patient reports a dose", async () => {
    await patient.getByRole("link", { name: "Medications" }).first().click();
    const dose = patient.locator("li").filter({ hasText: /Demo-Antibiotic|Demo-Analgesic/i }).getByRole("button", { name: "Taken" }).first();
    await expect(dose).toBeVisible({ timeout: 30_000 });
    await dose.click();
    await expect(patient.getByText("You reported: taken").first()).toBeVisible();
  });

  await test.step("doctor authorizes a prescription; pharmacy receives and acknowledges", async () => {
    await expect(doctor.getByText("Send a prescription")).toBeVisible({ timeout: 30_000 });
    await expect(doctor.getByLabel("Medication (fictional)")).toHaveValue("Demo-Antibiotic (fictional)"); // pre-filled
    await doctor.getByRole("button", { name: "Authorize prescription" }).click();
    await expect(doctor.getByText("Authorized and sent (simulated transmission).")).toBeVisible();
    const rx = pharm.locator("li").filter({ hasText: RX }).first();
    await expect(rx).toBeVisible({ timeout: 30_000 });
    await rx.getByRole("button", { name: "Receive prescription" }).click();
    await rx.getByRole("button", { name: "Acknowledge" }).click();
  });

  await test.step("pharmacy reports a delay: the agents wake up and their work is visible beside the windows", async () => {
    await pharm.locator("li").filter({ hasText: RX }).first().getByRole("button", { name: "Report a delay" }).click();
    await expect(log.getByText("Woke up: pharmacy delayed").first()).toBeVisible({ timeout: 30_000 });
    await expect(log.getByText("Handoff → Writer").first()).toBeVisible({ timeout: 90_000 });
    await expect(log.getByText(/Approved by the Safety Reviewer/).first()).toBeVisible({ timeout: 90_000 });
    await expect(log.getByText("Waiting for a clinician").first()).toBeVisible({ timeout: 90_000 });
    await shot(page, "20-stage-agents-working");
  });

  await test.step("a human approves and the patient is told", async () => {
    const card = doctor.locator("li").filter({ hasText: RX }).filter({ hasText: "Draft by agent" }).first();
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.getByRole("button", { name: "Approve and send to patient" }).click();
    await page.getByRole("region", { name: "Patient window" }).getByRole("button", { name: "Visit" }).click();
    await expect(patient.getByText("Pharmacy reported a delay").first()).toBeVisible({ timeout: 30_000 }); // the status bar, on the home page
    await expect(patient.getByText(/Your doctor reviewed a note prepared by the assistants and sent you a message/)).toBeVisible({ timeout: 30_000 });
    await patient.getByRole("link", { name: /Updates/ }).first().click();
    await expect(patient.getByText(/Message from your care team/).first()).toBeVisible({ timeout: 30_000 });
    await shot(page, "21-stage-patient-told");
  });

  writeReport("stage");
  expect(problems, problems.join("\n")).toEqual([]);
});
