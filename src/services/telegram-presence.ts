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
  planning: "plan",
  critiquing: "critique",
  creating_implementation: "implementation",
  implementing: "implementation",
  remediating: "implementation",
  reviewing: "review",
  validating: "validation",
  documenting: "docs",
  final_validating: "validation",
  final_reviewing: "review",
  deploying: "deploy",
  verifying_production: "canary",
};

type PresenceStore = {
  getOwner(): { userId: string; chatId: string } | null;
  getControllerForOwner(userId: string, chatId: string): { controllerKey: string } | null;
  getPendingControllerTurn(controllerKey: string): {
    id: string;
    state: ControllerTurnState;
    awaitingInteractionId?: string | null;
  } | null;
  getActiveJob(): { id: string; state: JobState } | null;
  getWorkerLiveness(jobId: string): WorkerLiveness | null;
};

type PresenceTransport = {
  sendChatAction(chatId: string, action: "typing", signal?: AbortSignal): Promise<void>;
};

type TelegramPresenceTarget = Readonly<{
  key: string;
  chatId: string;
}>;

type PresenceOwner = NonNullable<ReturnType<PresenceStore["getOwner"]>>;

function controllerPresenceTarget(store: PresenceStore, owner: PresenceOwner): TelegramPresenceTarget | null {
  const controller = store.getControllerForOwner(owner.userId, owner.chatId);
  if (!controller) return null;
  const turn = store.getPendingControllerTurn(controller.controllerKey);
  if (!turn || !CONTROLLER_PRESENCE_STATES.has(turn.state)) return null;
  // Typing while the ball is in the owner's court is a lie: the turn is waiting
  // on their answer, not composing one.
  if (turn.awaitingInteractionId) return null;
  return { key: `controller:${turn.id}`, chatId: owner.chatId };
}

function workerPresenceTarget(store: PresenceStore, owner: PresenceOwner): TelegramPresenceTarget | null {
  const job = store.getActiveJob();
  if (!job) return null;
  const expectedWorkerKind = JOB_WORKER_KIND[job.state];
  const worker = store.getWorkerLiveness(job.id);
  if (!expectedWorkerKind || !worker || worker.jobId !== job.id) return null;
  if (worker.workerKind !== expectedWorkerKind || !WORKER_PRESENCE_STATES.has(worker.state)) return null;
  return {
    key: `job:${job.id}:${worker.workerKind}:${worker.generation}:${worker.resourceId}`,
    chatId: owner.chatId,
  };
}

export function resolveTelegramPresenceTarget(store: PresenceStore): TelegramPresenceTarget | null {
  const owner = store.getOwner();
  if (!owner) return null;
  return controllerPresenceTarget(store, owner) ?? workerPresenceTarget(store, owner);
}

export class TelegramPresenceCoordinator {
  private lastAttempt: { key: string; at: number } | null = null;

  public constructor(private readonly dependencies: {
    store: PresenceStore;
    telegram: PresenceTransport;
    warn: (message: string) => void;
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
      this.dependencies.warn(warning.slice(0, 500));
    }
    return HEARTBEAT_MS;
  }
}
