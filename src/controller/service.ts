import type { TelegramAgentStore } from "../storage/store";
import type { EffectFence } from "../services/effect-runner";
import type { ControllerAdapter, ControllerLocation, ControllerStatus } from "./bb-controller";
import type { ControllerThreadRecord, ControllerTurnRecord } from "./models";
import { projectControllerStream } from "./stream";

export type LunaControllerServiceDependencies = {
  store: TelegramAgentStore;
  adapter: ControllerAdapter;
  clock: { now(): number };
};

const CONTROLLER_DRAFT_REFRESH_MS = 20_000;

function boundedResponse(value: string): string | null {
  const text = value.trim();
  if (text.length === 0) return null;
  return text.length <= 4_000 ? text : text.slice(0, 3_999) + "…";
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
      if (status === "missing" || status === "error") {
        if (!this.dependencies.store.resetControllerThread({
          ...fenceAt(fence, this.dependencies.clock.now()),
          controllerKey: controller.controllerKey,
          expectedThreadId: controller.threadId,
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
          this.fail(turn, fence, "Controller thread was not idle for a new turn");
          return true;
        }
        let dispatchAfterSeq: number;
        try {
          dispatchAfterSeq = (await this.dependencies.adapter.events(controller.threadId, 0, signal)).latestSeq;
        } catch {
          this.fail(turn, fence, "Controller event baseline could not be verified");
          return true;
        }
        try {
          await this.dependencies.adapter.send(controller.threadId, turn.inputText, signal);
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

  public async reconcile(fence: EffectFence, signal: AbortSignal): Promise<boolean> {
    if (this.dependencies.store.failStaleControllerDispatches(
      fenceAt(fence, this.dependencies.clock.now()),
    )) return true;
    const owner = this.dependencies.store.getOwner();
    if (!owner) return false;
    const controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!controller?.threadId) return false;
    const submitted = this.dependencies.store
      .listControllerTurns(controller.controllerKey, 1_000)
      .find((turn) => turn.state === "submitted");
    if (!submitted) {
      let status: ControllerStatus;
      try {
        status = await this.dependencies.adapter.status(controller.threadId, signal);
      } catch {
        return false;
      }
      if (status !== "missing" && status !== "error") return false;
      return this.dependencies.store.resetControllerThread({
        ...fenceAt(fence, this.dependencies.clock.now()),
        controllerKey: controller.controllerKey,
        expectedThreadId: controller.threadId,
      });
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
    const refreshedAt = this.dependencies.clock.now();
    this.dependencies.store.refreshControllerDraft({
      ...fenceAt(fence, refreshedAt),
      turnId: submitted.id,
      sentBefore: Math.max(0, refreshedAt - CONTROLLER_DRAFT_REFRESH_MS),
    });
    if (status === "active" || status === "starting" || status === "stopping") return true;
    if (status === "missing") {
      this.dependencies.store.resetControllerThread({
        ...fenceAt(fence, this.dependencies.clock.now()),
        controllerKey: controller.controllerKey,
        expectedThreadId: controller.threadId,
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
      }
      this.dependencies.store.resetControllerThread({
        ...fenceAt(fence, this.dependencies.clock.now()),
        controllerKey: controller.controllerKey,
        expectedThreadId: controller.threadId,
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
    try {
      return await this.dependencies.adapter.spawn(turn, controller, signal);
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

  private fail(turn: ControllerTurnRecord, fence: EffectFence, error: string): void {
    this.dependencies.store.failControllerTurn({
      ...fenceAt(fence, this.dependencies.clock.now()),
      turnId: turn.id,
      error,
    });
  }
}
