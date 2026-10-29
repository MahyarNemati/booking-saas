/**
 * Reminders.
 *
 * The three things worth proving: scheduling is idempotent so a reschedule
 * does not double up, two workers cannot send the same reminder, and a
 * permanent failure is abandoned while a transient one is retried.
 */

import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database, Tx } from "@/db/client";
import {
  appointments,
  availabilityRules,
  organizations,
  reminders,
} from "@/db/schema";
import { withTenant } from "@/db/tenant";
import { instantOf } from "@/domain/time/zone";
import { createService, createStaff } from "@/server/booking/catalogue";
import { book, cancel, reschedule } from "@/server/booking/service";
import { createOrganization } from "@/server/orgs";
import type { Actor } from "@/server/rbac";
import {
  cancelReminders,
  claimDue,
  renderReminder,
  runOnce,
  scheduleReminders,
  stuckReminders,
  type DueReminder,
} from "@/server/reminders/service";
import { redact } from "@/server/reminders/provider";
import { createUser, hasDatabase, testDb } from "./db";
import { CollectingLogger, FakeSender } from "./fakes";

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

describe.skipIf(!hasDatabase)("reminders", () => {
  const db: Database = hasDatabase ? testDb() : (undefined as never);
  let orgId: string;
  let actor: Actor;
  let serviceId: string;
  let staffId: string;
  let sms: FakeSender;
  let email: FakeSender;
  let logger: CollectingLogger;

  const tenant = <T>(fn: (tx: Tx) => Promise<T>) =>
    withTenant(db, { orgId }, fn);

  beforeAll(async () => {
    const owner = await createUser(db, "clinic-owner");
    const org = await createOrganization(db, {
      userId: owner.id,
      name: "The Clinic",
    });
    orgId = org.id;
    actor = { kind: "user", userId: owner.id, role: "owner" };
    await db
      .update(organizations)
      // A day before and an hour before, which is what a business actually
      // wants and what the default is.
      .set({ timeZone: LONDON, reminderOffsetsMinutes: [24 * 60, 60] })
      .where(eq(organizations.id, orgId));

    serviceId = (
      await tenant((tx) =>
        createService(tx, actor, {
          orgId,
          name: "Check-up",
          durationMinutes: 30,
          stepMinutes: 30,
          minimumNoticeMinutes: 0,
          maximumAdvanceDays: 730,
        }),
      )
    ).id;
    staffId = (
      await tenant((tx) =>
        createStaff(tx, actor, { orgId, name: "Dr Who", timeZone: LONDON }),
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
    sms = new FakeSender("sms");
    email = new FakeSender("email");
    logger = new CollectingLogger();
  });

  // A distinct customer per booking unless a test asks otherwise. Customers
  // are matched on email, so sharing a name across tests would share the row
  // -- and a phone number set by one test would change what another
  // schedules.
  let customerSeq = 0;
  const makeBooking = async (
    startsAt: string,
    options: { phone?: string; name?: string } = {},
  ) => {
    customerSeq += 1;
    const name = options.name ?? `Patient${customerSeq}`;
    const { appointment } = await tenant((tx) =>
      book(tx, actor, {
        orgId,
        serviceId,
        startsAt: at(startsAt),
        staffId,
        customer: {
          name,
          email: `${name.toLowerCase()}@example.test`,
          ...(options.phone ? { phone: options.phone } : {}),
        },
        now: at("2026-05-01 09:00"),
      }),
    );
    return appointment;
  };

  const rowsFor = (appointmentId: string) =>
    db
      .select()
      .from(reminders)
      .where(eq(reminders.appointmentId, appointmentId));

  it("schedules a reminder per channel and offset when the booking is made", async () => {
    const appointment = await makeBooking("2026-06-01 10:00", {
      phone: "+447700900000",
    });
    const rows = await rowsFor(appointment.id);
    // Two offsets across two channels.
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.channel))).toEqual(
      new Set(["sms", "email"]),
    );
    const due = rows
      .filter((r) => r.channel === "sms")
      .map((r) => r.dueAt.getTime())
      .sort((a, b) => a - b);
    expect(due).toEqual([at("2026-05-31 10:00"), at("2026-06-01 09:00")]);
  });

  it("schedules email only when there is no phone number", async () => {
    const appointment = await makeBooking("2026-06-01 11:00");
    const rows = await rowsFor(appointment.id);
    expect(rows.map((r) => r.channel)).toEqual(["email", "email"]);
  });

  it("does not schedule a reminder whose time has already passed", async () => {
    // Booking two hours ahead cannot have a 24-hour reminder. Sending "your
    // appointment is in 24 hours" two hours before is worse than nothing.
    const appointment = await makeBooking("2026-06-02 10:00");
    await db
      .delete(reminders)
      .where(eq(reminders.appointmentId, appointment.id));
    const made = await tenant((tx) =>
      scheduleReminders(tx, {
        orgId,
        appointmentId: appointment.id,
        startsAt: at("2026-06-02 10:00"),
        offsetsMinutes: [24 * 60, 60],
        channels: ["email"],
        now: at("2026-06-02 08:00"),
      }),
    );
    expect(made).toHaveLength(1);
    expect(made[0]!.offsetMinutes).toBe(60);
  });

  it("is idempotent, so scheduling twice makes no duplicates", async () => {
    const appointment = await makeBooking("2026-06-03 10:00");
    const input = {
      orgId,
      appointmentId: appointment.id,
      startsAt: at("2026-06-03 10:00"),
      offsetsMinutes: [24 * 60, 60],
      channels: ["email" as const],
      now: at("2026-05-01 09:00"),
    };
    await tenant((tx) => scheduleReminders(tx, input));
    await tenant((tx) => scheduleReminders(tx, input));
    expect(await rowsFor(appointment.id)).toHaveLength(2);
  });

  it("moves the reminders when the appointment is rescheduled", async () => {
    const appointment = await makeBooking("2026-06-04 10:00");
    await tenant((tx) =>
      reschedule(tx, actor, {
        orgId,
        appointmentId: appointment.id,
        startsAt: at("2026-06-04 14:00"),
        now: at("2026-05-01 09:00"),
      }),
    );
    const rows = await rowsFor(appointment.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dueAt.getTime()).sort((a, b) => a - b)).toEqual([
      at("2026-06-03 14:00"),
      at("2026-06-04 13:00"),
    ]);
  });

  it("re-sends a reminder that had already gone out for the old time", async () => {
    // A customer reminded about Tuesday, whose appointment moves to Friday,
    // has to be reminded again -- otherwise the only message they have is
    // wrong.
    const appointment = await makeBooking("2026-06-05 10:00");
    await db
      .update(reminders)
      .set({ status: "sent", sentAt: new Date(), attempts: 1 })
      .where(eq(reminders.appointmentId, appointment.id));

    await tenant((tx) =>
      reschedule(tx, actor, {
        orgId,
        appointmentId: appointment.id,
        startsAt: at("2026-06-08 10:00"),
        now: at("2026-05-01 09:00"),
      }),
    );
    const rows = await rowsFor(appointment.id);
    expect(rows.every((r) => r.status === "scheduled")).toBe(true);
    expect(rows.every((r) => r.attempts === 0)).toBe(true);
    expect(rows.every((r) => r.sentAt === null)).toBe(true);
  });

  it("cancels the reminders when the booking is cancelled", async () => {
    const appointment = await makeBooking("2026-06-09 10:00");
    await tenant((tx) =>
      cancel(tx, actor, {
        orgId,
        appointmentId: appointment.id,
        now: at("2026-05-02 09:00"),
      }),
    );
    const rows = await rowsFor(appointment.id);
    expect(rows.every((r) => r.status === "cancelled")).toBe(true);
  });

  it("claims what is due and leases it", async () => {
    const appointment = await makeBooking("2026-06-10 10:00");
    // Half an hour before the appointment, both the day-before and the
    // hour-before reminders are already past due.
    const now = at("2026-06-10 09:30");

    const first = await claimDue(db, { now, limit: 10 });
    const mine = first.filter(
      (d) => d.reminder.appointmentId === appointment.id,
    );
    expect(mine).toHaveLength(2);
    expect(
      mine.map((m) => m.reminder.offsetMinutes).sort((a, b) => a - b),
    ).toEqual([60, 1440]);

    // The rows are now leased: in flight, stamped, and with the attempt
    // counted so a crashed worker's rows are visibly retried rather than
    // looking untouched.
    const rows = await rowsFor(appointment.id);
    expect(rows.every((r) => r.status === "sending")).toBe(true);
    expect(rows.every((r) => r.claimedAt !== null)).toBe(true);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);

    // A second pass takes nothing, because the lease has not expired.
    const second = await claimDue(db, { now, limit: 10 });
    expect(
      second.filter((d) => d.reminder.appointmentId === appointment.id),
    ).toHaveLength(0);
  });

  it("reclaims a reminder abandoned by a dead worker", async () => {
    // A worker that dies mid-send leaves the row in flight. The lease is what
    // gets the reminder out at all, and the only alternative is a separate
    // sweeper to write and forget about.
    const appointment = await makeBooking("2026-06-10 14:00");
    const now = at("2026-06-10 13:30");
    await claimDue(db, { now, limit: 10 });

    // Still leased a minute later.
    expect(
      (await claimDue(db, { now: now + 60_000, limit: 10 })).filter(
        (d) => d.reminder.appointmentId === appointment.id,
      ),
    ).toHaveLength(0);

    // Available again once the lease has run out.
    const reclaimed = await claimDue(db, { now: now + 10 * 60_000, limit: 10 });
    expect(
      reclaimed.filter((d) => d.reminder.appointmentId === appointment.id),
    ).toHaveLength(2);
    const rows = await rowsFor(appointment.id);
    expect(rows.every((r) => r.attempts === 2)).toBe(true);
  });

  it("does not hand the same reminder to two workers", async () => {
    // Two workers, concurrently and then one after the other. SKIP LOCKED
    // handles the first case; it is the second that needs the lease, because
    // the lock is gone the moment the claiming transaction commits and the
    // message has not been sent yet.
    const appointment = await makeBooking("2026-06-11 10:00");
    const now = at("2026-06-11 09:30");

    const [a, b] = await Promise.all([
      claimDue(db, { now, limit: 10 }),
      claimDue(db, { now, limit: 10 }),
    ]);
    const concurrent = [...a, ...b].filter(
      (d) => d.reminder.appointmentId === appointment.id,
    );
    expect(concurrent).toHaveLength(2); // the two due reminders, once each
    expect(new Set(concurrent.map((d) => d.reminder.id)).size).toBe(2);

    const later = await claimDue(db, { now: now + 1000, limit: 10 });
    expect(
      later.filter((d) => d.reminder.appointmentId === appointment.id),
    ).toHaveLength(0);
  });

  it("sends the due reminders and records the provider's ids", async () => {
    const appointment = await makeBooking("2026-06-12 10:00", {
      phone: "+447700900111",
    });
    const outcome = await runOnce(db, { sms, email }, logger, {
      now: at("2026-06-12 09:30"),
      limit: 10,
    });
    // Two offsets across two channels, all four already past due.
    expect(outcome.sent).toBe(4);
    expect(sms.sent).toHaveLength(2);
    expect(email.sent).toHaveLength(2);

    const rows = await rowsFor(appointment.id);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(4);
    expect(rows.every((r) => r.providerMessageId?.startsWith("msg_"))).toBe(
      true,
    );
    expect(rows.every((r) => r.sentAt !== null)).toBe(true);
    // The lease is released, so nothing looks in flight afterwards.
    expect(rows.every((r) => r.claimedAt === null)).toBe(true);

    // And a second pass sends nothing more.
    const again = await runOnce(db, { sms, email }, logger, {
      now: at("2026-06-12 09:31"),
    });
    expect(again.sent).toBe(0);
  });

  it("skips a reminder for a booking cancelled behind its back", async () => {
    // cancelReminders can be missed -- a direct status update, say. This is
    // the check that actually protects the customer from being reminded
    // about a booking that is not happening.
    const appointment = await makeBooking("2026-06-15 10:00");
    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledAt: new Date() })
      .where(eq(appointments.id, appointment.id));

    const outcome = await runOnce(db, { sms, email }, logger, {
      now: at("2026-06-15 09:30"),
    });
    expect(outcome.sent).toBe(0);
    expect(outcome.skipped).toBeGreaterThanOrEqual(1);
    expect(email.sent).toHaveLength(0);
  });

  it("retries a transient failure and gives up on a permanent one", async () => {
    const transient = await makeBooking("2026-06-16 10:00", { name: "Bob" });
    email.failure = { retryable: true, message: "the provider timed out" };
    await runOnce(db, { email }, logger, { now: at("2026-06-16 09:30") });

    let rows = await rowsFor(transient.id);
    let hourly = rows.find((r) => r.offsetMinutes === 60)!;
    // Still scheduled, so the next pass picks it up, with the failure
    // recorded for an operator to look at.
    expect(hourly.status).toBe("scheduled");
    expect(hourly.attempts).toBe(1);
    expect(hourly.lastError).toMatch(/timed out/);

    // Four attempts is the budget; the fourth failure gives up.
    for (let i = 0; i < 4; i += 1) {
      await runOnce(db, { email }, logger, { now: at("2026-06-16 09:30") });
    }
    rows = await rowsFor(transient.id);
    hourly = rows.find((r) => r.offsetMinutes === 60)!;
    expect(hourly.status).toBe("failed");

    // A permanent failure is abandoned at once: retrying an invalid number
    // burns the budget and eventually looks like an outage.
    const permanent = await makeBooking("2026-06-17 10:00", { name: "Carol" });
    const other = new FakeSender("email");
    other.failure = { retryable: false, message: "not a valid address" };
    await runOnce(db, { email: other }, logger, {
      now: at("2026-06-17 09:30"),
    });
    const permanentRows = await rowsFor(permanent.id);
    expect(permanentRows.find((r) => r.offsetMinutes === 60)!.status).toBe(
      "failed",
    );
    expect(permanentRows.find((r) => r.offsetMinutes === 60)!.attempts).toBe(1);
  });

  it("does not let one bad recipient stop the rest of the batch", async () => {
    const withPhone = await makeBooking("2026-06-18 10:00", {
      name: "Dave",
      phone: "+447700900222",
    });
    sms.failure = { retryable: false };
    const outcome = await runOnce(db, { sms, email }, logger, {
      now: at("2026-06-18 09:30"),
    });
    expect(outcome.failed).toBeGreaterThanOrEqual(1);
    expect(outcome.sent).toBeGreaterThanOrEqual(1);

    const rows = await rowsFor(withPhone.id);
    expect(
      rows.find((r) => r.channel === "email" && r.offsetMinutes === 60)!.status,
    ).toBe("sent");
    expect(
      rows.find((r) => r.channel === "sms" && r.offsetMinutes === 60)!.status,
    ).toBe("failed");
  });

  it("records a reminder with no address rather than retrying it for ever", async () => {
    const appointment = await makeBooking("2026-06-19 10:00");
    // Only an SMS sender configured, and the customer has no phone number.
    const outcome = await runOnce(db, { sms }, logger, {
      now: at("2026-06-19 09:30"),
    });
    expect(outcome.skipped).toBeGreaterThanOrEqual(1);
    const rows = await rowsFor(appointment.id);
    const hourly = rows.find((r) => r.offsetMinutes === 60)!;
    expect(hourly.status).toBe("failed");
    expect(hourly.lastError).toMatch(/no email sender/);
  });

  it("reports reminders that are stuck", async () => {
    const appointment = await makeBooking("2026-06-22 10:00");
    await db
      .update(reminders)
      .set({ dueAt: new Date(at("2026-06-22 06:00")), attempts: 2 })
      .where(eq(reminders.appointmentId, appointment.id));
    const stuck = await stuckReminders(db, at("2026-06-22 10:00"));
    expect(stuck.map((r) => r.appointmentId)).toContain(appointment.id);
  });

  it("does nothing when nothing is due", async () => {
    await makeBooking("2026-06-23 10:00");
    const outcome = await runOnce(db, { sms, email }, logger, {
      now: at("2026-05-01 09:00"),
    });
    expect(outcome).toEqual({ sent: 0, skipped: 0, failed: 0 });
  });

  it("cancels outstanding reminders on request and leaves sent ones alone", async () => {
    const appointment = await makeBooking("2026-06-24 10:00");
    await db
      .update(reminders)
      .set({ status: "sent", sentAt: new Date() })
      .where(eq(reminders.appointmentId, appointment.id));
    expect(await tenant((tx) => cancelReminders(tx, appointment.id))).toBe(0);
  });
});

describe("reminder text", () => {
  const base: DueReminder = {
    reminder: {
      id: "r1",
      orgId: "o1",
      appointmentId: "a1",
      channel: "sms",
      offsetMinutes: 60,
      dueAt: new Date(),
      status: "scheduled",
      claimedAt: null,
      attempts: 0,
      lastError: null,
      sentAt: null,
      providerMessageId: null,
      createdAt: new Date(),
    },
    appointmentStartsAt: new Date(Date.UTC(2026, 5, 1, 13, 30)),
    appointmentStatus: "confirmed",
    customerName: "Alice",
    customerEmail: "alice@example.test",
    customerPhone: "+447700900000",
    customerTimeZone: null,
    businessName: "The Clinic",
    businessTimeZone: "Europe/London",
    serviceName: "Check-up",
  };

  it("uses the business's zone when the customer's is unknown", () => {
    const text = renderReminder(base);
    expect(text).toContain("The Clinic");
    expect(text).toContain("Check-up");
    // 13:30 UTC is 14:30 in London in June.
    expect(text).toContain("14:30");
    expect(text).toContain("Monday 1 June");
  });

  it("uses the customer's own zone and names it", () => {
    // A reminder saying 14:30 to someone whose phone says 23:30 is worse than
    // no reminder: they will trust the message.
    const text = renderReminder({ ...base, customerTimeZone: "Asia/Tokyo" });
    expect(text).toContain("22:30");
    expect(text).toContain("Asia/Tokyo");
  });

  it("does not name the zone when it matches the business's", () => {
    const text = renderReminder({ ...base, customerTimeZone: "Europe/London" });
    expect(text).not.toContain("Europe/London");
  });
});

describe("redact", () => {
  it("keeps enough of a destination to be useful in a log, and no more", () => {
    expect(redact("+447700900123")).toBe("***0123");
    expect(redact("alice@example.test")).toBe("al***@example.test");
  });
});
