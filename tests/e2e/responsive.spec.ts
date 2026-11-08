import { BRAND } from "../../src/lib/brand";
import { expect, test } from "@playwright/test";
import { a11y, checkA11y, checkOverflow, problems, shot, signIn, watch, writeReport } from "./helpers";

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 820, height: 1180 };

test.describe("phone: the patient portal", () => {
  test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

  test("every patient page fits the screen, shows the bottom navigation and has no errors", async ({ page }) => {
    watch(page, "phone");
    await signIn(page, "Alex Rivera", /\/patient/);
    const pages: [string, RegExp][] = [
      ["/patient", /Good (morning|afternoon|evening)/],
      ["/patient/plan", /My care plan/],
      ["/patient/medications", /Medications/],
      ["/patient/timeline", /Care timeline/],
      ["/patient/ask", new RegExp(`Ask ${BRAND.name}`)],
      ["/patient/notifications", /Updates/],
    ];
    for (const [url, heading] of pages) {
      await page.goto(url);
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("navigation", { name: "Primary" }).last()).toBeVisible();
      await page.waitForTimeout(600);
      await shot(page, `phone${url.replace(/\//g, "-")}`);
      await checkOverflow(page, `phone ${url}`);
      await checkA11y(page, `phone ${url}`);
    }
    // Tap target size: the main buttons and nav links should be comfortable to hit.
    await page.goto("/patient");
    const small = await page.evaluate(() =>
      [...document.querySelectorAll("a, button")]
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => ({ el: (el.textContent ?? "").trim().slice(0, 30) || el.getAttribute("aria-label") || el.tagName, h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) }))
        .filter((x) => x.h < 40 || x.w < 40)
        .slice(0, 8),
    );
    if (small.length) problems.push(`[phone /patient] small tap targets: ${JSON.stringify(small)}`);
    writeReport("phone");
    console.log(`\nPHONE PROBLEMS (${problems.length}):\n${problems.map((p) => "  " + p).join("\n") || "  none"}`);
    console.log(`PHONE ACCESSIBILITY (${a11y.length}):\n${a11y.map((v) => `  [${v.impact}] ${v.page}: ${v.id} x${v.nodes} - ${v.help}`).join("\n") || "  none"}`);
    expect(problems).toEqual([]);
  });
});

for (const [label, viewport, mobile] of [["tablet", TABLET, false], ["phone", PHONE, true]] as const) {
  test.describe(`${label}: the doctor portal and pharmacy console`, () => {
    test.use({ viewport, isMobile: mobile, hasTouch: mobile });

    test("pages fit the screen and have no errors", async ({ page }) => {
      watch(page, `doctor ${label}`);
      await signIn(page, "Dr. Chen", /\/doctor/);
      for (const [url, heading] of [
        ["/doctor", "Overview"],
        ["/doctor/patients", "Patients"],
        ["/doctor/patients/p_alex", "Alex Rivera"],
        ["/doctor/prescriptions", "Prescriptions"],
        ["/doctor/gaps", "Care gaps"],
        ["/doctor/analytics", "Analytics"],
        ["/doctor/agents", "Agent room"],
      ] as const) {
        await page.goto(url);
        await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(800);
        await shot(page, `${label}-doctor${url.replace(/\//g, "-").replace("-doctor", "")}`);
        await checkOverflow(page, `${label} ${url}`);
        await checkA11y(page, `${label} ${url}`);
      }
      console.log(`\n${label.toUpperCase()} DOCTOR PROBLEMS: ${problems.length ? "\n" + problems.map((p) => "  " + p).join("\n") : "none"}`);
      expect(problems).toEqual([]);
    });
  });
}
