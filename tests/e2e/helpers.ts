import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

export const SHOTS = process.env.E2E_SHOTS ?? "test-results/shots";
fs.mkdirSync(SHOTS, { recursive: true });

export const problems: string[] = [];
export const a11y: { page: string; id: string; impact: string; help: string; nodes: number; sample: string }[] = [];

/** Records anything a user would experience as broken: script errors, console errors, failed API calls. */
export function watch(page: Page, name: string) {
  page.on("pageerror", (e) => problems.push(`[${name}] script error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`[${name}] console error: ${m.text().slice(0, 220)}`);
  });
  page.on("response", (r) => {
    const url = new URL(r.url());
    if (r.status() >= 400 && !url.pathname.startsWith("/_next/") && url.pathname !== "/favicon.ico") {
      problems.push(`[${name}] HTTP ${r.status()} ${r.request().method()} ${url.pathname}`);
    }
  });
}

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/** Horizontal scrolling on a phone is a layout bug. */
export async function checkOverflow(page: Page, label: string) {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (extra > 1) problems.push(`[${label}] page is ${extra}px wider than the screen (horizontal scroll)`);
}

export async function checkA11y(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  for (const v of r.violations) {
    a11y.push({ page: label, id: v.id, impact: v.impact ?? "n/a", help: v.help, nodes: v.nodes.length, sample: (v.nodes[0]?.html ?? "").slice(0, 140) });
  }
}

export async function signIn(page: Page, who: string, url: RegExp) {
  await page.goto("/");
  await page.getByRole("button", { name: `Continue as ${who}` }).click();
  await page.waitForURL(url, { timeout: 30_000 });
}

export function writeReport(name: string) {
  fs.writeFileSync(path.join(SHOTS, `${name}-report.json`), JSON.stringify({ problems, a11y }, null, 2));
}
