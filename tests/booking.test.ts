/**
 * Booking against a real Postgres.
 *
 * These tests exist for the things the engine's unit tests cannot reach: the
 * exclusion constraint, the transaction boundaries, and the race between two
 * customers wanting the same half hour. The engine is tested in
 * `src/domain/time`; nothing here re-tests slot arithmetic.
 */

import { eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database, Tx } from "@/db/client";
import {
  appointments,
  availabilityRules,
  organizations,
  staffServices,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { instantOf } from "@/domain/time/zone";
import {
  createService,
  createStaff,
  setStaffServices,
} from "@/server/booking/catalogue";
import {
  book,
  cancel,
  listAppointments,
  listSlots,
  markAttendance,
  reschedule,
} from "@/server/booking/service";
import { createOrganization } from "@/server/orgs";
import type { Actor } from "@/server/rbac";
import { createUser, hasDatabase, pgError, testDb } from "./db";

const LONDON = "Europe/London";

/** A London wall-clock time as epoch milliseconds. */
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

/** Releases every waiter once `count` of them have arrived. */
function barrier(count: number): () => Promise<void> {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= count) release();
    await open;
  };
}

describe.skipIf(!hasDatabase)("booking", () => {
  const db: Database = hasDatabase ? testDb() : (undefined as never);
  let orgId: string;
  let actor: Actor;
  let serviceId: string;
  let anaId: string;
  let benId: string;

  const tenant = <T>(fn: (tx: Tx) => Promise<T>) =>
    withTenant(db, { orgId }, fn);

  beforeAll(async () => {
    const owner = await createUser(db, "salon-owner");
    const org = await createOrganization(db, {
      userId: owner.id,
      name: "Snips",
    });
    orgId = org.id;
    actor = { kind: "user", userId: owner.id, role: "owner" };
    // The business keeps London hours, which is what makes the stored local
    // rules mean anything.
    await db
      .update(organizations)
      .set({ timeZone: LONDON })
      .where(eq(organizations.id, orgId));

    const service = await tenant((tx) =>
      createService(tx, actor, {
        orgId,
        name: "Cut",
        durationMinutes: 30,
        stepMinutes: 30,
        minimumNoticeMinutes: 0,
        maximumAdvanceDays: 730,
      }),
    );
    serviceId = service.id;

    anaId = (
      await tenant((tx) =>
        createStaff(tx, actor, { orgId, name: "Ana", timeZone: LONDON }),
      )
    ).id;
    benId = (
      await tenant((tx) =>
        createStaff(tx, actor, { orgId, name: "Ben", timeZone: LONDON }),
      )
    ).id;

    // Monday to Friday, 09:00 to 12:00, for the business as a whole.
    await tenant((tx) =>
      tx.insert(availabilityRules).values(
        [1, 2, 3, 4, 5].map((weekday) => ({
          orgId,
          staffId: null,
          weekday,
          startMinute: 9 * 60,
          endMinute: 12 * 60,
        })),
      ),
    );
  });

  beforeEach(async () => {
    // A clean diary per test. Deleting rather than rolling back, because the
    // concurrency tests need real committed transactions.
    await db.delete(appointments).where(eq(appointments.orgId, orgId));
    await db.delete(staffServices).where(eq(staffServices.orgId, orgId));
  });

  const customer = (name: string) => ({
    name,
    email: `${name.toLowerCase()}@example.test`,
  });

  it("books a slot the engine offered", async () => {
    const slots = await tenant((tx) =>
      listSlots(tx, {
        orgId,
        serviceId,
        within: { start: at("2026-06-01 00:00"), end: at("2026-06-02 00:00") },
        now: at("2026-05-01 09:00"),
      }),
    );
    expect(slots.map((s) => s.start)).toContain(at("2026-06-01 10:00"));

    const { appointment } = await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at("2026-06-01 10:00"),
        customer: customer("Alice"),
        now: at("2026-05-01 09:00"),
      }),
    );
    expect(appointment.startsAt.getTime()).toBe(at("2026-06-01 10:00"));
    expect(appointment.endsAt.getTime()).toBe(at("2026-06-01 10:30"));
    // No payment required, so it is confirmed outright.
    expect(appointment.status).toBe("confirmed");
    expect(appointment.paymentStatus).toBe("not_required");
    expect(appointment.manageToken).toHaveLength(43);
  });

  it("refuses a time that was never offered", async () => {
    // 10:15 is inside opening hours but not on the grid. This is the check
    // that stops a crafted request booking between the offered slots.
    await expect(
      tenant((tx) =>
        book(tx, actor, {
          orgId,
          serviceId,
          startsAt: at("2026-06-01 10:15"),
          customer: customer("Mallory"),
          now: at("2026-05-01 09:00"),
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses a slot outside opening hours", async () => {
    await expect(
      tenant((tx) =>
        book(tx, actor, {
          orgId,
          serviceId,
          startsAt: at("2026-06-01 15:00"),
          customer: customer("Mallory"),
          now: at("2026-05-01 09:00"),
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("takes the slot out of the list once it is booked", async () => {
    await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at("2026-06-01 10:00"),
        staffId: anaId,
        customer: customer("Alice"),
        now: at("2026-05-01 09:00"),
      }),
    );
    const slots = await tenant((tx) =>
      listSlots(tx, {
        orgId,
        serviceId,
        staffId: anaId,
        within: { start: at("2026-06-01 00:00"), end: at("2026-06-02 00:00") },
        now: at("2026-05-01 09:00"),
      }),
    );
    expect(slots.map((s) => s.start)).not.toContain(at("2026-06-01 10:00"));
    // And the neighbour is still there, because the range is half-open.
    expect(slots.map((s) => s.start)).toContain(at("2026-06-01 10:30"));
  });

  it("offers the slot to the other member of staff", async () => {
    await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at("2026-06-01 10:00"),
        staffId: anaId,
        customer: customer("Alice"),
        now: at("2026-05-01 09:00"),
      }),
    );
    const slots = await tenant((tx) =>
      listSlots(tx, {
        orgId,
        serviceId,
        within: { start: at("2026-06-01 00:00"), end: at("2026-06-02 00:00") },
        now: at("2026-05-01 09:00"),
      }),
    );
    const ten = slots.find((s) => s.start === at("2026-06-01 10:00"));
    expect(ten?.resourceIds).toEqual([benId]);
  });

  // The reason the exclusion constraint exists. Everything above is a check
  // the application performs; this is the case it cannot win on its own.
  it("lets exactly one of two simultaneous bookings through", async () => {
    const reach = barrier(2);

    // Both transactions open, both check availability and see the slot free,
    // then both insert. Without the constraint both would commit: the check
    // and the insert are two statements and there is no application-level
    // lock between them. With it, the second insert blocks until the first
    // commits and is then refused.
    const attempt = (name: string) =>
      withTenant(db, { orgId }, async (tx) => {
        await reach();
        return book(tx, actor, {
          orgId,
          serviceId,
          startsAt: at("2026-06-01 11:00"),
          staffId: anaId,
          customer: customer(name),
          now: at("2026-05-01 09:00"),
        });
      });

    const results = await Promise.allSettled([
      attempt("Alice"),
      attempt("Bob"),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // The loser is told the slot is gone, not shown a database error.
    const reason = (lost[0] as PromiseRejectedResult).reason as {
      code?: string;
      message?: string;
    };
    expect(reason.code).toBe("conflict");
    expect(reason.message).toMatch(/taken|no longer available/);
    // The DETAIL from Postgres names the conflicting row; it must not leak.
    expect(reason.message).not.toMatch(/exclusion|23P01|staff_id/);

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.orgId, orgId));
    expect(rows).toHaveLength(1);
  });

  it("holds the slot for an unpaid booking", async () => {
    // A booking that needs paying for is still real: the slot has to be held
    // or two customers reach the payment page for the same half hour.
    const paid = await tenant((tx) =>
      createService(tx, actor, {
        orgId,
        name: "Colour",
        durationMinutes: 30,
        stepMinutes: 30,
        minimumNoticeMinutes: 0,
        maximumAdvanceDays: 730,
        priceMinor: 5000,
        depositMinor: 1000,
        requiresPayment: true,
      }),
    );
    const { appointment } = await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId: paid.id,
        startsAt: at("2026-06-02 09:00"),
        staffId: anaId,
        customer: customer("Alice"),
        now: at("2026-05-01 09:00"),
      }),
    );
    expect(appointment.status).toBe("pending");
    expect(appointment.paymentStatus).toBe("pending");
    expect(appointment.depositMinor).toBe(1000);

    const slots = await tenant((tx) =>
      listSlots(tx, {
        orgId,
        serviceId: paid.id,
        staffId: anaId,
        within: { start: at("2026-06-02 00:00"), end: at("2026-06-03 00:00") },
        now: at("2026-05-01 09:00"),
      }),
    );
    expect(slots.map((s) => s.start)).not.toContain(at("2026-06-02 09:00"));
  });

  it("returns the same appointment for a repeated idempotency key", async () => {
    const input = {
      orgId,
      serviceId,
      startsAt: at("2026-06-03 09:00"),
      staffId: anaId,
      customer: customer("Alice"),
      idempotencyKey: "req-1",
      now: at("2026-05-01 09:00"),
    };
    const first = await tenant((tx) => book(tx, actor, input));
    const second = await tenant((tx) => book(tx, actor, input));

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.appointment.id).toBe(first.appointment.id);

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.orgId, orgId));
    expect(rows).toHaveLength(1);
  });

  it("deduplicates two simultaneous retries of the same request", async () => {
    // A double-clicked confirm button, with both requests in flight. The
    // partial unique index decides, and the loser returns the winner's row
    // rather than a conflict.
    const reach = barrier(2);
    const attempt = () =>
      withTenant(db, { orgId }, async (tx) => {
        await reach();
        return book(tx, actor, {
          orgId,
          serviceId,
          startsAt: at("2026-06-03 10:00"),
          staffId: anaId,
          customer: customer("Alice"),
          idempotencyKey: "req-2",
          now: at("2026-05-01 09:00"),
        });
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const ids = results
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof attempt>>> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value.appointment.id);

    // Either both succeeded with the same id, or one hit the slot conflict
    // first; what must never happen is two different appointments.
    expect(new Set(ids).size).toBe(1);
    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.orgId, orgId));
    expect(rows).toHaveLength(1);
  });

  it("reuses an existing customer rather than making a second row", async () => {
    const who = customer("Alice");
    const first = await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at("2026-06-04 09:00"),
        staffId: anaId,
        customer: who,
        now: at("2026-05-01 09:00"),
      }),
    );
    const second = await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at("2026-06-04 10:00"),
        staffId: anaId,
        customer: { ...who, name: "Alice Smith" },
        now: at("2026-05-01 09:00"),
      }),
    );
    expect(second.appointment.customerId).toBe(first.appointment.customerId);
  });

  it("refuses to put the same customer in two places at once", async () => {
    // The customer constraint, which catches a duplicate submission that got
    // past the idempotency key -- two browser tabs, say.
    const who = customer("Alice");
    await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at("2026-06-05 09:00"),
        staffId: anaId,
        customer: who,
        now: at("2026-05-01 09:00"),
      }),
    );
    await expect(
      tenant((tx) =>
        book(tx, actor, {
          orgId,
          serviceId,
          startsAt: at("2026-06-05 09:00"),
          staffId: benId,
          customer: who,
          now: at("2026-05-01 09:00"),
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("frees the slot when a booking is cancelled", async () => {
    const { appointment } = await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at("2026-06-08 09:00"),
        staffId: anaId,
        customer: customer("Alice"),
        now: at("2026-05-01 09:00"),
      }),
    );

    const result = await tenant((tx) =>
      cancel(tx, actor, {
        orgId,
        appointmentId: appointment.id,
        reason: "changed my mind",
        now: at("2026-05-02 09:00"),
      }),
    );
    expect(result.appointment.status).toBe("cancelled");
    expect(result.appointment.cancelledAt).not.toBeNull();
    // Nothing was paid, so nothing is refundable however early it is.
    expect(result.refundable).toBe(false);

    // The constraint's WHERE clause excludes cancelled rows, so the slot is
    // genuinely bookable again -- and the row is kept for the record.
    const { appointment: again } = await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at("2026-06-08 09:00"),
        staffId: anaId,
        customer: customer("Bob"),
        now: at("2026-05-01 09:00"),
      }),
    );
    expect(again.id).not.toBe(appointment.id);
    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.orgId, orgId));
    expect(rows).toHaveLength(2);
  });

  it("is idempotent about cancelling twice", async () => {
    const { appointment } = await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at("2026-06-09 09:00"),
        staffId: anaId,
        customer: customer("Alice"),
        now: at("2026-05-01 09:00"),
      }),
    );
    const input = {
      orgId,
      appointmentId: appointment.id,
      now: at("2026-05-02 09:00"),
    };
    await tenant((tx) => cancel(tx, actor, input));
    const second = await tenant((tx) => cancel(tx, actor, input));
    expect(second.appointment.status).toBe("cancelled");
    expect(second.refundable).toBe(false);
  });

  it("reports a refund only inside the cancellation window", async () => {
    const paid = await tenant((tx) =>
      createService(tx, actor, {
        orgId,
        name: "Spa Day",
        durationMinutes: 30,
        stepMinutes: 30,
        minimumNoticeMinutes: 0,
        maximumAdvanceDays: 730,
        priceMinor: 9000,
        requiresPayment: true,
        cancellationWindowHours: 48,
      }),
    );
    const makeBooking = async () => {
      const { appointment } = await tenant((tx) =>
        book(tx, actor, {
          orgId,
          serviceId: paid.id,
          startsAt: at("2026-06-10 09:00"),
          staffId: anaId,
          customer: customer("Alice"),
          now: at("2026-05-01 09:00"),
        }),
      );
      // Pretend the payment landed.
      await db
        .update(appointments)
        .set({ paymentStatus: "paid", status: "confirmed" })
        .where(eq(appointments.id, appointment.id));
      return appointment;
    };

    const early = await makeBooking();
    const earlyResult = await tenant((tx) =>
      cancel(tx, actor, {
        orgId,
        appointmentId: early.id,
        now: at("2026-06-07 09:00"), // three days before
      }),
    );
    expect(earlyResult.refundable).toBe(true);
    expect(earlyResult.refundMinor).toBe(9000);

    const late = await makeBooking();
    const lateResult = await tenant((tx) =>
      cancel(tx, actor, {
        orgId,
        appointmentId: late.id,
        now: at("2026-06-09 21:00"), // twelve hours before
      }),
    );
    expect(lateResult.refundable).toBe(false);
    expect(lateResult.refundMinor).toBe(0);
  });

  it("moves an appointment without colliding with itself", async () => {
    // Rescheduling by ten minutes overlaps where the appointment already is.
    // Excluding it from its own availability check is the only way the move
    // can succeed.
    const { appointment } = await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at("2026-06-11 09:00"),
        staffId: anaId,
        customer: customer("Alice"),
        now: at("2026-05-01 09:00"),
      }),
    );
    const moved = await tenant((tx) =>
      reschedule(tx, actor, {
        orgId,
        appointmentId: appointment.id,
        startsAt: at("2026-06-11 09:30"),
        now: at("2026-05-01 09:00"),
      }),
    );
    expect(moved.id).toBe(appointment.id);
    expect(moved.startsAt.getTime()).toBe(at("2026-06-11 09:30"));
    // The id, the payment and the manage link all survive the move.
    expect(moved.manageToken).toBe(appointment.manageToken);
  });

  it("refuses to move an appointment onto a taken slot", async () => {
    const { appointment } = await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at("2026-06-12 09:00"),
        staffId: anaId,
        customer: customer("Alice"),
        now: at("2026-05-01 09:00"),
      }),
    );
    await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at("2026-06-12 10:00"),
        staffId: anaId,
        customer: customer("Bob"),
        now: at("2026-05-01 09:00"),
      }),
    );
    await expect(
      tenant((tx) =>
        reschedule(tx, actor, {
          orgId,
          appointmentId: appointment.id,
          startsAt: at("2026-06-12 10:00"),
          now: at("2026-05-01 09:00"),
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("lets a customer manage their booking with the token, and nobody else", async () => {
    const { appointment } = await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at("2026-06-15 09:00"),
        staffId: anaId,
        customer: customer("Alice"),
        now: at("2026-05-01 09:00"),
      }),
    );
    // A wrong token of the same length, so the comparison is the thing being
    // tested rather than a length check.
    const wrong = "x".repeat(appointment.manageToken.length);
    await expect(
      tenant((tx) =>
        cancel(
          tx,
          { kind: "public", manageToken: wrong },
          { orgId, appointmentId: appointment.id, now: at("2026-05-02 09:00") },
        ),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });

    const result = await tenant((tx) =>
      cancel(
        tx,
        { kind: "public", manageToken: appointment.manageToken },
        { orgId, appointmentId: appointment.id, now: at("2026-05-02 09:00") },
      ),
    );
    expect(result.appointment.status).toBe("cancelled");
  });

  it("restricts a service to the staff who offer it", async () => {
    await tenant((tx) =>
      setStaffServices(tx, actor, {
        orgId,
        staffId: anaId,
        serviceIds: [serviceId],
      }),
    );
    const slots = await tenant((tx) =>
      listSlots(tx, {
        orgId,
        serviceId,
        within: { start: at("2026-06-16 00:00"), end: at("2026-06-17 00:00") },
        now: at("2026-05-01 09:00"),
      }),
    );
    expect(slots[0]?.resourceIds).toEqual([anaId]);

    await expect(
      tenant((tx) =>
        book(tx, actor, {
          orgId,
          serviceId,
          startsAt: at("2026-06-16 09:00"),
          staffId: benId,
          customer: customer("Alice"),
          now: at("2026-05-01 09:00"),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("records attendance and keeps the slot occupied", async () => {
    const { appointment } = await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at("2026-06-17 09:00"),
        staffId: anaId,
        customer: customer("Alice"),
        now: at("2026-05-01 09:00"),
      }),
    );
    const noShow = await tenant((tx) =>
      markAttendance(tx, actor, {
        orgId,
        appointmentId: appointment.id,
        attended: false,
      }),
    );
    expect(noShow.status).toBe("no_show");

    // A no-show still occupied the time: the slot does not come back.
    const slots = await tenant((tx) =>
      listSlots(tx, {
        orgId,
        serviceId,
        staffId: anaId,
        within: { start: at("2026-06-17 00:00"), end: at("2026-06-18 00:00") },
        now: at("2026-05-01 09:00"),
      }),
    );
    expect(slots.map((s) => s.start)).not.toContain(at("2026-06-17 09:00"));
  });

  it("lists the diary with the names a calendar needs", async () => {
    await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at("2026-06-18 09:00"),
        staffId: anaId,
        customer: customer("Alice"),
        now: at("2026-05-01 09:00"),
      }),
    );
    const rows = await tenant((tx) =>
      listAppointments(tx, actor, {
        orgId,
        within: { start: at("2026-06-18 00:00"), end: at("2026-06-19 00:00") },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      customerName: "Alice",
      serviceName: "Cut",
      staffName: "Ana",
    });
  });

  // The constraints below are reached with raw SQL on purpose: they exist to
  // catch writes the service layer would never make, so testing them through
  // the service layer would prove nothing. pgError unwraps the driver's
  // envelope to get at the server's own message.
  it("refuses an appointment that would end before it starts", async () => {
    // An empty range overlaps nothing, so without this check the exclusion
    // constraint would let any number of zero-length appointments through.
    const err = await pgError(
      db.execute(sql`
        insert into appointments
          (org_id, service_id, staff_id, customer_id, starts_at, ends_at, manage_token)
        select ${orgId}, ${serviceId}, ${anaId}, c.id,
               '2026-06-19 09:00+00'::timestamptz, '2026-06-19 09:00+00'::timestamptz, 'zero'
        from customers c where c.org_id = ${orgId} limit 1
      `),
    );
    expect(err.message).toMatch(/appointments_ends_after_starts/);
  });

  it("derives the blocked window itself, whatever the insert says", async () => {
    // blocked_from and blocked_to are set by a BEFORE trigger, so a write
    // that tries to supply its own -- narrowing the block and quietly
    // disabling the exclusion constraint for that row -- is overwritten
    // rather than rejected. That is the stronger outcome: there is no way to
    // store an appointment whose block disagrees with its times.
    await db.execute(sql`
      insert into appointments
        (org_id, service_id, staff_id, customer_id, starts_at, ends_at,
         buffer_before_minutes, blocked_from, blocked_to, manage_token)
      select ${orgId}, ${serviceId}, ${anaId}, c.id,
             '2026-06-20 09:00+00'::timestamptz, '2026-06-20 09:30+00'::timestamptz,
             10, '2026-06-20 09:10+00'::timestamptz, '2026-06-20 09:20+00'::timestamptz, 'narrow'
      from customers c where c.org_id = ${orgId} limit 1
    `);
    const [row] = await db
      .select({
        blockedFrom: sql<string>`blocked_from`,
        blockedTo: sql<string>`blocked_to`,
      })
      .from(appointments)
      .where(eq(appointments.manageToken, "narrow"));
    // The 10-minute leading buffer, not the 09:10 the insert asked for.
    expect(new Date(row!.blockedFrom).toISOString()).toBe(
      "2026-06-20T08:50:00.000Z",
    );
    expect(new Date(row!.blockedTo).toISOString()).toBe(
      "2026-06-20T09:30:00.000Z",
    );
  });

  it("will not book another organization's staff member", async () => {
    // The composite (org_id, staff_id) foreign key, which stops a bug in one
    // endpoint turning into a cross-tenant booking.
    const stranger = await createUser(db, "rival");
    const other = await createOrganization(db, {
      userId: stranger.id,
      name: "Rival Salon",
    });
    const rivalStaff = await withTenant(db, { orgId: other.id }, (tx) =>
      createStaff(
        tx,
        { kind: "user", userId: stranger.id, role: "owner" },
        { orgId: other.id, name: "Outsider" },
      ),
    );

    const err = await pgError(
      db.execute(sql`
        insert into appointments
          (org_id, service_id, staff_id, customer_id, starts_at, ends_at, manage_token)
        select ${orgId}, ${serviceId}, ${rivalStaff.id}, c.id,
               '2026-06-22 09:00+00'::timestamptz, '2026-06-22 09:30+00'::timestamptz, 'cross'
        from customers c where c.org_id = ${orgId} limit 1
      `),
    );
    expect(err.message).toMatch(/appointments_staff_same_org/);
  });
});
