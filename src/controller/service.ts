import type { TelegramAgentStore } from "../storage/store";
import type { EffectFence } from "../services/effect-runner";
import type { ControllerAdapter, ControllerLocation, ControllerStatus } from "./bb-controller";
import type { ControllerThreadRecord, ControllerTurnRecord } from "./models";
import { projectControllerStream } from "./stream";
import { buildTurnContext, composeTurnInput } from "./context";

export type LunaControllerServiceDependencies = {
  store: TelegramAgentStore;
  adapter: ControllerAdapter;
  clock: { now(): number };
};

const CONTROLLER_DRAFT_REFRESH_MS = 20_000;
// How long a queued message may wait for a busy controller thread before the
// owner is told it will not be answered.
const CONTROLLER_BUSY_WAIT_MS = 10 * 60_000;
/**
 * How long a submitted turn may go without producing a single BB event before
 * it is treated as wedged. Any event at all — reasoning, a tool call, output —
 * resets this, so only a thread that has genuinely stopped trips it. Silence is
 * the worst answer the owner can get, so it is bounded even when BB still
 * reports the thread as active.
 */
export const CONTROLLER_STALL_MS = 8 * 60_000;
const MAX_STEER_ATTEMPTS = 3;

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
          await this.dependencies.adapter.send(
            controller.threadId,
            this.composeInput(turn, { includeDigest: false }),
            signal,
          );
        } catch {
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
      if (waiting && waiting.retryCount < MAX_STEER_ATTEMPTS) {
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
      if (parked === null && refreshedAt - submitted.updatedAt >= CONTROLLER_STALL_MS) {
        this.fail(
          submitted,
          fence,
          "Controller turn stopped producing events",
          "That one stalled — the thread stopped responding, so I gave up on it. Ask me again and I'll retry.",
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

  private async spawnOrAdopt(
    turn: ControllerTurnRecord,
    controller: ControllerThreadRecord,
    fence: EffectFence,
    signal: AbortSignal,
  ): Promise<ControllerLocation | null> {
    let candidate: ControllerLocation | null;
    try {
      candidate = await this.dependencies.adapter.findSpawnCandidate(controller.controllerKey, signal);
    } catch {
      this.fail(turn, fence, "Controller spawn candidates are ambiguous");
      return null;
    }
    if (candidate) return candidate;
    // A replacement thread opens with the conversation so far, so retiring a
    // failed thread costs the owner a pause rather than the whole conversation.
    const seeded = { ...turn, inputText: this.composeInput(turn, { includeDigest: true }) };
    try {
      return await this.dependencies.adapter.spawn(seeded, controller, signal);
    } catch {
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
