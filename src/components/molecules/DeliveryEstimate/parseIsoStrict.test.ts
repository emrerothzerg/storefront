import { describe, expect, test } from "bun:test";
import { parseIsoStrict } from "./parseIsoStrict";

describe("parseIsoStrict", () => {
  test("accepts Z, offsets, optional seconds and 1-3 fraction digits", () => {
    expect(parseIsoStrict("2026-11-10T08:00:00.000Z")).toBe(Date.UTC(2026, 10, 10, 8));
    expect(parseIsoStrict("2026-11-10T08:00Z")).toBe(Date.UTC(2026, 10, 10, 8));
    expect(parseIsoStrict("2026-11-10T08:00:30Z")).toBe(Date.UTC(2026, 10, 10, 8, 0, 30));
    expect(parseIsoStrict("2026-11-10T08:00:00.5Z")).toBe(Date.UTC(2026, 10, 10, 8, 0, 0, 500));
    expect(parseIsoStrict("2026-11-10T23:30:00-05:00")).toBe(Date.UTC(2026, 10, 11, 4, 30));
    expect(parseIsoStrict("2026-11-10T01:00:00+02:00")).toBe(Date.UTC(2026, 10, 9, 23));
  });

  test("leap day only in leap years; offset may cross a day boundary on a valid date", () => {
    expect(parseIsoStrict("2028-02-29T12:00:00Z")).toBe(Date.UTC(2028, 1, 29, 12));
    expect(parseIsoStrict("2026-02-29T12:00:00Z")).toBeNull();
    expect(parseIsoStrict("2026-12-31T23:00:00-05:00")).toBe(Date.UTC(2027, 0, 1, 4));
  });

  test.each([
    "2026-02-31T08:00:00Z", // rolls to Mar 3 with Date.parse
    "2026-04-31T08:00:00Z",
    "2026-13-01T08:00:00Z",
    "2026-00-10T08:00:00Z",
    "2026-11-00T08:00:00Z",
    "2026-11-10T24:00:00Z",
    "2026-11-10T25:00:00Z",
    "2026-11-10T08:60:00Z",
    "2026-11-10T08:00:60Z",
    "2026-11-10T08:00:00+24:00",
    "2026-11-10T08:00:00+05:60",
    "2026-11-10T08:00:00", // no zone: Date.parse would use local time
    "2026-11-10", // date only
    "2026-11-10 08:00:00Z",
    "Nov 10, 2026",
    "2026-11-10T08:00:00.0000Z",
    " 2026-11-10T08:00:00Z",
    "2026-11-10T08:00:00Z ",
    "",
    "soon",
  ])("rejects %p", (value) => {
    expect(parseIsoStrict(value)).toBeNull();
  });

  test("non-strings are rejected", () => {
    for (const value of [undefined, null, 0, Number.NaN, {}, new Date()]) {
      expect(parseIsoStrict(value)).toBeNull();
    }
  });
});
