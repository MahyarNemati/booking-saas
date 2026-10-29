import type Stripe from "stripe";

/** The subset of Stripe the app depends on. Tests substitute a fake. */
export interface BillingProvider {
  createCustomer(input: {
    orgId: string;
    name: string;
    email?: string | null;
  }): Promise<string>;
  createCheckoutSession(input: {
    orgId: string;
    customerId: string;
    priceId: string;
    seats: number;
    successUrl: string;
    cancelUrl: string;
  }): Promise<string>;
  createPortalSession(input: {
    customerId: string;
    returnUrl: string;
  }): Promise<string>;
  retrieveSubscription(id: string): Promise<Stripe.Subscription>;
  updateSeatQuantity(subscriptionId: string, quantity: number): Promise<void>;
  /** Verifies the signature and returns the parsed event, or throws. */
  constructEvent(payload: string, signature: string): Stripe.Event;
}
