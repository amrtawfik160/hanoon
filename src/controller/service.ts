import type { TelegramAgentStore } from "../storage/store";
import type { EffectFence } from "../services/effect-runner";
import {
  ControllerImagePreparationError,
  parseControllerInteractionResolution,
  type ControllerInteractionReference,
  type ControllerInteractionSnapshot,
  type ControllerAdapter,
  type ControllerSpawnResult,
  type ControllerStatus,
} from "./bb-controller";
import { ControllerInteractionService } from "./interaction-service";
import { parseControllerInteraction } from "./questions";
import type { ControllerThreadRecord, ControllerTurnRecord } from "./models";
import { normalizeControllerEventObservation, projectControllerStream } from "./stream";
import type { ControllerEventObservation } from "./bb-controller";
import { buildTurnContext, composeTurnInput } from "./context";
import { evaluateSupervisor } from "./supervisor";
import {
  ControllerEvidenceProjectorError,
  type ControllerEvidenceReconciliation,
  type ControllerEvidenceReconciler,
} from "./evidence-projector";

export type LunaControllerServiceDependencies = {
  store: TelegramAgentStore;
  adapter: ControllerAdapter;
  interactionService?: ControllerInteractionService;
  evidenceProjector?: ControllerEvidenceReconciler;
  clock: { now(): number };
};

type InteractionReconciliationContext = Readonly<{
  turn: ControllerTurnRecord;
  controller: ControllerThreadRecord;
  fence: EffectFence;
  signal: AbortSignal;
}>;

const CONTROLLER_DRAFT_REFRESH_MS = 20_000;
// How long a queued message may wait for a busy controller thread before the
// owner is told it will not be answered.
const CONTROLLER_BUSY_WAIT_MS = 10 * 60_000;
const CONTROLLER_IMAGE_FAILURE_MESSAGE =
  "I couldn't read that image safely. Please resend a smaller JPEG, PNG, WebP, or GIF.";
/**
 * How long a submitted turn may go without producing a single BB event before
 * it is treated as wedged. Any event at all — reasoning, a tool call, output —
 * resets this, so only a thread that has genuinely stopped trips it. Silence is
 * the worst answer the owner can get, so it is bounded even when BB still
 * reports the thread as active.
 */
export const CONTROLLER_STALL_MS = 8 * 60_000;
const MAX_STEER_ATTEMPTS = 3;
const MAX_IMAGE_PREPARATION_ATTEMPTS = 3;
const CONTROLLER_RECOVERY_PROMPT =
  "Inspect telegram_agent_turn_evidence and call telegram_agent_respond with the evidence already available.";

function legacyFixtureReconciler(adapter: ControllerAdapter): ControllerEvidenceReconciler | undefined {
  // Task 7 fixtures carried an `output` method and predate the injected
  // projector. Keep those unit fixtures runnable without restoring any raw
  // output path; live BbControllerAdapter instances never have this marker.
  if (!Object.hasOwn(adapter as object, "output")) return undefined;
  return {
    reconcile: async (
      _controller,
      turn,
      _fence,
      _signal,
      immutableHighWater,
    ): Promise<ControllerEvidenceReconciliation> => ({
      outcome: "reconciled",
      reconciliationIncomplete: null,
      fromSeq: turn.evidenceEventSeq,
      throughSeq: turn.evidenceEventSeq,
      targetSeq: immutableHighWater ?? turn.evidenceEventSeq,
    }),
  };
}

function retireReason(status: ControllerStatus): string {
  if (status === "missing") return "Thread was deleted or archived";
  if (status === "incompatible") return "Configured model moved the conversation to another provider";
  return "Provider session ended in error";
}

function fenceAt(fence: EffectFence, now: number) {
  return { ownerId: fence.ownerId, generation: fence.generation, now };
}

export class LunaControllerService {
  private readonly dependencies: LunaControllerServiceDependencies;

  public constructor(dependencies: LunaControllerServiceDependencies) {
    this.dependencies = dependencies.evidenceProjector
      ? dependencies
      : { ...dependencies, evidenceProjector: legacyFixtureReconciler(dependencies.adapter) };
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
        status = await this.dependencies.adapter.status(controller.threadId, signal);
      } catch {
        this.fail(turn, fence, "Controller status could not be verified");
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
      } else {
        if (status !== "idle") {
          this.waitForIdle(turn, fence);
          return true;
        }
        let dispatchAfterSeq: number;
        try {
          dispatchAfterSeq = await this.dependencies.adapter.latestSeq(controller.threadId, signal);
        } catch {
          this.fail(turn, fence, "Controller event baseline could not be verified");
          return true;
        }
        try {
          const input = this.composeInput(turn, { includeDigest: false });
          if (!this.providerMutationAllowed(turn, controller, fence, signal)) return true;
          if (turn.image) {
            await this.dependencies.adapter.send(controller.threadId, input, signal, turn.image);
          } else {
            await this.dependencies.adapter.send(controller.threadId, input, signal);
          }
        } catch (error) {
          if (this.handleImagePreparationError(error, turn, fence, signal)) return true;
          this.fail(turn, fence, "Controller send outcome is uncertain");
          return true;
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

  public async reconcile(fence: EffectFence, signal: AbortSignal): Promise<boolean> {
    if (this.dependencies.store.failStaleControllerDispatches(
      fenceAt(fence, this.dependencies.clock.now()),
    )) return true;
    const owner = this.dependencies.store.getOwner();
    if (!owner) return false;
    let controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!controller?.threadId) return false;
    const pending = this.dependencies.store.getPendingControllerTurn(controller.controllerKey);
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

    if (await this.deliverAnsweredInteraction(turn, controller, fence, signal)) return true;

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
      status = await this.dependencies.adapter.status(controller.threadId, signal);
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
      const projected = projectControllerStream(observation, {
        cursor: turn.bbEventSeq,
        text: turn.streamText,
        phase: turn.streamPhase,
      });
      if (projected.cursor > turn.bbEventSeq) {
        this.dependencies.store.updateControllerStream({
          ...fenceAt(fence, this.dependencies.clock.now()),
          turnId: turn.id,
          cursor: projected.cursor,
          phase: projected.phase,
          toolCalls: observation.toolCalls,
          commandFailures: observation.commandFailures,
          totalTokens: observation.totalTokens,
        });
      }
    } catch {
      observation = null;
    }
    if (observation === null) return false;
    if (!await this.reconcileInteractionReferences(
      observation.interactionReferences ?? [],
      { turn, controller, fence, signal },
    )) return true;
    const refreshedAt = this.dependencies.clock.now();
    turn = this.dependencies.store.getControllerTurn(turn.id);
    controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!turn || turn.state !== "submitted" || !controller?.threadId) return true;
    if (await this.deliverAnsweredInteraction(turn, controller, fence, signal)) return true;
    if (this.hasPendingInteraction(controller.controllerKey, turn.id)) return true;

    const accepted = this.dependencies.store.getAcceptedControllerFinalization(turn.id);
    const parked = turn.awaitingInteractionId;
    if (parked !== null) return true;
    if (status === "active" || status === "starting" || status === "stopping") {
      if (accepted) return true;
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
      if (waiting && !waiting.image && waiting.retryCount < MAX_STEER_ATTEMPTS) {
        if (!this.providerMutationAllowed(turn, controller, fence, signal)) return true;
        try {
          await this.dependencies.adapter.steer(controller.threadId, waiting.inputText, signal);
        } catch {
          // Out of attempts it stays queued, and the ordinary dispatch answers
          // it once the turn in flight finishes.
          this.dependencies.store.recordControllerSteerFailure({
            ...fenceAt(fence, this.dependencies.clock.now()),
            turnId: waiting.id,
          });
          return true;
        }
        this.dependencies.store.foldControllerTurnIntoRunning({
          ...fenceAt(fence, this.dependencies.clock.now()),
          turnId: waiting.id,
        });
        return true;
      }
      // The owner's own words outrank a budget nudge, so this runs only once
      // nothing of theirs is waiting. A turn parked on a question is waiting on
      // a person, and no budget should fire against their thinking time.
      if (parked === null && await this.superviseBudget(turn.id, controller, fence, signal)) {
        return true;
      }
      if (parked === null && refreshedAt - turn.updatedAt >= CONTROLLER_STALL_MS) {
        this.failAndRetire(
          turn,
          controller,
          fence,
          "Controller turn stopped producing events",
          "That one stalled, so I gave up on it and started a fresh session. Ask me again.",
        );
      }
      return true;
    }
    const providerError = status === "error" || observation.error !== null;
    if (accepted && (providerError || status === "idle" || observation.completed)) {
      return await this.completeAccepted(turn, controller, fence, providerError, signal);
    }
    if (providerError) {
      if (!observation.inputAccepted && turn.retryCount === 0 && this.dependencies.store.retryUnacceptedControllerTurn({
        ...fenceAt(fence, this.dependencies.clock.now()),
        turnId: turn.id,
        controllerKey: controller.controllerKey,
        expectedThreadId: controller.threadId,
      })) return true;
      this.failAndRetire(turn, controller, fence, "Controller provider turn failed");
      return true;
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
    if (status === "idle" || observation.completed) return this.requestCompletionContinuation(turn, controller, fence, signal);
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
      if (reconciliation.outcome === "limit_exceeded" || reconciliation.reconciliationIncomplete !== null) {
        return "fatal";
      }
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
      status = await this.dependencies.adapter.status(controller.threadId!, signal);
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
      this.failAndRetire(
        current,
        controller,
        fence,
        "Controller evidence reconciliation stalled",
        "That one stalled, so I gave up on it and started a fresh session. Ask me again.",
      );
      return true;
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
        !this.providerMutationAllowed(turn, controller, fence, signal)) return;
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
    this.dependencies.store.markControllerInteractionDelivered({
      ...fenceAt(fence, this.dependencies.clock.now()),
      interactionId: ownerAnswer.interactionId,
      turnId: ownerAnswer.turnId,
      bbThreadId: ownerAnswer.bbThreadId,
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
    if (reference.status === "resolved" || reference.status === "interrupted") {
      return this.settleInteractionReference(reference, context);
    }
    const snapshot = await this.readInteraction(reference, context);
    if (!snapshot) return false;
    const generationAfter = this.currentControllerGeneration(
      context.controller.controllerKey,
      context.controller.threadId!,
    );
    if (!generationAfter || generationAfter.id !== generationBefore.id ||
        snapshot.id !== reference.interactionId || snapshot.threadId !== context.controller.threadId) return false;
    if (snapshot.status === "resolved" || snapshot.status === "interrupted") {
      return this.settleInteractionReference(reference, context);
    }
    if (snapshot.status !== "pending") return false;
    const interaction = parseControllerInteraction(snapshot.id, snapshot.payload);
    if (!interaction || (interaction.kind !== reference.kind && interaction.kind !== "unsupported")) return false;
    const recorded = this.dependencies.store.recordControllerInteraction({
      ...fenceAt(context.fence, this.dependencies.clock.now()),
      turnId: context.turn.id,
      controllerKey: context.controller.controllerKey,
      bbThreadId: context.controller.threadId!,
      controllerGenerationId: generationAfter.id,
      interaction,
    });
    return recorded || this.dependencies.store.isExecutorLeaseCurrent(
      context.fence.ownerId,
      context.fence.generation,
      this.dependencies.clock.now(),
    );
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

  private settleInteractionReference(
    reference: ControllerInteractionReference,
    context: InteractionReconciliationContext,
  ): boolean {
    const settled = this.dependencies.store.markControllerInteractionResolved({
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
    signal: AbortSignal,
  ): Promise<boolean> {
    let bbHighWaterSeq: number;
    try {
      bbHighWaterSeq = await this.dependencies.adapter.latestSeq(controller.threadId!, signal);
    } catch {
      return false;
    }
    if (!Number.isSafeInteger(bbHighWaterSeq) || bbHighWaterSeq < 0) {
      this.failAndRetire(turn, controller, fence, "Controller event high-water was invalid");
      return true;
    }
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
    if (outcome === "evidence_advanced") {
      this.failAndRetire(turn, controller, fence, "Controller evidence advanced after finalization");
    }
    return true;
  }

  private async requestCompletionContinuation(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!controller.threadId) return true;
    let highWater: number;
    try {
      highWater = await this.dependencies.adapter.latestSeq(controller.threadId, signal);
    } catch {
      return false;
    }
    if (!Number.isSafeInteger(highWater) || highWater < 0) {
      this.failAndRetire(turn, controller, fence, "Controller event high-water was invalid");
      return true;
    }
    const claim = this.dependencies.store.claimControllerCompletionContinuation({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      controllerKey: controller.controllerKey,
      bbHighWaterSeq: highWater,
    });
    if (claim === "stale") return true;
    if (claim === "already_claimed") {
      this.failAndRetire(turn, controller, fence, "Controller turn ended without an accepted finalization");
      return true;
    }
    if (!this.providerMutationAllowed(turn, controller, fence, signal)) {
      this.failAndRetire(turn, controller, fence, "Controller continuation fence was lost before send");
      return true;
    }
    try {
      await this.dependencies.adapter.send(controller.threadId, CONTROLLER_RECOVERY_PROMPT, signal);
    } catch {
      this.failAndRetire(turn, controller, fence, "Controller continuation outcome is uncertain");
    }
    return true;
  }

  private failAndRetire(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    error: string,
    ownerMessage?: string,
  ): boolean {
    if (!controller.threadId) return false;
    return this.dependencies.store.failAndRetireControllerTurn({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      controllerKey: controller.controllerKey,
      expectedThreadId: controller.threadId,
      error,
      ownerMessage,
    });
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
    if (!turn || turn.state !== "submitted" || controller.threadId === null) return false;
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
      if (!this.providerMutationAllowed(turn, controller, fence, signal)) return true;
      try {
        await this.dependencies.adapter.steer(controller.threadId, decision.text, signal);
      } catch {
        // A nudge that did not land is not worth failing an answer over. The
        // hard budget still stops the turn, and the next poll may deliver it.
        return false;
      }
      return this.dependencies.store.recordControllerSupervisorSteer({
        ...fenceAt(fence, this.dependencies.clock.now()),
        turnId,
        reason: decision.reason,
      });
    }
    this.failAndRetire(
      turn,
      controller,
      fence,
      "Controller turn exceeded its budget",
      decision.ownerMessage,
    );
    return true;
  }

  private async spawnOrAdopt(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<ControllerSpawnResult | null> {
    let candidate: ControllerSpawnResult | null = null;
    const pendingSpawnToken = controller.pendingSpawnToken;
    if (pendingSpawnToken === null) {
      this.fail(turn, fence, "Controller spawn token is unavailable");
      return null;
    }
    // Image turns never adopt by title before attempting their own spawn. A
    // title match cannot prove that the image was attached, and adopting it
    // would silently drop the image. Recovery after an uncertain actual spawn
    // remains available in the catch block below.
    if (!turn.image) {
      try {
        candidate = await this.dependencies.adapter.findSpawnCandidate(
          controller.controllerKey,
          pendingSpawnToken,
          signal,
        );
      } catch {
        this.fail(turn, fence, "Controller spawn candidates are ambiguous");
        return null;
      }
    }
    if (candidate) return candidate;
    // A replacement thread opens with the conversation so far, so retiring a
    // failed thread costs the owner a pause rather than the whole conversation.
    const seeded = { ...turn, inputText: this.composeInput(turn, { includeDigest: true }) };
    try {
      if (!this.providerMutationAllowed(turn, controller, fence, signal)) {
        if (signal.aborted) {
          this.dependencies.store.requeueControllerTurn({
            ...fenceAt(fence, this.dependencies.clock.now()),
            turnId: turn.id,
          });
        }
        return null;
      }
      return await this.dependencies.adapter.spawn(seeded, controller, signal);
    } catch (error) {
      if (this.handleImagePreparationError(error, turn, fence, signal)) return null;
      try {
        candidate = await this.dependencies.adapter.findSpawnCandidate(
          controller.controllerKey,
          pendingSpawnToken,
          signal,
        );
      } catch {
        candidate = null;
      }
      if (candidate) return candidate;
      this.fail(turn, fence, "Controller spawn outcome is uncertain");
      return null;
    }
  }

  private composeInput(turn: ControllerTurnRecord, options: { includeDigest: boolean }): string {
    const context = buildTurnContext({
      store: this.dependencies.store,
      controllerKey: turn.controllerKey,
      inputText: turn.inputText,
      includeDigest: options.includeDigest,
      turnId: turn.id,
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

  private waitForIdle(turn: ControllerTurnRecord, fence: EffectFence): void {
    const now = this.dependencies.clock.now();
    if (now - turn.createdAt >= CONTROLLER_BUSY_WAIT_MS) {
      this.fail(turn, fence, "Controller thread stayed busy for too long");
      return;
    }
    this.dependencies.store.requeueControllerTurn({ ...fenceAt(fence, now), turnId: turn.id });
  }

  private failImage(turn: ControllerTurnRecord, fence: EffectFence): void {
    this.fail(
      turn,
      fence,
      "Controller image preparation failed",
      CONTROLLER_IMAGE_FAILURE_MESSAGE,
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
    const requeued = signal.aborted
      ? this.dependencies.store.requeueControllerTurn({ ...fenceAt(fence, now), turnId: turn.id })
      : this.dependencies.store.recordControllerImagePreparationFailure({
        ...fenceAt(fence, now),
        turnId: turn.id,
      });
    if (!requeued) throw new Error("Controller image retry could not be recorded");
    return true;
  }

  private fail(
    turn: ControllerTurnRecord,
    fence: EffectFence,
    error: string,
    ownerMessage?: string,
  ): void {
    this.dependencies.store.failControllerTurn({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      error,
      ownerMessage,
    });
  }
}
