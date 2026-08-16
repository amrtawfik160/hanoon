import {
  assessDiskSpace,
  diskPressureNotice,
  planDiskReclaim,
  type DiskSpaceVerdict,
  type ReclaimPlan,
  type TempEntryObservation,
} from "../autonomy/disk-space";
import { redactError } from "../errors";
import type { TelegramAgentStore } from "../storage/store";

/**
 * Daily. The categories this sweeps grow over days, and a volume goes from
 * comfortable to full over hours at worst — an hourly scan would buy nothing
 * and cost a directory walk on every executor tick.
 */
export const DISK_SCAN_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * How long after startup the first sweep waits.
 *
 * Not politeness. A temp directory holding a leak has hundreds of thousands of
 * entries in it, and walking them is the slowest thing this service does — on
 * the executor's first tick it lands squarely on top of whatever the owner
 * asked for while the plugin was down. Nothing here is urgent to the minute,
 * so it waits until the machine has caught up with itself.
 */
export const DISK_STARTUP_DELAY_MS = 5 * 60_000;

/**
 * How long a warning stays given. A day, so pressure that persists is
 * mentioned again tomorrow rather than every tick, and so a warning about a
 * problem the owner is already fixing does not follow them around.
 */
export const DISK_NOTICE_DEDUP_MS = 24 * 60 * 60_000;

/**
 * Most one pass will remove. A leak measured in hundreds of thousands is worth
 * several days of visible, bounded progress rather than one unlink storm that
 * holds the executor for hours the first time it runs.
 */
export const DISK_RECLAIM_BATCH = 500;

export type TempDirectoryAccess = {
  /** One level of the temp root. Never recursive: only the top names matter. */
  list(): Promise<readonly TempEntryObservation[]>;
  /** Remove one entry by name. Rejects rather than reporting a false success. */
  remove(name: string): Promise<void>;
  /** Free and total bytes on the volume, or null when it cannot be read. */
  usage(): Promise<{ freeBytes: number; totalBytes: number } | null>;
};

export type DiskHousekeepingDependencies = {
  store: Pick<
    TelegramAgentStore,
    "getOwner" | "getControllerForOwner" | "enqueueControllerTurn" | "claimHousekeepingNotice"
  >;
  temp: TempDirectoryAccess;
  clock: { now(): number };
  issueUpdateId(now: number): number;
  /** Whether removal is armed. Off means plan and report, delete nothing. */
  reclaimArmed(): boolean;
  warn?: (message: string) => void;
};

export type DiskHousekeepingOutcome = Readonly<{
  verdict: DiskSpaceVerdict;
  plan: ReclaimPlan;
  removed: readonly string[];
  notified: boolean;
}>;

/**
 * The safety net for a volume filling up.
 *
 * Two jobs, deliberately independent. It gives back the temporary directories
 * this project is responsible for, and it tells the owner when free space is
 * low whether or not it managed to reclaim anything — because the space is
 * usually being taken by something else, and a sweep that quietly reclaimed a
 * few megabytes of its own while the disk filled would be worse than useless.
 *
 * Every step is best-effort and independently guarded. This is the thing that
 * runs when something has already gone wrong, so it must not be able to take
 * the executor down with it.
 */
export class DiskHousekeepingService {
  private nextScanAt: number | null = null;

  public constructor(private readonly dependencies: DiskHousekeepingDependencies) {}

  public async processDue(): Promise<boolean> {
    const now = this.dependencies.clock.now();
    if (this.nextScanAt === null) {
      this.nextScanAt = now + DISK_STARTUP_DELAY_MS;
      return false;
    }
    if (now < this.nextScanAt) return false;
    this.nextScanAt = now + DISK_SCAN_INTERVAL_MS;
    try {
      const outcome = await this.sweep(now);
      return outcome.removed.length > 0 || outcome.notified;
    } catch (error) {
      this.dependencies.warn?.(`Disk housekeeping did not complete: ${redactError(error).slice(0, 200)}`);
      return false;
    }
  }

  /** Exposed for tests and for a deliberate one-off; `processDue` paces it. */
  public async sweep(now: number): Promise<DiskHousekeepingOutcome> {
    const verdict = await this.readUsage();
    const plan = await this.planReclaim(now);
    const removed = await this.applyReclaim(plan);
    const notified = this.notify(verdict, removed.length, now);
    return { verdict, plan, removed, notified };
  }

  private async readUsage(): Promise<DiskSpaceVerdict> {
    let usage: { freeBytes: number; totalBytes: number } | null = null;
    try {
      usage = await this.dependencies.temp.usage();
    } catch (error) {
      // Loud, because going blind here is not the same as finding nothing:
      // this check cannot see the volume during exactly the conditions it
      // exists to catch.
      this.dependencies.warn?.(`Disk usage could not be read: ${redactError(error).slice(0, 200)}`);
    }
    if (usage === null) {
      return assessDiskSpace({ freeBytes: Number.NaN, totalBytes: Number.NaN });
    }
    return assessDiskSpace(usage);
  }

  private async planReclaim(now: number): Promise<ReclaimPlan> {
    let entries: readonly TempEntryObservation[] = [];
    try {
      entries = await this.dependencies.temp.list();
    } catch (error) {
      this.dependencies.warn?.(`Temporary directory could not be read: ${redactError(error).slice(0, 200)}`);
      return { reclaim: [], kept: [] };
    }
    return planDiskReclaim({ entries, now });
  }

  private async applyReclaim(plan: ReclaimPlan): Promise<string[]> {
    if (plan.reclaim.length === 0) return [];
    if (!this.dependencies.reclaimArmed()) {
      this.dependencies.warn?.(
        `Disk housekeeping found ${plan.reclaim.length} reclaimable temporary directories but removal is not armed`,
      );
      return [];
    }
    const removed: string[] = [];
    // Bounded per pass: one bad name must not turn a daily sweep into an
    // hours-long unlink storm, and a leak that big is worth several days of
    // visible progress rather than one silent one.
    for (const name of plan.reclaim.slice(0, DISK_RECLAIM_BATCH)) {
      try {
        await this.dependencies.temp.remove(name);
        removed.push(name);
      } catch (error) {
        // One directory that will not go is one directory, not the sweep.
        this.dependencies.warn?.(
          `Temporary directory ${name} could not be removed: ${redactError(error).slice(0, 120)}`,
        );
      }
    }
    return removed;
  }

  private notify(verdict: DiskSpaceVerdict, reclaimed: number, now: number): boolean {
    if (verdict.level !== "low" && verdict.level !== "critical") return false;
    const owner = this.dependencies.store.getOwner();
    if (!owner) return false;
    const controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!controller) return false;
    // Claim first: the message must not be sent twice for one day of pressure,
    // and claiming is the only step that can decide that. Keyed by level, so a
    // volume that goes from low to critical still says so.
    if (!this.dependencies.store.claimHousekeepingNotice({
      key: `disk:${verdict.level}`,
      detail: verdict.summary,
      now,
      dedupMs: DISK_NOTICE_DEDUP_MS,
    })) return false;
    this.dependencies.store.enqueueControllerTurn({
      controllerKey: controller.controllerKey,
      telegramUserId: owner.userId,
      telegramChatId: owner.chatId,
      updateId: this.dependencies.issueUpdateId(now),
      inputText: diskPressureNotice(verdict, reclaimed),
      // Not the owner speaking, so this must never read as their verdict on
      // the previous answer.
      origin: "system",
      now,
    });
    return true;
  }
}
