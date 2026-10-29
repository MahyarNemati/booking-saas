import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end configuration.
 *
 * The app is built and started by Playwright, against a database the global
 * setup migrates and seeds. That is slower than pointing at a dev server but
 * it is the only arrangement that tests what is actually deployed: a server
 * component rendering slots, a client component posting a booking, and a
 * route handler writing it.
 */
const PORT = Number(process.env.E2E_PORT ?? 3210);
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/booking_e2e";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One worker: the tests book real slots in one shared diary, so running
  // them in parallel would have them competing for the same times. Honest
  // about the constraint rather than hiding it behind random slot picking.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    // A fixed browser zone, so a test asserting on a displayed time does not
    // depend on where it runs.
    timezoneId: "Europe/London",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      DATABASE_URL,
      AUTH_SECRET: "e2e-secret-at-least-thirty-two-chars",
      RATE_LIMIT_BACKEND: "postgres",
      LOG_LEVEL: "warn",
    },
  },
});
