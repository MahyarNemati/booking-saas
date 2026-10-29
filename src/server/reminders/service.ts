/**
 * Scheduling and sending appointment reminders.
 *
 * Reminders are rows with a due time, not timers in a process. A timer dies
 * with the process holding it, and a booking made in January for a date in
 * March would need the process to stay up for two months. A row survives a
 * restart, can be claimed by exactly one worker, and leaves a record of what
 * was sent — which is the difference between believing a customer was
 * reminded and knowing it.
 */

import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Database, Executor } from "@/db/client";
import {
  appointments,
  customers,
  organizations,
  reminders,
  services,
  type Reminder,
  type ReminderChannel,
} from "@/db/schema";
import { formatMinuteOfDay, MINUTE, partsOf } from "@/domain/time/zone";
import type { Logger } from "@/lib/logger";
import { SendError, type MessageSender } from "./provider";

/** How many times a transient failure is retried before giving up. */
const MAX_ATTEMPTS = 4;

/**
 * How long a worker's claim on a reminder lasts.
 *
 * A worker that dies mid-send leaves the row `sending` for ever unless
 * something reclaims it. The lease is that something: long enough that a slow
 * provider call does not get the reminder sent twice, short enough that a
 * crashed worker's reminders still go out in time to be useful.
 */
const LEASE_MINUTES = 5;

export interface ScheduleInput {
  orgId: string;
  appointmentId: string;
  startsAt: number;
  /** Minutes before the appointment. Taken from the organization's settings. */
  offsetsMinutes: readonly number[];
  channels: readonly ReminderChannel[];
  now?: number;
}

/**
 * Creates or updates the reminders for one appointment.
 *
 * Idempotent through the natural key (appointment, channel, offset), so this
 * can be called again after a reschedule without producing duplicates — which
 * is exactly what rescheduling needs, since the due times all move.
 *
 * A reminder whose time has already passed is not created at all. Sending "your
 * appointment is in 24 hours" for an appointment in two hours is worse than
 * sending nothing.
 */
export async function scheduleReminders(
  tx: Executor,
  input: ScheduleInput,
): Promise<Reminder[]> {
  const now = input.now ?? Date.now();
  const rows: {
    orgId: string;
    appointmentId: string;
    channel: ReminderChannel;
    offsetMinutes: number;
    dueAt: Date;
  }[] = [];

  for (const channel of input.channels) {
    for (const offsetMinutes of input.offsetsMinutes) {
      const dueAt = input.startsAt - offsetMinutes * MINUTE;
      if (dueAt <= now) continue;
      rows.push({
        orgId: input.orgId,
        appointmentId: input.appointmentId,
        channel,
        offsetMinutes,
        dueAt: new Date(dueAt),
      });
    }
  }
  if (rows.length === 0) return [];

  return tx
    .insert(reminders)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        reminders.appointmentId,
        reminders.channel,
        reminders.offsetMinutes,
      ],
      set: {
        dueAt: sql`excluded.due_at`,
        // A rescheduled appointment needs its already-sent reminder to go
        // again for the new time, and its attempt count reset.
        status: "scheduled",
        claimedAt: null,
        attempts: 0,
        sentAt: null,
        lastError: null,
      },
      // Only reschedule the ones that have actually moved, so a no-op update
      // does not resurrect a reminder that was correctly sent.
      setWhere: sql`${reminders.dueAt} <> excluded.due_at`,
    })
    .returning();
}

/** Cancels the outstanding reminders for a booking that is no longer happening. */
export async function cancelReminders(
  tx: Executor,
  appointmentId: string,
): Promise<number> {
  const rows = await tx
    .update(reminders)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(reminders.appointmentId, appointmentId),
        eq(reminders.status, "scheduled"),
      ),
    )
    .returning({ id: reminders.id });
  return rows.length;
}

export interface DueReminder {
  reminder: Reminder;
  appointmentStartsAt: Date;
  appointmentStatus: string;
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  customerTimeZone: string | null;
  businessName: string;
  businessTimeZone: string;
  serviceName: string;
}

/**
 * Claims up to `limit` due reminders for this worker.
 *
 * Two mechanisms, and both are needed.
 *
 * `FOR UPDATE SKIP LOCKED` keeps two workers from reading the same row in the
 * same instant: each row is locked by whoever reaches it first and the others
 * walk past instead of blocking. Without `SKIP LOCKED` they serialise behind
 * one row; without the lock at all they both take it.
 *
 * That alone is not enough, and getting this wrong is a subtle way to text
 * every customer twice. The lock lasts only as long as the transaction, and
 * the message is sent *after* it commits -- so a row left `scheduled` is
 * claimable again the moment the claiming transaction ends. The row is
 * therefore moved to `sending` with the time it was claimed, and only rows
 * that are scheduled, or stuck in `sending` past their lease, are taken.
 * Reclaiming an expired lease is also what recovers a worker that died
 * mid-send, with no separate sweeper.
 */
export async function claimDue(
  db: Database,
  options: { limit?: number; now?: number; leaseMinutes?: number } = {},
): Promise<DueReminder[]> {
  const limit = options.limit ?? 50;
  const nowMs = options.now ?? Date.now();
  const now = new Date(nowMs);
  const leaseCutoff = new Date(
    nowMs - (options.leaseMinutes ?? LEASE_MINUTES) * 60_000,
  );

  return db.transaction(async (tx) => {
    // The timestamps go in as ISO strings with explicit casts. A raw `sql`
    // template has no column to take a type from, so passing a Date leaves
    // the driver with a value it refuses outright -- and the failure is a
    // TypeError about Buffers, which is a long way from the cause.
    const claimed = await tx.execute<{ id: string }>(sql`
      select id from reminders
      where due_at <= ${now.toISOString()}::timestamptz
        and (
          status = 'scheduled'
          or (status = 'sending' and claimed_at < ${leaseCutoff.toISOString()}::timestamptz)
        )
      order by due_at
      limit ${limit}
      for update skip locked
    `);
    const ids = [...claimed].map((r) => r.id);
    if (ids.length === 0) return [];

    // Marked as in flight inside the same transaction that claimed them, so
    // the lock is never released with the rows still looking available.
    await tx
      .update(reminders)
      .set({
        status: "sending",
        claimedAt: now,
        attempts: sql`${reminders.attempts} + 1`,
      })
      .where(inArray(reminders.id, ids));

    const rows = await tx
      .select({
        reminder: reminders,
        appointmentStartsAt: appointments.startsAt,
        appointmentStatus: appointments.status,
        customerName: customers.name,
        customerEmail: customers.email,
        customerPhone: customers.phone,
        customerTimeZone: customers.timeZone,
        businessName: organizations.name,
        businessTimeZone: organizations.timeZone,
        serviceName: services.name,
      })
      .from(reminders)
      .innerJoin(appointments, eq(appointments.id, reminders.appointmentId))
      .innerJoin(customers, eq(customers.id, appointments.customerId))
      .innerJoin(services, eq(services.id, appointments.serviceId))
      .innerJoin(organizations, eq(organizations.id, reminders.orgId))
      .where(inArray(reminders.id, ids));

    return rows.map((r) => ({
      reminder: r.reminder,
      appointmentStartsAt: r.appointmentStartsAt,
      appointmentStatus: r.appointmentStatus,
      customerName: r.customerName,
      customerEmail: r.customerEmail,
      customerPhone: r.customerPhone,
      customerTimeZone: r.customerTimeZone,
      businessName: r.businessName,
      businessTimeZone: r.businessTimeZone,
      serviceName: r.serviceName,
    }));
  });
}

/**
 * The reminder text.
 *
 * Rendered in the *customer's* zone when it is known, falling back to the
 * business's. A reminder telling someone their appointment is at 09:00 when
 * their phone says 10:00 is worse than no reminder: they will trust the
 * message.
 */
export function renderReminder(due: DueReminder): string {
  const zone = due.customerTimeZone ?? due.businessTimeZone;
  const parts = partsOf(due.appointmentStartsAt.getTime(), zone);
  const time = formatMinuteOfDay(parts.hour * 60 + parts.minute);
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(due.appointmentStartsAt);

  return (
    `Reminder: ${due.serviceName} at ${due.businessName}, ` +
    `${date} at ${time}. ` +
    // The zone is named when it is not the business's own, so a customer who
    // booked while travelling is not left guessing which clock it is.
    (due.customerTimeZone && due.customerTimeZone !== due.businessTimeZone
      ? `(${zone}) `
      : "") +
    `Reply to this message if you need to change it.`
  );
}

export interface SendOutcome {
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * Sends the claimed reminders.
 *
 * Each one is finished independently: a permanent failure is recorded and
 * abandoned, a transient one is put back with its attempt count raised, and
 * neither affects the others in the batch. One bad phone number must not stop
 * forty good reminders.
 */
export async function sendClaimed(
  db: Database,
  senders: Partial<Record<ReminderChannel, MessageSender>>,
  due: readonly DueReminder[],
  logger: Pick<Logger, "info" | "warn">,
): Promise<SendOutcome> {
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of due) {
    const { reminder } = item;

    // The appointment may have been cancelled between scheduling and now, and
    // cancelReminders may have missed it -- a direct status update, say. The
    // check here is the one that actually protects the customer from being
    // reminded about a booking that is not happening.
    if (item.appointmentStatus === "cancelled") {
      await db
        .update(reminders)
        .set({ status: "cancelled", claimedAt: null })
        .where(eq(reminders.id, reminder.id));
      skipped += 1;
      continue;
    }

    const sender = senders[reminder.channel];
    const to =
      reminder.channel === "sms" ? item.customerPhone : item.customerEmail;
    if (!sender || !to) {
      await db
        .update(reminders)
        .set({
          status: "failed",
          claimedAt: null,
          lastError: sender
            ? `no ${reminder.channel} address`
            : `no ${reminder.channel} sender`,
        })
        .where(eq(reminders.id, reminder.id));
      skipped += 1;
      continue;
    }

    try {
      const result = await sender.send({
        to,
        body: renderReminder(item),
        // One message per reminder row, however many times the worker
        // retries: the provider deduplicates on this.
        idempotencyKey: reminder.id,
      });
      await db
        .update(reminders)
        .set({
          status: "sent",
          claimedAt: null,
          sentAt: new Date(),
          providerMessageId: result.messageId,
          lastError: null,
        })
        .where(eq(reminders.id, reminder.id));
      sent += 1;
    } catch (err) {
      const retryable = err instanceof SendError ? err.retryable : true;
      const attempts = reminder.attempts + 1;
      const giveUp = !retryable || attempts >= MAX_ATTEMPTS;

      await db
        .update(reminders)
        .set({
          // Back to scheduled so the next pass picks it up; a due time in the
          // past means it is tried again immediately, which is right for a
          // transient failure. The lease is released either way, so a
          // retryable failure does not have to wait for it to expire.
          status: giveUp ? "failed" : "scheduled",
          claimedAt: null,
          lastError:
            err instanceof Error ? err.message.slice(0, 500) : String(err),
        })
        .where(eq(reminders.id, reminder.id));

      logger.warn(
        { reminderId: reminder.id, attempts, retryable, giveUp },
        "reminder send failed",
      );
      failed += 1;
    }
  }

  if (sent > 0 || failed > 0) {
    logger.info({ sent, skipped, failed }, "reminder batch finished");
  }
  return { sent, skipped, failed };
}

/** One pass of the worker: claim what is due and send it. */
export async function runOnce(
  db: Database,
  senders: Partial<Record<ReminderChannel, MessageSender>>,
  logger: Pick<Logger, "info" | "warn">,
  options: { limit?: number; now?: number } = {},
): Promise<SendOutcome> {
  const due = await claimDue(db, options);
  if (due.length === 0) return { sent: 0, skipped: 0, failed: 0 };
  return sendClaimed(db, senders, due, logger);
}

/**
 * Reminders that are overdue and getting nowhere, for an operator to look at.
 *
 * Covers both shapes of stuck: one that keeps failing and being rescheduled,
 * and one abandoned in `sending` by a worker that died. The second is
 * reclaimed automatically once its lease expires, so appearing here means it
 * has been through that at least once and is still not going out.
 */
export async function stuckReminders(
  db: Database,
  now = Date.now(),
): Promise<Reminder[]> {
  return db
    .select()
    .from(reminders)
    .where(
      and(
        inArray(reminders.status, ["scheduled", "sending"]),
        lte(reminders.dueAt, new Date(now - 60 * MINUTE)),
        sql`${reminders.attempts} >= 1`,
      ),
    );
}
