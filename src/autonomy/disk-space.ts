/**
 * Disk pressure, and what can safely be given back.
 *
 * On 2026-08-15 this machine reached 100% full. The cause was a test fixture
 * leaking one temporary directory per run since 13 August — roughly half a
 * million of them, a few hundred gigabytes in aggregate. Nothing noticed. The
 * leak itself is someone else's fix; this is the thing that should have caught
 * it, and would catch the next one, whatever it turns out to be.
 *
 * Valor has two pieces here and this borrows both: a daily read-only check that
 * warns below 10 GB free (`reflections/housekeeping/disk_space_check.py`), and
 * a sweep that ages out known-disposable state
 * (`reflections/housekeeping/disk_reclaim.py`). What it borrows above all is
 * the sweep's posture: every guard fails CLOSED. A check that cannot answer
 * keeps the candidate. Keeping a stale directory one more day costs a
 * directory; guessing wrong costs someone's data.
 *
 * Both functions here are pure. They take observations and return a verdict or
 * a plan; reading the filesystem and deleting anything belongs to the caller.
 */

const GIB = 1024 ** 3;

/**
 * Free space below which the owner is told. Valor warns at 10 GB and that
 * number has held up there: large enough that a build, a checkout, or a day of
 * logs still fits afterwards, small enough not to fire on an ordinary machine.
 */
export const DISK_LOW_FREE_BYTES = 10 * GIB;

/**
 * Below this the machine is close to refusing writes, and a warning that reads
 * the same as the routine one is a warning nobody hurries for.
 */
export const DISK_CRITICAL_FREE_BYTES = 2 * GIB;

export type DiskSpaceLevel = "ok" | "low" | "critical" | "unknown";

export type DiskSpaceVerdict = Readonly<{
  level: DiskSpaceLevel;
  freeBytes: number | null;
  totalBytes: number | null;
  /** One line, in the words the owner would use. */
  summary: string;
}>;

function gigabytes(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

function usable(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * How much room is left. Pure: the caller decides who hears about it.
 *
 * Unreadable figures give `unknown` rather than `ok`. "I could not tell" and
 * "there is plenty" are different facts, and collapsing them is how a check
 * goes blind during exactly the conditions it exists to catch.
 */
export function assessDiskSpace(input: Readonly<{
  freeBytes: number;
  totalBytes: number;
}>): DiskSpaceVerdict {
  if (!usable(input.freeBytes) || !usable(input.totalBytes) || input.totalBytes === 0) {
    return {
      level: "unknown",
      freeBytes: null,
      totalBytes: null,
      summary: "Free disk space could not be read",
    };
  }
  const free = gigabytes(input.freeBytes);
  const total = gigabytes(input.totalBytes);
  if (input.freeBytes < DISK_CRITICAL_FREE_BYTES) {
    return {
      level: "critical",
      freeBytes: input.freeBytes,
      totalBytes: input.totalBytes,
      summary: `The disk is nearly full: ${free} free of ${total}`,
    };
  }
  if (input.freeBytes < DISK_LOW_FREE_BYTES) {
    return {
      level: "low",
      freeBytes: input.freeBytes,
      totalBytes: input.totalBytes,
      summary: `Disk space is getting low: ${free} free of ${total}`,
    };
  }
  return {
    level: "ok",
    freeBytes: input.freeBytes,
    totalBytes: input.totalBytes,
    summary: `Disk space is fine: ${free} free of ${total}`,
  };
}

/**
 * Temporary directories this project is responsible for, by exact name prefix.
 *
 * An allow-list, never a deny-list. The temp directory belongs to the whole
 * machine, and a sweep that removed "everything except a keep-list" would reap
 * whatever some other program starts writing tomorrow. Something unrecognised
 * is somebody else's, and it stays.
 *
 *   - `bb-fake-plugin-host-` — one per test fixture, from
 *     `@bb/plugin-sdk/testing`. The prefix that filled the volume.
 *   - `telegram-agent-frames-` — video frames extracted by
 *     `src/controller/frames.ts`, removed on the happy path and leaked on a
 *     crash.
 *   - `hanoon-`, `eval-integrity-` — scratch directories from this repo's
 *     eval tests.
 */
export const DISPOSABLE_TEMP_PREFIXES: readonly string[] = Object.freeze([
  "bb-fake-plugin-host-",
  "telegram-agent-frames-",
  "hanoon-",
  "eval-integrity-",
]);

/**
 * How long a candidate must have sat untouched. A full day is far longer than
 * any test run or frame extraction, so nothing live is ever a candidate, and
 * short enough that a leak cannot build for a week before anything reclaims it.
 */
export const DISPOSABLE_TEMP_MIN_AGE_MS = 24 * 60 * 60_000;

export type TempEntryObservation = Readonly<{
  name: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  /** Last modification, or null when it could not be read. */
  modifiedAt: number | null;
}>;

export type ReclaimPlan = Readonly<{
  reclaim: readonly string[];
  kept: readonly Readonly<{ name: string; reason: string }>[];
}>;

function keepReason(
  entry: TempEntryObservation,
  now: number,
  minAgeMs: number,
): string | null {
  if (entry.isSymbolicLink) return "symlink";
  if (!entry.isDirectory) return "not_a_directory";
  if (!DISPOSABLE_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) return "not_ours";
  // Belt and braces: a prefix match with nothing after it is the shared parent
  // name, not one instance of it, and is never a candidate.
  if (DISPOSABLE_TEMP_PREFIXES.includes(entry.name)) return "not_ours";
  if (entry.modifiedAt === null || !Number.isFinite(entry.modifiedAt)) return "age_unknown";
  if (now - entry.modifiedAt < minAgeMs) return "too_young";
  return null;
}

/**
 * Which of the observed temp entries may go, and why each of the rest stays.
 *
 * Pure, and every rejection is named. A sweep that reports only what it removed
 * cannot be reviewed: the interesting question is always what it nearly took.
 */
export function planDiskReclaim(input: Readonly<{
  entries: readonly TempEntryObservation[];
  now: number;
  minAgeMs?: number;
}>): ReclaimPlan {
  const minAgeMs = input.minAgeMs ?? DISPOSABLE_TEMP_MIN_AGE_MS;
  const reclaim: string[] = [];
  const kept: { name: string; reason: string }[] = [];
  for (const entry of input.entries) {
    const reason = keepReason(entry, input.now, minAgeMs);
    if (reason === null) reclaim.push(entry.name);
    else kept.push({ name: entry.name, reason });
  }
  return { reclaim, kept };
}

/**
 * What the owner is told, in plain words and without the numbers they cannot
 * act on. Reclaiming is mentioned only when something was actually reclaimed,
 * because "I tidied up" with nothing behind it reads as noise.
 */
export function diskPressureNotice(
  verdict: DiskSpaceVerdict,
  reclaimed: number,
): string {
  const tidied = reclaimed > 0
    ? ` I already cleared ${reclaimed} leftover temporary ${reclaimed === 1 ? "folder" : "folders"} of my own.`
    : "";
  const urgency = verdict.level === "critical"
    ? "This one needs looking at now: things will start failing when it fills."
    : "Worth a look before it becomes a problem.";
  return `${verdict.summary}.${tidied}\n\n${urgency}\n\n` +
    "Tell the owner this in plain words: how much room is left, that you tidied up what was yours if you did, " +
    "and that something else is using the space if it is. Do not send a report if you already told them about this today.";
}
