/**
 * Taking a deposit for a booking.
 *
 * Separate from `server/billing`, which handles the business's subscription to
 * this product. These are two different money flows in two different
 * directions and conflating them makes both harder to follow: the business
 * pays us a subscription; the customer pays the business a deposit.
 *
 * An interface rather than Stripe directly, for the usual reason — the tests
 * need to assert what was asked for without a network — and for one specific
 * to payments: a fake lets the failure paths be exercised. A refund that fails
 * is the interesting case and it is not one you can produce on demand against
 * a real API.
 */

export interface PaymentIntent {
  id: string;
  /** What the client needs to complete the payment in the browser. */
  clientSecret: string;
  amountMinor: number;
  currency: string;
  status:
    | "requires_payment_method"
    | "requires_confirmation"
    | "processing"
    | "succeeded"
    | "canceled";
}

export interface Refund {
  id: string;
  amountMinor: number;
  status: "pending" | "succeeded" | "failed";
}

export interface PaymentProvider {
  createIntent(input: {
    amountMinor: number;
    currency: string;
    /**
     * Carried through to the webhook, which is how a payment is matched back
     * to an appointment. The webhook arrives with no session and no cookies,
     * so this is the only link.
     */
    metadata: { appointmentId: string; orgId: string };
    description?: string;
    customerEmail?: string;
    /**
     * Makes the create safe to retry. Stripe returns the original intent for
     * a repeated key, so a retried request does not take two deposits.
     */
    idempotencyKey?: string;
  }): Promise<PaymentIntent>;

  retrieveIntent(id: string): Promise<PaymentIntent>;

  refund(input: {
    paymentIntentId: string;
    /** Omitted means the full amount. */
    amountMinor?: number;
    idempotencyKey?: string;
  }): Promise<Refund>;

  /** Verifies the signature and returns the parsed event, or throws. */
  constructEvent(payload: string, signature: string): PaymentEvent;
}

/**
 * The events this app acts on, narrowed from Stripe's full set.
 *
 * A narrow type rather than Stripe's `Event` so the handler is exhaustive and
 * a new event type is a compile error rather than a silent `default: return`.
 */
export type PaymentEvent =
  | {
      id: string;
      type: "payment_intent.succeeded";
      intentId: string;
      amountMinor: number;
      metadata: Record<string, string>;
    }
  | {
      id: string;
      type: "payment_intent.payment_failed";
      intentId: string;
      reason?: string;
      metadata: Record<string, string>;
    }
  | {
      id: string;
      type: "charge.refunded";
      intentId: string;
      amountRefundedMinor: number;
      metadata: Record<string, string>;
    }
  | { id: string; type: "other"; raw: string };
