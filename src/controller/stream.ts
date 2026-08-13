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
  if (observation.error !== null) return "failed";
  if (observation.completed) return "complete";
  if (observation.assistantOutputObserved) return "responding";
  if (observation.toolActivityObserved) return "using_tools";
  if (observation.inputAccepted) return "thinking";
  return prior;
}

export function normalizeControllerEventObservation(
  observation: ControllerEventResult,
): ControllerEventObservation {
  if ("assistantOutputObserved" in observation && "toolActivityObserved" in observation &&
      typeof observation.assistantOutputObserved === "boolean" &&
      typeof observation.toolActivityObserved === "boolean") {
    return {
      latestSeq: observation.latestSeq,
      inputAccepted: observation.inputAccepted,
      assistantOutputObserved: observation.assistantOutputObserved,
      toolActivityObserved: observation.toolActivityObserved,
      completed: observation.completed,
      error: observation.error,
      interactionReferences: observation.interactionReferences ?? [],
      toolCalls: observation.toolCalls,
      commandFailures: observation.commandFailures,
      totalTokens: observation.totalTokens,
    };
  }
  return {
    latestSeq: observation.latestSeq,
    inputAccepted: observation.inputAccepted,
    assistantOutputObserved: false,
    toolActivityObserved: false,
    completed: observation.completed,
    error: observation.error,
    interactionReferences: observation.interactionReferences ?? [],
    toolCalls: observation.toolCalls,
    commandFailures: observation.commandFailures,
    totalTokens: observation.totalTokens,
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
