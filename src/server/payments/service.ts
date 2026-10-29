/**
 * Deposits: taking one when a booking is made, and giving it back when the
 * booking is cancelled in time.
 *
 * The rule the whole module is built around: **the money is the source of
 * truth and the webhook is what tells us about it.** The browser is not. A
 * customer whose card succeeds and whose network then drops has paid, and the
 * appointment must become confirmed anyway; a customer who reaches a "thank
 * you" page has not necessarily paid at all. So the confirmation happens in
 * the webhook handler and nowhere else, and the page that says "thank you"
 * reads the appointment rather than asserting anything about it.
 */

import { and, eq, lt, sql } from "drizzle-orm";
import type { Database, Executor } from "@/db/client";
import { appointments, stripeEvents, type Appointment } from "@/db/schema";
import { enterTenant } from "@/db/tenant";
import { AppError } from "@/lib/errors";
import type { Logger } from "@/lib/logger";
import { recordAudit } from "@/server/audit";
import type { PaymentEvent, PaymentIntent, PaymentProvider } from "./provider";

export interface PaymentDeps {
  db: Database;
  payments: PaymentProvider;
  logger: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Creates (or re-uses) the payment intent for a pending booking.
 *
 * Re-uses deliberately: a customer who reloads the payment page must not end
 * up with two intents for one booking, because then one of them is abandoned
 * and Stripe eventually reports a failure for a booking that was paid.
 */
export async function intentForAppointment(
  deps: PaymentDeps,
  tx: Executor,
  appointmentId: string,
): Promise<PaymentIntent> {
  const [appointment] = await tx
    .select()
    .from(appointments)
    .where(eq(appointments.id, appointmentId));
  if (!appointment) throw new AppError("not_found", "no such appointment");
  if (appointment.status === "cancelled") {
    throw new AppError("invalid", "that booking has been cancelled");
  }
  if (appointment.paymentStatus === "paid") {
    throw new AppError("invalid", "that booking is already paid for");
  }
  const amountMinor = appointment.depositMinor || appointment.priceMinor;
  if (amountMinor <= 0) {
    throw new AppError("invalid", "that booking does not require a payment");
  }

  let replacing: string | undefined;
  if (appointment.stripePaymentIntentId) {
    const existing = await deps.payments.retrieveIntent(
      appointment.stripePaymentIntentId,
    );
    // A cancelled intent cannot be paid, so that one case needs a new one.
    if (existing.status !== "canceled") return existing;
    replacing = existing.id;
  }

  const intent = await deps.payments.createIntent({
    amountMinor,
    currency: appointment.currency,
    metadata: { appointmentId: appointment.id, orgId: appointment.orgId },
    description: `Booking ${appointment.id}`,
    // Keyed on the appointment, so reloading the payment page returns the
    // same intent instead of taking a second deposit.
    //
    // The key also names the intent being replaced, which matters: Stripe
    // returns the *original* result for a repeated key, so a bare
    // `intent:<appointment>` would hand back the cancelled intent and leave
    // the customer with no way to pay. Naming the predecessor makes the key
    // change exactly when a genuinely new intent is needed, and stay the same
    // when the same replacement is retried.
    idempotencyKey: replacing
      ? `intent:${appointment.id}:after:${replacing}`
      : `intent:${appointment.id}`,
  });

  await tx
    .update(appointments)
    .set({ stripePaymentIntentId: intent.id })
    .where(eq(appointments.id, appointment.id));

  return intent;
}

export type PaymentOutcome =
  "processed" | "duplicate" | "ignored" | "unmatched";

/**
 * Applies one verified payment event, exactly once.
 *
 * The event id is recorded in the same transaction as its effect. A crash
 * between the two lets Stripe retry; a redelivery after commit is a no-op.
 * That ordering is the whole of idempotency here, and it is why the insert
 * comes first rather than last.
 */
export function handlePaymentEvent(
  deps: PaymentDeps,
  event: PaymentEvent,
): Promise<PaymentOutcome> {
  return deps.db.transaction(async (tx) => {
    if (event.type === "other") return "ignored";

    const fresh = await tx
      .insert(stripeEvents)
      .values({ id: event.id, type: event.type })
      .onConflictDoNothing()
      .returning({ id: stripeEvents.id });
    if (fresh.length === 0) return "duplicate";

    const appointmentId = event.metadata.appointmentId;
    const orgId = event.metadata.orgId;
    if (!appointmentId || !orgId) {
      // A payment that is not ours, or one whose metadata was lost. Recorded
      // and ignored rather than retried for three days.
      deps.logger.warn(
        { eventId: event.id, type: event.type },
        "payment event without appointment metadata",
      );
      return "unmatched";
    }

    // The webhook has no session, so the tenant context is established from
    // the event's own metadata -- and then every query is confined to it by
    // row-level security, so a forged orgId cannot reach another tenant's
    // rows.
    await enterTenant(tx as never, { orgId });

    const [appointment] = await tx
      .select()
      .from(appointments)
      .where(
        and(eq(appointments.id, appointmentId), eq(appointments.orgId, orgId)),
      );
    if (!appointment) {
      deps.logger.warn(
        { eventId: event.id, appointmentId },
        "payment for an unknown appointment",
      );
      return "unmatched";
    }

    switch (event.type) {
      case "payment_intent.succeeded":
        await paid(tx, deps, appointment, event.amountMinor, event.intentId);
        return "processed";
      case "payment_intent.payment_failed":
        await failed(tx, deps, appointment, event.reason);
        return "processed";
      case "charge.refunded":
        await refunded(tx, deps, appointment, event.amountRefundedMinor);
        return "processed";
    }
  });
}

async function paid(
  tx: Executor,
  deps: PaymentDeps,
  appointment: Appointment,
  amountMinor: number,
  intentId: string,
): Promise<void> {
  // A cancelled booking that is then paid for is a real race: the customer
  // cancelled while the card was being processed. The payment is recorded so
  // the refund path has something to work from, but the booking stays
  // cancelled -- its slot has already been given away.
  const status = appointment.status === "cancelled" ? "cancelled" : "confirmed";

  await tx
    .update(appointments)
    .set({ status, paymentStatus: "paid", stripePaymentIntentId: intentId })
    .where(eq(appointments.id, appointment.id));

  await recordAudit(tx, {
    orgId: appointment.orgId,
    actor: { kind: "system" },
    action: "payment.succeeded",
    target: { type: "appointment", id: appointment.id },
    metadata: { amountMinor, currency: appointment.currency, status },
  });

  if (status === "cancelled") {
    deps.logger.warn(
      { appointmentId: appointment.id },
      "payment arrived for a cancelled booking; a refund is owed",
    );
  }
}

async function failed(
  tx: Executor,
  deps: PaymentDeps,
  appointment: Appointment,
  reason?: string,
): Promise<void> {
  // The booking is not cancelled here. A declined card is usually followed by
  // a second attempt a moment later, and cancelling would give the slot away
  // in between. The sweeper below releases it if nobody pays.
  await tx
    .update(appointments)
    .set({ paymentStatus: "failed" })
    .where(eq(appointments.id, appointment.id));

  deps.logger.info({ appointmentId: appointment.id, reason }, "payment failed");
  await recordAudit(tx, {
    orgId: appointment.orgId,
    actor: { kind: "system" },
    action: "payment.failed",
    target: { type: "appointment", id: appointment.id },
    metadata: { reason: reason ?? null },
  });
}

async function refunded(
  tx: Executor,
  deps: PaymentDeps,
  appointment: Appointment,
  amountRefundedMinor: number,
): Promise<void> {
  const total = appointment.depositMinor || appointment.priceMinor;
  const status =
    amountRefundedMinor >= total ? "refunded" : "partially_refunded";
  await tx
    .update(appointments)
    .set({ paymentStatus: status })
    .where(eq(appointments.id, appointment.id));
  await recordAudit(tx, {
    orgId: appointment.orgId,
    actor: { kind: "system" },
    action: "payment.refunded",
    target: { type: "appointment", id: appointment.id },
    metadata: { amountRefundedMinor, status },
  });
}

/**
 * Refunds a cancelled booking.
 *
 * Called after `cancel()` has decided a refund is due, and separately from it:
 * a cancellation that could not be recorded because a refund failed is worse
 * than one recorded with a refund still outstanding. The appointment is
 * already cancelled and the slot already free by the time this runs.
 */
export async function refundCancellation(
  deps: PaymentDeps,
  tx: Executor,
  input: { appointmentId: string; amountMinor?: number },
): Promise<{ refunded: boolean; reason?: string }> {
  const [appointment] = await tx
    .select()
    .from(appointments)
    .where(eq(appointments.id, input.appointmentId));
  if (!appointment) throw new AppError("not_found", "no such appointment");
  if (
    !appointment.stripePaymentIntentId ||
    appointment.paymentStatus !== "paid"
  ) {
    return { refunded: false, reason: "nothing was paid" };
  }

  try {
    const refund = await deps.payments.refund({
      paymentIntentId: appointment.stripePaymentIntentId,
      ...(input.amountMinor !== undefined
        ? { amountMinor: input.amountMinor }
        : {}),
      // One refund per appointment however many times this is called, which
      // matters because a cancellation can be retried.
      idempotencyKey: `refund:${appointment.id}`,
    });
    if (refund.status === "failed") {
      return { refunded: false, reason: "the refund was declined" };
    }
    // The status is set by the charge.refunded webhook rather than here, so
    // there is one writer and a refund that Stripe reverses is reflected.
    deps.logger.info(
      { appointmentId: appointment.id, refundId: refund.id },
      "refund requested",
    );
    return { refunded: true };
  } catch (err) {
    // A failed refund must not lose the cancellation. It is logged loudly and
    // left for a human, because money that should have moved and did not is
    // not something to retry silently.
    deps.logger.error(
      { appointmentId: appointment.id, err: String(err) },
      "refund failed; manual intervention needed",
    );
    return { refunded: false, reason: "the refund could not be processed" };
  }
}

/**
 * Releases bookings whose payment never arrived.
 *
 * Without this a slot held by an abandoned payment page is lost until the
 * appointment passes. The window is generous on purpose — a customer fetching
 * a card from another room is normal, and giving their slot away at 90 seconds
 * is worse than holding it for 30 minutes.
 *
 * Returns the appointments it released, for the caller to log.
 */
export async function releaseUnpaidHolds(
  db: Database,
  options: { olderThanMinutes?: number; now?: number } = {},
): Promise<Appointment[]> {
  const minutes = options.olderThanMinutes ?? 30;
  const now = options.now ?? Date.now();
  const cutoff = new Date(now - minutes * 60_000);

  // Not scoped to one organization: this runs as the worker, on everything.
  // It is deliberately a single statement, so two workers racing cannot
  // release the same hold twice.
  return db
    .update(appointments)
    .set({
      status: "cancelled",
      cancelledAt: new Date(now),
      cancellationReason: "payment not completed",
    })
    .where(
      and(
        eq(appointments.status, "pending"),
        sql`${appointments.paymentStatus} in ('pending', 'failed')`,
        lt(appointments.createdAt, cutoff),
      ),
    )
    .returning();
}
