/**
 * The availability engine: which slots can actually be booked.
 *
 * This is the one piece of a booking system that has to be right. Everything
 * else is forms and emails; this decides whether two customers can be sold the
 * same half hour. It is a pure function of its inputs — no database, no clock
 * of its own — because that is what makes the awkward cases testable, and the
 * awkward cases are the entire difficulty:
 *
 *   - a slot must fit inside the opening hours *including* the buffers around
 *     it, or the last appointment of the day overruns closing
 *   - a buffer belongs to the appointment, not to the gap: two 15-minute
 *     buffers between neighbours is 15 minutes of gap, not 30
 *   - "we need an hour's notice" is relative to now, which moves
 *   - the customer may be in a different zone from the business, so the dates
 *     a calendar shows are not the dates the rules are written in
 *   - when several staff can do the job, a time is offered if *any* of them is
 *     free, and the booking has to record which one
 *
 * The engine answers with the staff who can serve each slot rather than a bare
 * list of times, because "10:00 is available" is not actionable: booking it
 * needs a resource, and choosing one at write time reintroduces the race the
 * database constraint exists to prevent.
 */

import {
  intersect,
  normalize,
  overlaps,
  padAll,
  slice,
  type Interval,
} from "./interval";
import {
  expandScheduleBetween,
  type Schedule,
  ScheduleError,
} from "./schedule";
import { DAY, MINUTE } from "./zone";

/** How a service is booked. All durations are in minutes. */
export interface ServicePolicy {
  /** How long the appointment itself lasts. */
  readonly durationMinutes: number;
  /**
   * How far apart offered start times are. Separate from the duration because
   * the two are different questions: a 50-minute service offered on the hour
   * is duration 50, step 60.
   */
  readonly stepMinutes: number;
  /** Preparation time before the appointment, during which the staff are busy. */
  readonly bufferBeforeMinutes?: number;
  /** Clean-up time after it. */
  readonly bufferAfterMinutes?: number;
  /** The shortest notice a booking may be made at. */
  readonly minimumNoticeMinutes?: number;
  /** How far ahead bookings are accepted. */
  readonly maximumAdvanceDays?: number;
  /**
   * Snap offered times onto a grid of this many minutes past the hour, so a
   * business opening at 09:07 still offers 09:30 rather than 09:07.
   */
  readonly alignToMinutes?: number;
}

/** Something already in the diary. */
export interface Busy {
  readonly interval: Interval;
  /**
   * Buffers belonging to the existing appointment. Taken from the service it
   * was booked for, which may differ from the one being booked now.
   */
  readonly bufferBeforeMinutes?: number;
  readonly bufferAfterMinutes?: number;
}

/** A person or room that can serve the appointment. */
export interface Resource {
  readonly id: string;
  /** Their working hours. Intersected with the business's opening hours. */
  readonly schedule?: Schedule;
  readonly busy?: readonly Busy[];
}

export interface AvailabilityQuery {
  /** The business's opening hours. */
  readonly schedule: Schedule;
  readonly service: ServicePolicy;
  /** The window to search, as instants. */
  readonly within: Interval;
  /** Now, passed in rather than read, so the engine stays pure. */
  readonly now: number;
  readonly resources: readonly Resource[];
  /** Busy time that blocks every resource, such as a whole-business closure. */
  readonly busy?: readonly Busy[];
}

export interface Slot {
  readonly start: number;
  readonly end: number;
  /** Every resource that could take it, in the order they were given. */
  readonly resourceIds: readonly string[];
}

export class AvailabilityError extends Error {}

function validatePolicy(p: ServicePolicy): void {
  const positive: [string, number | undefined][] = [
    ["durationMinutes", p.durationMinutes],
    ["stepMinutes", p.stepMinutes],
  ];
  for (const [name, value] of positive) {
    if (!Number.isFinite(value) || (value as number) <= 0) {
      throw new AvailabilityError(
        `${name} must be a positive number of minutes, got ${value}`,
      );
    }
  }
  const nonNegative: [string, number | undefined][] = [
    ["bufferBeforeMinutes", p.bufferBeforeMinutes],
    ["bufferAfterMinutes", p.bufferAfterMinutes],
    ["minimumNoticeMinutes", p.minimumNoticeMinutes],
    ["maximumAdvanceDays", p.maximumAdvanceDays],
    ["alignToMinutes", p.alignToMinutes],
  ];
  for (const [name, value] of nonNegative) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new AvailabilityError(`${name} cannot be negative, got ${value}`);
    }
  }
}

/** The busy intervals a resource has, grown by each appointment's own buffers. */
function blockedBy(busy: readonly Busy[]): Interval[] {
  return normalize(
    busy
      .map((b) =>
        padAll(
          [b.interval],
          (b.bufferBeforeMinutes ?? 0) * MINUTE,
          (b.bufferAfterMinutes ?? 0) * MINUTE,
        ),
      )
      .flat(),
  );
}

/**
 * The window within which a booking is allowed at all: not sooner than the
 * minimum notice, not later than the maximum advance.
 */
export function bookableWindow(service: ServicePolicy, now: number): Interval {
  const notice = (service.minimumNoticeMinutes ?? 0) * MINUTE;
  const advanceDays = service.maximumAdvanceDays;
  const start = now + notice;
  // Measured in days from now rather than calendar days, which is what
  // "we take bookings 60 days ahead" means and avoids a second zone question.
  const end =
    advanceDays === undefined
      ? Number.MAX_SAFE_INTEGER
      : now + advanceDays * 24 * 60 * MINUTE;
  return { start, end: Math.max(start, end) };
}

/**
 * Finds the bookable slots in `within`.
 *
 * The shape of the calculation, per resource:
 *
 *   1. open      = business hours ∩ resource hours, over the requested range
 *   2. blocked   = (shared busy ∪ resource busy), each grown by its own buffers
 *   3. candidate starts come from slicing `open`
 *   4. a candidate is kept when the appointment itself lies inside opening
 *      hours and the appointment *plus this service's buffers* overlaps
 *      nothing in `blocked`
 *   5. finally the slots are filtered by the bookable window
 *
 * Two details in there are the ones that get written wrong.
 *
 * The buffers are checked against bookings, not against opening hours. Prep
 * before the first appointment of the day and clean-up after the last are
 * work the staff do outside opening hours; requiring the buffers to fit
 * inside the opening window silently deletes the first and last slot of
 * every day. But a buffer may never overlap another booking, because that is
 * the same person in two places.
 *
 * The grid comes from the opening hours and the bookable window is applied
 * afterwards, not folded into the hours first. Clipping the hours to "now
 * plus an hour's notice" would move the grid: the offered times would become
 * 10:05, 10:35 instead of 10:30, 11:00, and they would drift with the clock.
 * Worse, `isSlotBookable` searches a window of exactly one slot, so a grid
 * derived from that window accepts *any* start time -- which lets a crafted
 * request book at 10:15 when only 10:00 and 10:30 were ever offered.
 */
export function availableSlots(query: AvailabilityQuery): Slot[] {
  const { schedule, service, within, now, resources } = query;
  validatePolicy(service);
  if (within.end < within.start) {
    throw new AvailabilityError("the search window ends before it starts");
  }
  if (resources.length === 0) return [];

  const duration = service.durationMinutes * MINUTE;
  const step = service.stepMinutes * MINUTE;
  const bufferBefore = (service.bufferBeforeMinutes ?? 0) * MINUTE;
  const bufferAfter = (service.bufferAfterMinutes ?? 0) * MINUTE;
  const align = service.alignToMinutes ? service.alignToMinutes * MINUTE : 0;

  const allowed = bookableWindow(service, now);
  // The window a booking is actually permitted in. It filters the finished
  // slots; it must not narrow the hours the grid is built from.
  const permitted: Interval = {
    start: Math.max(within.start, allowed.start),
    end: Math.min(within.end, allowed.end),
  };
  if (permitted.end <= permitted.start) return [];

  // Expanded once over the requested range and reused: this is the expensive
  // part, since it walks every date in the range through Intl.
  const businessHours = expandScheduleBetween(schedule, within);
  if (businessHours.length === 0) return [];

  const sharedBlocked = blockedBy(query.busy ?? []);

  // slot start -> the resources that can serve it. A Map keeps insertion
  // order, so the slots come out in time order as long as each resource is
  // walked in time order.
  const byStart = new Map<number, { end: number; resourceIds: string[] }>();

  for (const resource of resources) {
    let open = businessHours;
    if (resource.schedule) {
      open = intersect(open, expandScheduleBetween(resource.schedule, within));
    }
    if (open.length === 0) continue;

    const blocked = normalize([
      ...sharedBlocked,
      ...blockedBy(resource.busy ?? []),
    ]);

    for (const span of open) {
      // Candidate starts come from the opening hours, so the offered times are
      // stable from day to day, and are then aligned to the grid.
      const from =
        align > 0 ? Math.ceil(span.start / align) * align : span.start;
      if (from + duration > span.end) continue;

      for (const slot of slice(
        { start: from, end: span.end },
        duration,
        step,
      )) {
        // The bookable window filters the finished slot; it never shapes the
        // grid. The slot has to lie entirely inside it, since a booking that
        // starts inside the window and ends outside it is still a booking.
        if (slot.start < permitted.start || slot.end > permitted.end) continue;

        // The appointment is inside opening hours by construction. Its
        // buffers may fall outside them -- prep and clean-up are not trading
        // hours -- but may not overlap another booking.
        const withBuffers: Interval = {
          start: slot.start - bufferBefore,
          end: slot.end + bufferAfter,
        };
        if (blocked.some((b) => overlaps(b, withBuffers))) continue;

        const existing = byStart.get(slot.start);
        if (existing) existing.resourceIds.push(resource.id);
        else
          byStart.set(slot.start, {
            end: slot.end,
            resourceIds: [resource.id],
          });
      }
    }
  }

  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, { end, resourceIds }]) => ({ start, end, resourceIds }));
}

/**
 * Whether one specific booking is allowed, which is a different question from
 * listing slots and has to be asked again at write time.
 *
 * A customer's browser may have been showing a slot list for twenty minutes.
 * Re-checking at submission is what turns a stale list into a clear error
 * instead of a double booking — and the database constraint behind this is
 * what catches the two requests that re-check in the same millisecond.
 */
export function isSlotBookable(
  query: AvailabilityQuery,
  slot: { start: number; resourceId?: string },
):
  { ok: true; resourceIds: readonly string[] } | { ok: false; reason: string } {
  const duration = query.service.durationMinutes * MINUTE;
  const end = slot.start + duration;

  const allowed = bookableWindow(query.service, query.now);
  if (slot.start < allowed.start) {
    const notice = query.service.minimumNoticeMinutes ?? 0;
    return {
      ok: false,
      reason: `bookings need at least ${notice} minutes' notice`,
    };
  }
  if (slot.start > allowed.end) {
    return {
      ok: false,
      reason: `bookings are only accepted ${query.service.maximumAdvanceDays} days ahead`,
    };
  }

  let slots: Slot[];
  try {
    // Search the whole local day around the slot, not the slot itself. The
    // grid is built from the opening hours inside the search window, so
    // asking about a one-slot window would make any start time land on the
    // grid -- and that is the check standing between a crafted request and a
    // booking at a time nobody was offered.
    slots = availableSlots({
      ...query,
      within: { start: slot.start - DAY, end: end + DAY },
    });
  } catch (err) {
    if (err instanceof ScheduleError || err instanceof AvailabilityError) {
      return { ok: false, reason: err.message };
    }
    throw err;
  }

  const match = slots.find((s) => s.start === slot.start && s.end === end);
  if (!match) return { ok: false, reason: "that time is no longer available" };

  if (slot.resourceId && !match.resourceIds.includes(slot.resourceId)) {
    return {
      ok: false,
      reason: "that member of staff is no longer available at that time",
    };
  }
  return {
    ok: true,
    resourceIds: slot.resourceId ? [slot.resourceId] : match.resourceIds,
  };
}

/** Groups slots by local date in a zone, which is how a calendar renders them. */
export function groupByLocalDate(
  slots: readonly Slot[],
  zone: string,
): { date: string; slots: Slot[] }[] {
  const out = new Map<string, Slot[]>();
  for (const slot of slots) {
    // The *customer's* zone, not the business's: the grid a customer sees has
    // to be the days of their own calendar, or a late evening slot shows up
    // on the wrong day.
    const key = localDateKey(slot.start, zone);
    const bucket = out.get(key);
    if (bucket) bucket.push(slot);
    else out.set(key, [slot]);
  }
  return [...out.entries()].map(([date, s]) => ({ date, slots: s }));
}

function localDateKey(instant: number, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));
  // en-CA formats as YYYY-MM-DD, which sorts correctly as a string.
  return parts;
}
