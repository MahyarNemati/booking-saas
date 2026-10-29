/**
 * Opening hours, as rules in local time, expanded into UTC intervals.
 *
 * A business writes down "Tuesday to Saturday, 09:00 to 17:30, closed for
 * lunch 13:00 to 14:00, and we shut on the 24th of December". None of that is
 * a UTC interval, and the translation is where the bugs live:
 *
 *   - the weekday is the weekday *in the business's zone*, which is not the
 *     weekday in UTC for a third of the day
 *   - "09:00" is a different instant in January and in July
 *   - twice a year a day is 23 or 25 hours long, so the same rule produces a
 *     different amount of time
 *   - a business open past midnight is describing a window that belongs to the
 *     day it started on, not the day it ends on
 *
 * The rules are therefore stored as local wall-clock times and expanded for a
 * requested range, rather than being flattened into instants when they are
 * saved. Flattening is tempting and wrong: the rule outlives the next
 * transition, and a stored instant does not.
 */

import { normalize, subtract, union, type Interval } from "./interval";
import {
  addDays,
  atMinuteOfDay,
  compareDates,
  dateOf,
  datesBetween,
  formatDate,
  formatMinuteOfDay,
  isValidZone,
  type MinuteOfDay,
  type PlainDate,
  weekdayOfDate,
} from "./zone";

export class ScheduleError extends Error {}

/** A window of local time, minutes after midnight on the day it starts. */
export interface Window {
  readonly startMinute: MinuteOfDay;
  /**
   * May exceed 24:00, which is how a business open until 02:00 is expressed:
   * `startMinute` 1080 (18:00), `endMinute` 1560 (26:00).
   */
  readonly endMinute: MinuteOfDay;
}

/** A weekly recurring window, optionally only valid for part of the year. */
export interface WeeklyRule extends Window {
  /** 0 = Sunday, matching `Date.prototype.getUTCDay`. */
  readonly weekday: number;
  /** First date the rule applies, inclusive. */
  readonly from?: PlainDate;
  /** Last date the rule applies, inclusive. */
  readonly until?: PlainDate;
}

/**
 * Replaces the weekly rules for one date entirely.
 *
 * An empty `windows` means closed. That distinction has to be explicit: with
 * only additive rules there is no way to say "closed on Christmas Day", and
 * with only subtractive ones there is no way to say "open specially on a
 * Sunday".
 */
export interface DateOverride {
  readonly date: PlainDate;
  readonly windows: readonly Window[];
}

export interface Schedule {
  /** IANA zone the local times are in, e.g. `Europe/London`. */
  readonly zone: string;
  readonly weekly: readonly WeeklyRule[];
  readonly overrides?: readonly DateOverride[];
  /** Closures that cut across the rules: holidays, sickness, a long lunch. */
  readonly closures?: readonly Interval[];
}

export interface DateRange {
  readonly from: PlainDate;
  readonly to: PlainDate;
}

const MINUTES_IN_DAY = 24 * 60;
/** Two days, so a window can run past midnight but not for ever. */
const MAX_END_MINUTE = 2 * MINUTES_IN_DAY;

export function validateWindow(w: Window): void {
  for (const [name, value] of [
    ["startMinute", w.startMinute],
    ["endMinute", w.endMinute],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new ScheduleError(
        `${name} must be a non-negative integer, got ${value}`,
      );
    }
  }
  if (w.startMinute >= MINUTES_IN_DAY) {
    throw new ScheduleError(
      `startMinute ${formatMinuteOfDay(w.startMinute)} is on the next day; ` +
        `put the window on that day instead`,
    );
  }
  if (w.endMinute <= w.startMinute) {
    throw new ScheduleError(
      `a window must end after it starts, got ` +
        `${formatMinuteOfDay(w.startMinute)}–${formatMinuteOfDay(w.endMinute)}`,
    );
  }
  if (w.endMinute > MAX_END_MINUTE) {
    throw new ScheduleError(
      `endMinute ${w.endMinute} is more than a day past midnight; ` +
        `a window that long is almost certainly a mistake`,
    );
  }
}

export function validateSchedule(schedule: Schedule): void {
  if (!isValidZone(schedule.zone)) {
    throw new ScheduleError(
      `unknown time zone ${JSON.stringify(schedule.zone)}`,
    );
  }
  for (const rule of schedule.weekly) {
    if (
      !Number.isInteger(rule.weekday) ||
      rule.weekday < 0 ||
      rule.weekday > 6
    ) {
      throw new ScheduleError(`weekday must be 0–6, got ${rule.weekday}`);
    }
    validateWindow(rule);
    if (rule.from && rule.until && compareDates(rule.from, rule.until) > 0) {
      throw new ScheduleError(
        `rule is valid from ${formatDate(rule.from)} until ${formatDate(rule.until)}, ` +
          `which is a range that cannot contain a date`,
      );
    }
  }
  for (const override of schedule.overrides ?? []) {
    for (const w of override.windows) validateWindow(w);
  }
}

function ruleApplies(rule: WeeklyRule, date: PlainDate): boolean {
  if (rule.weekday !== weekdayOfDate(date)) return false;
  if (rule.from && compareDates(date, rule.from) < 0) return false;
  if (rule.until && compareDates(date, rule.until) > 0) return false;
  return true;
}

/**
 * The windows that apply on one local date: the override if there is one, the
 * matching weekly rules otherwise.
 */
export function windowsOn(schedule: Schedule, date: PlainDate): Window[] {
  const override = (schedule.overrides ?? []).find(
    (o) => compareDates(o.date, date) === 0,
  );
  if (override) return [...override.windows];
  return schedule.weekly
    .filter((r) => ruleApplies(r, date))
    .map((r) => ({
      startMinute: r.startMinute,
      endMinute: r.endMinute,
    }));
}

/**
 * Expands a schedule into UTC intervals covering `range`.
 *
 * `range` is in local dates, because that is what a calendar shows. The day
 * before and after are expanded as well and then clipped: a window running
 * past midnight belongs to the previous local day, so asking for a single day
 * must still pick up the tail of the night before.
 */
export function expandSchedule(
  schedule: Schedule,
  range: DateRange,
): Interval[] {
  validateSchedule(schedule);
  if (compareDates(range.from, range.to) > 0) return [];

  const dates = datesBetween(range.from, range.to);
  const spans: Interval[] = [];

  for (const date of dates) {
    for (const w of windowsOn(schedule, date)) {
      // A window on a day the clocks move forward can lose its start: 01:00
      // on the spring-forward Sunday does not exist. `shift` keeps the
      // business open rather than closing it for the day, and the window ends
      // at the wall-clock time it says, so the day is simply an hour shorter.
      const start = atMinuteOfDay(date, w.startMinute, schedule.zone, "shift");
      const end = atMinuteOfDay(date, w.endMinute, schedule.zone, "shift");
      if (end > start) spans.push({ start, end });
    }
  }

  const open = normalize(spans);
  const closed = normalize([...(schedule.closures ?? [])]);
  return subtract(open, closed);
}

/**
 * Expands a schedule and clips it to an instant range, which is what a
 * calendar query actually wants: "the hours between these two instants".
 */
export function expandScheduleBetween(
  schedule: Schedule,
  bounds: Interval,
): Interval[] {
  validateSchedule(schedule);
  const { fromDate, toDate } = boundsToDates(schedule.zone, bounds);
  const expanded = expandSchedule(schedule, { from: fromDate, to: toDate });
  // Clip rather than filter: a window overlapping the edge is partly wanted.
  const clipped: Interval[] = [];
  for (const span of expanded) {
    const start = Math.max(span.start, bounds.start);
    const end = Math.min(span.end, bounds.end);
    if (end > start) clipped.push({ start, end });
  }
  return clipped;
}

function boundsToDates(
  zone: string,
  bounds: Interval,
): { fromDate: PlainDate; toDate: PlainDate } {
  if (bounds.end < bounds.start) {
    throw new ScheduleError("bounds end before they start");
  }
  // One extra day on each side, for the same reason expandSchedule needs it:
  // a window that began yesterday evening can still be open now.
  return {
    fromDate: addDays(dateOf(bounds.start, zone), -1),
    toDate: addDays(dateOf(bounds.end, zone), 1),
  };
}

/** Merges several schedules, for a business with more than one source of hours. */
export function mergeSchedules(
  schedules: readonly Schedule[],
  range: DateRange,
): Interval[] {
  return schedules.reduce<Interval[]>(
    (acc, schedule) => union(acc, expandSchedule(schedule, range)),
    [],
  );
}

/** A compact description, for an error message or a debug log. */
export function describeSchedule(schedule: Schedule): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const byDay = schedule.weekly
    .slice()
    .sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute)
    .map(
      (r) =>
        `${days[r.weekday] ?? r.weekday} ` +
        `${formatMinuteOfDay(r.startMinute)}–${formatMinuteOfDay(r.endMinute)}`,
    );
  const parts = [schedule.zone, ...byDay];
  for (const o of schedule.overrides ?? []) {
    parts.push(
      o.windows.length === 0
        ? `${formatDate(o.date)} closed`
        : `${formatDate(o.date)} ` +
            o.windows
              .map(
                (w) =>
                  `${formatMinuteOfDay(w.startMinute)}–${formatMinuteOfDay(w.endMinute)}`,
              )
              .join(", "),
    );
  }
  return parts.join("; ");
}
