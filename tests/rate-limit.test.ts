import { describe, expect, it } from "vitest";
import { PostgresRateLimiter } from "@/server/rate-limit";
import { hasDatabase, testDb } from "./db";

describe.skipIf(!hasDatabase)("PostgresRateLimiter", () => {
  const limiter = hasDatabase
    ? new PostgresRateLimiter(testDb())
    : (undefined as never);
  const policy = { capacity: 5, refillPerSecond: 0.001 };

  it("never admits more than capacity under concurrent load", async () => {
    const key = `burst:${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 25 }, () => limiter.consume(key, policy)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    const refused = results.find((r) => !r.allowed);
    expect(refused?.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills over time", async () => {
    const key = `refill:${Date.now()}`;
    const fast = { capacity: 1, refillPerSecond: 20 };
    expect((await limiter.consume(key, fast)).allowed).toBe(true);
    expect((await limiter.consume(key, fast)).allowed).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect((await limiter.consume(key, fast)).allowed).toBe(true);
  });
});
