import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { z } from "zod";
import type { Database, Tx } from "@/db/client";
import { organizations, stripeEvents, subscriptions } from "@/db/schema";
import { enterTenant } from "@/db/tenant";
import type { Logger } from "@/lib/logger";
import { recordAudit } from "../audit";
import { planForPrice, type PriceCatalog } from "./plans";
import type { BillingProvider } from "./provider";

export type WebhookOutcome = "processed" | "duplicate" | "ignored" | "stale";

export interface WebhookDeps {
  db: Database;
  billing: Pick<BillingProvider, "retrieveSubscription">;
  prices: PriceCatalog;
  logger: Pick<Logger, "info" | "warn">;
}

const ENTITLED = ["active", "trialing", "past_due"];
const uuid = z.uuid();

/**
 * Applies one verified Stripe event exactly once. The event id is recorded in
 * the same transaction as its effect, so a crash between the two lets Stripe
 * retry, and a redelivery after commit is a no-op. Subscription rows carry the
 * timestamp of the event that last wrote them; older events are discarded so
 * out-of-order delivery cannot regress state.
 */
export function handleStripeEvent(
  deps: WebhookDeps,
  event: Stripe.Event,
): Promise<WebhookOutcome> {
  return deps.db.transaction(async (tx) => {
    const fresh = await tx
      .insert(stripeEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning({ id: stripeEvents.id });
    if (fresh.length === 0) return "duplicate";

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        if (session.mode !== "subscription" || !session.subscription)
          return "ignored";
        const sub =
          typeof session.subscription === "string"
            ? await deps.billing.retrieveSubscription(session.subscription)
            : session.subscription;
        return applySubscription(
          tx,
          deps,
          sub,
          event,
          session.client_reference_id,
        );
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        return applySubscription(tx, deps, event.data.object, event, null);
      default:
        return "ignored";
    }
  });
}

async function resolveOrgId(
  tx: Tx,
  sub: Stripe.Subscription,
  hint: string | null,
): Promise<string | null> {
  const candidate = hint ?? sub.metadata?.org_id ?? null;
  if (candidate && uuid.safeParse(candidate).success) return candidate;
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const [org] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.stripeCustomerId, customerId))
    .limit(1);
  return org?.id ?? null;
}

async function applySubscription(
  tx: Tx,
  deps: WebhookDeps,
  sub: Stripe.Subscription,
  event: Stripe.Event,
  orgHint: string | null,
): Promise<WebhookOutcome> {
  const orgId = await resolveOrgId(tx, sub, orgHint);
  if (!orgId) {
    deps.logger.warn(
      { eventId: event.id, subscription: sub.id },
      "stripe event for unknown org",
    );
    return "ignored";
  }
  const item = sub.items.data[0];
  const priceId = item?.price.id;
  const plan = priceId ? planForPrice(deps.prices, priceId) : null;
  if (!item || !priceId || !plan) {
    deps.logger.warn(
      { eventId: event.id, priceId },
      "stripe event for unknown price",
    );
    return "ignored";
  }

  const status =
    event.type === "customer.subscription.deleted" ? "canceled" : sub.status;
  const eventAt = new Date(event.created * 1000);
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  // Everything below runs under RLS for the resolved org.
  await enterTenant(tx, { orgId });

  const row = {
    orgId,
    stripeSubscriptionId: sub.id,
    stripePriceId: priceId,
    plan,
    status,
    seats: item.quantity ?? 1,
    currentPeriodEnd: item.current_period_end
      ? new Date(item.current_period_end * 1000)
      : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    lastEventAt: eventAt,
    updatedAt: new Date(),
  };

  const written = await tx
    .insert(subscriptions)
    .values(row)
    .onConflictDoUpdate({
      target: subscriptions.orgId,
      set: {
        stripeSubscriptionId: sql`excluded.stripe_subscription_id`,
        stripePriceId: sql`excluded.stripe_price_id`,
        plan: sql`excluded.plan`,
        status: sql`excluded.status`,
        seats: sql`excluded.seats`,
        currentPeriodEnd: sql`excluded.current_period_end`,
        cancelAtPeriodEnd: sql`excluded.cancel_at_period_end`,
        lastEventAt: sql`excluded.last_event_at`,
        updatedAt: sql`excluded.updated_at`,
      },
      // Ignore stale events, and never let a dead subscription overwrite its live replacement.
      setWhere: and(
        lte(subscriptions.lastEventAt, eventAt),
        or(
          eq(subscriptions.stripeSubscriptionId, sub.id),
          inArray(sql`excluded.status`, ENTITLED),
        ),
      ),
    })
    .returning({ orgId: subscriptions.orgId });

  if (written.length === 0) return "stale";

  await tx
    .update(organizations)
    .set({ stripeCustomerId: customerId })
    .where(
      and(eq(organizations.id, orgId), isNull(organizations.stripeCustomerId)),
    );

  await recordAudit(tx, {
    orgId,
    actor: { kind: "system" },
    action: "billing.subscription_synced",
    target: { type: "subscription", id: sub.id },
    metadata: { plan, status, seats: row.seats, event: event.type },
  });
  deps.logger.info(
    { eventId: event.id, orgId, plan, status },
    "subscription synced",
  );
  return "processed";
}
