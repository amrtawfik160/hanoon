import { parseWorkerThreadTitle } from "../agent-skills/role-resolver";
import { redactError } from "../errors";
import { parseThreadInteraction } from "../controller/questions";
import type { TelegramAgentStore } from "../storage/store";

/**
 * The HTTP status behind a BB rejection, from a structured field when the error
 * carries one and from its message when it does not. Null means the shape was
 * not recognised, which is deliberately treated as retryable: guessing
 * "permanent" from an unreadable error would drop the owner's answer.
 */
function httpStatusOf(error: unknown): number | null {
  const candidate = error as { status?: unknown; statusCode?: unknown } | null;
  for (const value of [candidate?.status, candidate?.statusCode]) {
    if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  }
  const match = /\bHTTP (\d{3})\b/.exec(error instanceof Error ? error.message : String(error ?? ""));
  return match ? Number(match[1]) : null;
}

/**
 * Whether BB has refused this answer in a way no retry can change: the
 * interaction has already been resolved, or is gone.
 *
 * It matters more than it looks. Answers are delivered oldest-first, one at a
 * time, so an undeliverable one does not merely retry forever — it sits at the
 * head of the queue and every later tap the owner makes waits behind it. Left
 * alone it also spins about once a second, which is what stopped the executor
 * shutting down cleanly.
 *
 * A rate limit and a server fault are excluded: those are exactly the cases
 * where retrying is the right answer.
 */
export function isPermanentInteractionRejection(error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status === null || status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

export type WatchedThread = {
  id: string;
  title: string;
  status: string;
  parentThreadId: string | null;
  /** BB can leave a question open while the public status is idle. */
  hasPendingInteraction?: boolean;
};

export type PendingThreadInteraction = {
  id: string;
  status: string;
  payload: unknown;
};

export type ThreadNoticeThreads = {
  listWatchable(offset: number, limit: number): Promise<WatchedThread[]>;
  interactions(threadId: string): Promise<PendingThreadInteraction[]>;
  resolve(threadId: string, interactionId: string, resolution: Record<string, unknown>): Promise<void>;
};

export type ThreadNoticeServiceDependencies = {
  store: Pick<
    TelegramAgentStore,
    | "getOwner"
    | "observeThread"
    | "recordThreadInteraction"
    | "getAnsweredThreadInteraction"
    | "markThreadInteractionDelivered"
    | "discardThreadInteractions"
    | "isControllerOwnedThread"
    | "hasPendingThreadInteractionForThread"
  >;
  threads: ThreadNoticeThreads;
  clock: { now(): number };
  warn?: (message: string) => void;
};

// Only threads that are doing something can start needing something, so the
// interaction check is limited to those rather than every thread on the board.
const BLOCKABLE_STATUSES = new Set(["active", "starting", "stopping"]);
/**
 * A sweep costs one thread list plus one interaction read per working thread,
 * and the executor loop it rides on runs as often as every 250ms while an
 * answer streams. Pacing it here keeps a background courtesy from turning into
 * a flood of BB calls; a blocked thread waits seconds longer to be reported,
 * which is nothing next to how long the owner would otherwise wait.
 */
const SWEEP_INTERVAL_MS = 15_000;
const THREAD_PAGE_SIZE = 100;
const MAX_WATCHABLE_THREADS = 10_000;

/**
 * Tells the owner when a thread finishes or gets blocked, and carries their
 * answer back. The owner runs BB entirely from Telegram, so a thread waiting on
 * a click in the BB app is a thread that waits forever.
 */
export class ThreadNoticeService {
  private sweptAt: number | null = null;

  public constructor(private readonly dependencies: ThreadNoticeServiceDependencies) {}

  /**
   * Drops the pacing guard for the next sweep. BB telling us its interactions
   * changed is news the pacing was never meant to hold back: the owner is
   * looking at a card that no longer means anything.
   */
  public requestSweep(): void {
    this.sweptAt = null;
  }

  public async processDue(): Promise<boolean> {
    const owner = this.dependencies.store.getOwner();
    if (!owner) return false;
    // The owner's own tap is not a background courtesy: it goes out at once.
    let didWork = await this.deliverAnswer();
    const now = this.dependencies.clock.now();
    if (this.sweptAt !== null && now - this.sweptAt < SWEEP_INTERVAL_MS) return didWork;
    this.sweptAt = now;
    let threads: WatchedThread[];
    try {
      threads = [];
      while (threads.length < MAX_WATCHABLE_THREADS) {
        const page = await this.dependencies.threads.listWatchable(threads.length, THREAD_PAGE_SIZE);
        if (page.length > THREAD_PAGE_SIZE) throw new Error("thread list page exceeded its requested limit");
        threads.push(...page);
        if (page.length < THREAD_PAGE_SIZE) break;
      }
      if (threads.length >= MAX_WATCHABLE_THREADS) throw new Error("watchable thread scan exceeded its safe limit");
    } catch (error) {
      this.warn("Watched threads could not be listed", error);
      return didWork;
    }
    for (const thread of threads) {
      // Pipeline workers already have a job status card. Announcing their
      // internal titles as "finished" is noise the owner cannot act on.
      if (parseWorkerThreadTitle(thread.title) !== null) {
        if (BLOCKABLE_STATUSES.has(thread.status) || thread.hasPendingInteraction === true) {
          didWork = await this.checkBlocked(thread, owner.chatId) || didWork;
        }
        continue;
      }
      // A sub-agent's thread is the parent's business, not the owner's; they
      // asked to hear about the work they started, not each step inside it. A
      // thread the controller started is the exception, because the controller
      // is reachable: its block goes to the controller rather than being
      // dropped. A worker under a job stays the pipeline's business.
      const isChild = thread.parentThreadId !== null;
      if (
        isChild &&
        !this.dependencies.store.isControllerOwnedThread(thread.parentThreadId) &&
        !this.dependencies.store.hasPendingThreadInteractionForThread(thread.id)
      ) continue;
      if (!isChild) {
        if (this.dependencies.store.observeThread({
          threadId: thread.id,
          title: thread.title,
          status: thread.status,
          userId: owner.userId,
          chatId: owner.chatId,
          now,
        }) !== null) didWork = true;
      }
      if (!BLOCKABLE_STATUSES.has(thread.status)) continue;
      didWork = await this.checkBlocked(thread, owner.chatId) || didWork;
    }
    return didWork;
  }

  private async checkBlocked(thread: WatchedThread, chatId: string): Promise<boolean> {
    let pending: PendingThreadInteraction[];
    try {
      pending = await this.dependencies.threads.interactions(thread.id);
    } catch (error) {
      this.warn(`Interactions for ${thread.id} could not be read`, error);
      return false;
    }
    const open = pending.filter((interaction) => interaction.status === "pending");
    // Retiring a card the owner already answered elsewhere is work of its own:
    // an edit is now waiting to go out, and the loop should not settle for idle.
    let asked = this.dependencies.store.discardThreadInteractions(
      thread.id,
      open.map((interaction) => interaction.id),
      this.dependencies.clock.now(),
    ) > 0;
    for (const candidate of open) {
      const interaction = parseThreadInteraction(candidate.id, candidate.payload);
      if (!interaction) continue;
      if (this.dependencies.store.recordThreadInteraction({
        interactionId: candidate.id,
        threadId: thread.id,
        title: thread.title,
        interaction,
        chatId,
        now: this.dependencies.clock.now(),
        // Provenance travels with the interaction; the store decides who
        // answers, so no caller can route around it.
        parentThreadId: thread.parentThreadId,
      })) asked = true;
    }
    return asked;
  }

  private async deliverAnswer(): Promise<boolean> {
    const answered = this.dependencies.store.getAnsweredThreadInteraction();
    if (!answered) return false;
    try {
      await this.dependencies.threads.resolve(answered.threadId, answered.interactionId, answered.resolution);
    } catch (error) {
      this.warn(`Answer for ${answered.threadId} could not be delivered`, error);
      if (!isPermanentInteractionRejection(error)) return false;
      // BB will never accept this one, and it is first in a single-file queue.
      // Settling it discharges an obligation that cannot be met and, far more
      // importantly, lets every answer queued behind it through.
      return this.dependencies.store.markThreadInteractionDelivered(
        answered.interactionId,
        this.dependencies.clock.now(),
      );
    }
    return this.dependencies.store.markThreadInteractionDelivered(
      answered.interactionId,
      this.dependencies.clock.now(),
    );
  }

  private warn(message: string, error: unknown): void {
    this.dependencies.warn?.(`${message}: ${redactError(error).slice(0, 200)}`);
  }
}
