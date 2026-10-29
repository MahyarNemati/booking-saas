import type Stripe from "stripe";
import type { BillingProvider } from "@/server/billing/provider";
import type {
  PaymentEvent,
  PaymentIntent,
  PaymentProvider,
  Refund,
} from "@/server/payments/provider";
import {
  SendError,
  type Message,
  type MessageSender,
  type SendResult,
} from "@/server/reminders/provider";

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

// ------------------------------------------------------------- payments

/**
 * A payment provider that records what it was asked for and can be made to
 * fail. The failure paths are the reason this exists: a declined refund is the
 * interesting case and it cannot be produced on demand against a real API.
 */
export class FakePayments implements PaymentProvider {
  readonly intents = new Map<string, PaymentIntent>();
  readonly refunds: {
    paymentIntentId: string;
    amountMinor?: number;
    key?: string;
  }[] = [];
  /** Keyed by idempotency key, so a repeated create returns the same intent. */
  private readonly byKey = new Map<string, string>();
  private counter = 0;
  refundFails = false;
  refundDeclines = false;

  async createIntent(input: {
    amountMinor: number;
    currency: string;
    metadata: { appointmentId: string; orgId: string };
    idempotencyKey?: string;
  }): Promise<PaymentIntent> {
    if (input.idempotencyKey) {
      const existing = this.byKey.get(input.idempotencyKey);
      if (existing) return this.intents.get(existing)!;
    }
    this.counter += 1;
    const intent: PaymentIntent = {
      id: `pi_fake_${this.counter}`,
      clientSecret: `pi_fake_${this.counter}_secret`,
      amountMinor: input.amountMinor,
      currency: input.currency,
      status: "requires_payment_method",
    };
    this.intents.set(intent.id, intent);
    if (input.idempotencyKey) this.byKey.set(input.idempotencyKey, intent.id);
    return intent;
  }

  async retrieveIntent(id: string): Promise<PaymentIntent> {
    const intent = this.intents.get(id);
    if (!intent) throw new Error(`no such intent ${id}`);
    return intent;
  }

  async refund(input: {
    paymentIntentId: string;
    amountMinor?: number;
    idempotencyKey?: string;
  }): Promise<Refund> {
    if (this.refundFails)
      throw new Error("the payment provider is unreachable");
    this.refunds.push({
      paymentIntentId: input.paymentIntentId,
      ...(input.amountMinor !== undefined
        ? { amountMinor: input.amountMinor }
        : {}),
      ...(input.idempotencyKey ? { key: input.idempotencyKey } : {}),
    });
    return {
      id: `re_fake_${this.refunds.length}`,
      amountMinor: input.amountMinor ?? 0,
      status: this.refundDeclines ? "failed" : "succeeded",
    };
  }

  constructEvent(): PaymentEvent {
    throw new Error(
      "the fake does not verify signatures; build events directly",
    );
  }

  /** Marks an intent as cancelled, so the service has to make a new one. */
  cancelIntent(id: string): void {
    const intent = this.intents.get(id);
    if (intent) this.intents.set(id, { ...intent, status: "canceled" });
  }
}

// ------------------------------------------------------------ reminders

/** A sender that records messages, and can be told to fail in either way. */
export class FakeSender implements MessageSender {
  readonly sent: Message[] = [];
  /** Set to make every send fail. */
  failure: { retryable: boolean; message?: string } | null = null;

  constructor(readonly channel: "sms" | "email") {}

  async send(message: Message): Promise<SendResult> {
    if (this.failure) {
      throw new SendError(
        this.failure.message ?? "the provider rejected the message",
        this.failure.retryable,
      );
    }
    this.sent.push(message);
    return { messageId: `msg_${this.sent.length}` };
  }
}

/**
 * Collects log lines so a test can assert on what was reported.
 *
 * Several things here log rather than throw -- a refund that could not be
 * processed, a payment for a cancelled booking -- precisely because the
 * operation must not fail. The log line is then the only observable
 * behaviour, which makes it worth asserting on.
 *
 * The signatures are pino's, loose enough to satisfy its `LogFn` overloads.
 */
export class CollectingLogger {
  readonly lines: { level: string; fields: unknown; message: string }[] = [];

  private record(level: string) {
    return (first: unknown, ...rest: unknown[]): void => {
      // pino accepts either (obj, msg) or (msg); both are used in this app.
      const message = typeof first === "string" ? first : String(rest[0] ?? "");
      const fields = typeof first === "string" ? undefined : first;
      this.lines.push({ level, fields, message });
    };
  }

  info = this.record("info");
  warn = this.record("warn");
  error = this.record("error");
  debug = this.record("debug");

  /** Every line whose message contains `text`, at any level. */
  matching(text: string): { level: string; message: string }[] {
    return this.lines.filter((l) => l.message.includes(text));
  }
}
