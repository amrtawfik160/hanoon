import type { ControllerEventObservation } from "./bb-controller";
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

export function projectControllerStream(
  observation: ControllerEventObservation,
  prior: ControllerStreamState,
): ControllerStreamState {
  if (observation.latestSeq <= prior.cursor) {
    return { ...prior, text: CONTROLLER_PHASE_TEXT[prior.phase] };
  }
  const phase = nextStreamPhase(observation, prior.phase);
  // A draft is phase-only: raw assistant output and any legacy pre-cutover
  // stream text are discarded entirely, so provider prose can never leak into
  // the durable reply, a digest, or a completed response.
  return {
    cursor: observation.latestSeq,
    text: CONTROLLER_PHASE_TEXT[phase],
    phase,
  };
}
