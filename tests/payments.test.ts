/**
 * Deposits, confirmations and refunds.
 *
 * The property under test throughout: the webhook is what confirms a booking,
 * not the browser. A customer whose card succeeds and whose network then drops
 * has paid, and their appointment must become confirmed anyway.
 */

import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database, Tx } from "@/db/client";
import {
  appointments,
  availabilityRules,
  organizations,
  stripeEvents,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { instantOf } from "@/domain/time/zone";
import { createService, createStaff } from "@/server/booking/catalogue";
import { book, cancel } from "@/server/booking/service";
import type { PaymentEvent } from "@/server/payments/provider";
import {
  handlePaymentEvent,
  intentForAppointment,
  refundCancellation,
  releaseUnpaidHolds,
} from "@/server/payments/service";
import { createOrganization } from "@/server/orgs";
import type { Actor } from "@/server/rbac";
import { createUser, hasDatabase, testDb } from "./db";
import { CollectingLogger, FakePayments } from "./fakes";

const LONDON = "Europe/London";

function at(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text);
  if (!m) throw new Error(`bad test time ${text}`);
  return instantOf(
    {
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: 0,
    },
    LONDON,
    "reject",
  );
}

let eventSeq = 0;

/**
 * A verified payment event, as the provider would hand one over.
 *
 * Built directly rather than through the fake's constructEvent: signature
 * verification is the provider's job and is tested where it lives, and
 * everything interesting about the handler is what it does with an event it
 * already trusts.
 */
function succeeded(
  appointmentId: string,
  orgId: string,
  amountMinor: number,
  intentId?: string,
): PaymentEvent {
  eventSeq += 1;
  return {
    id: `evt_ok_${eventSeq}_${Date.now()}`,
    type: "payment_intent.succeeded",
    intentId: intentId ?? `pi_fake_${eventSeq}`,
    amountMinor,
    metadata: { appointmentId, orgId },
  };
}

describe.skipIf(!hasDatabase)("payments", () => {
  const db: Database = hasDatabase ? testDb() : (undefined as never);
  let orgId: string;
  let actor: Actor;
  let serviceId: string;
  let staffId: string;
  let payments: FakePayments;
  let logger: CollectingLogger;

  const tenant = <T>(fn: (tx: Tx) => Promise<T>) =>
    withTenant(db, { orgId }, fn);

  beforeAll(async () => {
    const owner = await createUser(db, "spa-owner");
    const org = await createOrganization(db, {
      userId: owner.id,
      name: "Still Waters",
    });
    orgId = org.id;
    actor = { kind: "user", userId: owner.id, role: "owner" };
    await db
      .update(organizations)
      .set({ timeZone: LONDON })
      .where(eq(organizations.id, orgId));

    const service = await tenant((tx) =>
      createService(tx, actor, {
        orgId,
        name: "Massage",
        durationMinutes: 60,
        stepMinutes: 60,
        minimumNoticeMinutes: 0,
        maximumAdvanceDays: 730,
        priceMinor: 8000,
        depositMinor: 2000,
        requiresPayment: true,
        cancellationWindowHours: 24,
      }),
    );
    serviceId = service.id;
    staffId = (
      await tenant((tx) =>
        createStaff(tx, actor, { orgId, name: "Mo", timeZone: LONDON }),
      )
    ).id;

    await tenant((tx) =>
      tx.insert(availabilityRules).values(
        [1, 2, 3, 4, 5].map((weekday) => ({
          orgId,
          staffId: null,
          weekday,
          startMinute: 9 * 60,
          endMinute: 17 * 60,
        })),
      ),
    );
  });

  beforeEach(async () => {
    await db.delete(appointments).where(eq(appointments.orgId, orgId));
    payments = new FakePayments();
    logger = new CollectingLogger();
  });

  const makeBooking = async (startsAt: string, name = "Alice") => {
    const { appointment } = await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at(startsAt),
        staffId,
        customer: { name, email: `${name.toLowerCase()}@example.test` },
        now: at("2026-05-01 09:00"),
      }),
    );
    return appointment;
  };

  it("takes a deposit, not the full price", async () => {
    const appointment = await makeBooking("2026-06-01 10:00");
    expect(appointment.status).toBe("pending");
    expect(appointment.depositMinor).toBe(2000);
    expect(appointment.priceMinor).toBe(8000);

    const intent = await tenant((tx) =>
      intentForAppointment({ db, payments, logger }, tx, appointment.id),
    );
    expect(intent.amountMinor).toBe(2000);
    expect(intent.currency).toBe("GBP");
  });

  it("re-uses the intent when the payment page is reloaded", async () => {
    // Two intents for one booking means one gets abandoned, and Stripe then
    // reports a failure for a booking that was paid.
    const appointment = await makeBooking("2026-06-01 11:00");
    const first = await tenant((tx) =>
      intentForAppointment({ db, payments, logger }, tx, appointment.id),
    );
    const second = await tenant((tx) =>
      intentForAppointment({ db, payments, logger }, tx, appointment.id),
    );
    expect(second.id).toBe(first.id);
    expect(payments.intents.size).toBe(1);
  });

  it("makes a new intent when the old one was cancelled", async () => {
    // Stripe returns the original result for a repeated idempotency key, so
    // re-creating under the same key would hand back the cancelled intent and
    // leave the customer unable to pay. The key names the intent being
    // replaced for exactly this reason.
    const appointment = await makeBooking("2026-06-01 12:00");
    const first = await tenant((tx) =>
      intentForAppointment({ db, payments, logger }, tx, appointment.id),
    );
    payments.cancelIntent(first.id);
    const second = await tenant((tx) =>
      intentForAppointment({ db, payments, logger }, tx, appointment.id),
    );
    expect(second.id).not.toBe(first.id);
    expect(second.status).not.toBe("canceled");

    // And the replacement is itself idempotent: a reload at this point must
    // not create a third.
    payments.cancelIntent(second.id);
    const third = await tenant((tx) =>
      intentForAppointment({ db, payments, logger }, tx, appointment.id),
    );
    expect(third.id).not.toBe(second.id);
    expect(payments.intents.size).toBe(3);
  });

  it("confirms the booking when the payment webhook arrives", async () => {
    const appointment = await makeBooking("2026-06-01 13:00");
    const outcome = await handlePaymentEvent(
      { db, payments, logger },
      succeeded(appointment.id, orgId, 2000),
    );
    expect(outcome).toBe("processed");

    const [row] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, appointment.id));
    expect(row!.status).toBe("confirmed");
    expect(row!.paymentStatus).toBe("paid");
  });

  it("applies a redelivered webhook exactly once", async () => {
    // Stripe retries for three days. The event id is recorded in the same
    // transaction as its effect, so a redelivery after commit is a no-op.
    const appointment = await makeBooking("2026-06-01 14:00");
    const event = succeeded(appointment.id, orgId, 2000);
    expect(await handlePaymentEvent({ db, payments, logger }, event)).toBe(
      "processed",
    );
    expect(await handlePaymentEvent({ db, payments, logger }, event)).toBe(
      "duplicate",
    );

    const seen = await db
      .select()
      .from(stripeEvents)
      .where(eq(stripeEvents.id, event.id));
    expect(seen).toHaveLength(1);
  });

  it("records a failed payment without giving the slot away", async () => {
    // A declined card is usually followed by a second attempt. Cancelling
    // here would hand the slot to someone else in between.
    const appointment = await makeBooking("2026-06-02 10:00");
    eventSeq += 1;
    await handlePaymentEvent(
      { db, payments, logger },
      {
        id: `evt_fail_${eventSeq}_${Date.now()}`,
        type: "payment_intent.payment_failed",
        intentId: "pi_x",
        reason: "card_declined",
        metadata: { appointmentId: appointment.id, orgId },
      },
    );
    const [row] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, appointment.id));
    expect(row!.paymentStatus).toBe("failed");
    expect(row!.status).toBe("pending");
  });

  it("ignores a payment with no appointment metadata", async () => {
    eventSeq += 1;
    const outcome = await handlePaymentEvent(
      { db, payments, logger },
      {
        id: `evt_orphan_${eventSeq}_${Date.now()}`,
        type: "payment_intent.succeeded",
        intentId: "pi_orphan",
        amountMinor: 100,
        metadata: {},
      },
    );
    expect(outcome).toBe("unmatched");
    expect(
      logger.lines.some((l) =>
        l.message.includes("without appointment metadata"),
      ),
    ).toBe(true);
  });

  it("ignores an event type it does not handle", async () => {
    const outcome = await handlePaymentEvent(
      { db, payments, logger },
      { id: "evt_other", type: "other", raw: "invoice.paid" },
    );
    expect(outcome).toBe("ignored");
  });

  it("keeps a booking cancelled when the payment arrives too late", async () => {
    // The customer cancelled while the card was being processed. The slot is
    // already gone, so the booking stays cancelled and the payment is
    // recorded for the refund path -- loudly, because money is owed.
    const appointment = await makeBooking("2026-06-02 11:00");
    await tenant((tx) =>
      cancel(tx, actor, {
        orgId,
        appointmentId: appointment.id,
        now: at("2026-05-02 09:00"),
      }),
    );
    await handlePaymentEvent(
      { db, payments, logger },
      succeeded(appointment.id, orgId, 2000),
    );

    const [row] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, appointment.id));
    expect(row!.status).toBe("cancelled");
    expect(row!.paymentStatus).toBe("paid");
    expect(logger.lines.some((l) => l.message.includes("refund is owed"))).toBe(
      true,
    );
  });

  it("refunds a cancellation inside the window", async () => {
    const appointment = await makeBooking("2026-06-03 10:00");
    const intent = await tenant((tx) =>
      intentForAppointment({ db, payments, logger }, tx, appointment.id),
    );
    await handlePaymentEvent(
      { db, payments, logger },
      succeeded(appointment.id, orgId, 2000, intent.id),
    );

    const result = await tenant((tx) =>
      cancel(tx, actor, {
        orgId,
        appointmentId: appointment.id,
        now: at("2026-06-01 10:00"),
      }),
    );
    expect(result.refundable).toBe(true);

    const refund = await tenant((tx) =>
      refundCancellation({ db, payments, logger }, tx, {
        appointmentId: appointment.id,
        amountMinor: result.refundMinor,
      }),
    );
    expect(refund.refunded).toBe(true);
    expect(payments.refunds).toHaveLength(1);
    expect(payments.refunds[0]).toMatchObject({ amountMinor: 2000 });
    // Keyed on the appointment, so a retried cancellation cannot refund twice.
    expect(payments.refunds[0]!.key).toBe(`refund:${appointment.id}`);
  });

  it("does not refund when nothing was paid", async () => {
    const appointment = await makeBooking("2026-06-03 11:00");
    const refund = await tenant((tx) =>
      refundCancellation({ db, payments, logger }, tx, {
        appointmentId: appointment.id,
      }),
    );
    expect(refund).toEqual({ refunded: false, reason: "nothing was paid" });
    expect(payments.refunds).toHaveLength(0);
  });

  it("keeps the cancellation when the refund fails", async () => {
    // A cancellation lost because a refund failed is worse than one recorded
    // with a refund outstanding: the customer has lost their slot *and* still
    // has a live booking.
    const appointment = await makeBooking("2026-06-03 12:00");
    const intent = await tenant((tx) =>
      intentForAppointment({ db, payments, logger }, tx, appointment.id),
    );
    await handlePaymentEvent(
      { db, payments, logger },
      succeeded(appointment.id, orgId, 2000, intent.id),
    );
    await tenant((tx) =>
      cancel(tx, actor, {
        orgId,
        appointmentId: appointment.id,
        now: at("2026-06-01 10:00"),
      }),
    );

    payments.refundFails = true;
    const refund = await tenant((tx) =>
      refundCancellation({ db, payments, logger }, tx, {
        appointmentId: appointment.id,
      }),
    );
    expect(refund.refunded).toBe(false);

    const [row] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, appointment.id));
    expect(row!.status).toBe("cancelled");
    // And it is shouted about, because money that should have moved did not.
    expect(
      logger.lines.some(
        (l) => l.level === "error" && l.message.includes("manual intervention"),
      ),
    ).toBe(true);
  });

  it("reports a declined refund without throwing", async () => {
    const appointment = await makeBooking("2026-06-03 13:00");
    const intent = await tenant((tx) =>
      intentForAppointment({ db, payments, logger }, tx, appointment.id),
    );
    await handlePaymentEvent(
      { db, payments, logger },
      succeeded(appointment.id, orgId, 2000, intent.id),
    );
    payments.refundDeclines = true;
    const refund = await tenant((tx) =>
      refundCancellation({ db, payments, logger }, tx, {
        appointmentId: appointment.id,
      }),
    );
    expect(refund).toEqual({
      refunded: false,
      reason: "the refund was declined",
    });
  });

  it("marks a refund from the webhook, not from the refund call", async () => {
    // One writer for the payment status, so a refund Stripe later reverses is
    // reflected rather than remembered wrongly.
    const appointment = await makeBooking("2026-06-04 10:00");
    await handlePaymentEvent(
      { db, payments, logger },
      succeeded(appointment.id, orgId, 2000),
    );
    eventSeq += 1;
    await handlePaymentEvent(
      { db, payments, logger },
      {
        id: `evt_refund_${eventSeq}_${Date.now()}`,
        type: "charge.refunded",
        intentId: "pi_x",
        amountRefundedMinor: 2000,
        metadata: { appointmentId: appointment.id, orgId },
      },
    );
    const [row] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, appointment.id));
    expect(row!.paymentStatus).toBe("refunded");

    eventSeq += 1;
    await handlePaymentEvent(
      { db, payments, logger },
      {
        id: `evt_partial_${eventSeq}_${Date.now()}`,
        type: "charge.refunded",
        intentId: "pi_x",
        amountRefundedMinor: 500,
        metadata: { appointmentId: appointment.id, orgId },
      },
    );
    const [again] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, appointment.id));
    expect(again!.paymentStatus).toBe("partially_refunded");
  });

  it("releases a slot whose payment never arrived", async () => {
    const appointment = await makeBooking("2026-06-05 10:00");
    const bookedAt = at("2026-05-01 09:00");
    // The hold's age is measured from created_at, which the database sets, so
    // the row is backdated to make it old.
    await db
      .update(appointments)
      .set({ createdAt: new Date(bookedAt) })
      .where(eq(appointments.id, appointment.id));

    // Not yet: the window has not passed.
    expect(
      await releaseUnpaidHolds(db, {
        olderThanMinutes: 30,
        now: bookedAt + 10 * 60_000,
      }),
    ).toHaveLength(0);

    const released = await releaseUnpaidHolds(db, {
      olderThanMinutes: 30,
      now: bookedAt + 60 * 60_000,
    });
    expect(released.map((r) => r.id)).toContain(appointment.id);

    const [row] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, appointment.id));
    expect(row!.status).toBe("cancelled");
    expect(row!.cancellationReason).toBe("payment not completed");

    // And the slot is bookable again.
    const again = await makeBooking("2026-06-05 10:00", "Bob");
    expect(again.id).not.toBe(appointment.id);
  });

  it("never releases a paid booking", async () => {
    const appointment = await makeBooking("2026-06-08 10:00");
    await handlePaymentEvent(
      { db, payments, logger },
      succeeded(appointment.id, orgId, 2000),
    );
    await db
      .update(appointments)
      .set({ createdAt: new Date(at("2026-05-01 09:00")) })
      .where(eq(appointments.id, appointment.id));

    const released = await releaseUnpaidHolds(db, { olderThanMinutes: 1 });
    expect(released.map((r) => r.id)).not.toContain(appointment.id);
  });

  it("refuses an intent for a booking that needs no payment", async () => {
    const free = await tenant((tx) =>
      createService(tx, actor, {
        orgId,
        name: "Consultation",
        durationMinutes: 60,
        stepMinutes: 60,
        minimumNoticeMinutes: 0,
        maximumAdvanceDays: 730,
      }),
    );
    const { appointment } = await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId: free.id,
        startsAt: at("2026-06-09 10:00"),
        staffId,
        customer: { name: "Carol", email: "carol@example.test" },
        now: at("2026-05-01 09:00"),
      }),
    );
    await expect(
      tenant((tx) =>
        intentForAppointment({ db, payments, logger }, tx, appointment.id),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("refuses an intent for a cancelled or already-paid booking", async () => {
    const appointment = await makeBooking("2026-06-10 10:00");
    await handlePaymentEvent(
      { db, payments, logger },
      succeeded(appointment.id, orgId, 2000),
    );
    await expect(
      tenant((tx) =>
        intentForAppointment({ db, payments, logger }, tx, appointment.id),
      ),
    ).rejects.toMatchObject({ code: "invalid" });

    const other = await makeBooking("2026-06-10 11:00", "Dave");
    await tenant((tx) =>
      cancel(tx, actor, {
        orgId,
        appointmentId: other.id,
        now: at("2026-05-02 09:00"),
      }),
    );
    await expect(
      tenant((tx) =>
        intentForAppointment({ db, payments, logger }, tx, other.id),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });
});
