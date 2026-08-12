import type { TelegramAgentStore } from "../storage/store";
import type { EffectFence } from "../services/effect-runner";
import {
  ControllerImagePreparationError,
  type ControllerAdapter,
  type ControllerLocation,
  type ControllerStatus,
} from "./bb-controller";
import type { ControllerThreadRecord, ControllerTurnRecord } from "./models";
import { projectControllerStream } from "./stream";
import { buildTurnContext, composeTurnInput } from "./context";
import { evaluateSupervisor } from "./supervisor";

export type LunaControllerServiceDependencies = {
  store: TelegramAgentStore;
  adapter: ControllerAdapter;
  clock: { now(): number };
};

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

function boundedResponse(value: string): string | null {
  const text = value.trim();
  if (text.length === 0) return null;
  return text.length <= 4_000 ? text : text.slice(0, 3_999) + "…";
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
    const controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
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

    // An answer the owner already gave outranks anything else: until BB hears
    // it, the thread cannot make progress and every other check is noise.
    const ownerAnswer = this.dependencies.store.getAnsweredControllerQuestion(controller.controllerKey);
    if (ownerAnswer) {
      try {
        await this.dependencies.adapter.answerQuestion(
          controller.threadId,
          ownerAnswer.interactionId,
          ownerAnswer.answers,
          signal,
        );
      } catch {
        return false;
      }
      this.dependencies.store.markControllerQuestionDelivered({
        ...fenceAt(fence, this.dependencies.clock.now()),
        interactionId: ownerAnswer.interactionId,
      });
      return true;
    }

    let status: ControllerStatus;
    try {
      status = await this.dependencies.adapter.status(controller.threadId, signal);
    } catch {
      return false;
    }
    let observation: Awaited<ReturnType<ControllerAdapter["events"]>> | null = null;
    try {
      observation = await this.dependencies.adapter.events(
        controller.threadId,
        submitted.bbEventSeq,
        signal,
      );
      const projected = projectControllerStream(observation, {
        cursor: submitted.bbEventSeq,
        text: submitted.streamText,
        phase: submitted.streamPhase,
      });
      if (projected.cursor > submitted.bbEventSeq) {
        this.dependencies.store.updateControllerStream({
          ...fenceAt(fence, this.dependencies.clock.now()),
          turnId: submitted.id,
          cursor: projected.cursor,
          text: projected.text,
          phase: projected.phase,
          toolCalls: observation.toolCalls,
          commandFailures: observation.commandFailures,
          totalTokens: observation.totalTokens,
        });
      }
    } catch {
      observation = null;
    }
    if (observation?.pendingQuestion) {
      this.dependencies.store.recordControllerQuestion({
        ...fenceAt(fence, this.dependencies.clock.now()),
        turnId: submitted.id,
        interactionId: observation.pendingQuestion.interactionId,
        questions: observation.pendingQuestion.questions,
      });
    }
    const refreshedAt = this.dependencies.clock.now();
    // A turn parked on a question is waiting on a person. Redrawing its draft
    // would only replace the question with stale half-written output.
    const parked = this.dependencies.store.getControllerTurn(submitted.id)?.awaitingInteractionId ?? null;
    if (parked === null) {
      this.dependencies.store.refreshControllerDraft({
        ...fenceAt(fence, refreshedAt),
        turnId: submitted.id,
        sentBefore: Math.max(0, refreshedAt - CONTROLLER_DRAFT_REFRESH_MS),
      });
    }
    if (status === "active" || status === "starting" || status === "stopping") {
      // Anything the owner says while an answer is being written belongs to that
      // answer. Holding it back until the turn ends is how a correction arrives
      // too late to correct anything.
      const waiting = parked === null
        ? this.dependencies.store.getQueuedControllerTurn(controller.controllerKey)
        : null;
      if (waiting && !waiting.image && waiting.retryCount < MAX_STEER_ATTEMPTS) {
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
      if (parked === null && await this.superviseBudget(submitted.id, controller, fence, signal)) {
        return true;
      }
      if (parked === null && refreshedAt - submitted.updatedAt >= CONTROLLER_STALL_MS) {
        // Retiring the thread is the half that matters. Failing only the turn
        // leaves the wedge in place, and every later message then waits out the
        // busy timeout against a thread that will never go idle.
        this.dependencies.store.resetControllerThread({
          ...fenceAt(fence, this.dependencies.clock.now()),
          controllerKey: controller.controllerKey,
          expectedThreadId: controller.threadId,
          reason: "Thread stopped producing events mid-answer",
        });
        this.fail(
          submitted,
          fence,
          "Controller turn stopped producing events",
          "That one stalled, so I gave up on it and started a fresh session. Ask me again.",
        );
      }
      return true;
    }
    if (status === "missing") {
      this.dependencies.store.resetControllerThread({
        ...fenceAt(fence, this.dependencies.clock.now()),
        controllerKey: controller.controllerKey,
        expectedThreadId: controller.threadId,
        reason: "Thread disappeared mid-answer",
      });
      this.fail(submitted, fence, "Controller conversation became unavailable");
      return true;
    }
    if (status === "error") {
      if (observation === null || submitted.bbEventSeq !== submitted.dispatchAfterSeq) {
        try {
          observation = await this.dependencies.adapter.events(
            controller.threadId,
            submitted.dispatchAfterSeq,
            signal,
          );
        } catch {
          observation = null;
        }
      }
      if (observation !== null) {
        if (!observation.inputAccepted && submitted.retryCount === 0) {
          if (this.dependencies.store.retryUnacceptedControllerTurn({
            ...fenceAt(fence, this.dependencies.clock.now()),
            turnId: submitted.id,
            controllerKey: controller.controllerKey,
            expectedThreadId: controller.threadId,
          })) return true;
        }
        // The turn window spans the whole answer here, so an answer BB already
        // finished is delivered even though the thread itself is now unusable.
        const answered = observation.completed && observation.error === null
          ? boundedResponse(observation.assistantDelta)
          : null;
        if (answered && this.dependencies.store.completeControllerTurn({
          ...fenceAt(fence, this.dependencies.clock.now()),
          turnId: submitted.id,
          responseText: answered,
        })) {
          this.dependencies.store.resetControllerThread({
            ...fenceAt(fence, this.dependencies.clock.now()),
            controllerKey: controller.controllerKey,
            expectedThreadId: controller.threadId,
            reason: "Answered, then the provider session errored",
          });
          return true;
        }
      }
      this.dependencies.store.resetControllerThread({
        ...fenceAt(fence, this.dependencies.clock.now()),
        controllerKey: controller.controllerKey,
        expectedThreadId: controller.threadId,
        reason: "Provider turn failed",
      });
      this.fail(submitted, fence, "Controller provider turn failed");
      return true;
    }

    const response = boundedResponse(await this.dependencies.adapter.output(controller.threadId, signal));
    if (!response) {
      this.fail(submitted, fence, "Controller completed without a usable response");
      return true;
    }
    if (!this.dependencies.store.completeControllerTurn({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: submitted.id,
      responseText: response,
    })) {
      throw new Error("Controller turn changed before its response was recorded");
    }
    return true;
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
      totalTokens: turn.totalTokens,
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
    // Retiring the thread is the half that matters: a turn stopped for cost
    // that left its thread alive would let the next message resume the loop.
    this.dependencies.store.resetControllerThread({
      ...fenceAt(fence, this.dependencies.clock.now()),
      controllerKey: controller.controllerKey,
      expectedThreadId: controller.threadId,
      reason: "Turn exceeded its supervisor budget",
    });
    this.fail(turn, fence, "Controller turn exceeded its budget", decision.ownerMessage);
    return true;
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
