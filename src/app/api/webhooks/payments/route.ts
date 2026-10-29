/**
 * Stripe's callback for customer deposits.
 *
 * Three things matter here and nothing else does.
 *
 * The signature is verified before the body is looked at, because a webhook
 * endpoint is a public URL that confirms bookings and anyone can POST to it.
 *
 * The raw body is read as text. Parsing and re-serialising it would change the
 * bytes and the signature would no longer match -- the single most common
 * reason a working integration starts failing.
 *
 * A 200 is returned for anything that is not worth retrying, including an
 * event for an unknown appointment. Stripe retries a non-2xx for three days,
 * and a permanent failure retried for three days is just noise.
 */

import { getDb } from "@/db/client";
import { env } from "@/env";
import { logger } from "@/lib/logger";
import { StripePayments } from "@/server/payments/stripe-provider";
import { handlePaymentEvent } from "@/server/payments/service";

export async function POST(request: Request): Promise<Response> {
  const e = env();
  if (!e.STRIPE_SECRET_KEY || !e.STRIPE_WEBHOOK_SECRET) {
    // Not configured is not an error the caller can fix, but it must not look
    // like success either.
    return Response.json(
      { error: "payments are not configured" },
      { status: 503 },
    );
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return Response.json({ error: "missing signature" }, { status: 400 });
  }

  const payments = new StripePayments(
    e.STRIPE_SECRET_KEY,
    e.STRIPE_WEBHOOK_SECRET,
  );
  const raw = await request.text();

  let event;
  try {
    event = payments.constructEvent(raw, signature);
  } catch (err) {
    // A bad signature is either a misconfiguration or someone probing. 400,
    // and nothing from the body is logged.
    logger.warn({ err: String(err) }, "rejected a payment webhook signature");
    return Response.json({ error: "invalid signature" }, { status: 400 });
  }

  try {
    const outcome = await handlePaymentEvent(
      { db: getDb(), payments, logger },
      event,
    );
    return Response.json({ outcome });
  } catch (err) {
    // A failure here is ours, and Stripe retrying is the right answer.
    logger.error(
      { err: String(err), eventId: event.id },
      "payment webhook failed",
    );
    return Response.json(
      { error: "could not process the event" },
      { status: 500 },
    );
  }
}
