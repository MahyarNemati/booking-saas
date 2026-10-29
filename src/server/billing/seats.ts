import { and, count, gt, isNull } from "drizzle-orm";
import type { Executor } from "@/db/client";
import { invitations, memberships } from "@/db/schema";

/**
 * Seats in use: members plus invitations that are still redeemable. Counting
 * pending invites stops an org on a capped plan from inviting past its limit.
 * Must run inside withTenant(); RLS supplies the org filter.
 */
export async function countSeats(tx: Executor): Promise<{ members: number; pending: number }> {
  const [m] = await tx.select({ n: count() }).from(memberships);
  const [i] = await tx
    .select({ n: count() })
    .from(invitations)
    .where(
      and(
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, new Date()),
      ),
    );
  return { members: m?.n ?? 0, pending: i?.n ?? 0 };
}
