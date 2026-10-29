/**
 * Wall-clock arithmetic in an IANA time zone.
 *
 * A business says "we open at nine". That is a wall-clock time in a named
 * zone, and it is *not* a fixed offset from UTC: the same "nine" is a
 * different instant in January and in July, and twice a year there is a nine
 * that happens twice or not at all. A booking system that stores opening hours
 * as UTC offsets is wrong for half the year, and one that stores them as local
 * times without handling the transitions is wrong twice a year — usually by an
 * hour, on the two days when a missed appointment is most annoying.
 *
 * This module does the two conversions everything else needs:
 *
 *   - instant → wall clock in a zone (`partsOf`), which is easy: `Intl` does it
 *   - wall clock in a zone → instant (`instantOf`), which is not, because the
 *     mapping is neither total nor injective
 *
 * It uses `Intl.DateTimeFormat` rather than a dependency, because the zone
 * database is already in the runtime and shipping a second copy of it that
 * drifts from the first is worse than no dependency at all.
 */

export class TimeZoneError extends Error {}

export interface WallClock {
  readonly year: number;
  /** 1–12, not the 0–11 that `Date` uses. Off-by-one month bugs are forever. */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** A calendar date in a zone, with no time of day. */
export interface PlainDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Minutes after local midnight. Opening hours are naturally expressed this way. */
export type MinuteOfDay = number;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw new TimeZoneError(`unknown time zone ${JSON.stringify(zone)}`);
    }
    formatters.set(zone, f);
  }
  return f;
}

/** Whether the runtime recognises this zone. Validate spec input with it. */
export function isValidZone(zone: string): boolean {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

/** The wall clock showing in `zone` at `instant`. */
export function partsOf(instant: number, zone: string): WallClock {
  const parts = formatterFor(zone).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new TimeZoneError(`missing ${type} formatting ${zone}`);
    return Number(found.value);
  };
  // hourCycle h23 still renders midnight as 24 in some ICU versions.
  const hour = get("hour") % 24;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second"),
  };
}

/** The zone's offset from UTC at `instant`, in milliseconds. */
export function offsetAt(instant: number, zone: string): number {
  const p = partsOf(instant, zone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  // The remainder keeps sub-second precision, which formatToParts drops.
  return asUtc - (instant - (instant % 1000));
}

/**
 * How a wall-clock time maps onto the timeline.
 *
 * `exact` is the ordinary case. `gap` is a time that does not exist, because
 * the clocks jumped forward over it — 01:30 on the spring-forward Sunday in
 * London. `ambiguous` is a time that happens twice, because they went back.
 *
 * Both are represented rather than hidden, because the right answer depends on
 * what the time means. For a recurring opening hour, skipping the day would
 * close the business; for a one-off appointment, silently picking one of two
 * instants is how someone arrives an hour late.
 */
export type Resolution =
  | { readonly kind: "exact"; readonly instant: number }
  | { readonly kind: "gap"; readonly before: number; readonly after: number }
  | {
      readonly kind: "ambiguous";
      readonly first: number;
      readonly second: number;
    };

/**
 * What to do with a wall-clock time that is not exact.
 *
 * - `earlier` / `later` pick an end of an ambiguous time, and for a gap take
 *   the instant just before or just after it.
 * - `shift` moves a gap time forward by the size of the jump, so 01:30 becomes
 *   02:30 — which is what a person means by "half past one" on a day when
 *   half past one did not happen.
 * - `reject` throws. Correct for an appointment someone typed in.
 */
export type GapPolicy = "earlier" | "later" | "shift" | "reject";

/**
 * Resolves a wall-clock time in a zone, reporting gaps and ambiguity.
 *
 * The method is a two-step fixed point rather than a transition-table lookup,
 * because `Intl` exposes no transition table. Guess the instant using the
 * offset that applies at the naive UTC interpretation, then check what wall
 * clock that instant actually shows: if it matches, done; if not, try again
 * with the corrected offset. Two iterations suffice for every real zone,
 * because an offset change is itself never large enough to cross a second
 * transition.
 */
export function resolve(wall: WallClock, zone: string): Resolution {
  const naive = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );

  // Two candidate offsets: the one in force just before the naive instant and
  // the one just after. At a transition they differ, and that is the signal.
  const offsetBefore = offsetAt(naive - DAY, zone);
  const offsetAfter = offsetAt(naive + DAY, zone);

  const candidates = new Set<number>();
  for (const offset of [offsetBefore, offsetAfter]) {
    const guess = naive - offset;
    // Keep only guesses that actually show this wall clock in this zone. This
    // is the whole test: a gap time produces none, an ambiguous time two.
    if (sameWallClock(partsOf(guess, zone), wall)) candidates.add(guess);
  }

  const found = [...candidates].sort((a, b) => a - b);
  if (found.length === 1) return { kind: "exact", instant: found[0]! };
  if (found.length >= 2)
    return { kind: "ambiguous", first: found[0]!, second: found[1]! };

  // No candidate: the clocks jumped over this time. Report the instants on
  // either side of the jump so a caller can shift or reject.
  const before = naive - Math.max(offsetBefore, offsetAfter);
  const after = naive - Math.min(offsetBefore, offsetAfter);
  return { kind: "gap", before, after };
}

function sameWallClock(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * The instant for a wall-clock time, with an explicit policy for the days when
 * that question has no single answer.
 */
export function instantOf(
  wall: WallClock,
  zone: string,
  policy: GapPolicy = "shift",
): number {
  const r = resolve(wall, zone);
  switch (r.kind) {
    case "exact":
      return r.instant;
    case "ambiguous":
      // The earlier of the two is the first time the clock showed it, which is
      // what someone who wrote the time down meant.
      return policy === "later" ? r.second : r.first;
    case "gap":
      switch (policy) {
        case "earlier":
          return r.before;
        case "later":
        case "shift":
          return r.after;
        case "reject":
          throw new TimeZoneError(
            `${format(wall)} does not exist in ${zone}: the clocks moved forward over it`,
          );
      }
  }
}

/** The instant of local midnight starting `date` in `zone`. */
export function startOfDay(date: PlainDate, zone: string): number {
  // Midnight itself can fall in a gap (Lord Howe, and historically several
  // others), so the policy matters even here: take the first instant of the
  // day that exists.
  return instantOf({ ...date, hour: 0, minute: 0, second: 0 }, zone, "later");
}

/** The instant `minutes` after local midnight on `date` in `zone`. */
export function atMinuteOfDay(
  date: PlainDate,
  minutes: MinuteOfDay,
  zone: string,
  policy: GapPolicy = "shift",
): number {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new TimeZoneError(
      `minute of day must be a non-negative integer, got ${minutes}`,
    );
  }
  // Minutes past midnight rather than a clock time, so values at or beyond
  // 24:00 mean "into the next day" — which is how a business open until 02:00
  // describes itself, and the case that breaks naive hour/minute handling.
  const days = Math.floor(minutes / (24 * 60));
  const rest = minutes % (24 * 60);
  const base = addDays(date, days);
  return instantOf(
    { ...base, hour: Math.floor(rest / 60), minute: rest % 60, second: 0 },
    zone,
    policy,
  );
}

/** The calendar date showing in `zone` at `instant`. */
export function dateOf(instant: number, zone: string): PlainDate {
  const { year, month, day } = partsOf(instant, zone);
  return { year, month, day };
}

/** Minutes since local midnight at `instant`. */
export function minuteOfDayAt(instant: number, zone: string): MinuteOfDay {
  const p = partsOf(instant, zone);
  return p.hour * 60 + p.minute;
}

/**
 * Day of the week in `zone`: 0 = Sunday, matching `Date.prototype.getUTCDay`.
 *
 * Computed from the civil date rather than from the instant, because the day
 * of the week in Auckland is not the day of the week in UTC.
 */
export function weekdayOf(instant: number, zone: string): number {
  const { year, month, day } = dateOf(instant, zone);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function weekdayOfDate(date: PlainDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Calendar arithmetic on the date itself, so a DST day is still one day. */
export function addDays(date: PlainDate, days: number): PlainDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day));
  d.setUTCDate(d.getUTCDate() + days);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

export function compareDates(a: PlainDate, b: PlainDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/** Every date from `from` to `to` inclusive, in calendar order. */
export function datesBetween(from: PlainDate, to: PlainDate): PlainDate[] {
  if (compareDates(from, to) > 0) return [];
  const out: PlainDate[] = [];
  let cursor = from;
  // A bound rather than `while (true)`: a bad range should fail loudly instead
  // of allocating until the process dies.
  for (let i = 0; i <= 3660; i += 1) {
    out.push(cursor);
    if (compareDates(cursor, to) >= 0) return out;
    cursor = addDays(cursor, 1);
  }
  throw new TimeZoneError(
    "date range is longer than ten years; narrow the query",
  );
}

/** `YYYY-MM-DD`. */
export function formatDate(date: PlainDate): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
}

export function parseDate(text: string): PlainDate {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m)
    throw new TimeZoneError(
      `expected a YYYY-MM-DD date, got ${JSON.stringify(text)}`,
    );
  const date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  // Reject 2026-02-30 rather than rolling it into March, which is what the
  // Date constructor would do silently.
  const roundTrip = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (
    roundTrip.getUTCFullYear() !== date.year ||
    roundTrip.getUTCMonth() + 1 !== date.month ||
    roundTrip.getUTCDate() !== date.day
  ) {
    throw new TimeZoneError(`${text} is not a real date`);
  }
  return date;
}

export function format(wall: WallClock): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)} ` +
    `${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`
  );
}

/** `HH:MM` for a minute of day, with hours past 24 wrapped for display. */
export function formatMinuteOfDay(minutes: MinuteOfDay): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

export function parseMinuteOfDay(text: string): MinuteOfDay {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m)
    throw new TimeZoneError(
      `expected an HH:MM time, got ${JSON.stringify(text)}`,
    );
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  // 24:00 is allowed as an end time, and means midnight at the end of the day.
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) {
    throw new TimeZoneError(`${text} is not a valid time of day`);
  }
  return hour * 60 + minute;
}

/** The zone's current offset rendered as `+01:00`, for display only. */
export function formatOffset(instant: number, zone: string): string {
  const offset = offsetAt(instant, zone);
  const sign = offset < 0 ? "-" : "+";
  const total = Math.abs(Math.round(offset / MINUTE));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sign}${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}
