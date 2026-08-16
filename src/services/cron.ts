/**
 * Five-field cron evaluation, self-contained on purpose.
 *
 * The plugin ships as a single bundled file, and bundling `cron-parser`'s CJS
 * build lost its internal field constraints at runtime: every expression parsed
 * fine under vitest and threw "Cannot read properties of undefined" inside the
 * loaded plugin, so every scheduled monitor silently refused to arm. Owning the
 * ~100 lines we actually need removes that whole class of failure.
 *
 * Supported per field: `*`, `a`, `a-b`, `*\/n`, `a-b/n`, `a/n`, comma lists, and
 * three-letter month and weekday names. Sunday is 0 or 7. As in standard cron,
 * when both day-of-month and day-of-week are restricted a day matches if either
 * one does.
 */

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Five years of days is well past any schedule worth arming. */
const MAX_DAYS_SCANNED = 366 * 5;

type CronFields = {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  restrictsDayOfMonth: boolean;
  restrictsDayOfWeek: boolean;
};

function namedValue(token: string, names: string[]): number | null {
  const index = names.indexOf(token.toLowerCase());
  return index === -1 ? null : index;
}

function boundedNumber(token: string, min: number, max: number, names: string[] | null): number | null {
  const named = names ? namedValue(token, names) : null;
  const value = named === null ? Number(token) : named + (names === MONTH_NAMES ? 1 : 0);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function parseField(
  spec: string,
  min: number,
  max: number,
  names: string[] | null,
): Set<number> | null {
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const [range, stepText, ...extra] = part.split("/");
    if (extra.length > 0 || range === undefined || range.length === 0) return null;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;

    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [startText, endText, ...rest] = range.split("-");
      if (rest.length > 0 || startText === undefined || endText === undefined) return null;
      const start = boundedNumber(startText, min, max, names);
      const end = boundedNumber(endText, min, max, names);
      if (start === null || end === null || start > end) return null;
      from = start;
      to = end;
    } else {
      const single = boundedNumber(range, min, max, names);
      if (single === null) return null;
      from = single;
      to = stepText === undefined ? single : max;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values.size > 0 ? values : null;
}

export function parseCron(cron: string): CronFields | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minuteSpec, hourSpec, dayOfMonthSpec, monthSpec, dayOfWeekSpec] = fields as [
    string, string, string, string, string,
  ];

  const minutes = parseField(minuteSpec, 0, 59, null);
  const hours = parseField(hourSpec, 0, 23, null);
  const daysOfMonth = parseField(dayOfMonthSpec, 1, 31, null);
  const months = parseField(monthSpec, 1, 12, MONTH_NAMES);
  const rawDaysOfWeek = parseField(dayOfWeekSpec, 0, 7, DAY_NAMES);
  if (!minutes || !hours || !daysOfMonth || !months || !rawDaysOfWeek) return null;

  // Cron accepts both 0 and 7 for Sunday; JavaScript only knows 0.
  const daysOfWeek = new Set([...rawDaysOfWeek].map((day) => (day === 7 ? 0 : day)));

  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    restrictsDayOfMonth: dayOfMonthSpec !== "*",
    restrictsDayOfWeek: dayOfWeekSpec !== "*",
  };
}

function dayMatches(fields: CronFields, date: Date): boolean {
  if (!fields.months.has(date.getMonth() + 1)) return false;
  const byDayOfMonth = fields.daysOfMonth.has(date.getDate());
  const byDayOfWeek = fields.daysOfWeek.has(date.getDay());
  if (fields.restrictsDayOfMonth && fields.restrictsDayOfWeek) return byDayOfMonth || byDayOfWeek;
  if (fields.restrictsDayOfMonth) return byDayOfMonth;
  if (fields.restrictsDayOfWeek) return byDayOfWeek;
  return true;
}

/**
 * First matching occurrence strictly after `after`, in server-local time, or
 * null when the expression is unusable.
 */
export function nextCronOccurrence(cron: string, after: number): number | null {
  const fields = parseCron(cron);
  if (fields === null || !Number.isFinite(after)) return null;

  const start = new Date(after);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const cursor = new Date(start);
  for (let day = 0; day < MAX_DAYS_SCANNED; day += 1) {
    if (dayMatches(fields, cursor)) {
      for (let hour = cursor.getHours(); hour < 24; hour += 1) {
        if (!fields.hours.has(hour)) continue;
        const fromMinute = hour === cursor.getHours() ? cursor.getMinutes() : 0;
        for (let minute = fromMinute; minute < 60; minute += 1) {
          if (!fields.minutes.has(minute)) continue;
          const occurrence = new Date(cursor);
          occurrence.setHours(hour, minute, 0, 0);
          if (occurrence.getTime() > after) return occurrence.getTime();
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(0, 0, 0, 0);
  }
  return null;
}
