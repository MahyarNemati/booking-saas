import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Tx } from "./client";

export const TENANT_ROLE = "app_tenant";

export interface TenantContext {
  orgId: string | null;
  userId?: string | null;
}

const uuid = z.uuid();

/**
 * Drops the current transaction to the unprivileged tenant role and pins the
 * org and user settings that the RLS policies read. Both are transaction
 * local, so they cannot leak to the next borrower of a pooled connection.
 */
export async function enterTenant(tx: Tx, ctx: TenantContext): Promise<void> {
  const orgId = ctx.orgId ? uuid.parse(ctx.orgId) : "";
  const userId = ctx.userId ? uuid.parse(ctx.userId) : "";
  await tx.execute(
    sql`select set_config('app.current_org', ${orgId}, true), set_config('app.current_user', ${userId}, true)`,
  );
  await tx.execute(sql.raw(`set local role ${TENANT_ROLE}`));
}

/**
 * Runs `fn` in a transaction scoped to one organization. Postgres filters
 * every read and rejects every write that targets another org, regardless of
 * what the query itself says.
 */
export function withTenant<T>(
  db: Database,
  ctx: { orgId: string; userId?: string | null },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await enterTenant(tx, ctx);
    return fn(tx);
  });
}

/** Runs `fn` with no org selected; only the user's own memberships are visible. */
export function withUser<T>(
  db: Database,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await enterTenant(tx, { orgId: null, userId });
    return fn(tx);
  });
}
