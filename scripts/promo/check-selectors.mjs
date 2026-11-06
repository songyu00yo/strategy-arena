#!/usr/bin/env node
/** Unpaid tool-development check only. Its fixture footage is never a promo source. */
import { chromium } from "@playwright/test";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  cinematicClick,
  fillVideoSample,
  finishedShots,
  openRematch,
  otherCaseShots,
  wait,
} from "./ui.mjs";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:3302").origin;
const health = await fetch(`${base}/api/health`).then((r) => r.json());
if (health.version !== "demo" || health.commit !== "demo")
  throw new Error("Selector development requires an explicitly unpaid demo server");
const work = resolve("work/promo-selector-development-only");
mkdirSync(work, { recursive: true, mode: 0o700 });
const cache = resolve(work, "demo-record.json");
const cached =
  existsSync(cache) && !process.argv.includes("--fresh")
    ? JSON.parse(readFileSync(cache, "utf8"))
    : null;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  reducedMotion: "no-preference",
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
let latest;
page.on("response", async (r) => {
  if (!r.url().includes("/api/") || r.url().includes("/events")) return;
  const data = await r.json().catch(() => null);
  if (data?.id && Array.isArray(data.versions)) {
    latest = data;
    writeFileSync(cache, JSON.stringify(data), { mode: 0o600 });
  }
});
const shot = async (id, operation) => {
  if (id === "full-replay" && process.argv.includes("--skip-replay")) {
    console.log("UNPAID SELECTOR DEVELOPMENT: skipping already verified full-replay");
    return;
  }
  console.log(`UNPAID SELECTOR DEVELOPMENT: ${id}`);
  await operation();
  await page.screenshot({ path: resolve(work, `${id}.png`) });
};
const completed = async (number) => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const version = latest?.versions.find((v) => v.number === number && v.status === "completed");
    if (version) {
      await wait(7000);
      return version;
    }
    await wait(1000);
  }
  throw new Error("Demo did not finish in selector-check window");
};
try {
  if (cached?.id)
    await context.addInitScript(
      (id) => localStorage.setItem("strategy-arena:last-id", id),
      cached.id,
    );
  await page.goto(base, { waitUntil: "domcontentloaded" });
  if (!cached?.id) {
    await fillVideoSample(page, { demo: true });
    await cinematicClick(page, page.getByRole("button", { name: "让方案上场", exact: true }));
  }
  const first = await completed(1);
  await finishedShots(page, first, shot);
  const dialog = await openRematch(page, { demo: true });
  await cinematicClick(page, dialog.getByRole("button", { name: "按新条件重新推演" }));
  const second = await completed(2);
  await page.getByRole("combobox", { name: "选择推演版本" }).selectOption(first.id);
  await wait(1200);
  await page.getByRole("combobox", { name: "选择推演版本" }).selectOption(second.id);
  await otherCaseShots(page, shot);
  console.log("UNPAID SELECTOR DEVELOPMENT PASSED. No real calls or delivery footage.");
} finally {
  await page.screenshot({ path: resolve(work, "last-development-screen.png") }).catch(() => {});
  await context.close();
  await browser.close();
}
