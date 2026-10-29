import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  abuts,
  complement,
  contains,
  covers,
  interval,
  IntervalError,
  intersect,
  intersection,
  normalize,
  overlaps,
  pad,
  padAll,
  slice,
  sliceAll,
  subtract,
  totalDuration,
  union,
  type Interval,
} from "./interval";

/** Intervals as `[start, end)` pairs, so the tests read like arithmetic. */
const at = (start: number, end: number): Interval => ({ start, end });
const pairs = (intervals: readonly Interval[]): [number, number][] =>
  intervals.map((i) => [i.start, i.end]);

describe("interval", () => {
  it("refuses an interval that ends before it starts", () => {
    expect(() => interval(10, 5)).toThrow(IntervalError);
    expect(() => interval(Number.NaN, 5)).toThrow(IntervalError);
    expect(() => interval(0, Number.POSITIVE_INFINITY)).toThrow(IntervalError);
    // A zero-length interval is allowed: it is the empty set, and the
    // algebra needs one.
    expect(interval(5, 5)).toEqual(at(5, 5));
  });

  it("is half-open, so back-to-back intervals do not overlap", () => {
    // The bug this prevents: refusing a 10:00 booking because a 09:00-10:00
    // one already ends at 10:00.
    expect(overlaps(at(9, 10), at(10, 11))).toBe(false);
    expect(abuts(at(9, 10), at(10, 11))).toBe(true);
    expect(contains(at(9, 10), 10)).toBe(false);
    expect(contains(at(9, 10), 9)).toBe(true);
  });

  it("knows when one interval covers another", () => {
    expect(covers(at(9, 17), at(10, 11))).toBe(true);
    expect(covers(at(9, 17), at(9, 17))).toBe(true);
    expect(covers(at(9, 17), at(16, 18))).toBe(false);
    // An empty interval is inside anything, which keeps the slot filter from
    // special-casing a zero-length service.
    expect(covers(at(9, 17), at(12, 12))).toBe(true);
  });

  it("intersects a pair", () => {
    expect(intersection(at(9, 12), at(11, 14))).toEqual(at(11, 12));
    expect(intersection(at(9, 10), at(10, 11))).toBeNull();
    expect(intersection(at(9, 17), at(12, 13))).toEqual(at(12, 13));
  });
});

describe("normalize", () => {
  it("sorts, drops empties and merges overlaps", () => {
    const result = normalize([at(17, 19), at(9, 12), at(5, 5), at(11, 14)]);
    expect(pairs(result)).toEqual([
      [9, 14],
      [17, 19],
    ]);
  });

  it("merges intervals that only touch", () => {
    // Leaving 09:00-12:00 and 12:00-17:00 separate would make a four-hour
    // appointment across noon impossible.
    expect(pairs(normalize([at(9, 12), at(12, 17)]))).toEqual([[9, 17]]);
  });

  it("swallows an interval contained in an earlier one", () => {
    expect(pairs(normalize([at(9, 17), at(10, 11)]))).toEqual([[9, 17]]);
  });

  it("leaves an already-normalised set alone", () => {
    const input = [at(1, 2), at(5, 6)];
    expect(pairs(normalize(input))).toEqual(pairs(input));
  });

  it("does not mutate its input", () => {
    const input = [at(17, 19), at(9, 12)];
    const copy = pairs(input);
    normalize(input);
    expect(pairs(input)).toEqual(copy);
  });
});

describe("union", () => {
  it("merges two sets", () => {
    expect(pairs(union([at(9, 12)], [at(11, 14), at(20, 21)]))).toEqual([
      [9, 14],
      [20, 21],
    ]);
  });
});

describe("intersect", () => {
  it("keeps only the shared parts", () => {
    const opening = [at(9, 13), at(14, 18)];
    const staffShift = [at(11, 15), at(17, 20)];
    expect(pairs(intersect(opening, staffShift))).toEqual([
      [11, 13],
      [14, 15],
      [17, 18],
    ]);
  });

  it("is empty when nothing is shared", () => {
    expect(intersect([at(9, 10)], [at(11, 12)])).toEqual([]);
    expect(intersect([], [at(9, 10)])).toEqual([]);
  });

  it("handles one interval spanning many on the other side", () => {
    expect(
      pairs(intersect([at(0, 100)], [at(1, 2), at(5, 6), at(50, 60)])),
    ).toEqual([
      [1, 2],
      [5, 6],
      [50, 60],
    ]);
  });
});

describe("subtract", () => {
  it("cuts a hole in the middle", () => {
    expect(pairs(subtract([at(9, 17)], [at(12, 13)]))).toEqual([
      [9, 12],
      [13, 17],
    ]);
  });

  it("trims the ends", () => {
    expect(pairs(subtract([at(9, 17)], [at(8, 10)]))).toEqual([[10, 17]]);
    expect(pairs(subtract([at(9, 17)], [at(16, 18)]))).toEqual([[9, 16]]);
  });

  it("removes a span entirely", () => {
    expect(subtract([at(9, 17)], [at(8, 18)])).toEqual([]);
    expect(subtract([at(9, 17)], [at(9, 17)])).toEqual([]);
  });

  it("ignores a removal that only touches", () => {
    // A 09:00-10:00 appointment does not consume a 10:00-17:00 opening.
    expect(pairs(subtract([at(10, 17)], [at(9, 10)]))).toEqual([[10, 17]]);
  });

  it("handles one removal spanning several spans", () => {
    // The case a single cursor walking both lists in lockstep gets wrong.
    expect(
      pairs(subtract([at(1, 2), at(3, 4), at(5, 6)], [at(0, 10)])),
    ).toEqual([]);
    expect(pairs(subtract([at(1, 4), at(5, 8)], [at(2, 6)]))).toEqual([
      [1, 2],
      [6, 8],
    ]);
  });

  it("handles several removals inside one span", () => {
    expect(
      pairs(subtract([at(0, 20)], [at(2, 4), at(6, 8), at(18, 19)])),
    ).toEqual([
      [0, 2],
      [4, 6],
      [8, 18],
      [19, 20],
    ]);
  });

  it("is unaffected by the order of the removals", () => {
    const shuffled = subtract([at(0, 20)], [at(18, 19), at(2, 4), at(6, 8)]);
    const sorted = subtract([at(0, 20)], [at(2, 4), at(6, 8), at(18, 19)]);
    expect(pairs(shuffled)).toEqual(pairs(sorted));
  });

  it("subtracting nothing is the identity", () => {
    expect(pairs(subtract([at(9, 17)], []))).toEqual([[9, 17]]);
  });
});

describe("complement", () => {
  it("returns the gaps inside the bounds", () => {
    expect(pairs(complement([at(10, 11), at(14, 15)], at(9, 17)))).toEqual([
      [9, 10],
      [11, 14],
      [15, 17],
    ]);
  });
});

describe("pad", () => {
  it("grows an interval on both sides", () => {
    expect(pad(at(10, 11), 2, 3)).toEqual(at(8, 14));
  });

  it("collapses rather than inverting when shrunk too far", () => {
    const result = pad(at(10, 11), -5, -5);
    expect(result.end).toBeLessThanOrEqual(result.start);
    expect(totalDuration([result])).toBe(0);
  });

  it("merges appointments that overlap once padded", () => {
    // Two appointments 10 minutes apart with a 15-minute buffer each side are
    // effectively one block, and a slot must not be offered between them.
    const busy = padAll([at(0, 60), at(70, 130)], 15, 15);
    expect(pairs(busy)).toEqual([[-15, 145]]);
  });
});

describe("slice", () => {
  it("cuts a span into slots that fit", () => {
    expect(pairs(slice(at(0, 100), 30, 30))).toEqual([
      [0, 30],
      [30, 60],
      [60, 90],
    ]);
  });

  it("offers overlapping starts when the step is smaller than the length", () => {
    // A 50-minute service offered every 15 minutes: the slots overlap, and
    // booking one removes the others. Deriving step from length would make
    // this unexpressible.
    expect(pairs(slice(at(0, 80), 50, 15))).toEqual([
      [0, 50],
      [15, 65],
      [30, 80],
    ]);
  });

  it("offers nothing when the span is too short", () => {
    expect(slice(at(0, 29), 30, 30)).toEqual([]);
  });

  it("refuses a nonsensical length or step", () => {
    expect(() => slice(at(0, 100), 0, 30)).toThrow(IntervalError);
    expect(() => slice(at(0, 100), 30, 0)).toThrow(IntervalError);
    expect(() => slice(at(0, 100), 30, -1)).toThrow(IntervalError);
  });

  it("aligns to a grid so the times are round numbers", () => {
    // Opening at 09:07 with a 30-minute grid should offer 09:30, not 09:07.
    const span = at(7, 100);
    expect(pairs(sliceAll([span], 30, 30))).toEqual([
      [7, 37],
      [37, 67],
      [67, 97],
    ]);
    expect(pairs(sliceAll([span], 30, 30, { alignTo: 30 }))).toEqual([
      [30, 60],
      [60, 90],
    ]);
  });

  it("slices each span independently", () => {
    expect(pairs(sliceAll([at(0, 60), at(100, 160)], 30, 30))).toEqual([
      [0, 30],
      [30, 60],
      [100, 130],
      [130, 160],
    ]);
  });
});

// The set algebra is the foundation everything else stands on, so it is worth
// checking against properties rather than only examples. A bug here would show
// up as an occasional double booking, which is the hardest kind to reproduce.
describe("properties", () => {
  const anInterval = fc
    .tuple(
      fc.integer({ min: -500, max: 500 }),
      fc.integer({ min: 0, max: 200 }),
    )
    .map(([start, length]) => at(start, start + length));
  const aSet = fc.array(anInterval, { maxLength: 12 });

  it("normalize is idempotent", () => {
    fc.assert(
      fc.property(aSet, (set) => {
        const once = normalize(set);
        expect(pairs(normalize(once))).toEqual(pairs(once));
      }),
    );
  });

  it("a normalised set is sorted and disjoint", () => {
    fc.assert(
      fc.property(aSet, (set) => {
        const result = normalize(set);
        for (let i = 1; i < result.length; i += 1) {
          // Strictly greater: touching intervals should have been merged.
          expect(result[i]!.start).toBeGreaterThan(result[i - 1]!.end);
        }
      }),
    );
  });

  it("subtract then union recovers the original", () => {
    fc.assert(
      fc.property(aSet, aSet, (a, b) => {
        // (a - b) ∪ (a ∩ b) = a
        const recovered = union(subtract(a, b), intersect(a, b));
        expect(pairs(recovered)).toEqual(pairs(normalize(a)));
      }),
    );
  });

  it("subtract leaves nothing that overlaps the removal", () => {
    // The property that actually matters: a free slot must not overlap a
    // booking, ever, for any arrangement of bookings.
    fc.assert(
      fc.property(aSet, aSet, (free, busy) => {
        for (const remaining of subtract(free, busy)) {
          for (const taken of normalize(busy)) {
            expect(overlaps(remaining, taken)).toBe(false);
          }
        }
      }),
    );
  });

  it("subtract removes no more than it must", () => {
    // The other half: what is left plus what was removed accounts for all of
    // the original, so nothing is lost by accident.
    fc.assert(
      fc.property(aSet, aSet, (a, b) => {
        expect(
          totalDuration(subtract(a, b)) + totalDuration(intersect(a, b)),
        ).toBe(totalDuration(a));
      }),
    );
  });

  it("intersect is commutative and union is too", () => {
    fc.assert(
      fc.property(aSet, aSet, (a, b) => {
        expect(pairs(intersect(a, b))).toEqual(pairs(intersect(b, a)));
        expect(pairs(union(a, b))).toEqual(pairs(union(b, a)));
      }),
    );
  });

  it("every slice fits inside the span it came from", () => {
    fc.assert(
      fc.property(
        anInterval,
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: 1, max: 60 }),
        (span, length, step) => {
          for (const slot of slice(span, length, step)) {
            expect(covers(span, slot)).toBe(true);
            expect(slot.end - slot.start).toBe(length);
          }
        },
      ),
    );
  });

  it("slices do not overlap when the step is at least the length", () => {
    fc.assert(
      fc.property(
        anInterval,
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        (span, length, extra) => {
          const slots = slice(span, length, length + extra);
          for (let i = 1; i < slots.length; i += 1) {
            expect(overlaps(slots[i - 1]!, slots[i]!)).toBe(false);
          }
        },
      ),
    );
  });
});
