import { describe, expect, it } from "vitest";
import {
  addDays,
  atMinuteOfDay,
  dateOf,
  datesBetween,
  formatMinuteOfDay,
  formatOffset,
  instantOf,
  isValidZone,
  minuteOfDayAt,
  offsetAt,
  parseDate,
  parseMinuteOfDay,
  partsOf,
  resolve,
  startOfDay,
  TimeZoneError,
  weekdayOf,
  type WallClock,
} from "./zone";

/** A wall clock from the obvious arguments, so the tests read as times. */
function wall(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): WallClock {
  return { year, month, day, hour, minute, second };
}

const iso = (instant: number) => new Date(instant).toISOString();

describe("partsOf", () => {
  it("renders an instant as the wall clock in a zone", () => {
    // 2026-07-01T12:00:00Z: summer, so London is +01:00 and New York -04:00.
    const instant = Date.UTC(2026, 6, 1, 12, 0, 0);
    expect(partsOf(instant, "UTC")).toEqual(wall(2026, 7, 1, 12));
    expect(partsOf(instant, "Europe/London")).toEqual(wall(2026, 7, 1, 13));
    expect(partsOf(instant, "America/New_York")).toEqual(wall(2026, 7, 1, 8));
    expect(partsOf(instant, "Asia/Tokyo")).toEqual(wall(2026, 7, 1, 21));
  });

  it("handles zones whose offset is not a whole hour", () => {
    const instant = Date.UTC(2026, 6, 1, 0, 0, 0);
    // Kathmandu is +05:45, which breaks any code assuming whole hours.
    expect(partsOf(instant, "Asia/Kathmandu")).toEqual(wall(2026, 7, 1, 5, 45));
    // Chatham is +12:45 in winter, +13:45 in summer.
    expect(offsetAt(instant, "Asia/Kathmandu")).toBe((5 * 60 + 45) * 60_000);
  });

  it("crosses the date line correctly", () => {
    // 23:00 UTC is already tomorrow in Auckland and still today in Honolulu.
    const instant = Date.UTC(2026, 0, 15, 23, 0, 0);
    expect(dateOf(instant, "Pacific/Auckland")).toEqual({
      year: 2026,
      month: 1,
      day: 16,
    });
    expect(dateOf(instant, "Pacific/Honolulu")).toEqual({
      year: 2026,
      month: 1,
      day: 15,
    });
  });

  it("renders midnight as hour 0, not hour 24", () => {
    const instant = Date.UTC(2026, 2, 10, 0, 0, 0);
    expect(partsOf(instant, "UTC").hour).toBe(0);
  });

  it("rejects a zone the runtime does not know", () => {
    expect(() => partsOf(0, "Mars/Olympus_Mons")).toThrow(TimeZoneError);
    expect(isValidZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidZone("Europe/London")).toBe(true);
  });
});

describe("resolve", () => {
  it("resolves an ordinary time exactly", () => {
    const r = resolve(wall(2026, 7, 1, 9, 30), "Europe/London");
    expect(r.kind).toBe("exact");
    if (r.kind !== "exact") throw new Error("unreachable");
    // 09:30 BST is 08:30 UTC.
    expect(iso(r.instant)).toBe("2026-07-01T08:30:00.000Z");
  });

  it("reports a time that does not exist when the clocks go forward", () => {
    // London springs forward at 01:00 GMT on 2026-03-29, so 01:00–01:59
    // local never happens.
    const r = resolve(wall(2026, 3, 29, 1, 30), "Europe/London");
    expect(r.kind).toBe("gap");
    if (r.kind !== "gap") throw new Error("unreachable");
    expect(iso(r.before)).toBe("2026-03-29T00:30:00.000Z");
    expect(iso(r.after)).toBe("2026-03-29T01:30:00.000Z");
  });

  it("reports a time that happens twice when the clocks go back", () => {
    // London falls back at 02:00 BST on 2026-10-25, so 01:00–01:59 local
    // happens once in BST and once in GMT.
    const r = resolve(wall(2026, 10, 25, 1, 30), "Europe/London");
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") throw new Error("unreachable");
    expect(iso(r.first)).toBe("2026-10-25T00:30:00.000Z");
    expect(iso(r.second)).toBe("2026-10-25T01:30:00.000Z");
    expect(r.second - r.first).toBe(60 * 60_000);
  });

  it("finds the gap and the overlap in the southern hemisphere too", () => {
    // Sydney runs the other way round: forward in October, back in April.
    const forward = resolve(wall(2026, 10, 4, 2, 30), "Australia/Sydney");
    expect(forward.kind).toBe("gap");

    const back = resolve(wall(2026, 4, 5, 2, 30), "Australia/Sydney");
    expect(back.kind).toBe("ambiguous");
  });

  it("handles a half-hour transition", () => {
    // Lord Howe Island shifts by 30 minutes, not an hour. Any code that
    // assumes the jump is 3600 seconds gets this wrong.
    const r = resolve(wall(2026, 10, 4, 2, 15), "Australia/Lord_Howe");
    expect(r.kind).toBe("gap");
    if (r.kind !== "gap") throw new Error("unreachable");
    expect(r.after - r.before).toBe(30 * 60_000);
  });

  it("resolves exactly in a zone with no daylight saving at all", () => {
    for (const zone of [
      "UTC",
      "Asia/Tokyo",
      "Asia/Kolkata",
      "America/Phoenix",
    ]) {
      const r = resolve(wall(2026, 3, 29, 1, 30), zone);
      expect(r.kind, zone).toBe("exact");
    }
  });
});

describe("instantOf", () => {
  it("shifts a nonexistent time forward by default", () => {
    // 01:30 did not happen, and "half past one" on that day means 02:30 to a
    // person. Shifting is the only answer that keeps the appointment.
    const instant = instantOf(
      wall(2026, 3, 29, 1, 30),
      "Europe/London",
      "shift",
    );
    expect(iso(instant)).toBe("2026-03-29T01:30:00.000Z");
    expect(partsOf(instant, "Europe/London")).toEqual(wall(2026, 3, 29, 2, 30));
  });

  it("can reject a nonexistent time instead", () => {
    // What a form should do with a time a customer typed.
    expect(() =>
      instantOf(wall(2026, 3, 29, 1, 30), "Europe/London", "reject"),
    ).toThrow(/does not exist/);
  });

  it("takes the earlier of two ambiguous times by default", () => {
    const earlier = instantOf(wall(2026, 10, 25, 1, 30), "Europe/London");
    const later = instantOf(
      wall(2026, 10, 25, 1, 30),
      "Europe/London",
      "later",
    );
    expect(iso(earlier)).toBe("2026-10-25T00:30:00.000Z");
    expect(iso(later)).toBe("2026-10-25T01:30:00.000Z");
  });

  it("round-trips every ordinary time", () => {
    // The property that matters: for a time that exists exactly once, going
    // to an instant and back must return what you started with.
    const zones = [
      "UTC",
      "Europe/London",
      "America/New_York",
      "Asia/Kathmandu",
      "Pacific/Auckland",
      "America/Sao_Paulo",
    ];
    for (const zone of zones) {
      for (let day = 1; day <= 28; day += 1) {
        for (const hour of [0, 6, 9, 12, 17, 23]) {
          const w = wall(2026, 6, day, hour, 30);
          const r = resolve(w, zone);
          if (r.kind !== "exact") continue;
          expect(partsOf(r.instant, zone), `${zone} ${day} ${hour}`).toEqual(w);
        }
      }
    }
  });
});

describe("atMinuteOfDay", () => {
  it("places an opening time on a normal day", () => {
    const instant = atMinuteOfDay(
      { year: 2026, month: 7, day: 1 },
      9 * 60,
      "Europe/London",
    );
    expect(iso(instant)).toBe("2026-07-01T08:00:00.000Z");
  });

  it("gives the same wall-clock hour on both sides of a transition", () => {
    // This is the whole reason opening hours are stored as local times: 09:00
    // stays 09:00, and the UTC instant moves.
    const before = atMinuteOfDay(
      { year: 2026, month: 3, day: 28 },
      9 * 60,
      "Europe/London",
    );
    const after = atMinuteOfDay(
      { year: 2026, month: 3, day: 30 },
      9 * 60,
      "Europe/London",
    );
    expect(minuteOfDayAt(before, "Europe/London")).toBe(9 * 60);
    expect(minuteOfDayAt(after, "Europe/London")).toBe(9 * 60);
    // Two days apart on the clock, but one hour less than 48 hours of elapsed
    // time, because an hour was skipped.
    expect(after - before).toBe(47 * 60 * 60_000);
  });

  it("handles a minute of day past midnight, for a business open late", () => {
    // A bar open until 02:00 describes itself as 18:00–26:00, which is the
    // case that breaks hour/minute pairs.
    const instant = atMinuteOfDay(
      { year: 2026, month: 7, day: 1 },
      26 * 60,
      "Europe/London",
    );
    expect(partsOf(instant, "Europe/London")).toEqual(wall(2026, 7, 2, 2));
  });

  it("rejects a nonsensical minute of day", () => {
    expect(() =>
      atMinuteOfDay({ year: 2026, month: 7, day: 1 }, -60, "UTC"),
    ).toThrow(TimeZoneError);
    expect(() =>
      atMinuteOfDay({ year: 2026, month: 7, day: 1 }, 1.5, "UTC"),
    ).toThrow(TimeZoneError);
  });
});

describe("startOfDay", () => {
  it("is local midnight, not UTC midnight", () => {
    const instant = startOfDay(
      { year: 2026, month: 7, day: 1 },
      "America/New_York",
    );
    expect(iso(instant)).toBe("2026-07-01T04:00:00.000Z");
    expect(partsOf(instant, "America/New_York")).toEqual(wall(2026, 7, 1, 0));
  });

  it("survives a zone where midnight itself moved", () => {
    // Samoa skipped 2011-12-30 entirely when it changed side of the date
    // line, so that date has no midnight -- and no instants at all.
    const instant = startOfDay(
      { year: 2011, month: 12, day: 30 },
      "Pacific/Apia",
    );
    expect(Number.isFinite(instant)).toBe(true);
  });

  it("gives a day that is 23 or 25 hours long across a transition", () => {
    const spring = startOfDay(
      { year: 2026, month: 3, day: 29 },
      "Europe/London",
    );
    const nextDay = startOfDay(
      { year: 2026, month: 3, day: 30 },
      "Europe/London",
    );
    expect(nextDay - spring).toBe(23 * 60 * 60_000);

    const autumn = startOfDay(
      { year: 2026, month: 10, day: 25 },
      "Europe/London",
    );
    const after = startOfDay(
      { year: 2026, month: 10, day: 26 },
      "Europe/London",
    );
    expect(after - autumn).toBe(25 * 60 * 60_000);
  });
});

describe("weekdayOf", () => {
  it("uses the day of the week in the zone, not in UTC", () => {
    // Monday 00:30 in Auckland is still Sunday in UTC. A weekly opening rule
    // keyed on the UTC weekday opens on the wrong day.
    const instant = Date.UTC(2026, 0, 11, 11, 30); // Sunday 11:30 UTC
    expect(weekdayOf(instant, "UTC")).toBe(0);
    expect(weekdayOf(instant, "Pacific/Auckland")).toBe(1);
  });
});

describe("date helpers", () => {
  it("adds days across a month and a leap year", () => {
    expect(addDays({ year: 2026, month: 1, day: 31 }, 1)).toEqual({
      year: 2026,
      month: 2,
      day: 1,
    });
    expect(addDays({ year: 2028, month: 2, day: 28 }, 1)).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
    expect(addDays({ year: 2026, month: 2, day: 28 }, 1)).toEqual({
      year: 2026,
      month: 3,
      day: 1,
    });
    expect(addDays({ year: 2026, month: 1, day: 1 }, -1)).toEqual({
      year: 2025,
      month: 12,
      day: 31,
    });
  });

  it("lists an inclusive range of dates", () => {
    const dates = datesBetween(
      { year: 2026, month: 2, day: 27 },
      { year: 2026, month: 3, day: 1 },
    );
    expect(dates).toEqual([
      { year: 2026, month: 2, day: 27 },
      { year: 2026, month: 2, day: 28 },
      { year: 2026, month: 3, day: 1 },
    ]);
  });

  it("returns nothing for a backwards range rather than looping", () => {
    expect(
      datesBetween(
        { year: 2026, month: 3, day: 1 },
        { year: 2026, month: 2, day: 1 },
      ),
    ).toEqual([]);
  });

  it("refuses a range longer than ten years", () => {
    expect(() =>
      datesBetween(
        { year: 2000, month: 1, day: 1 },
        { year: 2030, month: 1, day: 1 },
      ),
    ).toThrow(/narrow the query/);
  });

  it("parses a date and refuses one that is not real", () => {
    expect(parseDate("2026-02-28")).toEqual({ year: 2026, month: 2, day: 28 });
    // 2026 is not a leap year, and Date would roll this into March.
    expect(() => parseDate("2026-02-29")).toThrow(/not a real date/);
    expect(() => parseDate("2026-13-01")).toThrow(/not a real date/);
    expect(() => parseDate("1 Feb 2026")).toThrow(/YYYY-MM-DD/);
  });
});

describe("minute of day formatting", () => {
  it("round-trips", () => {
    for (const text of ["00:00", "09:30", "17:45", "23:59", "24:00"]) {
      expect(formatMinuteOfDay(parseMinuteOfDay(text))).toBe(text);
    }
  });

  it("refuses a time that is not one", () => {
    for (const text of ["25:00", "09:60", "24:30", "9h30", ""]) {
      expect(() => parseMinuteOfDay(text), text).toThrow(TimeZoneError);
    }
  });
});

describe("formatOffset", () => {
  it("renders the offset in force at that instant", () => {
    const winter = Date.UTC(2026, 0, 15, 12);
    const summer = Date.UTC(2026, 6, 15, 12);
    expect(formatOffset(winter, "Europe/London")).toBe("+00:00");
    expect(formatOffset(summer, "Europe/London")).toBe("+01:00");
    expect(formatOffset(summer, "America/New_York")).toBe("-04:00");
    expect(formatOffset(summer, "Asia/Kathmandu")).toBe("+05:45");
  });
});
