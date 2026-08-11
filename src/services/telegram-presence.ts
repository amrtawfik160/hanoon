import type { ControllerTurnState } from "../controller/models";
import { redactError } from "../errors";
import type { ReadonlyJobLaneSnapshotProvider } from "./job-lane-runner";

const HEARTBEAT_MS = 4_000;
const CONTROLLER_PRESENCE_STATES = new Set<ControllerTurnState>(["dispatching", "submitted"]);

type PresenceStore = {
  getOwner(): { userId: string; chatId: string } | null;
  getControllerForOwner(userId: string, chatId: string): { controllerKey: string } | null;
  getPendingControllerTurn(controllerKey: string): {
    id: string;
    state: ControllerTurnState;
    awaitingInteractionId?: string | null;
  } | null;
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

function jobPresenceTarget(
  snapshots: ReadonlyJobLaneSnapshotProvider,
  owner: PresenceOwner,
): TelegramPresenceTarget | null {
  const snapshot = snapshots.snapshot();
  if (snapshot.pipelineActive + snapshot.controlActive === 0) return null;
  return { key: "jobs:aggregate", chatId: owner.chatId };
}

export function resolveTelegramPresenceTarget(
  store: PresenceStore,
  snapshots: ReadonlyJobLaneSnapshotProvider,
): TelegramPresenceTarget | null {
  const owner = store.getOwner();
  if (!owner) return null;
  return controllerPresenceTarget(store, owner) ?? jobPresenceTarget(snapshots, owner);
}

export class TelegramPresenceCoordinator {
  private lastAttempt: { key: string; at: number } | null = null;

  public constructor(private readonly dependencies: {
    store: PresenceStore;
    jobLanes: ReadonlyJobLaneSnapshotProvider;
    telegram: PresenceTransport;
    warn: (message: string) => void;
  }) {}

  public reset(): void {
    this.lastAttempt = null;
  }

  public async pulse(now: number, signal: AbortSignal): Promise<number | null> {
    if (!Number.isInteger(now) || now < 0) throw new TypeError("presence clock must be a non-negative integer");
    const target = resolveTelegramPresenceTarget(this.dependencies.store, this.dependencies.jobLanes);
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
