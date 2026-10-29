import { sql } from "drizzle-orm";
import type { Database } from "@/db/client";

export interface RateLimitPolicy {
  /** Bucket size: the burst a caller may spend at once. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  /** Milliseconds until enough tokens exist for the request that was refused. */
  retryAfterMs: number;
}

export interface RateLimiter {
  consume(
    key: string,
    policy: RateLimitPolicy,
    cost?: number,
  ): Promise<RateLimitResult>;
}

function result(
  policy: RateLimitPolicy,
  tokens: number,
  allowed: boolean,
  cost: number,
): RateLimitResult {
  const deficit = allowed ? 0 : cost - tokens;
  return {
    allowed,
    remaining: Math.max(0, Math.floor(tokens)),
    limit: policy.capacity,
    retryAfterMs:
      deficit > 0 ? Math.ceil((deficit / policy.refillPerSecond) * 1000) : 0,
  };
}

/** Token bucket held in process memory. Suitable for a single instance and for tests. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  async consume(
    key: string,
    policy: RateLimitPolicy,
    cost = 1,
  ): Promise<RateLimitResult> {
    const now = this.now();
    const prev = this.buckets.get(key);
    const elapsed = prev ? Math.max(0, now - prev.at) / 1000 : 0;
    const available = prev
      ? Math.min(
          policy.capacity,
          prev.tokens + elapsed * policy.refillPerSecond,
        )
      : policy.capacity;
    const allowed = available >= cost;
    const tokens = allowed ? available - cost : available;

    this.buckets.delete(key);
    this.buckets.set(key, { tokens, at: now });
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    return result(policy, tokens, allowed, cost);
  }
}

/**
 * Token bucket in Postgres. Refill and spend happen in one upsert, so
 * concurrent requests across instances serialize on the row lock and the
 * bucket can never be overdrawn.
 */
export class PostgresRateLimiter implements RateLimiter {
  constructor(private readonly db: Database) {}

  async consume(
    key: string,
    policy: RateLimitPolicy,
    cost = 1,
  ): Promise<RateLimitResult> {
    const cap = policy.capacity;
    const rate = policy.refillPerSecond;
    const refilled = sql`least(${cap}::float8, r.tokens + extract(epoch from (clock_timestamp() - r.updated_at)) * ${rate}::float8)`;
    const rows = await this.db.execute<{
      tokens: number;
      allowed: boolean;
    }>(sql`
      insert into rate_limits as r (key, tokens, allowed, updated_at)
      values (${key}, greatest(${cap}::float8 - ${cost}::float8, 0), ${cost} <= ${cap}, clock_timestamp())
      on conflict (key) do update set
        tokens = case when ${refilled} >= ${cost}::float8 then ${refilled} - ${cost}::float8 else ${refilled} end,
        allowed = ${refilled} >= ${cost}::float8,
        updated_at = clock_timestamp()
      returning tokens, allowed
    `);
    const row = rows[0];
    if (!row) throw new Error("rate limit upsert returned no row");
    return result(policy, Number(row.tokens), row.allowed, cost);
  }
}

export const POLICIES = {
  api: { capacity: 60, refillPerSecond: 1 },
  signIn: { capacity: 5, refillPerSecond: 1 / 60 },
  invite: { capacity: 20, refillPerSecond: 20 / 3600 },
} satisfies Record<string, RateLimitPolicy>;
