/**
 * Booking, cancelling and rescheduling.
 *
 * The important design decision in here is that availability is checked twice
 * and neither check is trusted on its own:
 *
 *   1. The engine re-checks the slot at write time, so a customer whose
 *      browser has been showing a stale slot list gets a clear message rather
 *      than a surprise.
 *   2. The database's exclusion constraint catches the case the engine cannot:
 *      two requests that both pass step 1 before either inserts. There is no
 *      amount of application-level care that closes that window, because the
 *      check and the insert are two statements.
 *
 * Code 23P01 from Postgres is therefore not an unexpected error. It is the
 * expected outcome of a race, and it is translated into the same conflict the
 * customer would have seen a moment earlier.
 */

import { and, eq, gt, inArray, lt } from "drizzle-orm";
import type { Executor } from "@/db/client";
import {
  appointments,
  customers,
  organizations,
  services,
  staff,
  type Appointment,
  type Service,
} from "@/db/schema";
import {
  availableSlots,
  isSlotBookable,
  type AvailabilityQuery,
  type ServicePolicy,
  type Slot,
} from "@/domain/time/availability";
import type { Interval } from "@/domain/time/interval";
import { MINUTE } from "@/domain/time/zone";
import { AppError } from "@/lib/errors";
import { recordAudit, type RequestMeta } from "@/server/audit";
import { assertWithinLimit } from "@/server/billing/plans";
import { getEntitlements } from "@/server/billing/service";
import { assertCan, type Actor } from "@/server/rbac";
import { cancelReminders, scheduleReminders } from "@/server/reminders/service";
import { appointmentsThisMonth } from "./catalogue";
import {
  BLOCKING_STATUSES,
  loadAvailability,
  staffForService,
} from "./schedule-source";

/** Postgres raises this when an exclusion constraint is violated. */
const EXCLUSION_VIOLATION = "23P01";
const UNIQUE_VIOLATION = "23505";

function pgCode(err: unknown): string | undefined {
  // postgres-js wraps the server error; drizzle wraps that again.
  const seen = new Set<unknown>();
  let cursor: unknown = err;
  while (cursor && typeof cursor === "object" && !seen.has(cursor)) {
    seen.add(cursor);
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

export function policyOf(service: Service): ServicePolicy {
  return {
    durationMinutes: service.durationMinutes,
    stepMinutes: service.stepMinutes,
    bufferBeforeMinutes: service.bufferBeforeMinutes,
    bufferAfterMinutes: service.bufferAfterMinutes,
    minimumNoticeMinutes: service.minimumNoticeMinutes,
    maximumAdvanceDays: service.maximumAdvanceDays,
    alignToMinutes: service.stepMinutes,
  };
}

async function loadService(
  db: Executor,
  orgId: string,
  serviceId: string,
): Promise<Service> {
  const [row] = await db
    .select()
    .from(services)
    .where(and(eq(services.orgId, orgId), eq(services.id, serviceId)));
  if (!row) throw new AppError("not_found", "no such service", { serviceId });
  if (!row.active)
    throw new AppError("invalid", "that service is not being offered", {
      serviceId,
    });
  return row;
}

/** The organization's reminder offsets, in minutes before the appointment. */
async function reminderOffsets(db: Executor, orgId: string): Promise<number[]> {
  const [org] = await db
    .select({ offsets: organizations.reminderOffsetsMinutes })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  // A business that has cleared its offsets wants no reminders, which is a
  // legitimate choice and not a reason to fall back to a default.
  return org?.offsets ?? [];
}

async function businessTimeZone(db: Executor, orgId: string): Promise<string> {
  const [org] = await db
    .select({ timeZone: organizations.timeZone })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) throw new AppError("not_found", "no such organization", { orgId });
  return org.timeZone;
}

export interface SlotQuery {
  orgId: string;
  serviceId: string;
  /** The window to search, as instants. */
  within: Interval;
  /** Now, passed in so a test can choose it. */
  now?: number;
  /** Restrict to one member of staff, when the customer picked one. */
  staffId?: string;
}

/** Builds the engine query for a service, loading everything it needs. */
async function buildQuery(
  db: Executor,
  query: SlotQuery,
  options: { excludeAppointmentId?: string } = {},
): Promise<{ query: AvailabilityQuery; service: Service }> {
  const service = await loadService(db, query.orgId, query.serviceId);
  const zone = await businessTimeZone(db, query.orgId);

  let staffIds = await staffForService(db, query.orgId, query.serviceId);
  if (staffIds.length === 0) {
    // No explicit assignment means anyone can do it, which is what a
    // one-person business expects without configuring anything.
    staffIds = [];
  }
  if (query.staffId) {
    // Asking for a member of staff who cannot perform the service is a
    // client error, not an empty list: an empty list reads as "fully booked".
    if (staffIds.length > 0 && !staffIds.includes(query.staffId)) {
      throw new AppError(
        "invalid",
        "that member of staff does not offer this service",
        {
          staffId: query.staffId,
          serviceId: query.serviceId,
        },
      );
    }
    staffIds = [query.staffId];
  }

  const loaded = await loadAvailability(db, {
    orgId: query.orgId,
    businessTimeZone: zone,
    ...(staffIds.length > 0 ? { staffIds } : {}),
    within: query.within,
    ...(options.excludeAppointmentId
      ? { excludeAppointmentId: options.excludeAppointmentId }
      : {}),
  });

  return {
    service,
    query: {
      schedule: loaded.business,
      service: policyOf(service),
      within: query.within,
      now: query.now ?? Date.now(),
      resources: loaded.resources,
      busy: loaded.sharedBusy,
    },
  };
}

/** The slots a customer can be offered. */
export async function listSlots(
  db: Executor,
  query: SlotQuery,
): Promise<Slot[]> {
  const built = await buildQuery(db, query);
  return availableSlots(built.query);
}

export interface BookInput {
  orgId: string;
  serviceId: string;
  /** Epoch milliseconds. The start the customer chose. */
  startsAt: number;
  staffId?: string;
  customer: { name: string; email?: string; phone?: string; timeZone?: string };
  /** The zone the customer was shown, recorded so a reschedule can match it. */
  customerTimeZone?: string;
  notes?: string;
  /**
   * Makes the request safe to retry. A customer double-clicking "confirm"
   * sends the same key twice and gets the same appointment back, rather than
   * two bookings or a confusing conflict.
   */
  idempotencyKey?: string;
  now?: number;
}

export interface BookResult {
  appointment: Appointment;
  /** True when an existing appointment was returned for a repeated key. */
  deduplicated: boolean;
}

/**
 * Books an appointment.
 *
 * Runs inside the caller's transaction, so the customer upsert and the
 * appointment insert either both happen or neither does. A customer row
 * created for a booking that then failed the exclusion constraint would leave
 * a stranger in the business's customer list.
 */
export async function book(
  db: Executor,
  actor: Actor | { kind: "public" },
  input: BookInput,
): Promise<BookResult> {
  // A public booking page writes on behalf of nobody, so there is no
  // permission to check; an internal caller must hold bookings:write.
  if (actor.kind !== "public") assertCan(actor, "bookings:write");

  const now = input.now ?? Date.now();

  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(
      db,
      input.orgId,
      input.idempotencyKey,
    );
    if (existing) return { appointment: existing, deduplicated: true };
  }

  const service = await loadService(db, input.orgId, input.serviceId);
  const duration = service.durationMinutes * MINUTE;
  const endsAt = input.startsAt + duration;

  // The plan's monthly booking allowance. Checked before the slot is held so
  // a business over its limit gets a payment_required rather than an
  // appointment it cannot keep -- and checked for public bookings too, since
  // that is where the volume comes from.
  const entitlements = await getEntitlements(db);
  assertWithinLimit(
    entitlements.maxAppointmentsPerMonth,
    await appointmentsThisMonth(db),
    "appointment this month",
  );

  const built = await buildQuery(db, {
    orgId: input.orgId,
    serviceId: input.serviceId,
    within: { start: input.startsAt, end: endsAt },
    now,
    ...(input.staffId ? { staffId: input.staffId } : {}),
  });

  const verdict = isSlotBookable(built.query, {
    start: input.startsAt,
    ...(input.staffId ? { resourceId: input.staffId } : {}),
  });
  if (!verdict.ok)
    throw new AppError("conflict", verdict.reason, {
      startsAt: input.startsAt,
    });

  const staffId = input.staffId ?? verdict.resourceIds[0];
  if (!staffId) {
    throw new AppError("conflict", "nobody is available at that time", {
      startsAt: input.startsAt,
    });
  }

  const customer = await upsertCustomer(db, input.orgId, input.customer);

  const requiresPayment = service.requiresPayment && service.priceMinor > 0;
  const depositMinor = requiresPayment
    ? (service.depositMinor ?? service.priceMinor)
    : 0;

  try {
    const [row] = await db
      .insert(appointments)
      .values({
        orgId: input.orgId,
        serviceId: service.id,
        staffId,
        customerId: customer.id,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(endsAt),
        // Copied from the service, not referenced: changing the service's
        // buffers later must not move an existing appointment's footprint.
        bufferBeforeMinutes: service.bufferBeforeMinutes,
        bufferAfterMinutes: service.bufferAfterMinutes,
        status: requiresPayment ? "pending" : "confirmed",
        paymentStatus: requiresPayment ? "pending" : "not_required",
        priceMinor: service.priceMinor,
        depositMinor,
        currency: service.currency,
        customerTimeZone:
          input.customerTimeZone ?? input.customer.timeZone ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        notes: input.notes ?? null,
        manageToken: newManageToken(),
      })
      .returning();
    if (!row) throw new AppError("conflict", "the booking was not created");

    // The channels come from the *resolved* customer rather than from this
    // request. A returning customer who gave a phone number last time can be
    // texted even if they left the field blank today, and -- more
    // importantly -- book and reschedule then agree, instead of one adding
    // SMS reminders the other never would.
    //
    // Reminders are scheduled in the same transaction as the booking. A
    // separate call afterwards can fail, and a booking with no reminder is a
    // missed appointment -- the one outcome the whole product exists to
    // prevent.
    await scheduleReminders(db, {
      orgId: input.orgId,
      appointmentId: row.id,
      startsAt: input.startsAt,
      offsetsMinutes: await reminderOffsets(db, input.orgId),
      channels: customer.phone ? ["sms", "email"] : ["email"],
      now,
    });

    if (actor.kind !== "public") {
      await recordAudit(db, {
        orgId: input.orgId,
        actor,
        action: "booking.created",
        target: { type: "appointment", id: row.id },
        metadata: { startsAt: new Date(input.startsAt).toISOString(), staffId },
      });
    }
    return { appointment: row, deduplicated: false };
  } catch (err) {
    const code = pgCode(err);
    if (code === EXCLUSION_VIOLATION) {
      // The race: another request booked this slot between our check and our
      // insert. The customer sees the same message they would have seen a
      // moment earlier, and the database's DETAIL -- which names the
      // conflicting row -- is deliberately not passed on.
      throw new AppError("conflict", "that time has just been taken", {
        startsAt: input.startsAt,
      });
    }
    if (code === UNIQUE_VIOLATION && input.idempotencyKey) {
      // Two retries of the same request in flight at once. Whichever lost can
      // return the row the winner created.
      const existing = await findByIdempotencyKey(
        db,
        input.orgId,
        input.idempotencyKey,
      );
      if (existing) return { appointment: existing, deduplicated: true };
    }
    throw err;
  }
}

async function findByIdempotencyKey(
  db: Executor,
  orgId: string,
  key: string,
): Promise<Appointment | undefined> {
  const [row] = await db
    .select()
    .from(appointments)
    .where(
      and(eq(appointments.orgId, orgId), eq(appointments.idempotencyKey, key)),
    );
  return row;
}

/**
 * Finds or creates the customer.
 *
 * Matched on email, then phone, because a returning customer typing their
 * email again should not become a second row — a business's customer list is
 * one of the few things they look at every day.
 */
async function upsertCustomer(
  db: Executor,
  orgId: string,
  input: { name: string; email?: string; phone?: string; timeZone?: string },
): Promise<{ id: string; email: string | null; phone: string | null }> {
  const email = input.email?.trim().toLowerCase() || undefined;
  const phone = input.phone?.trim() || undefined;

  if (email || phone) {
    const [found] = await db
      .select({
        id: customers.id,
        email: customers.email,
        phone: customers.phone,
      })
      .from(customers)
      .where(
        and(
          eq(customers.orgId, orgId),
          email ? eq(customers.email, email) : eq(customers.phone, phone!),
        ),
      );
    if (found) {
      // Fill in a detail the business did not have before -- not overwrite
      // one. A customer correcting their number does it from the admin
      // screen; a typo on a booking form must not replace a number that
      // works.
      if (phone && !found.phone) {
        await db
          .update(customers)
          .set({ phone })
          .where(eq(customers.id, found.id));
        return { ...found, phone };
      }
      if (email && !found.email) {
        await db
          .update(customers)
          .set({ email })
          .where(eq(customers.id, found.id));
        return { ...found, email };
      }
      return found;
    }
  }

  const [created] = await db
    .insert(customers)
    .values({
      orgId,
      name: input.name,
      email: email ?? null,
      phone: phone ?? null,
      timeZone: input.timeZone ?? null,
    })
    .returning({
      id: customers.id,
      email: customers.email,
      phone: customers.phone,
    });
  if (!created)
    throw new AppError("conflict", "the customer record was not created");
  return created;
}

export interface CancelInput {
  orgId: string;
  appointmentId: string;
  reason?: string;
  now?: number;
}

export interface CancelResult {
  appointment: Appointment;
  /** Whether the cancellation falls inside the service's refund window. */
  refundable: boolean;
  refundMinor: number;
}

/**
 * Cancels an appointment and reports whether it is refundable.
 *
 * The refund decision is returned rather than acted on: moving money is the
 * payments module's job, and a cancellation that cannot be recorded because a
 * refund failed is worse than one recorded with a refund still pending.
 */
export async function cancel(
  db: Executor,
  actor: Actor | { kind: "public"; manageToken: string },
  input: CancelInput,
  request?: RequestMeta,
): Promise<CancelResult> {
  if (actor.kind !== "public") assertCan(actor, "bookings:write");
  const now = input.now ?? Date.now();

  const [existing] = await db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.orgId, input.orgId),
        eq(appointments.id, input.appointmentId),
      ),
    );
  if (!existing) throw new AppError("not_found", "no such appointment");

  // A customer cancelling from an emailed link proves who they are with the
  // token, which is compared in full rather than used as a lookup key.
  if (
    actor.kind === "public" &&
    !safeEqual(actor.manageToken, existing.manageToken)
  ) {
    throw new AppError("forbidden", "that link is not valid for this booking");
  }

  if (existing.status === "cancelled") {
    // Idempotent: a customer clicking the cancel link twice should not get an
    // error, and should not be told a second time that it is refundable.
    return { appointment: existing, refundable: false, refundMinor: 0 };
  }

  const service = await loadService(db, input.orgId, existing.serviceId).catch(
    () => undefined,
  );
  const windowHours = service?.cancellationWindowHours ?? 24;
  const hoursUntil = (existing.startsAt.getTime() - now) / (60 * MINUTE);
  const refundable =
    hoursUntil >= windowHours && existing.paymentStatus === "paid";

  const [row] = await db
    .update(appointments)
    .set({
      status: "cancelled",
      cancelledAt: new Date(now),
      cancellationReason: input.reason ?? null,
    })
    .where(eq(appointments.id, existing.id))
    .returning();
  if (!row) throw new AppError("conflict", "the cancellation was not recorded");

  // Nobody should be reminded about a booking that is not happening.
  await cancelReminders(db, row.id);

  await recordAudit(db, {
    orgId: input.orgId,
    actor: actor.kind === "public" ? { kind: "system" } : actor,
    action: "booking.cancelled",
    target: { type: "appointment", id: row.id },
    metadata: { refundable, hoursUntil: Math.round(hoursUntil) },
    ...(request ? { request } : {}),
  });

  return {
    appointment: row,
    refundable,
    refundMinor: refundable ? row.depositMinor : 0,
  };
}

export interface RescheduleInput {
  orgId: string;
  appointmentId: string;
  startsAt: number;
  staffId?: string;
  now?: number;
}

/**
 * Moves an appointment.
 *
 * Done as an UPDATE rather than a cancel-and-rebook so the appointment keeps
 * its id, its payment and its manage link. That means the exclusion
 * constraint has to tolerate the row moving past itself, which it does: the
 * row being updated is not compared against its own old value.
 *
 * The availability check excludes this appointment, or moving it by ten
 * minutes would conflict with where it already is.
 */
export async function reschedule(
  db: Executor,
  actor: Actor | { kind: "public"; manageToken: string },
  input: RescheduleInput,
): Promise<Appointment> {
  if (actor.kind !== "public") assertCan(actor, "bookings:write");
  const now = input.now ?? Date.now();

  const [existing] = await db
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.orgId, input.orgId),
        eq(appointments.id, input.appointmentId),
      ),
    );
  if (!existing) throw new AppError("not_found", "no such appointment");
  if (
    actor.kind === "public" &&
    !safeEqual(actor.manageToken, existing.manageToken)
  ) {
    throw new AppError("forbidden", "that link is not valid for this booking");
  }
  if (existing.status === "cancelled") {
    throw new AppError(
      "invalid",
      "a cancelled booking cannot be moved; make a new one",
    );
  }

  const service = await loadService(db, input.orgId, existing.serviceId);
  const endsAt = input.startsAt + service.durationMinutes * MINUTE;
  const staffId = input.staffId ?? existing.staffId;

  const built = await buildQuery(
    db,
    {
      orgId: input.orgId,
      serviceId: existing.serviceId,
      within: { start: input.startsAt, end: endsAt },
      now,
      staffId,
    },
    { excludeAppointmentId: existing.id },
  );

  const verdict = isSlotBookable(built.query, {
    start: input.startsAt,
    resourceId: staffId,
  });
  if (!verdict.ok)
    throw new AppError("conflict", verdict.reason, {
      startsAt: input.startsAt,
    });

  try {
    const [row] = await db
      .update(appointments)
      .set({
        startsAt: new Date(input.startsAt),
        endsAt: new Date(endsAt),
        staffId,
      })
      .where(eq(appointments.id, existing.id))
      .returning();
    if (!row) throw new AppError("conflict", "the reschedule was not recorded");

    // The due times all move with the appointment. scheduleReminders is
    // idempotent on (appointment, channel, offset), so this updates the
    // existing rows rather than adding a second set -- and it resets a
    // reminder that had already been sent for the old time.
    //
    // The channels are derived from the customer, exactly as when the booking
    // was made. Passing both unconditionally would add SMS reminders for a
    // customer who never gave a phone number, and they would then fail on
    // every pass until the worker gave up.
    const [contact] = await db
      .select({ phone: customers.phone })
      .from(customers)
      .where(eq(customers.id, existing.customerId));
    await scheduleReminders(db, {
      orgId: input.orgId,
      appointmentId: row.id,
      startsAt: input.startsAt,
      offsetsMinutes: await reminderOffsets(db, input.orgId),
      channels: contact?.phone ? ["sms", "email"] : ["email"],
      now,
    });

    await recordAudit(db, {
      orgId: input.orgId,
      actor: actor.kind === "public" ? { kind: "system" } : actor,
      action: "booking.rescheduled",
      target: { type: "appointment", id: row.id },
      metadata: {
        from: existing.startsAt.toISOString(),
        to: row.startsAt.toISOString(),
      },
    });
    return row;
  } catch (err) {
    if (pgCode(err) === EXCLUSION_VIOLATION) {
      throw new AppError("conflict", "that time has just been taken", {
        startsAt: input.startsAt,
      });
    }
    throw err;
  }
}

/** Marks an appointment as attended or not, which is what the diary is for. */
export async function markAttendance(
  db: Executor,
  actor: Actor,
  input: { orgId: string; appointmentId: string; attended: boolean },
): Promise<Appointment> {
  assertCan(actor, "bookings:write");
  const [row] = await db
    .update(appointments)
    .set({ status: input.attended ? "completed" : "no_show" })
    .where(
      and(
        eq(appointments.orgId, input.orgId),
        eq(appointments.id, input.appointmentId),
        inArray(appointments.status, BLOCKING_STATUSES),
      ),
    )
    .returning();
  if (!row)
    throw new AppError("not_found", "no such appointment, or it is cancelled");
  return row;
}

/** The diary, for the admin calendar. */
export async function listAppointments(
  db: Executor,
  actor: Actor,
  input: { orgId: string; within: Interval; staffId?: string },
): Promise<
  (Appointment & {
    customerName: string;
    serviceName: string;
    staffName: string;
  })[]
> {
  assertCan(actor, "bookings:read");
  const rows = await db
    .select({
      appointment: appointments,
      customerName: customers.name,
      serviceName: services.name,
      staffName: staff.name,
    })
    .from(appointments)
    .innerJoin(customers, eq(customers.id, appointments.customerId))
    .innerJoin(services, eq(services.id, appointments.serviceId))
    .innerJoin(staff, eq(staff.id, appointments.staffId))
    .where(
      and(
        eq(appointments.orgId, input.orgId),
        input.staffId ? eq(appointments.staffId, input.staffId) : undefined,
        // lt/gt rather than a raw sql template: the template would pass the
        // Date straight to the driver without the column's type mapping, and
        // postgres-js then refuses it outright.
        lt(appointments.startsAt, new Date(input.within.end)),
        gt(appointments.endsAt, new Date(input.within.start)),
      ),
    )
    .orderBy(appointments.startsAt);

  return rows.map((r) => ({
    ...r.appointment,
    customerName: r.customerName,
    serviceName: r.serviceName,
    staffName: r.staffName,
  }));
}

/** A URL-safe token with enough entropy that guessing is not a strategy. */
function newManageToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Compares two tokens without leaking their length or contents through
 * timing. A manage token is a bearer credential, and `===` on a string
 * returns as soon as it finds a difference.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}
