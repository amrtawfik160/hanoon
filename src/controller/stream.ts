import type { ControllerEventObservation } from "./bb-controller";
import { CONTROLLER_PHASE_TEXT, type ControllerStreamPhase } from "./models";

export type ControllerStreamState = {
  cursor: number;
  text: string;
  phase: ControllerStreamPhase;
};

const MAX_DRAFT_CHARS = 3_900;

export const CONTROLLER_CONNECTING_PREVIEW = "Connecting…";
export const CONTROLLER_THINKING_PREVIEW = "Thinking…";
export const CONTROLLER_WORKING_PREVIEW = "Working…";

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

function clipDraft(value: string): string {
  const characters = Array.from(value);
  return characters.length <= MAX_DRAFT_CHARS
    ? value
    : characters.slice(characters.length - MAX_DRAFT_CHARS).join("");
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

export function controllerDraftPreview(input: {
  streamText: string;
  streamPhase: ControllerStreamPhase;
  fallbackText?: string;
}): string {
  if (input.streamText.trim().length > 0) return input.streamText;
  if (input.fallbackText && input.fallbackText.trim().length > 0) return input.fallbackText;
  if (input.streamPhase === "thinking") return CONTROLLER_THINKING_PREVIEW;
  if (input.streamPhase === "using_tools") return CONTROLLER_WORKING_PREVIEW;
  return CONTROLLER_CONNECTING_PREVIEW;
}
