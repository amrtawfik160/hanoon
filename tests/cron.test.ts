import { expect, it } from "vitest";
import { matchesCron, nextCronOccurrence, parseCron } from "../src/services/cron";

/** Local time throughout: an owner asking for 09:00 means their own morning. */
function at(text: string): number {
  return new Date(text).getTime();
}

function iso(value: number | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

it.each([
  ["every minute", "* * * * *", "2026-03-05T10:15:30", "2026-03-05 10:16"],
  ["daily at 07:00 later today", "0 7 * * *", "2026-03-05T06:59:00", "2026-03-05 07:00"],
  ["daily at 07:00 rolls to tomorrow", "0 7 * * *", "2026-03-05T07:00:00", "2026-03-06 07:00"],
  ["weekday mornings", "0 9 * * 1-5", "2026-03-07T12:00:00", "2026-03-09 09:00"],
  ["monday only", "0 8 * * 1", "2026-03-05T00:00:00", "2026-03-09 08:00"],
  ["friday evening", "0 17 * * 5", "2026-03-05T00:00:00", "2026-03-06 17:00"],
  ["a step", "*/15 * * * *", "2026-03-05T10:01:00", "2026-03-05 10:15"],
  ["a list", "0,30 * * * *", "2026-03-05T10:01:00", "2026-03-05 10:30"],
  ["a stepped range", "0-30/10 * * * *", "2026-03-05T10:01:00", "2026-03-05 10:10"],
  ["a day of month", "0 0 1 * *", "2026-03-05T00:00:00", "2026-04-01 00:00"],
  ["a month", "0 0 1 1 *", "2026-03-05T00:00:00", "2027-01-01 00:00"],
  ["sunday as 0", "0 6 * * 0", "2026-03-05T00:00:00", "2026-03-08 06:00"],
  ["sunday as 7", "0 6 * * 7", "2026-03-05T00:00:00", "2026-03-08 06:00"],
  ["a start-step", "5/15 * * * *", "2026-03-05T10:00:00", "2026-03-05 10:05"],
])("schedules %s", (_label, expression, from, expected) => {
  expect(iso(nextCronOccurrence(expression, at(from)))).toBe(expected);
});

// The three schedules the plugin installs for itself. These are exactly the
// expressions that silently failed in the built plugin before this evaluator.
it.each(["0 7 * * *", "0 8 * * 1", "0 17 * * 5"])("resolves the shipped schedule %s", (expression) => {
  const next = nextCronOccurrence(expression, at("2026-03-05T12:00:00"));

  expect(next).not.toBeNull();
  expect(next as number).toBeGreaterThan(at("2026-03-05T12:00:00"));
});

it("always returns a strictly later minute, never the current one", () => {
  const now = at("2026-03-05T07:00:00");

  expect(nextCronOccurrence("0 7 * * *", now)).toBeGreaterThan(now);
  expect(nextCronOccurrence("* * * * *", now)).toBe(at("2026-03-05T07:01:00"));
});

it("ignores seconds already elapsed in the current minute", () => {
  expect(iso(nextCronOccurrence("* * * * *", at("2026-03-05T10:15:59")))).toBe("2026-03-05 10:16");
});

it("runs when either day field matches once both are restricted", () => {
  const schedule = parseCron("0 0 13 * 5");
  if (!schedule) throw new Error("expected a schedule");

  // Friday the 6th matches by weekday; the 13th matches by date.
  expect(matchesCron(schedule, new Date("2026-03-06T00:00:00"))).toBe(true);
  expect(matchesCron(schedule, new Date("2026-03-13T00:00:00"))).toBe(true);
  expect(matchesCron(schedule, new Date("2026-03-10T00:00:00"))).toBe(false);
});

it.each([
  ["too few fields", "0 7 * *"],
  ["too many fields", "0 7 * * * *"],
  ["an empty expression", ""],
  ["a minute out of range", "60 * * * *"],
  ["an hour out of range", "* 24 * * *"],
  ["a day out of range", "* * 32 * *"],
  ["a month out of range", "* * * 13 *"],
  ["a weekday out of range", "* * * * 8"],
  ["an inverted range", "* * * * 5-1"],
  ["a zero step", "*/0 * * * *"],
  ["a non-numeric field", "abc * * * *"],
  ["a trailing comma", "1, * * * *"],
])("refuses %s", (_label, expression) => {
  expect(parseCron(expression)).toBeNull();
  expect(nextCronOccurrence(expression, at("2026-03-05T10:00:00"))).toBeNull();
});

it("terminates on a date that can never occur instead of searching forever", () => {
  expect(nextCronOccurrence("0 0 30 2 *", at("2026-03-05T10:00:00"))).toBeNull();
});

it("finds a leap day within its bounded search", () => {
  expect(iso(nextCronOccurrence("0 0 29 2 *", at("2026-03-05T10:00:00")))).toBe("2028-02-29 00:00");
});
