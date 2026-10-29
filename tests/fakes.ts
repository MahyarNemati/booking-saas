import type Stripe from "stripe";
import type { BillingProvider } from "@/server/billing/provider";

export class FakeBilling implements BillingProvider {
  readonly subscriptions = new Map<string, Stripe.Subscription>();
  readonly seatUpdates: Array<{ subscriptionId: string; quantity: number }> =
    [];
  readonly checkouts: Array<{ orgId: string; priceId: string; seats: number }> =
    [];
  customers = 0;

  async createCustomer(): Promise<string> {
    this.customers += 1;
    return `cus_fake_${this.customers}`;
  }

  async createCheckoutSession(input: {
    orgId: string;
    priceId: string;
    seats: number;
  }): Promise<string> {
    this.checkouts.push({
      orgId: input.orgId,
      priceId: input.priceId,
      seats: input.seats,
    });
    return `https://checkout.stripe.test/${input.orgId}`;
  }

  async createPortalSession(input: { customerId: string }): Promise<string> {
    return `https://billing.stripe.test/${input.customerId}`;
  }

  async retrieveSubscription(id: string): Promise<Stripe.Subscription> {
    const sub = this.subscriptions.get(id);
    if (!sub) throw new Error(`no such subscription ${id}`);
    return sub;
  }

  async updateSeatQuantity(
    subscriptionId: string,
    quantity: number,
  ): Promise<void> {
    this.seatUpdates.push({ subscriptionId, quantity });
  }

  constructEvent(payload: string): Stripe.Event {
    return JSON.parse(payload) as Stripe.Event;
  }
}

export function fakeSubscription(input: {
  id: string;
  customer: string;
  orgId?: string;
  priceId: string;
  status?: Stripe.Subscription.Status;
  quantity?: number;
}): Stripe.Subscription {
  return {
    id: input.id,
    object: "subscription",
    customer: input.customer,
    status: input.status ?? "active",
    cancel_at_period_end: false,
    metadata: input.orgId ? { org_id: input.orgId } : {},
    items: {
      object: "list",
      data: [
        {
          id: `si_${input.id}`,
          quantity: input.quantity ?? 1,
          current_period_end: 1_900_000_000,
          price: { id: input.priceId },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}

let eventSeq = 0;

export function fakeEvent<T extends Stripe.Event["type"]>(
  type: T,
  object: unknown,
  created = Math.floor(Date.now() / 1000),
): Stripe.Event {
  eventSeq += 1;
  return {
    id: `evt_test_${process.pid}_${eventSeq}_${Date.now()}`,
    object: "event",
    type,
    created,
    data: { object },
  } as unknown as Stripe.Event;
}
