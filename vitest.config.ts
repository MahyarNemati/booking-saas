import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // The files share one Postgres database, created by the global setup, and
    // some of what is under test is deliberately global: the reminder worker
    // claims everything that is due, because that is what a worker should do.
    // Run in parallel, one file's bookings become another file's due
    // reminders, and the suite fails about one run in three for reasons that
    // have nothing to do with the code.
    //
    // A database per file would allow parallelism and cost more setup time
    // than it saves -- the whole suite is a few seconds.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
