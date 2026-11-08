import { expect, test } from "@playwright/test";
import { problems, shot, watch, writeReport } from "./helpers";

/** Home readings (patient adds, doctor sets a range, a reading outside it is flagged) and the visit explainer, on one screen. Real models. */
test.use({ viewport: { width: 1509, height: 821 } });

test("home readings and the plain-language visit, from the Demo stage", async ({ page }) => {
  watch(page, "stage");
  await page.goto("/demo/stage");
  const doctor = page.frameLocator('iframe[title^="Doctor window"]');
  const patient = page.frameLocator('iframe[title^="Patient window"]');
  const pharm = page.frameLocator('iframe[title^="Pharmacy window"]');
  const win = (name: string) => page.getByRole("region", { name });
  await expect(doctor.getByRole("heading", { name: "Case board" })).toBeVisible({ timeout: 90_000 });

  await test.step("start afresh, then load the sample plan so there is a visit to explain", async () => {
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Start afresh" }).click();
    await expect(page.getByText(/Cleared \d+ demo events/)).toBeVisible({ timeout: 30_000 });
    await pharm.getByRole("button", { name: "Load sample data" }).click();
    await expect(patient.getByText(/Knee surgery/i).first()).toBeVisible({ timeout: 60_000 });
  });

  await test.step("the patient gets the visit in plain words, built only from the approved plan", async () => {
    await patient.getByRole("button", { name: "Explain my visit" }).click();
    await expect(patient.getByText("What to do")).toBeVisible({ timeout: 90_000 });
    await expect(patient.getByText(/Written by an AI assistant from your approved care plan only/)).toBeVisible();
    await expect(patient.locator("body")).not.toContainText(/get_[a-z_]+|needs_clarification/);
    await shot(page, "30-stage-visit-explained");
  });

  await test.step("the patient adds home readings (pre-filled), and the trend is described without judging", async () => {
    await win("Patient window").getByRole("button", { name: "Readings" }).click();
    await expect(patient.getByRole("heading", { name: "Home readings" })).toBeVisible({ timeout: 30_000 });
    await expect(patient.getByLabel("Value")).toHaveValue("74"); // pre-filled
    await patient.getByRole("button", { name: "Add reading" }).click();
    await expect(patient.getByText("Reading saved. Your care team can see it.")).toBeVisible();
    await patient.getByLabel("Value").fill("79");
    await patient.getByRole("button", { name: "Add reading" }).click();
    await expect(patient.getByText("Up 5 bpm from the previous reading.")).toBeVisible({ timeout: 30_000 });
    await expect(patient.locator("li").filter({ hasText: "Resting heart rate" })).not.toContainText(/normal|abnormal|serious|dangerous/i); // the app only describes change
  });

  await test.step("the doctor sets a range, the patient adds a reading outside it, and it becomes the doctor's next action", async () => {
    await doctor.getByRole("button", { name: "Save range" }).click(); // pre-filled 50 to 100 for heart rate
    await expect(doctor.getByText("Range saved. Readings outside it will be flagged for you.")).toBeVisible();
    await patient.getByLabel("Value").fill("118");
    await patient.getByRole("button", { name: "Add reading" }).click();
    await expect(doctor.getByText("Review a home reading outside your range")).toBeVisible({ timeout: 30_000 });
    await expect(doctor.getByText(/is above 100, outside the range you set/).first()).toBeVisible();
    await shot(page, "31-stage-reading-flagged");
  });

  await test.step("a question the assistant forwarded is answered by the doctor with the pre-filled reply, and the patient sees it", async () => {
    await win("Patient window").getByRole("button", { name: "Ask", exact: true }).click();
    await patient.getByLabel("Your question").fill("Is it okay to stop my antibiotic early?");
    await patient.getByRole("button", { name: "Send", exact: true }).click();
    await expect(patient.getByText("Sent to your care team").first()).toBeVisible({ timeout: 20_000 });
    await win("Doctor window").getByRole("button", { name: "Case board" }).click();
    await doctor.getByRole("button", { name: "Send answer" }).click(); // the reply box is pre-filled; sending it must work
    await expect(doctor.getByText("Answer sent to the patient.")).toBeVisible({ timeout: 20_000 });
  });

  writeReport("features");
  expect(problems, problems.join("\n")).toEqual([]);
});
