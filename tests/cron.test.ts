import { expect, it } from "vitest";
import { nextCronOccurrence } from "../src/services/cron";

/** 2026-08-11 12:34:56 local time. */
const NOW = new Date(2026, 7, 11, 12, 34, 56).getTime();

function at(cron: string, after: number = NOW): Date | null {
  const next = nextCronOccurrence(cron, after);
  return next === null ? null : new Date(next);
}

it.each([
  ["every minute", "* * * * *", new Date(2026, 7, 11, 12, 35)],
  ["hourly", "0 * * * *", new Date(2026, 7, 11, 13, 0)],
  ["step minutes", "*/20 * * * *", new Date(2026, 7, 11, 12, 40)],
  ["minute list", "0,20,40 * * * *", new Date(2026, 7, 11, 12, 40)],
  ["daily in the past hour", "0 9 * * *", new Date(2026, 7, 12, 9, 0)],
  ["daily later today", "30 18 * * *", new Date(2026, 7, 11, 18, 30)],
  ["weekdays only", "0 9 * * 1-5", new Date(2026, 7, 12, 9, 0)],
  ["sunday as 0", "0 9 * * 0", new Date(2026, 7, 16, 9, 0)],
  ["sunday as 7", "0 9 * * 7", new Date(2026, 7, 16, 9, 0)],
  ["named weekday", "0 9 * * MON", new Date(2026, 7, 17, 9, 0)],
  ["day of month", "0 0 1 * *", new Date(2026, 8, 1, 0, 0)],
  ["named month", "0 0 1 JAN *", new Date(2027, 0, 1, 0, 0)],
  ["hour range with step", "0 8-18/2 * * *", new Date(2026, 7, 11, 14, 0)],
])("schedules %s", (_name, cron, expected) => {
  expect(at(cron)).toEqual(expected);
});

it("matches either day field when both are restricted, as cron does", () => {
  // The 13th is a Thursday; the rule also names Mondays.
  expect(at("0 0 13 * MON")).toEqual(new Date(2026, 7, 13, 0, 0));
  expect(at("0 0 13 * MON", new Date(2026, 7, 13, 1, 0).getTime())).toEqual(new Date(2026, 7, 17, 0, 0));
});

it("returns an occurrence strictly after the given instant", () => {
  const exactlyOnTheMinute = new Date(2026, 7, 11, 13, 0, 0, 0).getTime();
  expect(at("0 * * * *", exactlyOnTheMinute)).toEqual(new Date(2026, 7, 11, 14, 0));
});

it.each([
  ["too few fields", "0 9 * *"],
  ["too many fields", "0 9 * * * *"],
  ["prose", "not a cron"],
  ["out of range minute", "60 * * * *"],
  ["out of range hour", "0 24 * * *"],
  ["inverted range", "0 18-8 * * *"],
  ["zero step", "*/0 * * * *"],
  ["empty", ""],
])("refuses %s", (_name, cron) => {
  expect(nextCronOccurrence(cron, NOW)).toBeNull();
});

it("refuses a date that never occurs", () => {
  expect(nextCronOccurrence("0 0 31 2 *", NOW)).toBeNull();
});
