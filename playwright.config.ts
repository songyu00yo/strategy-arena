import { defineConfig, devices } from "@playwright/test";
import { e2eAddress } from "./scripts/test-address.mjs";

const { origin } = e2eAddress();

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ["list"],
    ["html", { open: "never" }],
    ["junit", { outputFile: "test-results/e2e.xml" }],
  ],
  use: {
    baseURL: origin,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.PLAYWRIGHT_CHANNEL === "chrome" ? "chrome" : undefined,
      },
    },
  ],
  webServer: {
    command: "node scripts/start-e2e-server.mjs",
    url: origin,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      MODEL_API_KEY: "",
      ARENA_ACCESS_CODE: "e2e-only-access-code",
      ARENA_PUBLIC_DEMO: "false",
      ARENA_PUBLIC_ORIGIN: origin,
      ARENA_WORKER_ENABLED: "false",
      ARENA_SESSION_SECRET: "e2e-only-session-secret-never-use-in-production-12345678",
      ARENA_DATABASE_PATH: "./test-results/e2e.sqlite",
      ARENA_GLOBAL_BUDGET_CNY: "1",
      ARENA_DAILY_VISITOR_LIMIT: "100",
    },
  },
});
