import { defineConfig, devices } from "@playwright/test";
import functional from "./playwright.config";

export default defineConfig({
  ...functional,
  testDir: "./tests/display",
  fullyParallel: false,
  forbidOnly: true,
  // Cold-profile navigation and environment qualification share this deadline.
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "artifacts/display-e2e.json" }]],
  use: {
    ...functional.use,
    ...devices["Desktop Chrome"],
    channel: "chrome",
    headless: false,
    reducedMotion: "no-preference",
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "physical-chrome" }],
});
