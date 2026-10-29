import type Stripe from "stripe";
import type { Logger } from "@/lib/logger";
import type { BillingProvider } from "./provider";
import { handleStripeEvent, type WebhookDeps } from "./webhooks";

const MAX_BODY_BYTES = 512 * 1024;

/**
 * HTTP edge of the webhook: verifies the signature against the raw body,
 * then applies the event. Verification failures are 400 so Stripe stops
 * retrying a forged request; processing failures are 500 so it retries.
 */
export async function handleWebhookRequest(
  req: Request,
  deps: WebhookDeps & {
    billing: Pick<BillingProvider, "constructEvent" | "retrieveSubscription">;
    logger: Logger;
  },
): Promise<Response> {
  const signature = req.headers.get("stripe-signature");
  if (!signature)
    return Response.json({ error: "missing signature" }, { status: 400 });

  const payload = await req.text();
  if (Buffer.byteLength(payload) > MAX_BODY_BYTES) {
    return Response.json({ error: "payload too large" }, { status: 413 });
  }

  let event: Stripe.Event;
  try {
    event = deps.billing.constructEvent(payload, signature);
  } catch (err) {
    deps.logger.warn({ err }, "stripe signature verification failed");
    return Response.json({ error: "invalid signature" }, { status: 400 });
  }

  try {
    const outcome = await handleStripeEvent(deps, event);
    return Response.json({ received: true, outcome });
  } catch (err) {
    deps.logger.error(
      { err, eventId: event.id, type: event.type },
      "stripe event processing failed",
    );
    return Response.json({ error: "processing failed" }, { status: 500 });
  }
}
