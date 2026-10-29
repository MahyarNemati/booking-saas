import Stripe from "stripe";
import { AppError } from "@/lib/errors";
import type {
  PaymentEvent,
  PaymentIntent,
  PaymentProvider,
  Refund,
} from "./provider";

function toIntent(intent: Stripe.PaymentIntent): PaymentIntent {
  if (!intent.client_secret) {
    // Only happens for an intent in a terminal state, which the booking flow
    // should never be creating.
    throw new AppError("conflict", "the payment intent has no client secret", {
      intentId: intent.id,
    });
  }
  return {
    id: intent.id,
    clientSecret: intent.client_secret,
    amountMinor: intent.amount,
    currency: intent.currency.toUpperCase(),
    status: intent.status as PaymentIntent["status"],
  };
}

export class StripePayments implements PaymentProvider {
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string,
  ) {
    this.stripe = new Stripe(secretKey);
  }

  async createIntent(input: {
    amountMinor: number;
    currency: string;
    metadata: { appointmentId: string; orgId: string };
    description?: string;
    customerEmail?: string;
    idempotencyKey?: string;
  }): Promise<PaymentIntent> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: input.amountMinor,
        currency: input.currency.toLowerCase(),
        // The appointment id travels with the payment, because the webhook
        // arrives with no session: it is the only way back to the booking.
        metadata: input.metadata,
        ...(input.description ? { description: input.description } : {}),
        ...(input.customerEmail ? { receipt_email: input.customerEmail } : {}),
        automatic_payment_methods: { enabled: true },
      },
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    );
    return toIntent(intent);
  }

  async retrieveIntent(id: string): Promise<PaymentIntent> {
    return toIntent(await this.stripe.paymentIntents.retrieve(id));
  }

  async refund(input: {
    paymentIntentId: string;
    amountMinor?: number;
    idempotencyKey?: string;
  }): Promise<Refund> {
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: input.paymentIntentId,
        ...(input.amountMinor !== undefined
          ? { amount: input.amountMinor }
          : {}),
      },
      input.idempotencyKey
        ? { idempotencyKey: input.idempotencyKey }
        : undefined,
    );
    return {
      id: refund.id,
      amountMinor: refund.amount,
      status: (refund.status ?? "pending") as Refund["status"],
    };
  }

  constructEvent(payload: string, signature: string): PaymentEvent {
    const event = this.stripe.webhooks.constructEvent(
      payload,
      signature,
      this.webhookSecret,
    );
    switch (event.type) {
      case "payment_intent.succeeded": {
        const intent = event.data.object;
        return {
          id: event.id,
          type: "payment_intent.succeeded",
          intentId: intent.id,
          amountMinor: intent.amount_received,
          metadata: intent.metadata ?? {},
        };
      }
      case "payment_intent.payment_failed": {
        const intent = event.data.object;
        return {
          id: event.id,
          type: "payment_intent.payment_failed",
          intentId: intent.id,
          ...(intent.last_payment_error?.message
            ? { reason: intent.last_payment_error.message }
            : {}),
          metadata: intent.metadata ?? {},
        };
      }
      case "charge.refunded": {
        const charge = event.data.object;
        const intentId =
          typeof charge.payment_intent === "string"
            ? charge.payment_intent
            : charge.payment_intent?.id;
        if (!intentId) return { id: event.id, type: "other", raw: event.type };
        return {
          id: event.id,
          type: "charge.refunded",
          intentId,
          amountRefundedMinor: charge.amount_refunded,
          metadata: charge.metadata ?? {},
        };
      }
      default:
        // Everything else is recorded and ignored. Returning a tagged "other"
        // rather than throwing means an unexpected event does not make Stripe
        // retry it for three days.
        return { id: event.id, type: "other", raw: event.type };
    }
  }
}
