import { eq } from "drizzle-orm";
import type { Database, Executor } from "@/db/client";
import { organizations, subscriptions, type Subscription } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { AppError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { recordAudit } from "../audit";
import { assertCan, type Actor } from "../rbac";
import { entitlementsFor, type Entitlements, type PriceCatalog } from "./plans";
import type { BillingProvider } from "./provider";
import { countSeats } from "./seats";

export async function getSubscription(tx: Executor): Promise<Subscription | null> {
  const [row] = await tx.select().from(subscriptions).limit(1);
  return row ?? null;
}

export async function getEntitlements(tx: Executor): Promise<Entitlements> {
  return entitlementsFor(await getSubscription(tx));
}

export interface BillingDeps {
  db: Database;
  billing: BillingProvider;
  prices: PriceCatalog;
  appUrl: string;
}

export async function startCheckout(
  deps: BillingDeps,
  input: {
    orgId: string;
    slug: string;
    actor: Actor;
    plan: "pro" | "enterprise";
    email?: string | null;
  },
): Promise<string> {
  assertCan(input.actor, "billing:manage");
  const priceId = deps.prices[input.plan];
  if (!priceId) throw new AppError("invalid", `no price configured for ${input.plan}`);

  const { org, seats } = await withTenant(deps.db, { orgId: input.orgId }, async (tx) => {
    const [o] = await tx.select().from(organizations).where(eq(organizations.id, input.orgId));
    if (!o) throw new AppError("not_found", "organization not found");
    const s = await countSeats(tx);
    return { org: o, seats: s.members };
  });

  let customerId = org.stripeCustomerId;
  if (!customerId) {
    customerId = await deps.billing.createCustomer({
      orgId: org.id,
      name: org.name,
      email: input.email,
    });
    await withTenant(deps.db, { orgId: org.id }, (tx) =>
      tx
        .update(organizations)
        .set({ stripeCustomerId: customerId })
        .where(eq(organizations.id, org.id)),
    );
  }

  const base = `${deps.appUrl}/o/${input.slug}/billing`;
  return deps.billing.createCheckoutSession({
    orgId: org.id,
    customerId,
    priceId,
    seats,
    successUrl: `${base}?checkout=success`,
    cancelUrl: `${base}?checkout=cancelled`,
  });
}

export async function openPortal(
  deps: BillingDeps,
  input: { orgId: string; slug: string; actor: Actor },
): Promise<string> {
  assertCan(input.actor, "billing:manage");
  const org = await withTenant(deps.db, { orgId: input.orgId }, async (tx) => {
    const [o] = await tx.select().from(organizations).where(eq(organizations.id, input.orgId));
    return o;
  });
  if (!org?.stripeCustomerId)
    throw new AppError("invalid", "organization has no billing account yet");
  return deps.billing.createPortalSession({
    customerId: org.stripeCustomerId,
    returnUrl: `${deps.appUrl}/o/${input.slug}/billing`,
  });
}

/**
 * Pushes the current member count to the paid subscription so per-seat
 * billing follows membership. Best effort: a failure is logged and the next
 * membership change or a manual portal edit reconciles it.
 */
export async function syncSeatQuantity(
  deps: { db: Database; billing: BillingProvider; logger: Pick<Logger, "warn" | "info"> },
  orgId: string,
): Promise<void> {
  const state = await withTenant(deps.db, { orgId }, async (tx) => ({
    sub: await getSubscription(tx),
    seats: await countSeats(tx),
  }));
  if (!state.sub || state.sub.status === "canceled" || state.sub.seats === state.seats.members)
    return;
  try {
    await deps.billing.updateSeatQuantity(state.sub.stripeSubscriptionId, state.seats.members);
    await withTenant(deps.db, { orgId }, (tx) =>
      recordAudit(tx, {
        orgId,
        actor: { kind: "system" },
        action: "billing.seats_synced",
        metadata: { from: state.sub?.seats, to: state.seats.members },
      }),
    );
  } catch (err) {
    deps.logger.warn({ err, orgId }, "seat quantity sync failed");
  }
}
