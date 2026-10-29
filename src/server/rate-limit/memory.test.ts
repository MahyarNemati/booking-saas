import { describe, expect, it } from "vitest";
import { MemoryRateLimiter } from "./index";

const policy = { capacity: 3, refillPerSecond: 1 };

describe("MemoryRateLimiter", () => {
  it("allows a burst up to capacity, then refuses with a retry hint", async () => {
    const now = 0;
    const rl = new MemoryRateLimiter(() => now);
    for (let i = 0; i < 3; i += 1) expect((await rl.consume("k", policy)).allowed).toBe(true);
    const refused = await rl.consume("k", policy);
    expect(refused).toMatchObject({ allowed: false, remaining: 0, limit: 3 });
    expect(refused.retryAfterMs).toBe(1000);
  });

  it("refills at the configured rate without exceeding capacity", async () => {
    let now = 0;
    const rl = new MemoryRateLimiter(() => now);
    for (let i = 0; i < 3; i += 1) await rl.consume("k", policy);
    now = 1500;
    expect((await rl.consume("k", policy)).allowed).toBe(true);
    expect((await rl.consume("k", policy)).allowed).toBe(false);
    now = 60_000;
    expect((await rl.consume("k", policy)).remaining).toBe(2);
  });

  it("keeps buckets independent and evicts the least recently used", async () => {
    const rl = new MemoryRateLimiter(() => 0, 2);
    await rl.consume("a", policy, 3);
    await rl.consume("b", policy, 3);
    await rl.consume("c", policy, 3);
    expect((await rl.consume("a", policy)).allowed).toBe(true);
    expect((await rl.consume("c", policy)).allowed).toBe(false);
  });
});
