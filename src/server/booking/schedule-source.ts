/**
 * Turns the stored availability rows into the `Schedule` objects the engine
 * takes.
 *
 * The split is deliberate: `src/domain/time` knows nothing about the database
 * and the database knows nothing about interval algebra. This file is the only
 * place that knows both, which is why it is small and why the engine's tests
 * need no Postgres.
 */

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { Executor } from "@/db/client";
import {
  appointments,
  availabilityRules,
  dateOverrides,
  staff,
  staffServices,
  timeOff,
  type AppointmentStatus,
} from "@/db/schema";
import type { Busy, Resource } from "@/domain/time/availability";
import type { Interval } from "@/domain/time/interval";
import type {
  DateOverride,
  Schedule,
  WeeklyRule,
  Window,
} from "@/domain/time/schedule";
import { isValidZone, parseDate } from "@/domain/time/zone";
import { AppError } from "@/lib/errors";

/** Statuses that occupy the diary. A cancelled appointment frees its slot. */
export const BLOCKING_STATUSES: readonly AppointmentStatus[] = [
  "pending",
  "confirmed",
  "completed",
  "no_show",
];

export interface LoadedAvailability {
  /** The whole business: hours that apply to everyone. */
  business: Schedule;
  /** Per-staff hours and bookings, in the order the staff rows came back. */
  resources: Resource[];
  /** Closures that block every member of staff. */
  sharedBusy: Busy[];
}

interface Row {
  staffId: string | null;
  weekday: number;
  startMinute: number;
  endMinute: number;
  validFrom: string | null;
  validUntil: string | null;
}

function toWeeklyRule(row: Row): WeeklyRule {
  return {
    weekday: row.weekday,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
    ...(row.validFrom ? { from: parseDate(row.validFrom) } : {}),
    ...(row.validUntil ? { until: parseDate(row.validUntil) } : {}),
  };
}

function toOverride(row: {
  onDate: string;
  closed: boolean;
  windows: { startMinute: number; endMinute: number }[];
}): DateOverride {
  return {
    date: parseDate(row.onDate),
    // A closed day is an override with no windows. Keeping the boolean *and*
    // the array lets the database reject "closed with hours", which would
    // otherwise be representable and ambiguous.
    windows: row.closed ? [] : (row.windows as Window[]),
  };
}

export interface LoadOptions {
  orgId: string;
  /** The business's own zone, from the organization row. */
  businessTimeZone: string;
  /** Restrict to these staff, e.g. those who can perform the service. */
  staffIds?: readonly string[];
  /** The window bookings are being looked for in, for the busy query. */
  within: Interval;
  /** Exclude one appointment, so rescheduling does not collide with itself. */
  excludeAppointmentId?: string;
}

/**
 * Loads everything the engine needs for one availability query.
 *
 * Deliberately a handful of queries rather than one join: the rows fan out
 * (rules × overrides × appointments) and a single join would multiply them,
 * then need de-duplicating in memory. Five indexed queries over a few hundred
 * rows each is both faster and far easier to read.
 */
export async function loadAvailability(
  db: Executor,
  options: LoadOptions,
): Promise<LoadedAvailability> {
  const { orgId, within } = options;
  if (!isValidZone(options.businessTimeZone)) {
    throw new AppError(
      "invalid",
      `unknown time zone ${options.businessTimeZone}`,
      {
        timeZone: options.businessTimeZone,
      },
    );
  }

  const staffFilter =
    options.staffIds && options.staffIds.length > 0
      ? and(
          eq(staff.orgId, orgId),
          eq(staff.active, true),
          inArray(staff.id, options.staffIds),
        )
      : and(eq(staff.orgId, orgId), eq(staff.active, true));

  const staffRows = await db
    .select({ id: staff.id, timeZone: staff.timeZone })
    .from(staff)
    .where(staffFilter);

  const rules = await db
    .select({
      staffId: availabilityRules.staffId,
      weekday: availabilityRules.weekday,
      startMinute: availabilityRules.startMinute,
      endMinute: availabilityRules.endMinute,
      validFrom: availabilityRules.validFrom,
      validUntil: availabilityRules.validUntil,
    })
    .from(availabilityRules)
    .where(eq(availabilityRules.orgId, orgId));

  // Overrides are fetched for a generous window: a date string comparison is
  // exact, and the engine ignores the ones outside its range.
  const overrideRows = await db
    .select({
      staffId: dateOverrides.staffId,
      onDate: dateOverrides.onDate,
      closed: dateOverrides.closed,
      windows: dateOverrides.windows,
    })
    .from(dateOverrides)
    .where(eq(dateOverrides.orgId, orgId));

  // Time off and appointments are filtered by the window, which is what the
  // indexes are for. The window is widened by a day on each side so an
  // appointment that started before it and runs into it is still found.
  const margin = 24 * 60 * 60 * 1000;
  const from = new Date(within.start - margin);
  const to = new Date(within.end + margin);

  const timeOffRows = await db
    .select({
      staffId: timeOff.staffId,
      startsAt: timeOff.startsAt,
      endsAt: timeOff.endsAt,
    })
    .from(timeOff)
    .where(
      and(
        eq(timeOff.orgId, orgId),
        lte(timeOff.startsAt, to),
        gte(timeOff.endsAt, from),
      ),
    );

  const appointmentRows = await db
    .select({
      id: appointments.id,
      staffId: appointments.staffId,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      bufferBeforeMinutes: appointments.bufferBeforeMinutes,
      bufferAfterMinutes: appointments.bufferAfterMinutes,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.orgId, orgId),
        inArray(appointments.status, BLOCKING_STATUSES),
        lte(appointments.startsAt, to),
        gte(appointments.endsAt, from),
      ),
    );

  const business: Schedule = {
    zone: options.businessTimeZone,
    weekly: rules.filter((r) => r.staffId === null).map(toWeeklyRule),
    overrides: overrideRows.filter((o) => o.staffId === null).map(toOverride),
  };

  const sharedBusy: Busy[] = timeOffRows
    .filter((t) => t.staffId === null)
    .map((t) => ({
      interval: { start: t.startsAt.getTime(), end: t.endsAt.getTime() },
    }));

  const resources: Resource[] = staffRows.map((member) => {
    const ownRules = rules.filter((r) => r.staffId === member.id);
    const ownOverrides = overrideRows.filter((o) => o.staffId === member.id);

    // A member of staff with no rules of their own works the business's
    // hours. Treating "no rows" as "never available" would make every new
    // staff member silently unbookable, which is a support ticket, not a
    // feature.
    const schedule: Schedule | undefined =
      ownRules.length === 0 && ownOverrides.length === 0
        ? undefined
        : {
            zone: isValidZone(member.timeZone)
              ? member.timeZone
              : options.businessTimeZone,
            weekly: ownRules.map(toWeeklyRule),
            overrides: ownOverrides.map(toOverride),
          };

    const busy: Busy[] = [
      ...timeOffRows
        .filter((t) => t.staffId === member.id)
        .map((t) => ({
          interval: { start: t.startsAt.getTime(), end: t.endsAt.getTime() },
        })),
      ...appointmentRows
        .filter(
          (a) =>
            a.staffId === member.id && a.id !== options.excludeAppointmentId,
        )
        .map((a) => ({
          interval: { start: a.startsAt.getTime(), end: a.endsAt.getTime() },
          // The appointment's own buffers, copied onto it when it was booked.
          // Reading today's service rules instead would move an existing
          // appointment's footprint when the rules change.
          bufferBeforeMinutes: a.bufferBeforeMinutes,
          bufferAfterMinutes: a.bufferAfterMinutes,
        })),
    ];

    return { id: member.id, ...(schedule ? { schedule } : {}), busy };
  });

  return { business, resources, sharedBusy };
}

/** The staff who can perform a service, as ids. */
export async function staffForService(
  db: Executor,
  orgId: string,
  serviceId: string,
): Promise<string[]> {
  const rows = await db
    .select({ staffId: staffServices.staffId })
    .from(staffServices)
    .where(
      and(
        eq(staffServices.orgId, orgId),
        eq(staffServices.serviceId, serviceId),
      ),
    );
  return rows.map((r) => r.staffId);
}

/** Helpers for the admin screens, which show rules rather than slots. */
export function describeRuleRow(row: Row): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const who = row.staffId ? "staff" : "business";
  const validity =
    row.validFrom || row.validUntil
      ? ` (${row.validFrom ?? "…"} to ${row.validUntil ?? "…"})`
      : "";
  return `${who} ${days[row.weekday] ?? row.weekday} ${hhmm(row.startMinute)}–${hhmm(row.endMinute)}${validity}`;
}
