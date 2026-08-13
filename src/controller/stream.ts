import type { ControllerEventObservation } from "./bb-controller";
import type { ControllerStreamPhase } from "./models";

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
  if (observation.assistantDelta.length > 0) return "responding";
  if (observation.toolCalls > 0) return "using_tools";
  if (observation.inputAccepted || (observation.thinkingDelta ?? "").length > 0) return "thinking";
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
  if (observation.latestSeq <= prior.cursor) return prior;
  const phase = nextStreamPhase(observation, prior.phase);
  const thinkingDelta = observation.thinkingDelta ?? "";
  let text = prior.text;
  if (observation.assistantDelta.length > 0) {
    text = prior.phase === "responding"
      ? `${prior.text}${observation.assistantDelta}`
      : observation.assistantDelta;
  } else if (thinkingDelta.length > 0 && phase !== "responding") {
    text = `${prior.text}${thinkingDelta}`;
  }
  return {
    cursor: observation.latestSeq,
    text: clipDraft(text),
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
