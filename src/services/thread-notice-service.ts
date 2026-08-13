import { redactError } from "../errors";
import { parseThreadInteraction } from "../controller/questions";
import type { TelegramAgentStore } from "../storage/store";

export type WatchedThread = {
  id: string;
  title: string;
  status: string;
  parentThreadId: string | null;
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
      // A sub-agent's thread is the parent's business, not the owner's; they
      // asked to hear about the work they started, not each step inside it.
      if (thread.parentThreadId !== null) continue;
      if (this.dependencies.store.observeThread({
        threadId: thread.id,
        title: thread.title,
        status: thread.status,
        chatId: owner.chatId,
        now,
      }) !== null) didWork = true;
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
    this.dependencies.store.discardThreadInteractions(thread.id, open.map((interaction) => interaction.id));
    let asked = false;
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
      return false;
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
