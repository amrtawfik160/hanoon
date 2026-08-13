import type { TelegramAgentStore } from "../storage/store";
import type { EffectFence } from "../services/effect-runner";
import {
  ControllerImagePreparationError,
  type ControllerAdapter,
  type ControllerInteractionReference,
  type ControllerLocation,
  type ControllerStatus,
} from "./bb-controller";
import type { ControllerThreadRecord, ControllerTurnRecord } from "./models";
import { projectControllerStream } from "./stream";
import { buildTurnContext, composeTurnInput } from "./context";
import { evaluateSupervisor } from "./supervisor";
import type { ControllerInteractionFetch, ControllerInteractionService } from "./interaction-service";
import {
  ControllerEvidenceProjectorError,
  type ControllerEvidenceReconciler,
  type ControllerEvidenceReconciliation,
} from "./evidence-projector";

/** The BB half of the hidden-controller interaction bridge. */
export type ControllerInteractionReconciler = Pick<
  ControllerInteractionService,
  "deliverAnswered" | "fetchPending"
>;

export type LunaControllerServiceDependencies = {
  store: TelegramAgentStore;
  adapter: ControllerAdapter;
  evidenceProjector: ControllerEvidenceReconciler;
  interactionService: ControllerInteractionReconciler;
  clock: { now(): number };
};

type TerminalContext = Readonly<{
  controller: ControllerThreadRecord;
  turn: ControllerTurnRecord;
  fence: EffectFence;
  signal: AbortSignal;
  status: ControllerStatus;
  observation: Awaited<ReturnType<ControllerAdapter["events"]>> | null;
  reconciliation: ControllerEvidenceReconciliation | null;
}>;
type CompletionContinuationClaim = "claimed" | "already_claimed" | "stale" | "failed";
type FailAndRetireOutcome = ReturnType<TelegramAgentStore["failAndRetireControllerTurn"]>;
type TerminalHighWaterOutcome = "matched" | "deferred" | "retired";
type BoundaryFailureContext = Readonly<{
  controller: ControllerThreadRecord;
  turn: ControllerTurnRecord;
  fence: EffectFence;
  signal: AbortSignal;
  failureSummary: string;
  /** The status already read on this pass, when the caller has one. */
  observedStatus?: ControllerStatus;
}>;

const CONTROLLER_DRAFT_REFRESH_MS = 20_000;
// How long a queued message may wait for a busy controller thread before the
// owner is told it will not be answered.
const CONTROLLER_BUSY_WAIT_MS = 10 * 60_000;
const CONTROLLER_IMAGE_FAILURE_MESSAGE =
  "I couldn't read that image safely. Please resend a smaller JPEG, PNG, WebP, or GIF.";
export const CONTROLLER_COMPLETION_RECOVERY_PROMPT =
  "Your previous turn ended without an accepted telegram_agent_respond call. " +
  "Inspect telegram_agent_turn_evidence, correct any rejected finalization, and make telegram_agent_respond your final action now. " +
  "Do not repeat a side effect.";
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

function retireReason(status: ControllerStatus): string {
  if (status === "missing") return "Thread was deleted or archived";
  if (status === "incompatible") return "Configured model moved the conversation to another provider";
  return "Provider session ended in error";
}

function fenceAt(fence: EffectFence, now: number) {
  return { ownerId: fence.ownerId, generation: fence.generation, now };
}

export class LunaControllerService {
  public constructor(private readonly dependencies: LunaControllerServiceDependencies) {}

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

    // ===== Pre-terminal reconcile boundary (B2a) =====
    // 1. Adopt the submitted turn fence under the current global executor
    //    lease, then re-read. Every mutation below must run against the
    //    post-adoption record, never the pre-adoption one.
    if (!this.dependencies.store.adoptSubmittedControllerTurnFence({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: submitted.id,
    })) {
      // Stale fence / cursor change / abort: no terminal write; a later pass
      // re-adopts once Task 7 reconciles the advanced boundary.
      return false;
    }
    let turn = this.dependencies.store.getControllerTurn(submitted.id);
    let liveController = this.dependencies.store.getControllerByThreadId(controller.threadId);
    if (!this.validAdoptedTurn(turn, liveController, fence, controller)) return false;

    // 2. Deliver one already-durable owner answer. This is the sole operation
    //    allowed before evidence: until BB hears a decision the owner already
    //    made, the thread cannot produce any evidence at all, so a pass that
    //    finds one does nothing else whether or not the delivery lands.
    const ownerAnswer = this.dependencies.store.getAnsweredControllerInteraction(liveController!.controllerKey);
    if (ownerAnswer) {
      // Only one turn of a controller is ever submitted, so an answer parked on
      // a different one is a broken invariant rather than ordinary lag.
      if (ownerAnswer.turnId !== turn!.id) {
        return this.failAndRetire(
          liveController!,
          turn!,
          fence,
          "Controller owner answer did not match the adopted turn",
        ) === "retired";
      }
      if (await this.deliverOwnerAnswer(liveController!, fence, signal)) return true;
      return await this.retireParkedOnLostThread(liveController!, turn!, fence, signal);
    }

    // 3. Run the native-evidence projector on every pass through a fixed
    //    high-water, before any legacy question/status/events/phase/draft/
    //    steer/supervisor/stall work, then re-read afterward.
    let reconciliation: ControllerEvidenceReconciliation | null = null;
    try {
      reconciliation = await this.dependencies.evidenceProjector.reconcile(
        liveController!,
        turn!,
        fenceAt(fence, this.dependencies.clock.now()),
        signal,
      );
    } catch (error) {
      if (error instanceof ControllerEvidenceProjectorError) {
        // Deterministic projection failure: fail and retire atomically with a
        // bounded internal reason. No raw output can bypass this boundary.
        return this.failAndRetire(liveController!, turn!, fence, this.projectorFailure(error)) === "retired";
      }
      return this.retirePersistentBoundary({
        controller: liveController!,
        turn: turn!,
        fence,
        signal,
        failureSummary: "Controller evidence projection remained unavailable",
      });
    }

    // Re-read after projection.
    turn = this.dependencies.store.getControllerTurn(submitted.id);
    liveController = this.dependencies.store.getControllerByThreadId(controller.threadId);
    if (!this.validAdoptedTurn(turn, liveController, fence, controller)) return false;

    // 4. Deterministic, non-recoverable reconciliation outcomes fail-and-retire.
    if (reconciliation !== null) {
      if (reconciliation.outcome === "stale") return false; // no terminal write
      if (reconciliation.outcome === "limit_exceeded" || reconciliation.reconciliationIncomplete !== null) {
        return this.failAndRetire(
          liveController!,
          turn!,
          fence,
          reconciliation.outcome === "limit_exceeded"
            ? "Controller evidence limit exceeded during reconciliation"
            : reconciliation.reconciliationIncomplete === "page_cap"
              ? "Controller evidence reconciliation exceeded the bounded page cap"
              : "Controller evidence reconciliation hit a source gap",
        ) === "retired";
      }
    }
    // A cap marker observed on the re-read turn also fails-and-retires rather
    // than continuing an unprovable answer.
    if (turn!.evidenceLimitExceededAt !== null) {
      return this.failAndRetire(liveController!, turn!, fence, "Controller evidence limit exceeded") === "retired";
    }

    // ===== Pre-terminal work, all on the post-adoption turn =====
    let status: ControllerStatus;
    try {
      status = await this.dependencies.adapter.status(controller.threadId, signal);
    } catch {
      return this.retirePersistentBoundary({
        controller: liveController!,
        turn: turn!,
        fence,
        signal,
        failureSummary: "Controller status remained unavailable",
      });
    }
    let observation: Awaited<ReturnType<ControllerAdapter["events"]>> | null = null;
    try {
      observation = await this.dependencies.adapter.events(
        liveController!.threadId!,
        turn!.bbEventSeq,
        signal,
      );
    } catch {
      return this.retirePersistentBoundary({
        controller: liveController!,
        turn: turn!,
        fence,
        signal,
        failureSummary: "Controller event boundary remained unavailable",
        observedStatus: status,
      });
    }
    // 5. Persist every observed lifecycle reference before the event cursor
    //    advances past it, so a failed BB read costs a retry rather than the
    //    owner's only view of what the thread is blocked on.
    if (!await this.observeInteractions(liveController!, turn!, observation.interactions, fence, signal)) {
      return this.retirePersistentBoundary({
        controller: liveController!,
        turn: turn!,
        fence,
        signal,
        failureSummary: "Controller interaction boundary remained unavailable",
        observedStatus: status,
      });
    }
    const projected = projectControllerStream(observation, {
      cursor: turn!.bbEventSeq,
      text: turn!.streamText,
      phase: turn!.streamPhase,
    });
    // Keep durable store failures outside the external event-read catch. A
    // database invariant or write failure is not a transient BB boundary and
    // must propagate so its surrounding transaction can roll back loudly.
    this.dependencies.store.updateControllerStream({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn!.id,
      cursor: projected.cursor,
      phase: projected.phase,
      toolCalls: observation.toolCalls,
      commandFailures: observation.commandFailures,
      totalTokens: observation.totalTokens,
    });
    // 6. A turn waiting on a person does nothing else at all: no draft refresh,
    //    steering, budget, stall, continuation, completion, or silence. Its own
    //    answer is what unblocks it, and that arrives through step 2.
    if (this.parkedOnInteraction(turn!)) {
      await this.retireParkedOnLostThread(liveController!, turn!, fence, signal, status);
      return true;
    }
    const refreshedAt = this.dependencies.clock.now();
    this.dependencies.store.refreshControllerDraft({
      ...fenceAt(fence, refreshedAt),
      turnId: turn!.id,
      sentBefore: Math.max(0, refreshedAt - CONTROLLER_DRAFT_REFRESH_MS),
    });
    if (status === "active" || status === "starting" || status === "stopping") {
      // Active/starting/stopping do only phase/evidence work; no finalization
      // consumption happens here (B2b owns terminal handling). Anything the
      // owner says while an answer is being written belongs to that answer.
      const waiting = this.dependencies.store.getQueuedControllerTurn(liveController!.controllerKey);
      if (waiting && !waiting.image && waiting.retryCount < MAX_STEER_ATTEMPTS) {
        try {
          await this.dependencies.adapter.steer(liveController!.threadId!, waiting.inputText, signal);
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
      // nothing of theirs is waiting.
      if (await this.superviseBudget(turn!.id, liveController!, fence, signal)) {
        return true;
      }
      if (refreshedAt - turn!.updatedAt >= CONTROLLER_STALL_MS) {
        return this.failAndRetire(
          liveController!,
          turn!,
          fence,
          "Controller turn stopped producing events",
        ) === "retired";
      }
      return true;
    }
    if (observation === null && status !== "missing" && status !== "incompatible") {
      // A terminal status without its event/interaction boundary is not proof
      // that there is no parked owner question or later provider activity.
      return false;
    }

    // A non-active status is a terminal boundary. Re-read the exact submitted
    // turn and its live generation before inspecting or consuming durable
    // finalization state; nothing below is allowed to act on the earlier row.
    turn = this.dependencies.store.getControllerTurn(turn!.id);
    liveController = this.dependencies.store.getControllerByThreadId(controller.threadId);
    if (!this.validAdoptedTurn(turn, liveController, fence, controller)) return false;
    return await this.settleTerminal({
      controller: liveController!,
      turn: turn!,
      fence,
      signal,
      status,
      observation,
      reconciliation,
    });
  }

  private async settleTerminal(context: TerminalContext): Promise<boolean> {
    if (this.parkedOnInteraction(context.turn)) return true;
    if (context.status === "missing" || context.status === "incompatible") {
      return this.failAndRetire(
        context.controller,
        context.turn,
        context.fence,
        context.status === "missing"
          ? "Controller conversation became unavailable"
          : "Controller provider became incompatible",
      ) === "retired";
    }
    let accepted: ReturnType<TelegramAgentStore["getAcceptedControllerFinalization"]>;
    try {
      accepted = this.dependencies.store.getAcceptedControllerFinalization(context.turn.id);
    } catch {
      return this.failAndRetire(
        context.controller,
        context.turn,
        context.fence,
        "Controller accepted finalization storage is invalid",
      ) === "retired";
    }
    if (accepted !== null) return await this.completeAcceptedFinalization(context);
    if (context.status === "error") return await this.settleUnfinalizedError(context);
    return await this.sendCompletionContinuation(context);
  }

  private async completeAcceptedFinalization(context: TerminalContext): Promise<boolean> {
    const highWater = await this.terminalHighWaterMatches(context);
    if (highWater !== "matched") return highWater === "retired";
    const completion = this.dependencies.store.completeControllerTurnFromFinalization({
      ...fenceAt(context.fence, this.dependencies.clock.now()),
      turnId: context.turn.id,
      controllerKey: context.turn.controllerKey,
    });
    if (completion === "stale") return false;
    if (completion === "evidence_advanced") {
      return this.failAndRetire(
        context.controller,
        context.turn,
        context.fence,
        "Controller evidence advanced after finalization",
      ) === "retired";
    }
    if (context.status === "error") {
      return this.dependencies.store.resetControllerThread({
        ...fenceAt(context.fence, this.dependencies.clock.now()),
        controllerKey: context.controller.controllerKey,
        expectedThreadId: context.controller.threadId!,
        reason: "Provider turn failed after accepted finalization",
      });
    }
    return true;
  }

  private async settleUnfinalizedError(context: TerminalContext): Promise<boolean> {
    let observation: TerminalContext["observation"] | null = context.observation;
    if (context.turn.bbEventSeq !== context.turn.dispatchAfterSeq) {
      try {
        observation = await this.dependencies.adapter.events(
          context.controller.threadId!,
          context.turn.dispatchAfterSeq,
          context.signal,
        );
      } catch {
        return this.retirePersistentBoundary({
          controller: context.controller,
          turn: context.turn,
          fence: context.fence,
          signal: context.signal,
          failureSummary: "Controller provider error baseline remained unavailable",
        });
      }
    }
    if (observation !== null && !observation.inputAccepted && context.turn.retryCount === 0) {
      if (this.dependencies.store.retryUnacceptedControllerTurn({
        ...fenceAt(context.fence, this.dependencies.clock.now()),
        turnId: context.turn.id,
        controllerKey: context.controller.controllerKey,
        expectedThreadId: context.controller.threadId!,
      })) return true;
      let accepted: ReturnType<TelegramAgentStore["getAcceptedControllerFinalization"]>;
      try {
        accepted = this.dependencies.store.getAcceptedControllerFinalization(context.turn.id);
      } catch {
        return this.failAndRetire(
          context.controller,
          context.turn,
          context.fence,
          "Controller accepted finalization storage is invalid",
        ) === "retired";
      }
      if (accepted !== null) return await this.settleAcceptedWinner(context);
    }
    const failed = this.failAndRetireUnaccepted(context, "Controller provider turn failed");
    if (failed === "retired") return true;
    if (failed === "stale") return false;
    return await this.settleAcceptedWinner(context);
  }

  private async sendCompletionContinuation(context: TerminalContext): Promise<boolean> {
    let latestSeq: number;
    try {
      latestSeq = await this.dependencies.adapter.latestSeq(context.controller.threadId!, context.signal);
    } catch {
      return this.retirePersistentBoundary({
        controller: context.controller,
        turn: context.turn,
        fence: context.fence,
        signal: context.signal,
        failureSummary: "Controller continuation boundary remained unavailable",
      });
    }
    if (context.reconciliation !== null &&
        (context.reconciliation.targetSeq === null || context.reconciliation.targetSeq !== latestSeq)) return false;
    const claim = this.claimCompletionContinuation(context, latestSeq);
    if (claim === "stale") return false;
    if (claim !== "claimed") return true;
    if (!this.dependencies.store.isExecutorLeaseCurrent(
      context.fence.ownerId,
      context.fence.generation,
      this.dependencies.clock.now(),
    )) return false;
    try {
      await this.dependencies.adapter.send(
        context.controller.threadId!,
        CONTROLLER_COMPLETION_RECOVERY_PROMPT,
        context.signal,
      );
    } catch {
      return this.failAndRetire(
        context.controller,
        context.turn,
        context.fence,
        "Controller continuation send outcome is uncertain",
      ) === "retired";
    }
    return true;
  }

  private claimCompletionContinuation(
    context: TerminalContext,
    latestSeq: number,
  ): CompletionContinuationClaim {
    let claim: Exclude<CompletionContinuationClaim, "failed">;
    try {
      claim = this.dependencies.store.claimControllerCompletionContinuation({
        ...fenceAt(context.fence, this.dependencies.clock.now()),
        turnId: context.turn.id,
        controllerKey: context.turn.controllerKey,
        bbHighWaterSeq: latestSeq,
      });
    } catch {
      return this.failAndRetire(
        context.controller,
        context.turn,
        context.fence,
        "Controller continuation claim failed",
      ) === "retired" ? "failed" : "stale";
    }
    if (claim === "already_claimed") {
      return this.failAndRetire(
        context.controller,
        context.turn,
        context.fence,
        "Controller continuation ended without finalization",
      ) === "retired" ? "failed" : "stale";
    }
    return claim;
  }

  /**
   * Hands BB the one decision the owner already made. A BB failure here is not
   * terminal: the answer stays durable and the next pass tries again, because
   * losing it would leave the thread waiting on an owner who has already
   * replied.
   */
  private async deliverOwnerAnswer(
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      return await this.dependencies.interactionService.deliverAnswered({
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: this.dependencies.clock.now(),
        controllerKey: controller.controllerKey,
        signal,
      });
    } catch {
      return false;
    }
  }

  /**
   * A thread BB has lost can never settle what is parked on it, so the owner is
   * told once instead of holding dead buttons forever. Only a proven missing or
   * incompatible thread retires a parked turn; elapsed time never does, because
   * a parked turn's idle time is the owner's thinking time.
   */
  private async retireParkedOnLostThread(
    controller: ControllerThreadRecord,
    turn: ControllerTurnRecord,
    fence: EffectFence,
    signal: AbortSignal,
    observed?: ControllerStatus,
  ): Promise<boolean> {
    let status = observed;
    if (status === undefined) {
      try {
        status = await this.dependencies.adapter.status(controller.threadId!, signal);
      } catch {
        return false;
      }
    }
    return this.retireLostThread(controller, turn, fence, status);
  }

  private retireLostThread(
    controller: ControllerThreadRecord,
    turn: ControllerTurnRecord,
    fence: EffectFence,
    status: ControllerStatus | undefined,
  ): boolean {
    if (status !== "missing" && status !== "incompatible") return false;
    return this.failAndRetire(
      controller,
      turn,
      fence,
      status === "missing"
        ? "Controller conversation became unavailable"
        : "Controller provider became incompatible",
    ) === "retired";
  }

  /**
   * Turns lifecycle references into durable rows. The inline event is only a
   * hint: each pending reference is fenced, fetched from BB, and projected
   * before anything is stored or shown. Returns false when the boundary could
   * not be read, so the caller leaves the event cursor where it was.
   */
  private async observeInteractions(
    controller: ControllerThreadRecord,
    turn: ControllerTurnRecord,
    references: readonly ControllerInteractionReference[],
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (references.length === 0) return true;
    const generation = this.dependencies.store.getOpenControllerGeneration(
      controller.controllerKey,
      controller.threadId!,
    );
    if (!generation) return false;
    const settle = (interactionId: string): boolean => {
      const settled = this.dependencies.store.markControllerInteractionResolved({
        ...fenceAt(fence, this.dependencies.clock.now()),
        interactionId,
        turnId: turn.id,
        bbThreadId: controller.threadId!,
      });
      // Refusing to settle a row this turn is parked on would consume BB's
      // only word that the block is over. A reference for something never
      // recorded is ordinary and settles nothing. The parked id is re-read
      // because settling an earlier reference in this window promotes it.
      return settled || this.awaitingInteractionId(turn) !== interactionId;
    };
    for (const reference of references) {
      if (reference.status !== "pending") {
        if (!settle(reference.interactionId)) return false;
        continue;
      }
      const source = {
        ...fenceAt(fence, this.dependencies.clock.now()),
        turnId: turn.id,
        controllerKey: controller.controllerKey,
        bbThreadId: controller.threadId!,
        controllerGenerationId: generation.id,
      };
      if (!this.dependencies.store.controllerInteractionSourceCanRecord(source)) return false;
      let fetched: ControllerInteractionFetch;
      try {
        fetched = await this.dependencies.interactionService.fetchPending({
          bbThreadId: controller.threadId!,
          interactionId: reference.interactionId,
          signal,
        });
      } catch {
        return false;
      }
      // Nothing was established about this block, so the pass may not claim to
      // have read past the event that named it.
      if (fetched.outcome === "invalid") return false;
      // The stream still called it open, but BB says otherwise and BB is the
      // authority. Settling here is safe, and a no-op when nothing is recorded.
      if (fetched.outcome === "settled") {
        if (!settle(reference.interactionId)) return false;
        continue;
      }
      // A refused record means the fence moved or the row disagrees with what
      // BB just returned. Advancing the cursor past it would lose the owner's
      // only view of the block, so the pass fails instead.
      if (!this.dependencies.store.recordControllerInteraction({
        ...source,
        now: this.dependencies.clock.now(),
        interaction: fetched.interaction,
      })) return false;
    }
    return true;
  }

  /** The interaction the turn is parked on right now, not when the pass began. */
  private awaitingInteractionId(turn: ControllerTurnRecord): string | null {
    return this.dependencies.store.getControllerTurn(turn.id)?.awaitingInteractionId ?? null;
  }

  /**
   * True while the exact submitted turn still has an interaction the owner has
   * not settled, or one they settled that BB has not been told about yet.
   */
  private parkedOnInteraction(turn: ControllerTurnRecord): boolean {
    return this.dependencies.store.hasActiveControllerInteraction(turn.id, turn.controllerKey);
  }

  private async terminalHighWaterMatches(context: TerminalContext): Promise<TerminalHighWaterOutcome> {
    if (context.reconciliation?.targetSeq === null) return "deferred";
    let latestSeq: number;
    try {
      latestSeq = await this.dependencies.adapter.latestSeq(context.controller.threadId!, context.signal);
    } catch {
      return this.retirePersistentBoundary({
        controller: context.controller,
        turn: context.turn,
        fence: context.fence,
        signal: context.signal,
        failureSummary: "Controller finalization boundary remained unavailable",
      }) ? "retired" : "deferred";
    }
    return context.reconciliation === null ||
      (context.reconciliation.targetSeq === latestSeq &&
        context.turn.evidenceEventSeq === context.reconciliation.targetSeq)
      ? "matched"
      : "deferred";
  }

  private validAdoptedTurn(
    turn: ControllerTurnRecord | null,
    liveController: ControllerThreadRecord | null,
    fence: EffectFence,
    requested: ControllerThreadRecord,
  ): boolean {
    if (!turn || turn.state !== "submitted") return false;
    if (!liveController || liveController.state !== "active" ||
        liveController.threadId !== requested.threadId ||
        liveController.controllerKey !== requested.controllerKey ||
        turn.controllerKey !== liveController.controllerKey) return false;
    if (turn.leaseOwner !== fence.ownerId || turn.leaseGeneration !== fence.generation) return false;
    return true;
  }

  private failAndRetire(
    controller: ControllerThreadRecord,
    turn: ControllerTurnRecord,
    fence: EffectFence,
    error: string,
  ): FailAndRetireOutcome {
    return this.dependencies.store.failAndRetireControllerTurn({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      controllerKey: turn.controllerKey,
      expectedThreadId: controller.threadId!,
      error,
      expectedAcceptedFinalizationId: turn.acceptedFinalizationId,
    });
  }

  private failAndRetireUnaccepted(context: TerminalContext, error: string): FailAndRetireOutcome {
    return this.dependencies.store.failAndRetireControllerTurn({
      ...fenceAt(context.fence, this.dependencies.clock.now()),
      turnId: context.turn.id,
      controllerKey: context.turn.controllerKey,
      expectedThreadId: context.controller.threadId!,
      error,
      expectedAcceptedFinalizationId: null,
    });
  }

  private async settleAcceptedWinner(context: TerminalContext): Promise<boolean> {
    const turn = this.dependencies.store.getControllerTurn(context.turn.id);
    const controller = this.dependencies.store.getControllerByThreadId(context.controller.threadId!);
    if (!this.validAdoptedTurn(turn, controller, context.fence, context.controller)) return false;
    if (this.parkedOnInteraction(turn!)) return true;
    let accepted: ReturnType<TelegramAgentStore["getAcceptedControllerFinalization"]>;
    try {
      accepted = this.dependencies.store.getAcceptedControllerFinalization(turn!.id);
    } catch {
      return this.failAndRetire(
        controller!,
        turn!,
        context.fence,
        "Controller accepted finalization storage is invalid",
      ) === "retired";
    }
    if (accepted === null) return false;
    return await this.completeAcceptedFinalization({ ...context, controller: controller!, turn: turn! });
  }

  private retirePersistentBoundary(context: BoundaryFailureContext): boolean {
    if (context.signal.aborted) return false;
    // A turn waiting on a person produces no events, so its idle time is the
    // owner's thinking time rather than evidence of a wedged thread. Measuring
    // a boundary failure against it would fail a turn the owner is still
    // answering, and take their live Telegram buttons down with it. Only a
    // thread BB has provably lost ends a parked turn.
    if (this.parkedOnInteraction(context.turn)) {
      return this.retireLostThread(context.controller, context.turn, context.fence, context.observedStatus);
    }
    if (this.dependencies.clock.now() - context.turn.updatedAt < CONTROLLER_STALL_MS) return false;
    return this.failAndRetire(
      context.controller,
      context.turn,
      context.fence,
      context.failureSummary,
    ) === "retired";
  }

  private projectorFailure(error: ControllerEvidenceProjectorError): string {
    switch (error.code) {
      case "source_identity_invalid": return "Controller provider identity became invalid";
      case "source_event_invalid": return "Controller provider reported an invalid event boundary";
      case "native_identity_conflict": return "Controller native evidence conflicted in identity";
      case "cursor_conflict": return "Controller evidence cursor conflicted during projection";
    }
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
    return this.failAndRetire(controller, turn, fence, "Controller turn exceeded its budget") === "retired";
  }

  private async spawnOrAdopt(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<ControllerLocation | null> {
    let candidate: ControllerLocation | null = null;
    // Image turns never adopt by title before attempting their own spawn. A
    // title match cannot prove that the image was attached, and adopting it
    // would silently drop the image. Recovery after an uncertain actual spawn
    // remains available in the catch block below.
    if (!turn.image) {
      try {
        candidate = await this.dependencies.adapter.findSpawnCandidate(controller.controllerKey, signal);
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
      return await this.dependencies.adapter.spawn(seeded, controller, signal);
    } catch (error) {
      if (this.handleImagePreparationError(error, turn, fence, signal)) return null;
      try {
        candidate = await this.dependencies.adapter.findSpawnCandidate(controller.controllerKey, signal);
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
