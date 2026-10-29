/**
 * Migrates and seeds the end-to-end database before the browser starts.
 *
 * Done here rather than in a test so a failure is reported as setup rather
 * than as a mysteriously empty page.
 */

import { execFileSync } from "node:child_process";

export default function globalSetup(): void {
  const url =
    process.env.E2E_DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/booking_e2e";

  const env = {
    ...process.env,
    DATABASE_URL: url,
    AUTH_SECRET: "e2e-secret-at-least-thirty-two-chars",
  };
  const run = (script: string) =>
    execFileSync("npx", ["tsx", script], { env, stdio: "inherit" });

  run("src/db/migrate.ts");
  run("src/db/seed.ts");
}
