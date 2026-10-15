import { describe, expect, it } from "vitest";
import { addDays, nextDue, parseRecur, todayIn, weekdayOf, zonedToEpoch } from "../src/lib/recur";

describe("parseRecur", () => {
  it("accepts and canonicalizes valid shapes", () => {
    expect(parseRecur(null)).toBeNull();
    expect(parseRecur({ freq: "daily" })).toEqual({ freq: "daily" });
    expect(parseRecur({ freq: "every", days: 2 })).toEqual({ freq: "every", days: 2 });
    expect(parseRecur({ freq: "every", days: 30 })).toEqual({ freq: "every", days: 30 });
    expect(parseRecur({ freq: "weekly", weekdays: [4, 0, 2, 2] })).toEqual({ freq: "weekly", weekdays: [0, 2, 4] });
  });
  it("rejects anything else", () => {
    const bad: unknown[] = [
      "daily",
      [],
      {},
      { freq: "monthly" },
      { freq: "daily", days: 1 },
      { freq: "every", days: 1 },
      { freq: "every", days: 31 },
      { freq: "every", days: 2.5 },
      { freq: "every", days: "3" },
      { freq: "every" },
      { freq: "weekly", weekdays: [] },
      { freq: "weekly", weekdays: [7] },
      { freq: "weekly", weekdays: [-1] },
      { freq: "weekly", weekdays: ["1"] },
      { freq: "weekly" },
      { freq: "weekly", weekdays: [1], x: 1 },
    ];
    for (const b of bad) expect(parseRecur(b)).toBe(false);
  });
});

describe("nextDue", () => {
  it("daily crosses month and year boundaries", () => {
    expect(nextDue({ freq: "daily" }, "2026-01-31")).toBe("2026-02-01");
    expect(nextDue({ freq: "daily" }, "2026-02-28")).toBe("2026-03-01");
    expect(nextDue({ freq: "daily" }, "2028-02-28")).toBe("2028-02-29");
    expect(nextDue({ freq: "daily" }, "2026-12-31")).toBe("2027-01-01");
  });
  it("every N days", () => {
    expect(nextDue({ freq: "every", days: 3 }, "2026-10-30")).toBe("2026-11-02");
    expect(nextDue({ freq: "every", days: 14 }, "2026-12-25")).toBe("2027-01-08");
    expect(nextDue({ freq: "every", days: 30 }, "2026-02-01")).toBe("2026-03-03");
  });
  it("weekly picks the next listed weekday and wraps around the week", () => {
    expect(weekdayOf("2026-10-15")).toBe(4); // Thursday
    const sunTueThu = { freq: "weekly" as const, weekdays: [0, 2, 4] };
    expect(nextDue(sunTueThu, "2026-10-15")).toBe("2026-10-18"); // Thu -> Sun
    expect(nextDue(sunTueThu, "2026-10-18")).toBe("2026-10-20"); // Sun -> Tue
    expect(nextDue(sunTueThu, "2026-10-17")).toBe("2026-10-18"); // Sat -> Sun
    // only one weekday: a full week later
    expect(nextDue({ freq: "weekly", weekdays: [4] }, "2026-10-15")).toBe("2026-10-22");
    // year boundary: Thu 2026-12-31 -> Mon 2027-01-04
    expect(nextDue({ freq: "weekly", weekdays: [1] }, "2026-12-31")).toBe("2027-01-04");
  });
  it("addDays handles negatives", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});

describe("zones", () => {
  it("zonedToEpoch across the America/New_York spring-forward (2026-03-08)", () => {
    const tz = "America/New_York";
    expect(zonedToEpoch("2026-03-07", "09:00", tz)).toBe(Date.UTC(2026, 2, 7, 14, 0)); // EST -5
    expect(zonedToEpoch("2026-03-08", "01:30", tz)).toBe(Date.UTC(2026, 2, 8, 6, 30)); // still EST
    expect(zonedToEpoch("2026-03-08", "09:00", tz)).toBe(Date.UTC(2026, 2, 8, 13, 0)); // EDT -4
    expect(zonedToEpoch("2026-03-09", "00:00", tz)).toBe(Date.UTC(2026, 2, 9, 4, 0));
    // fall back (2026-11-01): 09:00 is EST again
    expect(zonedToEpoch("2026-11-01", "09:00", tz)).toBe(Date.UTC(2026, 10, 1, 14, 0));
    expect(zonedToEpoch("2026-10-31", "09:00", tz)).toBe(Date.UTC(2026, 9, 31, 13, 0));
  });
  it("zonedToEpoch in Asia/Riyadh (UTC+3, no DST) and UTC", () => {
    expect(zonedToEpoch("2026-03-08", "09:00", "Asia/Riyadh")).toBe(Date.UTC(2026, 2, 8, 6, 0));
    expect(zonedToEpoch("2026-07-01", "00:15", "Asia/Riyadh")).toBe(Date.UTC(2026, 5, 30, 21, 15));
    expect(zonedToEpoch("2026-07-01", "23:59", "UTC")).toBe(Date.UTC(2026, 6, 1, 23, 59));
  });
  it("todayIn uses the zone's calendar day", () => {
    const at = Date.UTC(2026, 9, 15, 22, 30); // 22:30Z
    expect(todayIn("UTC", at)).toBe("2026-10-15");
    expect(todayIn("Asia/Riyadh", at)).toBe("2026-10-16");
    expect(todayIn("America/New_York", at)).toBe("2026-10-15");
    expect(todayIn("Pacific/Kiritimati", Date.UTC(2026, 11, 31, 11, 0))).toBe("2027-01-01");
  });
});
