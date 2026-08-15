import type {
  ControllerFailureCode,
  ControllerSteerReservation,
  ControllerSupervisorSteerAttempt,
  TelegramAgentStore,
} from "../storage/store";
import type { EffectFence } from "../services/effect-runner";
import {
  ControllerImagePreparationError,
  parseControllerInteractionResolution,
  type ControllerInteractionReference,
  type ControllerInteractionSnapshot,
  type ControllerAdapter,
  type ControllerLocation,
  type ControllerSteerReconciliation,
  type ControllerStatus,
  type ControllerProviderFailure,
} from "./bb-controller";
import {
  ControllerInteractionService,
  controllerInteractionResolutionMatches,
} from "./interaction-service";
import { parseControllerInteraction } from "./questions";
import type { ControllerThreadRecord, ControllerTurnRecord } from "./models";
import { normalizeControllerEventObservation, projectControllerStream } from "./stream";
import type { ControllerEventObservation } from "./bb-controller";
import { buildTurnContext, composeTurnInput } from "./context";
import { evaluateSupervisor } from "./supervisor";
import {
  ControllerEvidenceProjectorError,
  type ControllerEvidenceReconciler,
} from "./evidence-projector";

export type LunaControllerServiceDependencies = {
  store: TelegramAgentStore;
  adapter: ControllerAdapter;
  interactionService?: ControllerInteractionService;
  evidenceProjector: ControllerEvidenceReconciler;
  clock: { now(): number };
  warn?: (message: string) => void;
};

type InteractionReconciliationContext = Readonly<{
  turn: ControllerTurnRecord;
  controller: ControllerThreadRecord;
  fence: EffectFence;
  signal: AbortSignal;
}>;

const CONTROLLER_DRAFT_REFRESH_MS = 20_000;
const CONTROLLER_DISPATCH_BACKOFF_BASE_MS = 1_000;
const CONTROLLER_DISPATCH_BACKOFF_MAX_MS = 30_000;
/**
 * How long a submitted turn may go without producing a single BB event before
 * it is treated as wedged. Any event at all — reasoning, a tool call, output —
 * resets this, so only a thread that has genuinely stopped trips it. Silence is
 * the worst answer the owner can get, so it is bounded even when BB still
 * reports the thread as active.
 */
export const CONTROLLER_STALL_MS = 8 * 60_000;
export const CONTROLLER_BUSY_NOTICE_MS = 2 * 60_000;
// Give the submitted-turn watchdog its full window, then retire a thread whose
// unrelated busy state would otherwise strand queued owner input forever.
export const CONTROLLER_BUSY_ROLLOVER_MS = CONTROLLER_STALL_MS + 2 * 60_000;
const MAX_STEER_ATTEMPTS = 3;
const MAX_IMAGE_PREPARATION_ATTEMPTS = 3;
export const CONTROLLER_COMPLETION_RECOVERY_PROMPT =
  "Your previous turn ended without an accepted telegram_agent_respond call. Inspect telegram_agent_turn_evidence, correct any rejected finalization, and make telegram_agent_respond your final action now. Do not repeat a side effect.";
export const CONTROLLER_RECOVERY_PROMPT = CONTROLLER_COMPLETION_RECOVERY_PROMPT;

function retireReason(status: ControllerStatus): string {
  if (status === "missing") return "Thread was deleted or archived";
  if (status === "incompatible") return "Configured model moved the conversation to another provider";
  return "Provider session ended in error";
}

function fenceAt(fence: EffectFence, now: number) {
  return { ownerId: fence.ownerId, generation: fence.generation, now };
}

function controllerDispatchBackoffMs(attempts: number): number {
  const exponent = Math.min(Math.max(0, attempts), 5);
  return Math.min(CONTROLLER_DISPATCH_BACKOFF_MAX_MS, CONTROLLER_DISPATCH_BACKOFF_BASE_MS * (2 ** exponent));
}

export class LunaControllerService {
  private readonly dependencies: LunaControllerServiceDependencies;

  public constructor(dependencies: LunaControllerServiceDependencies) {
    this.dependencies = dependencies;
  }

  public async processOne(fence: EffectFence, signal: AbortSignal): Promise<boolean> {
    const now = this.dependencies.clock.now();
    const turn = this.dependencies.store.claimNextControllerTurn(fenceAt(fence, now));
    if (!turn) return false;
    const owner = this.dependencies.store.getOwner();
    if (!owner) {
      this.fail(turn, fence, "Controller owner is no longer paired");
      return true;
    }
    let controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!controller || controller.controllerKey !== turn.controllerKey) {
      this.fail(turn, fence, "Controller mapping is unavailable");
      return true;
    }

    if (controller.threadId !== null) {
      let status: ControllerStatus;
      try {
        status = await this.dependencies.adapter.status(controller.threadId, signal, turn.modelFallbackIndex);
      } catch {
        this.requeueAfterTransientRead(turn, fence, "Controller status could not be verified");
        return true;
      }
      if (status === "missing" || status === "error" || status === "incompatible") {
        if (!this.dependencies.store.resetControllerThread({
          ...fenceAt(fence, this.dependencies.clock.now()),
          controllerKey: controller.controllerKey,
          expectedThreadId: controller.threadId,
          reason: retireReason(status),
        })) {
          this.fail(turn, fence, "Controller mapping changed during recovery");
          return true;
        }
        controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
        if (!controller) {
          this.fail(turn, fence, "Controller mapping is unavailable after recovery");
          return true;
        }
      } else if (status !== "idle") {
        if (this.waitForIdle(turn, controller, fence) === "queued") {
          return true;
        }
        const refreshed = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
        if (!refreshed || refreshed.controllerKey !== turn.controllerKey || refreshed.threadId !== null) {
          this.dependencies.store.requeueControllerTurn({
            ...fenceAt(fence, this.dependencies.clock.now()),
            turnId: turn.id,
          });
          return true;
        }
        controller = refreshed;
      } else {
        let dispatchAfterSeq: number;
        try {
          dispatchAfterSeq = await this.dependencies.adapter.latestSeq(controller.threadId, signal);
        } catch {
          this.requeueAfterTransientRead(turn, fence, "Controller event baseline could not be verified");
          return true;
        }
        if (!Number.isSafeInteger(dispatchAfterSeq) || dispatchAfterSeq < 0) {
          this.requeueAfterTransientRead(turn, fence, "Controller event baseline was invalid");
          return true;
        }
        const input = this.composeInput(turn, { includeDigest: false });
        if (!this.providerMutationAllowed(turn, controller, fence, signal)) return true;
        if (!this.dependencies.store.prepareControllerDispatch({
          ...fenceAt(fence, this.dependencies.clock.now()),
          turnId: turn.id,
          kind: "send",
          expectedThreadId: controller.threadId,
          dispatchAfterSeq,
        })) return true;
        try {
          if (turn.image) {
            await this.dependencies.adapter.send(controller.threadId, input, signal, turn.image, turn.modelFallbackIndex);
          } else {
            await this.dependencies.adapter.send(controller.threadId, input, signal, null, turn.modelFallbackIndex);
          }
        } catch (error) {
          if (this.handleImagePreparationError(error, turn, fence, signal)) return true;
          if (!this.dependencies.store.markControllerDeliveryUnknown({
            ...fenceAt(fence, this.dependencies.clock.now()),
            turnId: turn.id,
          })) return true;
          const unknown = this.dependencies.store.getControllerTurn(turn.id);
          return unknown?.state === "dispatching" && unknown.deliveryState === "delivery_unknown"
            ? this.reconcileUnknownDelivery(unknown, controller, fence, signal)
            : true;
        }
        if (!this.dependencies.store.markControllerTurnSubmitted({
          ...fenceAt(fence, this.dependencies.clock.now()),
          turnId: turn.id,
          dispatchAfterSeq,
        })) {
          throw new Error("Controller turn changed before send completion was recorded");
        }
        return true;
      }
    }

    if (controller.threadId === null) {
      const location = await this.spawnOrAdopt(turn, controller, fence, signal);
      if (!location) return true;
      if (!this.dependencies.store.markControllerSpawned({
        ...fenceAt(fence, this.dependencies.clock.now()),
        turnId: turn.id,
        ...location,
      })) {
        throw new Error("Controller mapping changed before spawn completion was recorded");
      }
      if (!this.dependencies.store.markControllerTurnSubmitted({
        ...fenceAt(fence, this.dependencies.clock.now()),
        turnId: turn.id,
      })) {
        throw new Error("Controller turn changed before spawn submission was recorded");
      }
    }
    return true;
  }

  /** True while an answer is still arriving, so the executor can poll at the
   *  rate the Telegram draft is redrawn rather than at its ordinary cadence. */
  public isStreaming(): boolean {
    const owner = this.dependencies.store.getOwner();
    if (!owner) return false;
    const controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!controller) return false;
    return this.dependencies.store.getPendingControllerTurn(controller.controllerKey)?.state === "submitted";
  }

  /**
   * Milliseconds until the in-flight turn runs out of time, or null when none
   * is running. A wedged turn produces no events, so an executor that only woke
   * for provider activity never reached the stall check and left the turn
   * sitting well past its deadline. The deadline is a fixed moment: the loop
   * sleeps up to it rather than past it.
   */
  public nextStallDeadlineMs(now: number): number | null {
    const owner = this.dependencies.store.getOwner();
    if (!owner) return null;
    const controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!controller?.threadId) return null;
    const pending = this.dependencies.store.getPendingControllerTurn(controller.controllerKey);
    if (pending?.state !== "submitted" || pending.awaitingInteractionId !== null) return null;
    return Math.max(0, pending.updatedAt + CONTROLLER_STALL_MS - now);
  }

  public async reconcile(fence: EffectFence, signal: AbortSignal): Promise<boolean> {
    const recoveredDispatch = this.dependencies.store.failStaleControllerDispatches(
      fenceAt(fence, this.dependencies.clock.now()),
    );
    const owner = this.dependencies.store.getOwner();
    if (!owner) return recoveredDispatch;
    let controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!controller) return recoveredDispatch;
    let pending = this.dependencies.store.getPendingControllerTurn(controller.controllerKey);
    if (pending?.state === "dispatching" && pending.deliveryState === "intent") {
      this.dependencies.store.markControllerDeliveryUnknown({
        ...fenceAt(fence, this.dependencies.clock.now()),
        turnId: pending.id,
      });
      pending = this.dependencies.store.getControllerTurn(pending.id);
    }
    if (pending?.state === "dispatching" && pending.deliveryState === "delivery_unknown") {
      if (pending.nextDispatchAt > this.dependencies.clock.now()) return recoveredDispatch;
      return this.reconcileUnknownDelivery(pending, controller, fence, signal);
    }
    if (recoveredDispatch) return true;
    if (!controller.threadId) return false;
    const submitted = pending?.state === "submitted" ? pending : null;
    if (!submitted) {
      let status: ControllerStatus;
      try {
        status = await this.dependencies.adapter.status(controller.threadId, signal);
      } catch {
        return false;
      }
      if (status !== "missing" && status !== "error" && status !== "incompatible") return false;
      return this.dependencies.store.resetControllerThread({
        ...fenceAt(fence, this.dependencies.clock.now()),
        controllerKey: controller.controllerKey,
        expectedThreadId: controller.threadId,
        reason: retireReason(status),
      });
    }

    if (!this.dependencies.store.adoptSubmittedControllerTurnFence({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: submitted.id,
    })) return true;
    let turn = this.dependencies.store.getControllerTurn(submitted.id);
    controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!turn || turn.state !== "submitted" || !controller?.threadId) return true;

    if (await this.reconcileReservedSteer(controller.controllerKey, fence, signal)) return true;
    if (await this.reconcilePendingSupervisorSteer(submitted.id, fence, signal)) return true;
    turn = this.dependencies.store.getControllerTurn(submitted.id);
    controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!turn || turn.state !== "submitted" || !controller?.threadId) return true;

    if (await this.deliverAnsweredInteraction(turn, controller, fence, signal)) return true;

    const acceptedBeforeProgress = this.dependencies.store.getAcceptedControllerFinalization(turn.id);
    if (acceptedBeforeProgress) {
      if (this.hasPendingInteraction(controller.controllerKey, turn.id)) return true;
      const completed = await this.completeAccepted(turn, controller, fence, false);
      const completedTurn = this.dependencies.store.getControllerTurn(turn.id);
      if (completedTurn?.state === "completed" && controller.threadId) {
        let statusAfterAcceptance: ControllerStatus | null = null;
        try {
          statusAfterAcceptance = await this.dependencies.adapter.status(controller.threadId, signal, turn.modelFallbackIndex);
        } catch {
          // Delivery is already durable; a status read is only best-effort cleanup.
        }
        if (
          statusAfterAcceptance === "missing" ||
          statusAfterAcceptance === "error" ||
          statusAfterAcceptance === "incompatible"
        ) {
          this.dependencies.store.resetControllerThread({
            ...fenceAt(fence, this.dependencies.clock.now()),
            controllerKey: controller.controllerKey,
            expectedThreadId: controller.threadId,
            reason: retireReason(statusAfterAcceptance),
          });
        }
      }
      return completed;
    }
    if (turn.acceptedFinalizationId !== null) {
      this.failAndRetire(
        turn,
        controller,
        fence,
        "Accepted controller finalization failed semantic revalidation",
      );
      return true;
    }
    if (
      turn.awaitingInteractionId === null &&
      this.dependencies.clock.now() - turn.updatedAt >= CONTROLLER_STALL_MS
    ) {
      return this.requestCompletionContinuation(turn, controller, fence, signal, "stalled");
    }

    const evidenceOutcome = await this.reconcileEvidence(controller, turn, fence, signal);
    if (evidenceOutcome === "retry") return this.handleEvidenceRetry(turn, controller, fence, signal);
    if (evidenceOutcome === "stale") return true;
    if (evidenceOutcome === "fatal") {
      this.failAndRetire(turn, controller, fence, "Controller evidence could not be reconciled safely");
      return true;
    }
    turn = this.dependencies.store.getControllerTurn(turn.id);
    controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!turn || turn.state !== "submitted" || !controller?.threadId) return true;

    let status: ControllerStatus;
    try {
      status = await this.dependencies.adapter.status(controller.threadId, signal, turn.modelFallbackIndex);
    } catch {
      return false;
    }
    let observation: ControllerEventObservation | null = null;
    try {
      const rawObservation = await this.dependencies.adapter.events(
        controller.threadId,
        turn.bbEventSeq,
        signal,
      );
      observation = {
        ...normalizeControllerEventObservation(rawObservation),
        interactionReferences: rawObservation.interactionReferences ?? [],
      };
      if (!Number.isSafeInteger(observation.latestSeq)) return true;
    } catch {
      observation = null;
    }
    if (observation === null) return false;
    if (!await this.reconcileInteractionReferences(
      observation.interactionReferences ?? [],
      { turn, controller, fence, signal },
    )) return true;
    const projected = projectControllerStream(observation, {
      cursor: turn.bbEventSeq,
      text: turn.streamText,
      phase: turn.streamPhase,
    });
    if (projected.cursor >= turn.bbEventSeq) {
      this.dependencies.store.updateControllerStream({
        ...fenceAt(fence, this.dependencies.clock.now()),
        turnId: turn.id,
        cursor: projected.cursor,
        phase: projected.phase,
        toolCalls: observation.toolCalls,
        commandFailures: observation.commandFailures,
        totalTokens: observation.totalTokens,
        inputAccepted: observation.inputAccepted || observation.failure?.inputAccepted === true,
        assistantDraft: observation.assistantDraft,
      });
    }
    const refreshedAt = this.dependencies.clock.now();
    turn = this.dependencies.store.getControllerTurn(turn.id);
    controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!turn || turn.state !== "submitted" || !controller?.threadId) return true;
    if (await this.deliverAnsweredInteraction(turn, controller, fence, signal)) return true;
    if (this.hasPendingInteraction(controller.controllerKey, turn.id)) return true;

    const accepted = this.dependencies.store.getAcceptedControllerFinalization(turn.id);
    const parked = turn.awaitingInteractionId;
    if (parked !== null) return true;
    if (turn.acceptedFinalizationId !== null && accepted === null) {
      this.failAndRetire(
        turn,
        controller,
        fence,
        "Accepted controller finalization failed semantic revalidation",
      );
      return true;
    }
    if (status === "active" || status === "starting" || status === "stopping") {
      if (!accepted) {
        this.dependencies.store.refreshControllerDraft({
          ...fenceAt(fence, refreshedAt),
          turnId: turn.id,
          sentBefore: Math.max(0, refreshedAt - CONTROLLER_DRAFT_REFRESH_MS),
        });
        // Anything the owner says while an answer is being written belongs to that
        // answer. Holding it back until the turn ends is how a correction arrives
        // too late to correct anything.
        const waiting = parked === null
          ? this.dependencies.store.getQueuedControllerTurn(controller.controllerKey)
          : null;
        if (waiting && !waiting.image && waiting.recoverySourceTurnId === null &&
            waiting.retryCount < MAX_STEER_ATTEMPTS) {
          if (signal.aborted || !this.dependencies.store.reserveControllerSteer({
            ...fenceAt(fence, this.dependencies.clock.now()),
            runningTurnId: turn.id,
            waitingTurnId: waiting.id,
            controllerKey: turn.controllerKey,
            expectedThreadId: controller.threadId,
          })) return true;
          let outcome: ControllerSteerReconciliation = "applied";
          try {
            await this.dependencies.adapter.steer(controller.threadId, waiting.inputText, signal);
          } catch {
            // A thrown call may have reached BB; reconcile before choosing any retry.
            outcome = await this.reconcileProviderSteer({
              threadId: controller.threadId,
              inputText: waiting.inputText,
              idempotencyKey: `controller-steer:${turn.id}:${waiting.id}`,
            }, signal);
          }
          const settled = this.dependencies.store.settleControllerSteer({
            ...fenceAt(fence, this.dependencies.clock.now()),
            runningTurnId: turn.id,
            waitingTurnId: waiting.id,
            controllerKey: turn.controllerKey,
            outcome,
          });
          if (settled === "stale") return true;
          return true;
        }
      }
      // The owner's own words outrank a budget nudge, so this runs only once
      // nothing of theirs is waiting. A turn parked on a question is waiting on
      // a person, and no budget should fire against their thinking time.
      if (!accepted && parked === null && await this.superviseBudget(turn.id, controller, fence, signal)) {
        return true;
      }
      if (parked === null && refreshedAt - turn.updatedAt >= CONTROLLER_STALL_MS) {
        return this.requestCompletionContinuation(turn, controller, fence, signal, "stalled");
      }
      return true;
    }
    const statusFailure = this.failureForStatus(status, turn.inputAccepted);
    const failure = status === "missing" || status === "incompatible"
      ? statusFailure
      : observation.failure ?? statusFailure;
    const providerError = failure !== null;
    if (accepted && (providerError || status === "idle" || observation.completed)) {
      return await this.completeAccepted(turn, controller, fence, providerError);
    }
    if (failure?.willRetry) {
      this.warnFailure("provider_retry", turn, controller, failure);
      return true;
    }
    if (failure) {
      this.warnFailure("provider_failure", turn, controller, failure);
      if (failure.code === "oauth_expired" || failure.code === "provider_rejected") {
        this.failAndRetire(turn, controller, fence, `Controller permanent failure: ${failure.code}`, failure.code);
        return true;
      }
      const inputAccepted = turn.inputAccepted || observation.inputAccepted || failure.inputAccepted;
      if (turn.completionContinuations >= 2) {
        this.failAndRetire(turn, controller, fence, `Controller recovery failed: ${failure.code}`, "recovery_exhausted");
        return true;
      }
      const profileCount = this.configuredProfileCount();
      if (!inputAccepted && turn.modelFallbackIndex + 1 < profileCount) {
        this.dependencies.store.retryUnacceptedControllerTurn({
          ...fenceAt(fence, this.dependencies.clock.now()),
          turnId: turn.id,
          controllerKey: controller.controllerKey,
          expectedThreadId: controller.threadId,
          nextFallbackIndex: turn.modelFallbackIndex + 1,
        });
        return true;
      }
      if (inputAccepted) {
        return this.beginFreshRecovery(turn, controller, fence, failure.code);
      }
      this.failAndRetire(turn, controller, fence, `Controller profiles exhausted: ${failure.code}`, "recovery_exhausted");
      return true;
    }
    if (status === "idle" || observation.completed) return this.requestCompletionContinuation(turn, controller, fence, signal);
    return true;
  }

  private async reconcileReservedSteer(
    controllerKey: string,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<boolean> {
    const reservation = this.dependencies.store.getControllerSteerReservation(controllerKey);
    if (!reservation) return false;
    const outcome = await this.reconcileProviderSteer(reservation, signal);
    const settled = this.dependencies.store.settleControllerSteer({
      ...fenceAt(fence, this.dependencies.clock.now()),
      runningTurnId: reservation.runningTurnId,
      waitingTurnId: reservation.waitingTurnId,
      controllerKey: reservation.controllerKey,
      outcome,
    });
    return settled === "settled" || settled === "stale";
  }

  private async reconcilePendingSupervisorSteer(
    turnId: string,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<boolean> {
    const attempt = this.dependencies.store.getPendingControllerSupervisorSteer(turnId);
    if (!attempt) return false;
    const providerOutcome = await this.reconcileProviderSteer(attempt, signal);
    const outcome = providerOutcome === "applied" ? "applied" : "unknown";
    const settled = this.dependencies.store.settleControllerSupervisorSteer({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: attempt.turnId,
      controllerKey: attempt.controllerKey,
      reason: attempt.reason,
      outcome,
    });
    return settled === "settled" || settled === "stale";
  }

  private async reconcileProviderSteer(
    reservation: Pick<ControllerSteerReservation | ControllerSupervisorSteerAttempt, "threadId" | "inputText" | "idempotencyKey">,
    signal: AbortSignal,
  ): Promise<ControllerSteerReconciliation> {
    const reconcile = this.dependencies.adapter.reconcileSteer;
    if (!reconcile || signal.aborted || reservation.threadId.length === 0 || reservation.inputText === null) {
      return "unknown";
    }
    try {
      const outcome = await reconcile({
        threadId: reservation.threadId,
        text: reservation.inputText,
        idempotencyKey: reservation.idempotencyKey,
        signal,
      });
      return outcome === "applied" || outcome === "not_applied" || outcome === "unknown"
        ? outcome
        : "unknown";
    } catch {
      // A transport or provider error cannot distinguish delivery from refusal.
      // The caller must settle it as unknown so a successor never replays it.
      return "unknown";
    }
  }

  private async reconcileUnknownDelivery(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return true;
    if (!this.providerMutationAllowed(turn, controller, fence, signal)) {
      return this.recordUnknownDeliveryPending(turn, fence, signal);
    }
    return turn.dispatchKind === "spawn"
      ? this.reconcileUnknownSpawn(turn, controller, fence, signal)
      : this.reconcileUnknownSend(turn, controller, fence, signal);
  }

  private async reconcileUnknownSpawn(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (controller.threadId !== null && controller.capabilitySubjectId === turn.id) {
      if (!this.dependencies.store.markControllerTurnSubmitted({
        ...fenceAt(fence, this.dependencies.clock.now()),
        turnId: turn.id,
      })) return this.recordUnknownDeliveryPending(turn, fence, signal);
      return true;
    }
    if (
      turn.dispatchCorrelationId === null ||
      controller.threadId !== null ||
      controller.pendingSpawnToken !== turn.dispatchCorrelationId
    ) return this.recordUnknownDeliveryPending(turn, fence, signal);
    let candidate: ControllerLocation | null;
    try {
      candidate = await this.dependencies.adapter.findSpawnCandidate(
        controller.controllerKey,
        turn.dispatchCorrelationId,
        signal,
        turn.modelFallbackIndex,
      );
    } catch {
      return this.recordUnknownDeliveryPending(turn, fence, signal);
    }
    if (!candidate || candidate.spawnToken !== turn.dispatchCorrelationId) {
      return this.recordUnknownDeliveryPending(turn, fence, signal);
    }
    if (!this.dependencies.store.reserveControllerSpawn({
      controllerKey: controller.controllerKey,
      turnId: turn.id,
      projectId: candidate.projectId,
      hostId: candidate.hostId,
      now: this.dependencies.clock.now(),
    })) return this.recordUnknownDeliveryPending(turn, fence, signal);
    if (!this.dependencies.store.markControllerSpawned({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      ...candidate,
    })) return this.recordUnknownDeliveryPending(turn, fence, signal);
    if (!this.dependencies.store.markControllerTurnSubmitted({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
    })) return this.recordUnknownDeliveryPending(turn, fence, signal);
    return true;
  }

  private async reconcileUnknownSend(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (
      turn.dispatchKind !== "send" || turn.dispatchCorrelationId !== `controller-dispatch:${turn.id}` ||
      controller.threadId === null
    ) return this.recordUnknownDeliveryPending(turn, fence, signal);
    let observation: ControllerEventObservation;
    try {
      observation = normalizeControllerEventObservation(await this.dependencies.adapter.events(
        controller.threadId,
        turn.dispatchAfterSeq,
        signal,
      ));
    } catch {
      return this.recordUnknownDeliveryPending(turn, fence, signal);
    }
    if (!Number.isSafeInteger(observation.latestSeq) || observation.latestSeq < turn.dispatchAfterSeq) {
      return this.recordUnknownDeliveryPending(turn, fence, signal);
    }
    const applied = observation.inputAccepted || observation.assistantOutputObserved ||
      observation.toolActivityObserved || observation.completed || observation.failure?.inputAccepted === true;
    if (!applied) return this.recordUnknownDeliveryPending(turn, fence, signal);
    if (!this.dependencies.store.markControllerTurnSubmitted({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      dispatchAfterSeq: turn.dispatchAfterSeq,
    })) return this.recordUnknownDeliveryPending(turn, fence, signal);
    return true;
  }

  private recordUnknownDeliveryPending(
    turn: ControllerTurnRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): boolean {
    if (signal.aborted) return true;
    this.dependencies.store.recordControllerDeliveryReconciliationPending({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      retryAfterMs: controllerDispatchBackoffMs(turn.deliveryReconcileAttempts),
    });
    return true;
  }

  private async reconcileEvidence(
    controller: ControllerThreadRecord,
    turn: ControllerTurnRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<"ready" | "retry" | "stale" | "fatal"> {
    let highWater: number;
    try {
      highWater = await this.dependencies.adapter.latestSeq(controller.threadId!, signal);
    } catch {
      return "retry";
    }
    if (!Number.isSafeInteger(highWater) || highWater < 0) return "fatal";
    if (highWater < turn.evidenceEventSeq) return "stale";
    if (!this.dependencies.evidenceProjector) return "fatal";
    try {
      const reconciliation = await this.dependencies.evidenceProjector.reconcile(
        controller,
        turn,
        fenceAt(fence, this.dependencies.clock.now()),
        signal,
        highWater,
      );
      if (!reconciliation) return "fatal";
      if (reconciliation.outcome === "stale") return "stale";
      if (reconciliation.outcome === "limit_exceeded") {
        return "fatal";
      }
      if (reconciliation.reconciliationIncomplete !== null) return "retry";
      if (reconciliation.targetSeq !== highWater) return "stale";
      return "ready";
    } catch (error) {
      if (signal.aborted) return "stale";
      if (error instanceof ControllerEvidenceProjectorError) {
        return error.code === "cursor_conflict" ? "stale" : "fatal";
      }
      return "retry";
    }
  }

  private async handleEvidenceRetry(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.hasPendingInteraction(controller.controllerKey, turn.id) ||
        this.dependencies.store.getAnsweredControllerInteraction(controller.controllerKey)?.turnId === turn.id) return true;
    let status: ControllerStatus;
    try {
      status = await this.dependencies.adapter.status(controller.threadId!, signal, turn.modelFallbackIndex);
    } catch {
      return false;
    }
    if (status === "missing" || status === "incompatible") {
      this.failAndRetire(
        turn,
        controller,
        fence,
        status === "missing" ? "Controller conversation became unavailable" : "Controller conversation uses an incompatible provider",
      );
      return true;
    }
    const current = this.dependencies.store.getControllerTurn(turn.id);
    if (current?.state === "submitted" && current.awaitingInteractionId === null &&
        this.dependencies.clock.now() - current.updatedAt >= CONTROLLER_STALL_MS) {
      return this.requestCompletionContinuation(current, controller, fence, signal, "stalled");
    }
    return false;
  }

  private async deliverOwnerAnswer(
    ownerAnswer: NonNullable<ReturnType<TelegramAgentStore["getAnsweredControllerInteraction"]>>,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<void> {
    if (!controller.threadId) return;
    const turn = this.dependencies.store.getControllerTurn(ownerAnswer.turnId);
    if (!turn || turn.state !== "submitted" ||
        !this.interactionDeliveryAllowed(ownerAnswer, fence, signal)) return;
    try {
      if (this.dependencies.adapter.resolveInteraction) {
        const resolution = parseControllerInteractionResolution(ownerAnswer.resolution);
        await this.dependencies.adapter.resolveInteraction(
          controller.threadId,
          ownerAnswer.interactionId,
          resolution,
          signal,
        );
      } else if (ownerAnswer.interaction.kind === "user_question") {
        await this.dependencies.adapter.answerQuestion(
          controller.threadId,
          ownerAnswer.interactionId,
          ownerAnswer.answers,
          signal,
        );
      } else {
        return;
      }
    } catch {
      // Provider failures are ambiguous; retaining the durable answer lets the
      // executor retry after an authoritative read on the next pass.
      return;
    }
    if (!this.interactionDeliveryAllowed(ownerAnswer, fence, signal)) return;
    const getInteraction = this.dependencies.adapter.getInteraction;
    if (!getInteraction) return;
    let observed: ControllerInteractionSnapshot;
    try {
      observed = await getInteraction.call(
        this.dependencies.adapter,
        controller.threadId,
        ownerAnswer.interactionId,
        signal,
      );
    } catch {
      return;
    }
    if (observed.id !== ownerAnswer.interactionId || observed.threadId !== ownerAnswer.bbThreadId ||
        observed.status !== "resolved" ||
        !controllerInteractionResolutionMatches(observed.resolution, ownerAnswer.resolution)) return;
    this.dependencies.store.markControllerInteractionDelivered({
      ...fenceAt(fence, this.dependencies.clock.now()),
      interactionId: ownerAnswer.interactionId,
      turnId: ownerAnswer.turnId,
      bbThreadId: ownerAnswer.bbThreadId,
    });
  }

  private interactionDeliveryAllowed(
    ownerAnswer: NonNullable<ReturnType<TelegramAgentStore["getAnsweredControllerInteraction"]>>,
    fence: EffectFence,
    signal: AbortSignal,
  ): boolean {
    return !signal.aborted && this.dependencies.store.isControllerInteractionDeliveryFenceCurrent({
      ...fenceAt(fence, this.dependencies.clock.now()),
      interactionId: ownerAnswer.interactionId,
      turnId: ownerAnswer.turnId,
      controllerKey: ownerAnswer.controllerKey,
      bbThreadId: ownerAnswer.bbThreadId,
      controllerGenerationId: ownerAnswer.controllerGenerationId,
    });
  }

  private hasPendingInteraction(controllerKey: string, turnId: string): boolean {
    return this.dependencies.store.getPendingControllerInteraction(controllerKey)?.turnId === turnId;
  }

  private async deliverAnsweredInteraction(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<boolean> {
    const answered = this.dependencies.store.getAnsweredControllerInteraction(controller.controllerKey);
    if (!answered || answered.turnId !== turn.id) return false;
    if (this.dependencies.interactionService) {
      await this.dependencies.interactionService.deliverAnswered(
        controller.controllerKey,
        fenceAt(fence, this.dependencies.clock.now()),
        signal,
      );
      return true;
    }
    await this.deliverOwnerAnswer(answered, controller, fence, signal);
    return true;
  }

  private async reconcileInteractionReferences(
    references: readonly ControllerInteractionReference[],
    context: InteractionReconciliationContext,
  ): Promise<boolean> {
    for (const reference of references) {
      if (!await this.reconcileInteractionReference(reference, context)) return false;
    }
    return true;
  }

  private async reconcileInteractionReference(
    reference: ControllerInteractionReference,
    context: InteractionReconciliationContext,
  ): Promise<boolean> {
    const generationBefore = this.currentControllerGeneration(
      context.controller.controllerKey,
      context.controller.threadId!,
    );
    if (!generationBefore) return false;
    const snapshot = await this.readInteraction(reference, context);
    if (!snapshot) return false;
    const generationAfter = this.currentControllerGeneration(
      context.controller.controllerKey,
      context.controller.threadId!,
    );
    if (!generationAfter || generationAfter.id !== generationBefore.id ||
        snapshot.id !== reference.interactionId || snapshot.threadId !== context.controller.threadId) return false;
    if (reference.status === "interrupted") return false;
    if (reference.status === "resolved") return this.settleInteractionReference(reference, snapshot, context);
    if (snapshot.status === "resolved" || snapshot.status === "interrupted") {
      return this.settleInteractionReference(reference, snapshot, context);
    }
    if (snapshot.status !== "pending") return false;
    const interaction = parseControllerInteraction(snapshot.id, snapshot.payload);
    if (!interaction || (interaction.kind !== reference.kind && interaction.kind !== "unsupported")) return false;
    const recordOutcome = this.dependencies.store.recordControllerInteraction({
      ...fenceAt(context.fence, this.dependencies.clock.now()),
      turnId: context.turn.id,
      controllerKey: context.controller.controllerKey,
      bbThreadId: context.controller.threadId!,
      controllerGenerationId: generationAfter.id,
      interaction,
    });
    return recordOutcome === "recorded" || recordOutcome === "replay";
  }

  private async readInteraction(
    reference: ControllerInteractionReference,
    context: InteractionReconciliationContext,
  ): Promise<ControllerInteractionSnapshot | null> {
    const getInteraction = this.dependencies.adapter.getInteraction;
    if (!getInteraction || !context.controller.threadId) return null;
    try {
      return await getInteraction.call(
        this.dependencies.adapter,
        context.controller.threadId,
        reference.interactionId,
        context.signal,
      );
    } catch {
      // A failed external read cannot prove the interaction disappeared or resolved.
      return null;
    }
  }

  private async settleInteractionReference(
    reference: ControllerInteractionReference,
    snapshot: ControllerInteractionSnapshot,
    context: InteractionReconciliationContext,
  ): Promise<boolean> {
    if (reference.status !== "resolved" || snapshot.status !== "resolved") return false;
    const answered = this.dependencies.store.getAnsweredControllerInteraction(context.controller.controllerKey);
    if (!answered) {
      const pending = this.dependencies.store.getPendingControllerInteraction(context.controller.controllerKey);
      // A previously proven delivery removes the row. A still-pending row is
      // different: BB resolving it without the durable answer is not proof.
      return pending === null || pending.interactionId !== reference.interactionId;
    }
    if (answered.turnId !== context.turn.id ||
        answered.interactionId !== reference.interactionId ||
        answered.bbThreadId !== context.controller.threadId ||
        !controllerInteractionResolutionMatches(snapshot.resolution, answered.resolution)) return false;
    const settled = this.dependencies.store.markControllerInteractionDelivered({
      ...fenceAt(context.fence, this.dependencies.clock.now()),
      interactionId: reference.interactionId,
      turnId: context.turn.id,
      bbThreadId: context.controller.threadId!,
    });
    return settled || this.dependencies.store.isExecutorLeaseCurrent(
      context.fence.ownerId,
      context.fence.generation,
      this.dependencies.clock.now(),
    );
  }

  private currentControllerGeneration(controllerKey: string, threadId: string): { id: string; threadId: string } | null {
    const generations = this.dependencies.store.listControllerGenerations(controllerKey, 100);
    const open = generations.filter((generation) => generation.endedAt === null);
    if (open.length !== 1 || open[0]?.threadId !== threadId) return null;
    return { id: open[0].id, threadId: open[0].threadId };
  }

  private async completeAccepted(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    providerError: boolean,
  ): Promise<boolean> {
    const accepted = this.dependencies.store.getAcceptedControllerFinalization(turn.id);
    if (!accepted) return true;
    const bbHighWaterSeq = accepted.bbEventHighWaterSeq ?? turn.evidenceEventSeq;
    const outcome = this.dependencies.store.completeControllerTurnFromFinalization({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      controllerKey: turn.controllerKey,
      bbHighWaterSeq,
    });
    if (outcome === "completed") {
      if (providerError && controller.threadId) {
        this.dependencies.store.resetControllerThread({
          ...fenceAt(fence, this.dependencies.clock.now()),
          controllerKey: controller.controllerKey,
          expectedThreadId: controller.threadId,
          reason: "Accepted answer persisted before provider error",
        });
      }
      return true;
    }
    // The accepted finalization is durable. A later evidence row, provider
    // error, or stale race must not retire the answer it already sealed.
    return true;
  }

  private configuredProfileCount(): number {
    const count = this.dependencies.adapter.configuredProfileCount?.() ?? 1;
    if (!Number.isInteger(count) || count < 1 || count > 3) {
      throw new Error("Controller adapter returned an invalid execution profile count");
    }
    return count;
  }

  private failureForStatus(status: ControllerStatus, inputAccepted: boolean): ControllerProviderFailure | null {
    if (status === "missing") {
      return { code: "host_disconnected", retryable: true, willRetry: false, inputAccepted };
    }
    if (status === "incompatible") {
      return { code: "provider_rejected", retryable: false, willRetry: false, inputAccepted };
    }
    if (status === "error") {
      return { code: "unknown", retryable: true, willRetry: false, inputAccepted };
    }
    return null;
  }

  private warnFailure(
    stage: string,
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    failure: ControllerProviderFailure,
  ): void {
    this.dependencies.warn?.(JSON.stringify({
      event: "controller_failure",
      stage,
      turnId: turn.id,
      controllerThreadId: controller.threadId,
      code: failure.code,
      retryable: failure.retryable,
      willRetry: failure.willRetry,
      inputAccepted: failure.inputAccepted,
      executionProfileAttempt: turn.modelFallbackIndex + 1,
      recoveryAttempt: turn.completionContinuations >= 2 ? 1 : 0,
    }));
  }

  private async beginFreshRecovery(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    reason: string,
    terminalFailureCode: ControllerFailureCode = "recovery_exhausted",
  ): Promise<boolean> {
    if (!controller.threadId) return true;
    const profileCount = this.configuredProfileCount();
    const nextFallbackIndex = profileCount === 1
      ? 0
      : (turn.modelFallbackIndex + 1) % profileCount;
    const outcome = this.dependencies.store.beginControllerRecovery({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      controllerKey: turn.controllerKey,
      expectedThreadId: controller.threadId,
      error: `Controller recovery: ${reason}`,
      nextFallbackIndex,
    });
    if (outcome === "accepted_won") return this.completeAccepted(turn, controller, fence, true);
    if (outcome === "exhausted") {
      this.failAndRetire(turn, controller, fence, "Controller recovery attempts exhausted", terminalFailureCode);
    }
    return true;
  }

  private async requestCompletionContinuation(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
    terminalFailureCode: ControllerFailureCode = "recovery_exhausted",
  ): Promise<boolean> {
    if (!controller.threadId) return true;
    let highWater: number;
    try {
      highWater = await this.dependencies.adapter.latestSeq(controller.threadId, signal);
    } catch {
      return this.beginFreshRecovery(turn, controller, fence, "event high-water unavailable", terminalFailureCode);
    }
    if (!Number.isSafeInteger(highWater) || highWater < 0) {
      return this.beginFreshRecovery(turn, controller, fence, "event high-water invalid", terminalFailureCode);
    }
    const claim = this.dependencies.store.claimControllerCompletionContinuation({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      controllerKey: controller.controllerKey,
      bbHighWaterSeq: highWater,
    });
    if (claim === "stale") return true;
    if (claim === "already_claimed") {
      if (turn.completionContinuations >= 2) {
        this.failAndRetire(
          turn,
          controller,
          fence,
          "Controller recovery ended without an accepted finalization",
          terminalFailureCode,
        );
        return true;
      }
      return this.beginFreshRecovery(
        turn,
        controller,
        fence,
        "same-session correction was insufficient",
        terminalFailureCode,
      );
    }
    if (!this.providerMutationAllowed(turn, controller, fence, signal)) {
      return this.beginFreshRecovery(
        turn,
        controller,
        fence,
        "correction fence was lost before send",
        terminalFailureCode,
      );
    }
    try {
      await this.dependencies.adapter.send(
        controller.threadId,
        CONTROLLER_COMPLETION_RECOVERY_PROMPT,
        signal,
        null,
        turn.modelFallbackIndex,
      );
    } catch {
      return this.beginFreshRecovery(
        turn,
        controller,
        fence,
        "correction outcome was uncertain",
        terminalFailureCode,
      );
    }
    return true;
  }

  private failAndRetire(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    error: string,
    failureCode: ControllerFailureCode = "unknown",
  ): boolean {
    if (!controller.threadId) return false;
    return this.dependencies.store.failAndRetireControllerTurn({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      controllerKey: controller.controllerKey,
      expectedThreadId: controller.threadId,
      error,
      failureCode,
    }) === "retired";
  }

  /**
   * Bounds a turn by the work it has actually done. Returns true when the
   * supervisor acted, so the caller stops reconciling this turn.
   */
  private async superviseBudget(
    turnId: string,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<boolean> {
    const turn = this.dependencies.store.getControllerTurn(turnId);
    if (!turn || turn.state !== "submitted" || controller.threadId === null ||
        turn.acceptedFinalizationId !== null ||
        this.dependencies.store.getAcceptedControllerFinalization(turnId) !== null) return false;
    const decision = evaluateSupervisor({
      toolCalls: turn.toolCalls,
      // Spend for *this* turn: the reported figure counts the whole thread,
      // which has answered every earlier message too.
      totalTokens: Math.max(0, turn.totalTokens - (turn.tokenBaseline ?? turn.totalTokens)),
      commandFailures: turn.commandFailures,
      steersIssued: turn.supervisorSteers,
      steeredReasons: turn.supervisorReasons,
    });
    if (decision.kind === "continue") return false;
    if (decision.kind === "steer") {
      const claim = this.dependencies.store.claimControllerSupervisorSteer({
        ...fenceAt(fence, this.dependencies.clock.now()),
        turnId,
        controllerKey: turn.controllerKey,
        expectedThreadId: controller.threadId,
        reason: decision.reason,
        inputText: decision.text,
      });
      if (claim === "stale" || claim === "settled") return true;
      const attempt = this.dependencies.store.getControllerSupervisorSteerAttempt(turnId, decision.reason);
      if (!attempt) return true;
      if (claim === "pending") return this.reconcilePendingSupervisorSteer(turnId, fence, signal);

      let outcome: "applied" | "unknown" = "unknown";
      try {
        if (!signal.aborted) {
          await this.dependencies.adapter.steer(attempt.threadId, attempt.inputText, signal);
          outcome = "applied";
        }
      } catch {
        // The provider boundary is ambiguous. Reconcile once when the
        // adapter can prove whether this idempotency key landed; otherwise
        // settle unknown so a successor never replays it.
        const reconciled = await this.reconcileProviderSteer(attempt, signal);
        outcome = reconciled === "applied" ? "applied" : "unknown";
      }
      const settled = this.dependencies.store.settleControllerSupervisorSteer({
        ...fenceAt(fence, this.dependencies.clock.now()),
        turnId,
        controllerKey: turn.controllerKey,
        reason: decision.reason,
        outcome,
      });
      return settled === "settled" || settled === "stale";
    }
    if (this.dependencies.store.getAcceptedControllerFinalization(turnId) !== null) return false;
    this.failAndRetire(
      turn,
      controller,
      fence,
      "Controller turn exceeded its budget",
      "budget_exceeded",
    );
    return true;
  }

  private async spawnOrAdopt(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<ControllerLocation | null> {
    let candidate: ControllerLocation | null = null;
    const pendingSpawnToken = controller.pendingSpawnToken;
    if (pendingSpawnToken === null) {
      this.fail(turn, fence, "Controller spawn token is unavailable");
      return null;
    }
    if (!this.providerMutationAllowed(turn, controller, fence, signal)) {
      if (signal.aborted) {
        this.dependencies.store.requeueControllerTurn({
          ...fenceAt(fence, this.dependencies.clock.now()),
          turnId: turn.id,
        });
      }
      return null;
    }
    // The adapter only returns a candidate after matching the complete
    // tokenized identity: controller, pending turn, project, host, provider,
    // plugin origin, and hidden/non-terminal state. That identity is also the
    // evidence that an image-bearing spawn was this turn: the image is
    // prepared before BB creates the titled thread. Reserve the same
    // project/host before mapping it so adoption and a fresh spawn share the
    // same durable fence.
    try {
      candidate = await this.dependencies.adapter.findSpawnCandidate(
        controller.controllerKey,
        pendingSpawnToken,
        signal,
        turn.modelFallbackIndex,
      );
    } catch {
      this.requeueAfterTransientRead(turn, fence, "Controller spawn candidates could not be read");
      return null;
    }
    if (candidate) {
      if (!this.dependencies.store.prepareControllerDispatch({
        ...fenceAt(fence, this.dependencies.clock.now()),
        turnId: turn.id,
        kind: "spawn",
      })) return null;
      if (!this.dependencies.store.reserveControllerSpawn({
        controllerKey: controller.controllerKey,
        turnId: turn.id,
        projectId: candidate.projectId,
        hostId: candidate.hostId,
        now: this.dependencies.clock.now(),
      })) return null;
      return candidate;
    }
    // A replacement thread opens with the conversation so far, so retiring a
    // failed thread costs the owner a pause rather than the whole conversation.
    const seeded = { ...turn, inputText: this.composeInput(turn, { includeDigest: true }) };
    if (!this.providerMutationAllowed(turn, controller, fence, signal)) {
      if (signal.aborted) {
        this.dependencies.store.requeueControllerTurn({
          ...fenceAt(fence, this.dependencies.clock.now()),
          turnId: turn.id,
        });
      }
      return null;
    }
    if (!this.dependencies.store.prepareControllerDispatch({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      kind: "spawn",
    })) return null;
    try {
      return await this.dependencies.adapter.spawn(seeded, controller, signal);
    } catch (error) {
      if (this.handleImagePreparationError(error, turn, fence, signal)) return null;
      if (!this.dependencies.store.markControllerDeliveryUnknown({
        ...fenceAt(fence, this.dependencies.clock.now()),
        turnId: turn.id,
      })) return null;
      const unknown = this.dependencies.store.getControllerTurn(turn.id);
      if (unknown?.state === "dispatching" && unknown.deliveryState === "delivery_unknown") {
        await this.reconcileUnknownDelivery(unknown, controller, fence, signal);
      }
      return null;
    }
  }

  private composeInput(turn: ControllerTurnRecord, options: { includeDigest: boolean }): string {
    const recovery = turn.completionContinuations >= 2 || turn.recoverySourceTurnId !== null
      ? { privateDraft: turn.privateDraftText, sourceTurnId: turn.recoverySourceTurnId }
      : undefined;
    const context = buildTurnContext({
      store: this.dependencies.store,
      controllerKey: turn.controllerKey,
      inputText: turn.inputText,
      includeDigest: options.includeDigest || recovery !== undefined,
      turnId: turn.id,
      recovery,
      now: this.dependencies.clock.now(),
    });
    return composeTurnInput(context, turn.inputText);
  }

  private providerMutationAllowed(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): boolean {
    return !signal.aborted && this.dependencies.store.canMutateControllerTurn({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      controllerKey: turn.controllerKey,
      expectedThreadId: controller.threadId,
    });
  }

  private waitForIdle(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
  ): "queued" | "fresh_generation" {
    const now = this.dependencies.clock.now();
    const waitMs = Math.max(0, now - turn.createdAt);
    if (waitMs >= CONTROLLER_BUSY_NOTICE_MS) {
      this.dependencies.store.recordControllerBusyWaitNotice({
        ...fenceAt(fence, now),
        turnId: turn.id,
      });
    }
    if (waitMs >= CONTROLLER_BUSY_ROLLOVER_MS && controller.threadId !== null &&
        this.dependencies.store.resetControllerThread({
          ...fenceAt(fence, now),
          controllerKey: controller.controllerKey,
          expectedThreadId: controller.threadId,
          reason: "Controller remained busy beyond the queued-message wait",
        })) {
      return "fresh_generation";
    }
    this.dependencies.store.requeueControllerTurn({
      ...fenceAt(fence, now),
      turnId: turn.id,
    });
    return "queued";
  }

  private requeueAfterTransientRead(
    turn: ControllerTurnRecord,
    fence: EffectFence,
    error: string,
  ): void {
    this.dependencies.store.requeueControllerTurn({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      retryAfterMs: controllerDispatchBackoffMs(turn.dispatchRetryCount),
      incrementDispatchRetry: true,
      error,
    });
  }

  private failImage(turn: ControllerTurnRecord, fence: EffectFence): void {
    this.fail(
      turn,
      fence,
      "Controller image preparation failed",
      "image_preparation_failed",
    );
  }

  private handleImagePreparationError(
    error: unknown,
    turn: ControllerTurnRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): boolean {
    if (!(error instanceof ControllerImagePreparationError)) return false;
    if (!error.retryable || turn.retryCount + 1 >= MAX_IMAGE_PREPARATION_ATTEMPTS) {
      this.failImage(turn, fence);
      return true;
    }
    const now = this.dependencies.clock.now();
    const requeued = this.dependencies.store.recordControllerImagePreparationFailure({
      ...fenceAt(fence, now),
      turnId: turn.id,
      incrementRetry: !signal.aborted,
    });
    if (!requeued) throw new Error("Controller image retry could not be recorded");
    return true;
  }

  private fail(
    turn: ControllerTurnRecord,
    fence: EffectFence,
    error: string,
    failureCode: ControllerFailureCode = "unknown",
  ): void {
    this.dependencies.store.failControllerTurn({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      error,
      failureCode,
    });
  }
}
