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
    // Two tokens a second, so a token takes 500ms. The previous version used
    // twenty a second -- a token every 50ms -- and the second call below then
    // depended on two database round trips completing inside 50ms. It did
    // locally and failed on a slower CI runner, which is a flaky test rather
    // than a finding about the limiter.
    const slow = { capacity: 1, refillPerSecond: 2 };
    expect((await limiter.consume(key, slow)).allowed).toBe(true);
    // Immediately exhausted: nowhere near 500ms has passed.
    expect((await limiter.consume(key, slow)).allowed).toBe(false);
    // And comfortably past one token's worth of time, it admits again.
    await new Promise((r) => setTimeout(r, 800));
    expect((await limiter.consume(key, slow)).allowed).toBe(true);
  });
});
