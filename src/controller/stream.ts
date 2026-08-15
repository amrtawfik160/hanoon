import type { ControllerEventObservation, ControllerEventResult } from "./bb-controller";
import { CONTROLLER_PHASE_TEXT, type ControllerStreamPhase } from "./models";

export type ControllerStreamState = {
  cursor: number;
  text: string;
  phase: ControllerStreamPhase;
};

function nextStreamPhase(
  observation: ControllerEventObservation,
  prior: ControllerStreamPhase,
): ControllerStreamPhase {
  if (observation.failure !== null && !observation.failure.willRetry) return "failed";
  if (observation.completed) return "complete";
  if (observation.assistantOutputObserved) return "responding";
  if (observation.toolActivityObserved) return "using_tools";
  if (observation.inputAccepted) return "thinking";
  return prior;
}

export function normalizeControllerEventObservation(
  observation: ControllerEventResult,
): ControllerEventObservation {
  const modern = observation as ControllerEventObservation;
  if ("failure" in observation && typeof modern.assistantOutputObserved === "boolean" &&
      typeof modern.toolActivityObserved === "boolean") {
    return {
      latestSeq: modern.latestSeq,
      inputAccepted: modern.inputAccepted,
      assistantOutputObserved: modern.assistantOutputObserved,
      toolActivityObserved: modern.toolActivityObserved,
      completed: modern.completed,
      failure: modern.failure,
      assistantDraft: modern.assistantDraft,
      interactionReferences: modern.interactionReferences ?? [],
      toolCalls: modern.toolCalls,
      commandFailures: modern.commandFailures,
      totalTokens: modern.totalTokens,
    };
  }
  const legacy = observation as ControllerEventResult & { error: string | null };
  return {
    latestSeq: legacy.latestSeq,
    inputAccepted: legacy.inputAccepted,
    assistantOutputObserved: typeof legacy.assistantOutputObserved === "boolean"
      ? legacy.assistantOutputObserved
      : false,
    toolActivityObserved: typeof legacy.toolActivityObserved === "boolean"
      ? legacy.toolActivityObserved
      : false,
    completed: legacy.completed,
    failure: legacy.error === null ? null : {
      code: "unknown",
      retryable: true,
      willRetry: false,
      inputAccepted: legacy.inputAccepted,
    },
    assistantDraft: null,
    interactionReferences: legacy.interactionReferences ?? [],
    toolCalls: legacy.toolCalls,
    commandFailures: legacy.commandFailures,
    totalTokens: legacy.totalTokens,
  };
}

export function projectControllerStream(
  observation: ControllerEventObservation,
  prior: ControllerStreamState,
): ControllerStreamState {
  if (observation.latestSeq <= prior.cursor) return prior;
  const phase = nextStreamPhase(observation, prior.phase);
  return {
    cursor: observation.latestSeq,
    text: CONTROLLER_PHASE_TEXT[phase],
    phase,
  };
}
