// Records the README GIFs and screenshots from the REAL running product (no mock-ups).
//   1. Start the app on a spare port with a throwaway store:
//        pnpm build && CAREOS_STORE=memory APP_BASE_URL=http://localhost:3400 pnpm exec next start -p 3400
//   2. pnpm media            (needs Chrome and ffmpeg; the first scenario makes about a dozen real model calls)
//   3. Stop the server.
// Output goes to assets/readme/. Run it again after any rename or UI change.
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.MEDIA_BASE_URL ?? "http://localhost:3400";
const OUT = process.env.MEDIA_OUT ?? "assets/readme";
const TMP = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "careloop-media-"));
const SIZE = { width: 1440, height: 810 };
const pause = (p, ms = 1200) => p.waitForTimeout(ms);
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });

async function stage(name) {
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir: path.join(TMP, name), size: SIZE }, colorScheme: "light" });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/demo/stage`);
  const frame = (t) => page.frameLocator(`iframe[title^="${t} window"]`);
  const s = { ctx, page, doctor: frame("Doctor"), patient: frame("Patient"), pharm: frame("Pharmacy"), log: page.getByRole("region", { name: "Live agent log" }), win: (n) => page.getByRole("region", { name: n }) };
  await s.doctor.getByRole("heading", { name: "Case board" }).waitFor({ timeout: 90_000 });
  await s.patient.getByRole("heading", { name: /Your visit, Alex/ }).waitFor({ timeout: 90_000 });
  await s.pharm.getByRole("heading", { name: "Pharmacy simulator" }).waitFor({ timeout: 90_000 });
  return s;
}

/** Closes the recording (so the video is complete) and turns it into a GIF at a readable pace. */
async function finish(s, name, { width, fps, colors = 80, slow = 1.5 }) {
  const video = await s.page.video().path();
  await s.ctx.close();
  const vf = `fps=${fps},setpts=${slow}*PTS,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", video, "-vf", vf, "-loop", "0", path.join(OUT, `${name}.gif`)]);
  console.log(`${name}.gif  ${(fs.statSync(path.join(OUT, `${name}.gif`)).size / 1e6).toFixed(1)} MB`);
}

const shot = (target, name) => target.screenshot({ path: path.join(OUT, `${name}.png`) });

try {
  /* 1. The whole care cycle, with the agents working */
  {
    const s = await stage("cycle");
    s.page.once("dialog", (d) => d.accept());
    await s.page.getByRole("button", { name: "Start afresh" }).click();
    await s.page.getByText(/Cleared \d+ demo events/).waitFor({ timeout: 30_000 });
    await s.patient.getByText("No visit recorded yet").waitFor({ timeout: 60_000 });
    await pause(s.page, 1800);
    await s.doctor.getByText("Record this visit").waitFor();
    await pause(s.page, 1800);
    await s.doctor.getByRole("button", { name: "Create draft for review" }).click();
    await s.doctor.getByText("Review and approve the care plan").waitFor({ timeout: 90_000 });
    await pause(s.page, 1800);
    await s.doctor.getByRole("checkbox", { name: /I have reviewed this plan/ }).check();
    await pause(s.page, 800);
    await s.doctor.getByRole("button", { name: "Approve care plan" }).click();
    await s.patient.getByRole("heading", { name: "Your last visit" }).waitFor({ timeout: 30_000 });
    await pause(s.page, 2200);
    await s.doctor.getByText("Send a prescription").waitFor({ timeout: 30_000 });
    await pause(s.page, 1500);
    await s.doctor.getByRole("button", { name: "Authorize prescription" }).click();
    const rx = s.pharm.locator("li").filter({ hasText: "Antibiotic" }).first();
    await rx.waitFor({ timeout: 30_000 });
    await pause(s.page, 1200);
    await rx.getByRole("button", { name: "Receive prescription" }).click();
    await pause(s.page, 900);
    await rx.getByRole("button", { name: "Acknowledge" }).click();
    await pause(s.page, 900);
    await rx.getByRole("button", { name: "Report a delay" }).click();
    await s.log.getByText("Waiting for a clinician").first().waitFor({ timeout: 150_000 });
    await pause(s.page, 3500);
    await shot(s.page, "stage-agents");
    await shot(s.log, "agent-log");
    const card = s.doctor.locator("li").filter({ hasText: "Draft by agent" }).first();
    await card.waitFor({ timeout: 30_000 });
    await card.scrollIntoViewIfNeeded();
    await pause(s.page, 2000);
    await shot(s.win("Doctor window"), "doctor-proposal");
    await card.getByRole("button", { name: "Approve and send to patient" }).click();
    await pause(s.page, 1500);
    await s.win("Patient window").getByRole("button", { name: "Visit" }).click();
    await s.patient.getByText(/sent you a message about your prescription/).waitFor({ timeout: 30_000 });
    await pause(s.page, 2500);
    await shot(s.win("Patient window"), "patient-visit");
    await shot(s.page, "stage-final");
    await s.win("Doctor window").getByRole("button", { name: "Agent room" }).click();
    await s.doctor.getByRole("heading", { name: "Agent room", exact: true }).waitFor({ timeout: 30_000 });
    await pause(s.page, 2500);
    await shot(s.win("Doctor window"), "agent-room");
    await finish(s, "demo-cycle", { width: 960, fps: 6 });
  }

  /* 2. The plain-language visit (one model call), then home readings (no model) */
  {
    const s = await stage("readings");
    await s.patient.getByRole("button", { name: "Explain my visit" }).click();
    await s.patient.getByText("What to do").waitFor({ timeout: 90_000 });
    await pause(s.page, 3000);
    await shot(s.page, "stage-explainer");
    await s.win("Patient window").getByRole("button", { name: "Readings", exact: true }).click();
    await s.patient.getByRole("heading", { name: "Home readings" }).waitFor({ timeout: 60_000 });
    await pause(s.page, 1500);
    await s.patient.getByRole("button", { name: "Add reading" }).click();
    await pause(s.page, 1500);
    await s.patient.getByLabel("Value").fill("79");
    await pause(s.page, 600);
    await s.patient.getByRole("button", { name: "Add reading" }).click();
    await s.patient.getByText("Up 5 bpm from the previous reading.").waitFor({ timeout: 30_000 });
    await pause(s.page, 2000);
    await s.win("Doctor window").getByRole("button", { name: "Case board" }).click();
    await pause(s.page, 1500);
    await s.doctor.getByRole("button", { name: "Save range" }).click();
    await pause(s.page, 2000);
    await s.patient.getByLabel("Value").fill("118");
    await pause(s.page, 600);
    await s.patient.getByRole("button", { name: "Add reading" }).click();
    await s.doctor.getByText("Review a home reading outside your range").waitFor({ timeout: 30_000 });
    await pause(s.page, 3000);
    await shot(s.page, "stage-reading-flagged");
    await finish(s, "readings", { width: 860, fps: 7 });
  }

  /* 3. The assistant's safety gates: no model is called for either question */
  {
    const s = await stage("safety");
    s.page.once("dialog", (d) => d.accept());
    await s.page.getByRole("button", { name: "Start afresh" }).click();
    await s.page.getByText(/Cleared \d+ demo events/).waitFor({ timeout: 30_000 });
    await pause(s.page, 1200);
    await s.win("Patient window").getByRole("button", { name: "Ask", exact: true }).click();
    await s.patient.getByLabel("Your question").waitFor({ timeout: 30_000 });
    await pause(s.page, 1500);
    await s.patient.getByLabel("Your question").fill("I have chest pain");
    await pause(s.page, 800);
    await s.patient.getByRole("button", { name: "Send", exact: true }).click();
    await s.patient.getByText(/cannot assess symptoms/).waitFor({ timeout: 20_000 });
    await pause(s.page, 2500);
    await s.patient.getByLabel("Your question").fill("Is it okay to stop my antibiotic early?");
    await pause(s.page, 800);
    await s.patient.getByRole("button", { name: "Send", exact: true }).click();
    await s.patient.getByText("Sent to your care team").first().waitFor({ timeout: 20_000 });
    await pause(s.page, 2500);
    await shot(s.page, "stage-safety");
    await s.win("Doctor window").getByRole("button", { name: "Case board" }).click();
    const send = s.doctor.getByRole("button", { name: "Send answer" });
    await send.waitFor({ timeout: 30_000 });
    await send.scrollIntoViewIfNeeded();
    await pause(s.page, 2000);
    await send.click();
    await s.patient.getByText("Answered by your care team").first().waitFor({ timeout: 30_000 });
    await pause(s.page, 2500);
    await finish(s, "safety-gates", { width: 860, fps: 7 });
  }
} finally {
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
