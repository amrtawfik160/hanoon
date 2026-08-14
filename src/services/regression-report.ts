/**
 * A nightly suite that alerts on every failure gets muted within a week. These
 * rules exist so a message means "something is newly broken" and nothing else:
 *
 * - failures are tracked as a *set of command names*, never a count, so a new
 *   break is distinguishable from a different command failing in place of a
 *   fixed one;
 * - a command that fails once and passes on an immediate re-run is treated as
 *   flaky and never alerted on;
 * - a failure the owner has already been told about stays quiet until it
 *   changes.
 */
export type RegressionReading = Readonly<{
  /** Commands that failed twice in a row — a real failure. */
  confirmed: readonly string[];
  /** Commands that failed once then passed — noise, recorded but never alerted. */
  flaky: readonly string[];
}>;

export type RegressionTransition =
  | Readonly<{ kind: "silent" }>
  | Readonly<{ kind: "regressed"; newlyFailing: readonly string[] }>
  | Readonly<{ kind: "recovered" }>;

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * What, if anything, the owner should hear. Compares this run's confirmed
 * failures against what they were last told, not against the previous run:
 * a failure that comes and goes without ever being reported must not produce a
 * "recovered" message for something they never heard was broken.
 */
export function regressionTransition(input: {
  confirmed: readonly string[];
  reported: readonly string[];
}): RegressionTransition {
  const confirmed = new Set(sorted(input.confirmed));
  const reported = new Set(sorted(input.reported));
  const newlyFailing = [...confirmed].filter((name) => !reported.has(name));
  if (newlyFailing.length > 0) return { kind: "regressed", newlyFailing };
  if (confirmed.size === 0 && reported.size > 0) return { kind: "recovered" };
  return { kind: "silent" };
}

export function regressionNotice(input: {
  alias: string;
  transition: RegressionTransition;
  summary: string | null;
}): string | null {
  if (input.transition.kind === "regressed") {
    const names = input.transition.newlyFailing.join(", ");
    return `Something broke on ${alias(input.alias)} without anyone asking for work — the scheduled check failed on: ${names}.\n\nWhat it reported: ${input.summary ?? "no output"}\n\nFind out what actually broke and tell the owner in a line or two: what is failing, and whether you think it came from a recent change or from outside the project. Do not start a job to fix it without asking.`;
  }
  if (input.transition.kind === "recovered") {
    return `The scheduled check passes again on ${alias(input.alias)}. Tell the owner in one line, and say what fixed it if you know.`;
  }
  return null;
}

function alias(value: string): string {
  return value.slice(0, 40);
}
