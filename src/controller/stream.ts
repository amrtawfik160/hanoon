import type { ControllerEventObservation } from "./bb-controller";
import type { ControllerStreamPhase } from "./models";

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
  if (observation.assistantDelta.length > 0) return "responding";
  if (observation.inputAccepted) return "thinking";
  return prior;
}

export function projectControllerStream(
  observation: ControllerEventObservation,
  prior: ControllerStreamState,
): ControllerStreamState {
  if (observation.latestSeq <= prior.cursor) return prior;
  const combined = `${prior.text}${observation.assistantDelta}`;
  const characters = Array.from(combined);
  const text = characters.length <= 3_900
    ? combined
    : characters.slice(characters.length - 3_900).join("");
  return {
    cursor: observation.latestSeq,
    text,
    phase: nextStreamPhase(observation, prior.phase),
  };
}
