import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { beforeEach, describe, expect, it } from "vitest";
import { auditLogs, subscriptions } from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { logger } from "@/lib/logger";
import { StripeBillingProvider } from "@/server/billing/stripe-provider";
import { handleWebhookRequest } from "@/server/billing/webhook-request";
import { handleStripeEvent, type WebhookDeps } from "@/server/billing/webhooks";
import { createOrganization } from "@/server/orgs";
import { createUser, hasDatabase, testDb } from "./db";
import { FakeBilling, fakeEvent, fakeSubscription } from "./fakes";

const prices = { pro: "price_pro", enterprise: "price_ent" };
const quiet = logger.child({}, { level: "silent" });

describe.skipIf(!hasDatabase)("stripe webhooks", () => {
  const db = hasDatabase ? testDb() : (undefined as never);
  let billing: FakeBilling;
  let deps: WebhookDeps;
  let orgId: string;

  beforeEach(async () => {
    billing = new FakeBilling();
    deps = { db, billing, prices, logger: quiet };
    const user = await createUser(db, "owner");
    orgId = (
      await createOrganization(db, { userId: user.id, name: "Billing Co" })
    ).id;
  });

  const readSub = () =>
    withTenant(
      db,
      { orgId },
      async (tx) => (await tx.select().from(subscriptions))[0] ?? null,
    );

  it("activates a plan from checkout.session.completed", async () => {
    const sub = fakeSubscription({
      id: `sub_${orgId}`,
      customer: "cus_1",
      priceId: "price_pro",
      quantity: 4,
    });
    billing.subscriptions.set(sub.id, sub);
    const event = fakeEvent("checkout.session.completed", {
      mode: "subscription",
      subscription: sub.id,
      client_reference_id: orgId,
    });

    expect(await handleStripeEvent(deps, event)).toBe("processed");
    const row = await readSub();
    expect(row).toMatchObject({ plan: "pro", status: "active", seats: 4 });
  });

  it("applies each event exactly once", async () => {
    const sub = fakeSubscription({
      id: `sub_${orgId}`,
      customer: "cus_2",
      orgId,
      priceId: "price_pro",
    });
    const event = fakeEvent("customer.subscription.created", sub);

    const outcomes = await Promise.all([
      handleStripeEvent(deps, event),
      handleStripeEvent(deps, event),
      handleStripeEvent(deps, event),
    ]);
    expect(outcomes.filter((o) => o === "processed")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(2);

    const audits = await withTenant(db, { orgId }, (tx) =>
      tx
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, "billing.subscription_synced")),
    );
    expect(audits).toHaveLength(1);
  });

  it("ignores events older than the stored state", async () => {
    const id = `sub_${orgId}`;
    const now = Math.floor(Date.now() / 1000);
    const newer = fakeEvent(
      "customer.subscription.updated",
      fakeSubscription({
        id,
        customer: "cus_3",
        orgId,
        priceId: "price_ent",
        quantity: 9,
      }),
      now,
    );
    const older = fakeEvent(
      "customer.subscription.updated",
      fakeSubscription({
        id,
        customer: "cus_3",
        orgId,
        priceId: "price_pro",
        quantity: 2,
      }),
      now - 60,
    );
    expect(await handleStripeEvent(deps, newer)).toBe("processed");
    expect(await handleStripeEvent(deps, older)).toBe("stale");
    expect(await readSub()).toMatchObject({ plan: "enterprise", seats: 9 });
  });

  it("marks deleted subscriptions canceled", async () => {
    const sub = fakeSubscription({
      id: `sub_${orgId}`,
      customer: "cus_4",
      orgId,
      priceId: "price_pro",
    });
    const now = Math.floor(Date.now() / 1000);
    await handleStripeEvent(
      deps,
      fakeEvent("customer.subscription.created", sub, now - 10),
    );
    await handleStripeEvent(
      deps,
      fakeEvent("customer.subscription.deleted", sub, now),
    );
    expect((await readSub())?.status).toBe("canceled");
  });

  it("does not let a canceled old subscription overwrite its replacement", async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldSub = fakeSubscription({
      id: `sub_old_${orgId}`,
      customer: "cus_5",
      orgId,
      priceId: "price_pro",
    });
    const newSub = fakeSubscription({
      id: `sub_new_${orgId}`,
      customer: "cus_5",
      orgId,
      priceId: "price_ent",
    });
    await handleStripeEvent(
      deps,
      fakeEvent("customer.subscription.created", newSub, now - 5),
    );
    const outcome = await handleStripeEvent(
      deps,
      fakeEvent("customer.subscription.deleted", oldSub, now),
    );
    expect(outcome).toBe("stale");
    expect(await readSub()).toMatchObject({
      stripeSubscriptionId: newSub.id,
      status: "active",
    });
  });

  it("ignores prices that are not in the catalog and unrelated event types", async () => {
    const sub = fakeSubscription({
      id: `sub_${orgId}`,
      customer: "cus_6",
      orgId,
      priceId: "price_unknown",
    });
    expect(
      await handleStripeEvent(
        deps,
        fakeEvent("customer.subscription.created", sub),
      ),
    ).toBe("ignored");
    expect(await handleStripeEvent(deps, fakeEvent("invoice.paid", {}))).toBe(
      "ignored",
    );
    expect(await readSub()).toBeNull();
  });

  describe("HTTP handler", () => {
    const secret = "whsec_test_secret";
    const provider = new StripeBillingProvider("sk_test_unused", secret);
    const signer = new Stripe("sk_test_unused");

    const post = (payload: string, signature?: string) =>
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST",
        body: payload,
        headers: signature ? { "stripe-signature": signature } : {},
      });

    it("accepts a correctly signed event", async () => {
      const sub = fakeSubscription({
        id: `sub_${orgId}`,
        customer: "cus_7",
        orgId,
        priceId: "price_pro",
      });
      const payload = JSON.stringify(
        fakeEvent("customer.subscription.created", sub),
      );
      const signature = signer.webhooks.generateTestHeaderString({
        payload,
        secret,
      });
      const res = await handleWebhookRequest(post(payload, signature), {
        ...deps,
        billing: provider,
        logger: quiet,
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        received: true,
        outcome: "processed",
      });
    });

    it("rejects a missing or forged signature", async () => {
      const payload = JSON.stringify(
        fakeEvent("customer.subscription.created", {}),
      );
      const forged = signer.webhooks.generateTestHeaderString({
        payload,
        secret: "whsec_wrong",
      });
      const handlerDeps = { ...deps, billing: provider, logger: quiet };
      expect(
        (await handleWebhookRequest(post(payload), handlerDeps)).status,
      ).toBe(400);
      expect(
        (await handleWebhookRequest(post(payload, forged), handlerDeps)).status,
      ).toBe(400);
    });

    it("rejects a payload altered after signing", async () => {
      const sub = fakeSubscription({
        id: `sub_${orgId}`,
        customer: "cus_8",
        orgId,
        priceId: "price_pro",
      });
      const payload = JSON.stringify(
        fakeEvent("customer.subscription.created", sub),
      );
      const signature = signer.webhooks.generateTestHeaderString({
        payload,
        secret,
      });
      const tampered = payload.replace("price_pro", "price_ent");
      const res = await handleWebhookRequest(post(tampered, signature), {
        ...deps,
        billing: provider,
        logger: quiet,
      });
      expect(res.status).toBe(400);
      expect(await readSub()).toBeNull();
    });
  });
});
