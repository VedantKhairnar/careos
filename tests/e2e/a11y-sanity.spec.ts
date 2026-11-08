import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

// Zero accessibility violations on every page is only meaningful if the scanner can find a problem when there is one.
test("the accessibility scanner really runs: it flags a page with known problems", async ({ page }) => {
  await page.setContent('<html lang="en"><head><title>x</title></head><body><main><img src="x.png"><button></button><input></main></body></html>');
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const ids = r.violations.map((v) => v.id);
  expect(ids).toEqual(expect.arrayContaining(["image-alt", "button-name", "label"]));
  expect(r.passes.length).toBeGreaterThan(0);
});
