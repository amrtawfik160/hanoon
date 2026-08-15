import type { ControllerTurnState } from "../controller/models";
import { redactError } from "../errors";
import { TelegramApiError } from "../telegram/errors";

const HEARTBEAT_MS = 4_000;
const RETRY_AFTER_SAFETY_MS = 1_000;
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

export function resolveTelegramPresenceTarget(
  store: PresenceStore,
): TelegramPresenceTarget | null {
  const owner = store.getOwner();
  if (!owner) return null;
  // Background jobs can run for hours and already report durable state through
  // their own messages. Advertising them as one uninterrupted typing action
  // both misleads the owner and exhausts Telegram's per-chat flood budget.
  return controllerPresenceTarget(store, owner);
}

export class TelegramPresenceCoordinator {
  private nextAttempt: { key: string; at: number } | null = null;
  private retryAfterAt = 0;
  private inFlight: Promise<void> | null = null;

  public constructor(private readonly dependencies: {
    store: PresenceStore;
    telegram: PresenceTransport;
    warn: (message: string) => void;
  }) {}

  public reset(): void {
    this.nextAttempt = null;
    this.retryAfterAt = 0;
  }

  public async pulse(now: number, signal: AbortSignal): Promise<number | null> {
    if (!Number.isInteger(now) || now < 0) throw new TypeError("presence clock must be a non-negative integer");
    let target: TelegramPresenceTarget | null;
    try {
      target = resolveTelegramPresenceTarget(this.dependencies.store);
    } catch {
      // Presence is cosmetic. A broken lookup must not stop the executor.
      return HEARTBEAT_MS;
    }
    if (!target) {
      this.nextAttempt = null;
      return null;
    }

    if (this.inFlight !== null) return HEARTBEAT_MS;
    const targetDeadline = this.nextAttempt?.key === target.key ? this.nextAttempt.at : 0;
    const remaining = Math.max(targetDeadline, this.retryAfterAt) - now;
    if (remaining > 0) return remaining;

    this.nextAttempt = { key: target.key, at: now + HEARTBEAT_MS };
    let request: Promise<void>;
    try {
      request = this.dependencies.telegram.sendChatAction(target.chatId, "typing", signal);
    } catch (error) {
      request = Promise.reject(error);
    }

    const tracked = request.then(
      () => undefined,
      (error) => {
        // The request deliberately runs outside the executor's critical path.
        // Keep every failure contained here, including warning/reporting
        // failures, so a cosmetic Telegram call can never reject the worker.
        try {
          if (signal.aborted) return;
          if (
            error instanceof TelegramApiError &&
            error.errorCode === 429 &&
            error.retryAfterSeconds !== null &&
            Number.isFinite(error.retryAfterSeconds)
          ) {
            // Telegram's integer retry_after can land on the same server-side
            // boundary that just rejected us. Leave one second of slack so the
            // first retry does not immediately earn another 429.
            const retryAt = now + Math.max(0, Math.ceil(error.retryAfterSeconds * 1_000)) +
              RETRY_AFTER_SAFETY_MS;
            this.retryAfterAt = Math.max(this.retryAfterAt, retryAt);
          }
          const warning = `Telegram presence failed: ${redactError(error)}`;
          try {
            this.dependencies.warn(warning.slice(0, 500));
          } catch {
            // Warning delivery is cosmetic too.
          }
        } catch {
          // Presence must fail open even if error handling itself is faulty.
        }
      },
    );
    this.inFlight = tracked;
    void tracked.then(() => {
      if (this.inFlight === tracked) this.inFlight = null;
    });
    // Observe an already-settled rejection (especially a Telegram 429) before
    // returning the next deadline, without waiting on network I/O.
    await Promise.resolve();
    return Math.max(1, Math.max(this.nextAttempt.at, this.retryAfterAt) - now);
  }
}
