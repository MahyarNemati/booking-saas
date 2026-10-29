/**
 * Half-open intervals on the UTC timeline, as epoch milliseconds.
 *
 * Everything the availability engine does reduces to set arithmetic on these:
 * opening hours minus time off minus existing appointments, then sliced into
 * slots. Getting the algebra right once, with its own tests, means the rest of
 * the engine is mostly bookkeeping.
 *
 * Half-open — `[start, end)` — on purpose. A 09:00–10:00 appointment and a
 * 10:00–11:00 appointment do not overlap, and with closed intervals they
 * would: every booking system that uses `start <= x <= end` eventually
 * refuses a back-to-back booking for no reason.
 */

export interface Interval {
  /** Inclusive start, epoch milliseconds. */
  readonly start: number;
  /** Exclusive end, epoch milliseconds. */
  readonly end: number;
}

export class IntervalError extends Error {}

export function interval(start: number, end: number): Interval {
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new IntervalError(`interval bounds must be finite, got [${start}, ${end})`);
  }
  if (end < start) {
    throw new IntervalError(`interval end ${end} is before its start ${start}`);
  }
  return { start, end };
}

export function duration(i: Interval): number {
  return i.end - i.start;
}

export function isEmpty(i: Interval): boolean {
  return i.end <= i.start;
}

export function contains(i: Interval, instant: number): boolean {
  return instant >= i.start && instant < i.end;
}

/** Whether `outer` covers all of `inner`. An empty inner is always covered. */
export function covers(outer: Interval, inner: Interval): boolean {
  if (isEmpty(inner)) return true;
  return inner.start >= outer.start && inner.end <= outer.end;
}

export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end;
}

/**
 * Whether the two intervals touch but do not overlap, in either order. Used to
 * decide whether a buffer is needed between two appointments.
 */
export function abuts(a: Interval, b: Interval): boolean {
  return a.end === b.start || b.end === a.start;
}

export function intersection(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

/**
 * Normalises a set: drops empties, sorts by start, and merges anything that
 * overlaps or touches. Every function below assumes its inputs are normalised,
 * and every one returns a normalised result, so sets compose.
 *
 * Touching intervals are merged as well as overlapping ones. Leaving
 * 09:00–12:00 and 12:00–17:00 as two intervals would make a 4-hour appointment
 * across noon look impossible.
 */
export function normalize(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((i) => !isEmpty(i)).sort((a, b) => a.start - b.start);

  const out: Interval[] = [];
  for (const next of sorted) {
    const last = out.at(-1);
    if (last && next.start <= last.end) {
      if (next.end > last.end) out[out.length - 1] = { start: last.start, end: next.end };
    } else {
      out.push({ start: next.start, end: next.end });
    }
  }
  return out;
}

export function union(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  return normalize([...a, ...b]);
}

/** Every part of `a` that is also in `b`. */
export function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const left = normalize(a);
  const right = normalize(b);
  const out: Interval[] = [];

  // A merge walk rather than the nested loop: both sides are sorted, so each
  // interval is visited once. With a year of opening hours against a year of
  // appointments the difference is not academic.
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const l = left[i]!;
    const r = right[j]!;
    const hit = intersection(l, r);
    if (hit) out.push(hit);
    // Advance whichever ends first; the other may still overlap what follows.
    if (l.end < r.end) i += 1;
    else j += 1;
  }
  return out;
}

/** Every part of `a` that is not in `b`. */
export function subtract(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const keep = normalize(a);
  const remove = normalize(b);
  const out: Interval[] = [];

  let j = 0;
  for (const span of keep) {
    let cursor = span.start;
    // Skip anything entirely before this span.
    while (j < remove.length && remove[j]!.end <= span.start) j += 1;

    // `k` walks ahead without consuming `j`, because one removal can span
    // several keeps.
    let k = j;
    while (k < remove.length) {
      const gap = remove[k]!;
      if (gap.start >= span.end) break;
      if (gap.start > cursor) out.push({ start: cursor, end: Math.min(gap.start, span.end) });
      cursor = Math.max(cursor, gap.end);
      if (cursor >= span.end) break;
      k += 1;
    }
    if (cursor < span.end) out.push({ start: cursor, end: span.end });
  }
  return out.filter((i) => !isEmpty(i));
}

/** The gaps between the intervals of a normalised set, within `bounds`. */
export function complement(intervals: readonly Interval[], bounds: Interval): Interval[] {
  return subtract([bounds], intervals);
}

export function totalDuration(intervals: readonly Interval[]): number {
  return normalize(intervals).reduce((sum, i) => sum + duration(i), 0);
}

/**
 * Grows an interval by `before` at the start and `after` at the end. Negative
 * padding is allowed and shrinks it, which is how a "free by" rule is applied;
 * an interval that would invert collapses to its own midpoint-free empty.
 */
export function pad(i: Interval, before: number, after: number): Interval {
  const start = i.start - before;
  const end = i.end + after;
  return end > start ? { start, end } : { start, end: start };
}

export function padAll(
  intervals: readonly Interval[],
  before: number,
  after: number,
): Interval[] {
  return normalize(intervals.map((i) => pad(i, before, after)));
}

/**
 * Cuts `span` into intervals of `length`, every `step` apart, keeping only
 * those that fit entirely inside.
 *
 * `step` is separate from `length` because the two are genuinely different
 * questions: a 50-minute appointment offered on the hour is `length` 50,
 * `step` 60. Deriving one from the other is the usual shortcut and it makes
 * that case unexpressible.
 */
export function slice(span: Interval, length: number, step: number): Interval[] {
  if (length <= 0) throw new IntervalError(`slot length must be positive, got ${length}`);
  if (step <= 0) throw new IntervalError(`slot step must be positive, got ${step}`);

  const out: Interval[] = [];
  for (let start = span.start; start + length <= span.end; start += step) {
    out.push({ start, end: start + length });
  }
  return out;
}

export function sliceAll(
  spans: readonly Interval[],
  length: number,
  step: number,
  options: { readonly alignTo?: number } = {},
): Interval[] {
  const { alignTo } = options;
  const out: Interval[] = [];
  for (const span of normalize(spans)) {
    // Aligning to a grid makes the offered times the round numbers a customer
    // expects (09:00, 09:30) rather than whatever the opening time happens to
    // be plus a multiple of the step.
    const from =
      alignTo && alignTo > 0 ? Math.ceil(span.start / alignTo) * alignTo : span.start;
    if (from + length > span.end) continue;
    out.push(...slice({ start: from, end: span.end }, length, step));
  }
  return out;
}
