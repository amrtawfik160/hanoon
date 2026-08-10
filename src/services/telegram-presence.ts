import type {
  JobState,
  WorkerKind,
  WorkerLiveness,
} from "../domain/models";
import type { ControllerTurnState } from "../controller/models";
import { redactError } from "../errors";

const HEARTBEAT_MS = 4_000;
const CONTROLLER_PRESENCE_STATES = new Set<ControllerTurnState>(["dispatching", "submitted"]);
const WORKER_PRESENCE_STATES = new Set<WorkerLiveness["state"]>(["starting", "active"]);
const JOB_WORKER_KIND: Partial<Record<JobState, WorkerKind>> = {
  creating_implementation: "implementation",
  implementing: "implementation",
  remediating: "implementation",
  reviewing: "review",
  validating: "validation",
};

type PresenceStore = {
  getOwner(): { userId: string; chatId: string } | null;
  getControllerForOwner(userId: string, chatId: string): { controllerKey: string } | null;
  listControllerTurns(
    controllerKey: string,
    limit: number,
  ): readonly { id: string; state: ControllerTurnState }[];
  getActiveJob(): { id: string; state: JobState } | null;
  getWorkerLiveness(jobId: string): WorkerLiveness | null;
};

type PresenceTransport = {
  sendChatAction(chatId: string, action: "typing", signal?: AbortSignal): Promise<void>;
};

export type TelegramPresenceTarget = Readonly<{
  key: string;
  chatId: string;
}>;

export function resolveTelegramPresenceTarget(store: PresenceStore): TelegramPresenceTarget | null {
  const owner = store.getOwner();
  if (!owner) return null;

  const controller = store.getControllerForOwner(owner.userId, owner.chatId);
  if (controller) {
    const turn = store
      .listControllerTurns(controller.controllerKey, 1_000)
      .find((candidate) => CONTROLLER_PRESENCE_STATES.has(candidate.state));
    if (turn) return { key: `controller:${turn.id}`, chatId: owner.chatId };
  }

  const job = store.getActiveJob();
  if (!job) return null;
  const expectedWorkerKind = JOB_WORKER_KIND[job.state];
  if (!expectedWorkerKind) return null;
  const worker = store.getWorkerLiveness(job.id);
  if (
    !worker ||
    worker.jobId !== job.id ||
    worker.workerKind !== expectedWorkerKind ||
    !WORKER_PRESENCE_STATES.has(worker.state)
  ) return null;
  return {
    key: `job:${job.id}:${worker.workerKind}:${worker.generation}:${worker.resourceId}`,
    chatId: owner.chatId,
  };
}

export class TelegramPresenceCoordinator {
  private lastAttempt: { key: string; at: number } | null = null;

  public constructor(private readonly dependencies: {
    store: PresenceStore;
    telegram: PresenceTransport;
    warn?: (message: string) => void;
  }) {}

  public reset(): void {
    this.lastAttempt = null;
  }

  public async pulse(now: number, signal: AbortSignal): Promise<number | null> {
    if (!Number.isInteger(now) || now < 0) throw new TypeError("presence clock must be a non-negative integer");
    const target = resolveTelegramPresenceTarget(this.dependencies.store);
    if (!target) {
      this.lastAttempt = null;
      return null;
    }

    if (this.lastAttempt?.key === target.key) {
      const elapsed = Math.max(0, now - this.lastAttempt.at);
      if (elapsed < HEARTBEAT_MS) return HEARTBEAT_MS - elapsed;
    }

    this.lastAttempt = { key: target.key, at: now };
    try {
      await this.dependencies.telegram.sendChatAction(target.chatId, "typing", signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      const warning = `Telegram presence failed: ${redactError(error)}`;
      this.dependencies.warn?.(warning.slice(0, 500));
    }
    return HEARTBEAT_MS;
  }
}
