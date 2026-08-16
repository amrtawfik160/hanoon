/**
 * A self-contained 5-field cron evaluator.
 *
 * This deliberately does not use `cron-parser`. That library's internal modules
 * require each other circularly, and esbuild's lazy CommonJS initialisation
 * leaves one of them undefined at class-construction time, so every parse threw
 * `Cannot read properties of undefined (reading 'constraints')` inside the
 * built plugin while working perfectly from source. The failure was invisible
 * because the caller treats a throw as "invalid expression", so valid schedules
 * were silently rejected in production and only in production.
 *
 * A bundled agent cannot afford a dependency that behaves differently once
 * bundled, and the grammar it was being asked for is small enough to own:
 * `minute hour day-of-month month day-of-week`, each of which may be `*`, a
 * number, a range `a-b`, a list of those, or any of them stepped with `/n`.
 */

const FIELD_BOUNDS = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, // day of week, where 7 and 0 are both Sunday
] as const;

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 24 * 60;
// A cron that matches nothing real (30 February) must terminate rather than
// spin. Non-matching dates are skipped a day at a time, so this bounds a mostly
// day-stepped walk: nine years covers the widest real gap, the eight-year one
// between February 29ths across a skipped century leap year.
const MAX_SEARCH_MINUTES = 9 * 366 + 2 * MINUTES_PER_DAY;

function parseField(raw: string, index: number): Set<number> | null {
  const { min, max } = FIELD_BOUNDS[index] as { min: number; max: number };
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    if (part.length === 0) return null;
    const [spec, stepText, ...extra] = part.split("/");
    if (extra.length > 0 || spec === undefined) return null;
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText)) return null;
      step = Number(stepText);
      if (step < 1) return null;
    }
    let low: number;
    let high: number;
    if (spec === "*") {
      low = min;
      high = max;
    } else if (/^\d+$/.test(spec)) {
      low = Number(spec);
      // `5/15` means "from 5 onwards, every 15", not "exactly 5".
      high = stepText === undefined ? low : max;
    } else {
      const range = /^(\d+)-(\d+)$/.exec(spec);
      if (!range) return null;
      low = Number(range[1]);
      high = Number(range[2]);
    }
    if (low < min || high > max || low > high) return null;
    for (let value = low; value <= high; value += step) values.add(value);
  }
  if (values.size === 0) return null;
  // Sunday is 0 and 7 in different dialects; normalising here means a matcher
  // never has to care which one the owner wrote.
  if (index === 4 && values.delete(7)) values.add(0);
  return values;
}

export type CronSchedule = Readonly<{
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dayOfMonth: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dayOfWeek: ReadonlySet<number>;
  /** True when either day field is restricted, which changes how they combine. */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}>;

export function parseCron(expression: string): CronSchedule | null {
  if (typeof expression !== "string") return null;
  const atoms = expression.trim().split(/\s+/);
  if (atoms.length !== 5) return null;
  const fields = atoms.map((atom, index) => parseField(atom, index));
  if (fields.some((field) => field === null)) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as Set<number>[];
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    dayOfMonthRestricted: atoms[2] !== "*",
    dayOfWeekRestricted: atoms[4] !== "*",
  };
}

/**
 * Standard cron day semantics: when both day fields are restricted the entry
 * runs if *either* matches, not both. Restricting only one narrows normally.
 */
function matchesDay(schedule: CronSchedule, date: Date): boolean {
  const dayOfMonth = schedule.dayOfMonth.has(date.getDate());
  const dayOfWeek = schedule.dayOfWeek.has(date.getDay());
  if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) return dayOfMonth || dayOfWeek;
  if (schedule.dayOfMonthRestricted) return dayOfMonth;
  if (schedule.dayOfWeekRestricted) return dayOfWeek;
  return true;
}

export function matchesCron(schedule: CronSchedule, at: Date): boolean {
  return schedule.minute.has(at.getMinutes()) &&
    schedule.hour.has(at.getHours()) &&
    schedule.month.has(at.getMonth() + 1) &&
    matchesDay(schedule, at);
}

/**
 * The next matching local minute strictly after `after`, or null when the
 * expression is unparseable or can never match. Local time is deliberate: an
 * owner asking for 09:00 means their own morning.
 */
export function nextCronOccurrence(expression: string, after: number): number | null {
  const schedule = parseCron(expression);
  if (schedule === null || !Number.isFinite(after)) return null;
  // Epoch arithmetic only — never Date's local-component setters. During a
  // daylight-saving fall-back an ambiguous local time resolves to the offset
  // *before* the transition, so `setSeconds(0, 0)` rewinds the cursor by up to
  // an hour and returns a time that has already passed. A scheduler that is
  // handed a past due-time fires again on its very next poll, forever.
  let cursorMs = Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let step = 0; step < MAX_SEARCH_MINUTES; step += 1) {
    const candidate = new Date(cursorMs);
    if (matchesCron(schedule, candidate)) {
      return cursorMs > after ? cursorMs : null;
    }
    // A date that cannot match is skipped a day at a time rather than a minute
    // at a time, so an impossible expression such as `0 0 30 2 *` costs a few
    // thousand checks instead of two million on the executor's own thread.
    if (!matchesDay(schedule, candidate) || !schedule.month.has(candidate.getMonth() + 1)) {
      const elapsed = candidate.getHours() * 60 + candidate.getMinutes();
      cursorMs += (MINUTES_PER_DAY - elapsed) * MINUTE_MS;
      continue;
    }
    cursorMs += MINUTE_MS;
  }
  return null;
}
