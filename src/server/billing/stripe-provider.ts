import Stripe from "stripe";
import type { BillingProvider } from "./provider";

export class StripeBillingProvider implements BillingProvider {
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
  ) {
    this.stripe = new Stripe(secretKey, {
      maxNetworkRetries: 2,
      appInfo: { name: "saas-starter" },
    });
  }

  async createCustomer(input: {
    orgId: string;
    name: string;
    email?: string | null;
  }): Promise<string> {
    const customer = await this.stripe.customers.create(
      {
        name: input.name,
        email: input.email ?? undefined,
        metadata: { org_id: input.orgId },
      },
      { idempotencyKey: `customer:${input.orgId}` },
    );
    return customer.id;
  }

  async createCheckoutSession(input: {
    orgId: string;
    customerId: string;
    priceId: string;
    seats: number;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      customer: input.customerId,
      client_reference_id: input.orgId,
      line_items: [
        { price: input.priceId, quantity: Math.max(1, input.seats) },
      ],
      subscription_data: { metadata: { org_id: input.orgId } },
      allow_promotion_codes: true,
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    });
    if (!session.url) throw new Error("checkout session has no url");
    return session.url;
  }

  async createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<string> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
    });
    return session.url;
  }

  retrieveSubscription(id: string): Promise<Stripe.Subscription> {
    return this.stripe.subscriptions.retrieve(id);
  }

  async updateSeatQuantity(
    subscriptionId: string,
    quantity: number,
  ): Promise<void> {
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId);
    const item = sub.items.data[0];
    if (!item || item.quantity === quantity) return;
    await this.stripe.subscriptionItems.update(item.id, {
      quantity,
      proration_behavior: "create_prorations",
    });
  }

  constructEvent(payload: string, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(
      payload,
      signature,
      this.webhookSecret,
    );
  }
}
