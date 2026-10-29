import { describe, expect, it } from "vitest";
import {
  AvailabilityError,
  availableSlots,
  bookableWindow,
  groupByLocalDate,
  isSlotBookable,
  type AvailabilityQuery,
  type Resource,
  type ServicePolicy,
} from "./availability";
import type { Schedule } from "./schedule";
import { instantOf, MINUTE, parseDate, startOfDay } from "./zone";

const LONDON = "Europe/London";

/** An instant from a local wall-clock time in London, so tests read as times. */
function london(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(text);
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

/** Slot starts rendered as London wall-clock times, which is what we assert on. */
function times(slots: readonly { start: number }[]): string[] {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return slots.map((s) => f.format(new Date(s.start)));
}

function dayAndTimes(slots: readonly { start: number }[]): string[] {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return slots.map((s) => f.format(new Date(s.start)));
}

/** Monday–Friday, 09:00–12:00. Short on purpose, so slot lists stay readable. */
const weekdayMornings: Schedule = {
  zone: LONDON,
  weekly: [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    startMinute: 9 * 60,
    endMinute: 12 * 60,
  })),
};

const thirtyMinutes: ServicePolicy = { durationMinutes: 30, stepMinutes: 30 };

const anyone: Resource = { id: "staff-a" };

/** A query over one London day, with `now` far enough back to be irrelevant. */
function onDay(
  date: string,
  overrides: Partial<AvailabilityQuery> = {},
): AvailabilityQuery {
  const day = parseDate(date);
  const start = startOfDay(day, LONDON);
  return {
    schedule: weekdayMornings,
    service: thirtyMinutes,
    within: { start, end: start + 24 * 60 * MINUTE },
    now: start - 7 * 24 * 60 * MINUTE,
    resources: [anyone],
    ...overrides,
  };
}

describe("availableSlots", () => {
  it("offers every slot inside the opening hours", () => {
    // 2026-06-01 is a Monday.
    expect(times(availableSlots(onDay("2026-06-01")))).toEqual([
      "09:00",
      "09:30",
      "10:00",
      "10:30",
      "11:00",
      "11:30",
    ]);
  });

  it("offers nothing on a day the business is closed", () => {
    // 2026-06-06 is a Saturday.
    expect(availableSlots(onDay("2026-06-06"))).toEqual([]);
  });

  it("does not offer a slot that would overrun closing", () => {
    // A 45-minute service in a 09:00-12:00 window: the 11:30 start would end
    // at 12:15, which is past closing.
    const service: ServicePolicy = { durationMinutes: 45, stepMinutes: 30 };
    expect(times(availableSlots(onDay("2026-06-01", { service })))).toEqual([
      "09:00",
      "09:30",
      "10:00",
      "10:30",
      "11:00",
    ]);
  });

  it("removes a slot taken by an existing appointment", () => {
    const busy = [
      {
        interval: {
          start: london("2026-06-01 10:00"),
          end: london("2026-06-01 10:30"),
        },
      },
    ];
    expect(
      times(
        availableSlots(
          onDay("2026-06-01", { resources: [{ ...anyone, busy }] }),
        ),
      ),
    ).toEqual(["09:00", "09:30", "10:30", "11:00", "11:30"]);
  });

  it("still offers the slot that ends when an appointment starts", () => {
    // The half-open interval earning its keep: 09:30-10:00 does not clash
    // with 10:00-10:30.
    const busy = [
      {
        interval: {
          start: london("2026-06-01 10:00"),
          end: london("2026-06-01 10:30"),
        },
      },
    ];
    expect(
      times(
        availableSlots(
          onDay("2026-06-01", { resources: [{ ...anyone, busy }] }),
        ),
      ),
    ).toContain("09:30");
  });

  it("offers nothing between two appointments separated by less than the duration", () => {
    const busy = [
      {
        interval: {
          start: london("2026-06-01 09:00"),
          end: london("2026-06-01 10:00"),
        },
      },
      {
        interval: {
          start: london("2026-06-01 10:15"),
          end: london("2026-06-01 11:00"),
        },
      },
    ];
    const slots = times(
      availableSlots(onDay("2026-06-01", { resources: [{ ...anyone, busy }] })),
    );
    expect(slots).toEqual(["11:00", "11:30"]);
  });
});

describe("buffers", () => {
  const withBuffers: ServicePolicy = {
    durationMinutes: 30,
    stepMinutes: 30,
    bufferBeforeMinutes: 15,
    bufferAfterMinutes: 15,
  };

  it("keeps a slot clear of an appointment by the buffer", () => {
    // An existing 10:00-10:30 appointment with 15 minutes of buffer each side
    // blocks 09:45-10:45. A 09:30 start would need 09:15-10:45 including its
    // own buffers, so it clashes; so does 10:30.
    const busy = [
      {
        interval: {
          start: london("2026-06-01 10:00"),
          end: london("2026-06-01 10:30"),
        },
        bufferBeforeMinutes: 15,
        bufferAfterMinutes: 15,
      },
    ];
    const slots = times(
      availableSlots(
        onDay("2026-06-01", {
          service: withBuffers,
          resources: [{ ...anyone, busy }],
        }),
      ),
    );
    expect(slots).not.toContain("09:30");
    expect(slots).not.toContain("10:00");
    expect(slots).not.toContain("10:30");
    expect(slots).toContain("09:00");
    expect(slots).toContain("11:00");
  });

  it("lets the trailing buffer run past closing time", () => {
    // Cleaning up after the last customer of the day is allowed: the
    // appointment has to finish by closing, the buffer does not. Requiring
    // the buffer to fit would silently lose the last slot of every day.
    const slots = times(
      availableSlots(onDay("2026-06-01", { service: withBuffers })),
    );
    expect(slots).toContain("11:30");
  });

  it("stacks each appointment's own buffers, because they are different work", () => {
    // The existing appointment's trailing buffer is clean-up for it; the new
    // one's leading buffer is prep for the new one. The same person cannot do
    // both at once, so the gap really is the sum of the two -- 30 minutes
    // after a 09:30 finish, making 10:00 the first bookable start.
    const busy = [
      {
        interval: {
          start: london("2026-06-01 09:00"),
          end: london("2026-06-01 09:30"),
        },
        bufferAfterMinutes: 15,
      },
    ];
    const slots = times(
      availableSlots(
        onDay("2026-06-01", {
          service: {
            durationMinutes: 30,
            stepMinutes: 15,
            bufferBeforeMinutes: 15,
          },
          resources: [{ ...anyone, busy }],
        }),
      ),
    );
    expect(slots[0]).toBe("10:00");
  });

  it("pads an existing appointment by its own buffers and no others", () => {
    // The real double-count would be padding a booking by the buffers of the
    // service being booked now as well as its own. Measuring it: the same
    // query against an existing appointment that declares no trailing buffer
    // and one that declares fifteen minutes must differ by exactly those
    // fifteen minutes, and nothing more.
    const appointment = {
      start: london("2026-06-01 09:00"),
      end: london("2026-06-01 09:30"),
    };
    const service: ServicePolicy = {
      durationMinutes: 30,
      stepMinutes: 15,
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 15,
    };
    const firstStart = (bufferAfterMinutes: number) =>
      times(
        availableSlots(
          onDay("2026-06-01", {
            service,
            resources: [
              {
                ...anyone,
                busy: [{ interval: appointment, bufferAfterMinutes }],
              },
            ],
          }),
        ),
      )[0];

    // With no trailing buffer on the old appointment: prep for the new one
    // runs 09:30-09:45, so it starts at 09:45.
    expect(firstStart(0)).toBe("09:45");
    // With fifteen minutes of clean-up: that pushes the prep to 09:45-10:00.
    expect(firstStart(15)).toBe("10:00");
  });
});

describe("notice and advance limits", () => {
  it("refuses a slot inside the minimum notice", () => {
    const now = london("2026-06-01 09:05");
    const service: ServicePolicy = {
      durationMinutes: 30,
      stepMinutes: 30,
      minimumNoticeMinutes: 60,
    };
    // Now is 09:05 and an hour's notice is needed, so the first bookable slot
    // is the first one starting at or after 10:05 — which is 10:30.
    expect(
      times(availableSlots(onDay("2026-06-01", { service, now }))),
    ).toEqual(["10:30", "11:00", "11:30"]);
  });

  it("refuses a slot beyond the maximum advance", () => {
    const now = london("2026-06-01 08:00");
    const service: ServicePolicy = {
      durationMinutes: 30,
      stepMinutes: 30,
      maximumAdvanceDays: 2,
    };
    const start = startOfDay(parseDate("2026-06-01"), LONDON);
    const slots = availableSlots({
      ...onDay("2026-06-01", { service, now }),
      within: { start, end: start + 14 * 24 * 60 * MINUTE },
    });
    // The limit is elapsed time, not calendar days: two days from 08:00 on
    // the 1st runs out at 08:00 on the 3rd, which is before that day's first
    // slot. So Monday and Tuesday, and nothing on Wednesday.
    const days = new Set(dayAndTimes(slots).map((s) => s.slice(0, 10)));
    expect([...days].sort()).toEqual(["01/06/2026", "02/06/2026"]);
  });

  it("computes the bookable window from now", () => {
    const now = 1_000_000;
    expect(
      bookableWindow({ durationMinutes: 30, stepMinutes: 30 }, now),
    ).toEqual({
      start: now,
      end: Number.MAX_SAFE_INTEGER,
    });
    expect(
      bookableWindow(
        {
          durationMinutes: 30,
          stepMinutes: 30,
          minimumNoticeMinutes: 10,
          maximumAdvanceDays: 1,
        },
        now,
      ),
    ).toEqual({ start: now + 10 * MINUTE, end: now + 24 * 60 * MINUTE });
  });
});

describe("daylight saving", () => {
  it("keeps the same local opening hours when the clocks go forward", () => {
    // 2026-03-29 is the spring-forward Sunday in London. A business open
    // 09:00-12:00 is still open 09:00-12:00 — the UTC instants move.
    const sundayMornings: Schedule = {
      zone: LONDON,
      weekly: [{ weekday: 0, startMinute: 9 * 60, endMinute: 12 * 60 }],
    };
    const before = availableSlots(
      onDay("2026-03-22", { schedule: sundayMornings }),
    );
    const during = availableSlots(
      onDay("2026-03-29", { schedule: sundayMornings }),
    );
    expect(times(before)).toEqual(times(during));
    // And the instants really did shift by an hour.
    expect(during[0]!.start - before[0]!.start).toBe(
      6 * 24 * 60 * MINUTE + 23 * 60 * MINUTE,
    );
  });

  it("loses the hour that does not exist, rather than the whole day", () => {
    // A business open 00:30-03:30 on the spring-forward Sunday: 01:00-01:59
    // never happens, so the window is an hour shorter but still open.
    const overnight: Schedule = {
      zone: LONDON,
      weekly: [{ weekday: 0, startMinute: 30, endMinute: 3 * 60 + 30 }],
    };
    const day = startOfDay(parseDate("2026-03-29"), LONDON);
    const slots = availableSlots({
      ...onDay("2026-03-29", { schedule: overnight }),
      within: { start: day, end: day + 24 * 60 * MINUTE },
    });
    expect(slots.length).toBeGreaterThan(0);
    // Three hours of wall clock, two hours of real time, so four slots.
    expect(slots).toHaveLength(4);
    // The labels jump: the slot half an hour after 00:30 GMT is 02:00 BST,
    // because the clock skipped from 01:00 to 02:00 in between. Four slots of
    // real time, with an hour missing from the middle of the window.
    expect(times(slots)).toEqual(["00:30", "02:00", "02:30", "03:00"]);
  });

  it("offers the repeated hour twice when the clocks go back", () => {
    // 2026-10-25: 01:00-01:59 happens twice, so a business open 00:30-03:30
    // genuinely has an extra hour of bookable time.
    const overnight: Schedule = {
      zone: LONDON,
      weekly: [{ weekday: 0, startMinute: 30, endMinute: 3 * 60 + 30 }],
    };
    const day = startOfDay(parseDate("2026-10-25"), LONDON);
    const slots = availableSlots({
      ...onDay("2026-10-25", { schedule: overnight }),
      within: { start: day, end: day + 25 * 60 * MINUTE },
    });
    // Four hours of real time, so eight slots, and two of them read 01:00.
    expect(slots).toHaveLength(8);
    const labels = times(slots);
    expect(labels.filter((t) => t === "01:00")).toHaveLength(2);
    // Distinct instants, which is the point: they are different slots.
    expect(new Set(slots.map((s) => s.start)).size).toBe(8);
  });
});

describe("late-night opening", () => {
  it("handles a window that runs past midnight", () => {
    // A bar open 22:00-02:00 is expressed as 22:00-26:00 on the day it opens.
    const lateNight: Schedule = {
      zone: LONDON,
      weekly: [{ weekday: 5, startMinute: 22 * 60, endMinute: 26 * 60 }],
    };
    const friday = startOfDay(parseDate("2026-06-05"), LONDON);
    const slots = availableSlots({
      ...onDay("2026-06-05", { schedule: lateNight }),
      service: { durationMinutes: 60, stepMinutes: 60 },
      within: { start: friday, end: friday + 2 * 24 * 60 * MINUTE },
    });
    expect(dayAndTimes(slots)).toEqual([
      "05/06/2026, 22:00",
      "05/06/2026, 23:00",
      "06/06/2026, 00:00",
      "06/06/2026, 01:00",
    ]);
  });

  it("finds last night's window when asked about today only", () => {
    // Querying Saturday alone must still return the small hours, which
    // belong to Friday's rule. Expanding only the requested dates misses it.
    const lateNight: Schedule = {
      zone: LONDON,
      weekly: [{ weekday: 5, startMinute: 22 * 60, endMinute: 26 * 60 }],
    };
    const saturday = startOfDay(parseDate("2026-06-06"), LONDON);
    const slots = availableSlots({
      ...onDay("2026-06-06", { schedule: lateNight }),
      service: { durationMinutes: 60, stepMinutes: 60 },
      within: { start: saturday, end: saturday + 24 * 60 * MINUTE },
    });
    expect(dayAndTimes(slots)).toEqual([
      "06/06/2026, 00:00",
      "06/06/2026, 01:00",
    ]);
  });
});

describe("several resources", () => {
  const two: Resource[] = [{ id: "ana" }, { id: "ben" }];

  it("reports every member of staff who can take a slot", () => {
    const slots = availableSlots(onDay("2026-06-01", { resources: two }));
    expect(slots[0]!.resourceIds).toEqual(["ana", "ben"]);
  });

  it("still offers a slot when only one of them is free", () => {
    const resources: Resource[] = [
      {
        id: "ana",
        busy: [
          {
            interval: {
              start: london("2026-06-01 10:00"),
              end: london("2026-06-01 10:30"),
            },
          },
        ],
      },
      { id: "ben" },
    ];
    const slots = availableSlots(onDay("2026-06-01", { resources }));
    const ten = slots.find((s) => s.start === london("2026-06-01 10:00"));
    expect(ten?.resourceIds).toEqual(["ben"]);
  });

  it("drops a slot when nobody is free", () => {
    const busy = [
      {
        interval: {
          start: london("2026-06-01 10:00"),
          end: london("2026-06-01 10:30"),
        },
      },
    ];
    const resources: Resource[] = [
      { id: "ana", busy },
      { id: "ben", busy },
    ];
    expect(
      times(availableSlots(onDay("2026-06-01", { resources }))),
    ).not.toContain("10:00");
  });

  it("intersects a member of staff's own hours with the business's", () => {
    // Ben works mornings only in a business open all morning; Ana is part
    // time from 11:00.
    const fromEleven: Schedule = {
      zone: LONDON,
      weekly: [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        startMinute: 11 * 60,
        endMinute: 18 * 60,
      })),
    };
    const resources: Resource[] = [
      { id: "ana", schedule: fromEleven },
      { id: "ben" },
    ];
    const slots = availableSlots(onDay("2026-06-01", { resources }));
    expect(
      slots.find((s) => s.start === london("2026-06-01 09:00"))?.resourceIds,
    ).toEqual(["ben"]);
    expect(
      slots.find((s) => s.start === london("2026-06-01 11:00"))?.resourceIds,
    ).toEqual(["ana", "ben"]);
  });

  it("applies shared busy time to everyone", () => {
    // A team meeting blocks the whole business, not one person.
    const busy = [
      {
        interval: {
          start: london("2026-06-01 10:00"),
          end: london("2026-06-01 11:00"),
        },
      },
    ];
    const slots = times(
      availableSlots(onDay("2026-06-01", { resources: two, busy })),
    );
    expect(slots).toEqual(["09:00", "09:30", "11:00", "11:30"]);
  });

  it("returns nothing when there are no resources at all", () => {
    expect(availableSlots(onDay("2026-06-01", { resources: [] }))).toEqual([]);
  });
});

describe("overrides and closures", () => {
  it("closes on a date with an empty override", () => {
    const schedule: Schedule = {
      ...weekdayMornings,
      overrides: [{ date: parseDate("2026-06-01"), windows: [] }],
    };
    expect(availableSlots(onDay("2026-06-01", { schedule }))).toEqual([]);
  });

  it("opens specially on a day the weekly rules do not cover", () => {
    const schedule: Schedule = {
      ...weekdayMornings,
      overrides: [
        {
          date: parseDate("2026-06-06"), // a Saturday
          windows: [{ startMinute: 10 * 60, endMinute: 11 * 60 }],
        },
      ],
    };
    expect(times(availableSlots(onDay("2026-06-06", { schedule })))).toEqual([
      "10:00",
      "10:30",
    ]);
  });

  it("replaces the weekly hours rather than adding to them", () => {
    const schedule: Schedule = {
      ...weekdayMornings,
      overrides: [
        {
          date: parseDate("2026-06-01"),
          windows: [{ startMinute: 14 * 60, endMinute: 15 * 60 }],
        },
      ],
    };
    expect(times(availableSlots(onDay("2026-06-01", { schedule })))).toEqual([
      "14:00",
      "14:30",
    ]);
  });

  it("cuts a closure out of the opening hours", () => {
    const schedule: Schedule = {
      ...weekdayMornings,
      closures: [
        { start: london("2026-06-01 10:00"), end: london("2026-06-01 11:00") },
      ],
    };
    expect(times(availableSlots(onDay("2026-06-01", { schedule })))).toEqual([
      "09:00",
      "09:30",
      "11:00",
      "11:30",
    ]);
  });

  it("honours a rule's validity window", () => {
    // Summer hours: an extra afternoon window valid only in July.
    const schedule: Schedule = {
      zone: LONDON,
      weekly: [
        { weekday: 1, startMinute: 9 * 60, endMinute: 10 * 60 },
        {
          weekday: 1,
          startMinute: 14 * 60,
          endMinute: 15 * 60,
          from: parseDate("2026-07-01"),
          until: parseDate("2026-07-31"),
        },
      ],
    };
    expect(times(availableSlots(onDay("2026-06-01", { schedule })))).toEqual([
      "09:00",
      "09:30",
    ]);
    expect(times(availableSlots(onDay("2026-07-06", { schedule })))).toEqual([
      "09:00",
      "09:30",
      "14:00",
      "14:30",
    ]);
  });
});

describe("alignment", () => {
  it("snaps offered times onto a grid", () => {
    const schedule: Schedule = {
      zone: LONDON,
      weekly: [{ weekday: 1, startMinute: 9 * 60 + 7, endMinute: 11 * 60 }],
    };
    expect(times(availableSlots(onDay("2026-06-01", { schedule })))).toEqual([
      "09:07",
      "09:37",
      "10:07",
    ]);
    expect(
      times(
        availableSlots(
          onDay("2026-06-01", {
            schedule,
            service: { ...thirtyMinutes, alignToMinutes: 30 },
          }),
        ),
      ),
    ).toEqual(["09:30", "10:00", "10:30"]);
  });
});

describe("validation", () => {
  it("refuses a policy that cannot produce slots", () => {
    expect(() =>
      availableSlots(
        onDay("2026-06-01", {
          service: { durationMinutes: 0, stepMinutes: 30 },
        }),
      ),
    ).toThrow(AvailabilityError);
    expect(() =>
      availableSlots(
        onDay("2026-06-01", {
          service: { durationMinutes: 30, stepMinutes: 0 },
        }),
      ),
    ).toThrow(AvailabilityError);
    expect(() =>
      availableSlots(
        onDay("2026-06-01", {
          service: {
            durationMinutes: 30,
            stepMinutes: 30,
            bufferBeforeMinutes: -5,
          },
        }),
      ),
    ).toThrow(AvailabilityError);
  });

  it("refuses a backwards search window", () => {
    const start = startOfDay(parseDate("2026-06-01"), LONDON);
    expect(() =>
      availableSlots({
        ...onDay("2026-06-01"),
        within: { start, end: start - 1 },
      }),
    ).toThrow(AvailabilityError);
  });

  it("refuses an unknown time zone", () => {
    expect(() =>
      availableSlots(
        onDay("2026-06-01", {
          schedule: { ...weekdayMornings, zone: "Mars/Base" },
        }),
      ),
    ).toThrow(/unknown time zone/);
  });
});

describe("isSlotBookable", () => {
  it("accepts a slot that is in the list", () => {
    const query = onDay("2026-06-01");
    const result = isSlotBookable(query, { start: london("2026-06-01 10:00") });
    expect(result).toEqual({ ok: true, resourceIds: ["staff-a"] });
  });

  it("rejects a slot that is not on the grid", () => {
    // 10:15 is a real time inside opening hours, but not an offered start.
    // Accepting it would let a crafted request book outside the grid.
    const result = isSlotBookable(onDay("2026-06-01"), {
      start: london("2026-06-01 10:15"),
    });
    expect(result).toEqual({
      ok: false,
      reason: "that time is no longer available",
    });
  });

  it("rejects a slot that has just been taken", () => {
    // The stale-list case: the customer saw 10:00 twenty minutes ago.
    const busy = [
      {
        interval: {
          start: london("2026-06-01 10:00"),
          end: london("2026-06-01 10:30"),
        },
      },
    ];
    const result = isSlotBookable(
      onDay("2026-06-01", { resources: [{ ...anyone, busy }] }),
      {
        start: london("2026-06-01 10:00"),
      },
    );
    expect(result.ok).toBe(false);
  });

  it("explains a notice violation in terms of the policy", () => {
    const query = onDay("2026-06-01", {
      service: {
        durationMinutes: 30,
        stepMinutes: 30,
        minimumNoticeMinutes: 120,
      },
      now: london("2026-06-01 09:00"),
    });
    const result = isSlotBookable(query, { start: london("2026-06-01 09:30") });
    expect(result).toEqual({
      ok: false,
      reason: "bookings need at least 120 minutes' notice",
    });
  });

  it("rejects a member of staff who is not free, even when the slot is", () => {
    const resources: Resource[] = [
      {
        id: "ana",
        busy: [
          {
            interval: {
              start: london("2026-06-01 10:00"),
              end: london("2026-06-01 10:30"),
            },
          },
        ],
      },
      { id: "ben" },
    ];
    const query = onDay("2026-06-01", { resources });
    expect(
      isSlotBookable(query, {
        start: london("2026-06-01 10:00"),
        resourceId: "ben",
      }),
    ).toEqual({
      ok: true,
      resourceIds: ["ben"],
    });
    expect(
      isSlotBookable(query, {
        start: london("2026-06-01 10:00"),
        resourceId: "ana",
      }),
    ).toEqual({
      ok: false,
      reason: "that member of staff is no longer available at that time",
    });
  });

  it("reports a bad schedule as a reason rather than throwing", () => {
    const query = onDay("2026-06-01", {
      schedule: { ...weekdayMornings, zone: "Mars/Base" },
    });
    const result = isSlotBookable(query, { start: london("2026-06-01 10:00") });
    expect(result.ok).toBe(false);
  });
});

describe("groupByLocalDate", () => {
  it("groups by the viewer's own dates, not the business's", () => {
    // A 22:00 London slot is already tomorrow in Auckland. Showing it on
    // today's row of an Auckland customer's calendar is wrong.
    const slots = [
      {
        start: london("2026-06-05 22:00"),
        end: london("2026-06-05 23:00"),
        resourceIds: ["a"],
      },
    ];
    expect(groupByLocalDate(slots, LONDON).map((g) => g.date)).toEqual([
      "2026-06-05",
    ]);
    expect(
      groupByLocalDate(slots, "Pacific/Auckland").map((g) => g.date),
    ).toEqual(["2026-06-06"]);
  });

  it("keeps the slots of a day together and in order", () => {
    const slots = availableSlots(onDay("2026-06-01"));
    const groups = groupByLocalDate(slots, LONDON);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.slots).toHaveLength(6);
  });
});
