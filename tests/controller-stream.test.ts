import { describe, expect, it } from "vitest";
import { projectControllerStream } from "../src/controller/stream";
import { CONTROLLER_PHASE_TEXT, type ControllerStreamPhase } from "../src/controller/models";
import type { ControllerEventObservation } from "../src/controller/bb-controller";

const EMPTY: ControllerEventObservation = {
  latestSeq: 0,
  inputAccepted: false,
  assistantOutputObserved: false,
  toolActivityObserved: false,
  completed: false,
  error: null,
  interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
};

describe("controller stream projection", () => {
  it("uses the exact seven Hanoon phase literals from the authoritative plan", () => {
    expect(CONTROLLER_PHASE_TEXT).toEqual({
      queued: "Queued…",
      connecting: "Connecting to Hanoon…",
      thinking: "Hanoon is thinking…",
      using_tools: "Hanoon is checking the current state…",
      responding: "Hanoon is preparing the answer…",
      complete: "Hanoon finished.",
      failed: "Hanoon could not finish safely.",
    });
  });

  it("treats assistant output and tool activity as phase observations, never as text", () => {
    const projected = projectControllerStream({
      ...EMPTY,
      latestSeq: 13,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: true,
    }, {
      cursor: 10,
      text: "legacy raw prose that must be discarded",
      phase: "connecting",
    });

    // The draft is phase-only: raw provider prose never becomes the draft text.
    expect(projected.cursor).toBe(13);
    expect(projected.phase).toBe("responding");
    expect(projected.text).toBe(CONTROLLER_PHASE_TEXT.responding);
    expect(projected.text).not.toContain("legacy raw prose");
  });

  it("applies the phase priority assistant output > tool activity > input accepted", () => {
    const responding = projectControllerStream({
      ...EMPTY,
      latestSeq: 5,
      inputAccepted: true,
      toolActivityObserved: true,
      assistantOutputObserved: true,
    }, { cursor: 0, text: CONTROLLER_PHASE_TEXT.thinking, phase: "thinking" });
    expect(responding).toMatchObject({ phase: "responding", text: CONTROLLER_PHASE_TEXT.responding });

    const tooling = projectControllerStream({
      ...EMPTY,
      latestSeq: 6,
      inputAccepted: true,
      toolActivityObserved: true,
    }, { cursor: 5, text: CONTROLLER_PHASE_TEXT.thinking, phase: "thinking" });
    expect(tooling).toMatchObject({ phase: "using_tools", text: CONTROLLER_PHASE_TEXT.using_tools });

    const thinking = projectControllerStream({
      ...EMPTY,
      latestSeq: 7,
      inputAccepted: true,
    }, { cursor: 6, text: CONTROLLER_PHASE_TEXT.connecting, phase: "connecting" });
    expect(thinking).toMatchObject({ phase: "thinking", text: CONTROLLER_PHASE_TEXT.thinking });
  });

  // Table-driven proof of the authoritative phase priority:
  // error > completed event > assistant output > tool activity > input
  // accepted > prior phase. Each row supplies the observation that dominates;
  // every lower-level flag is also set so only the priority can decide.
  it.each([
    ["error beats completed", { error: "x", completed: true, assistantOutputObserved: true, toolActivityObserved: true, inputAccepted: true }, "failed"],
    ["completed event beats every output signal", { error: null, completed: true, assistantOutputObserved: true, toolActivityObserved: true, inputAccepted: true }, "complete"],
    ["assistant output beats tool activity and input", { error: null, completed: false, assistantOutputObserved: true, toolActivityObserved: true, inputAccepted: true }, "responding"],
    ["tool activity beats input accepted", { error: null, completed: false, assistantOutputObserved: false, toolActivityObserved: true, inputAccepted: true }, "using_tools"],
    ["input accepted beats the prior phase", { error: null, completed: false, assistantOutputObserved: false, toolActivityObserved: false, inputAccepted: true }, "thinking"],
    ["prior phase holds when nothing is observed", { error: null, completed: false, assistantOutputObserved: false, toolActivityObserved: false, inputAccepted: false }, "connecting"],
  ] as const)("%s", (_label, flags, expectedPhase) => {
    const projected = projectControllerStream({
      ...EMPTY,
      latestSeq: 20,
      inputAccepted: flags.inputAccepted,
      assistantOutputObserved: flags.assistantOutputObserved,
      toolActivityObserved: flags.toolActivityObserved,
      completed: flags.completed,
      error: flags.error,
    }, { cursor: 19, text: CONTROLLER_PHASE_TEXT.connecting, phase: "connecting" });
    expect(projected).toMatchObject({ phase: expectedPhase, text: CONTROLLER_PHASE_TEXT[expectedPhase] });
  });

  it("reports failed and complete from the observed error/completion events", () => {
    const failed = projectControllerStream({
      ...EMPTY,
      latestSeq: 8,
      assistantOutputObserved: true,
      error: "Controller provider turn failed",
    }, { cursor: 0, text: CONTROLLER_PHASE_TEXT.responding, phase: "responding" });
    expect(failed).toMatchObject({ phase: "failed", text: CONTROLLER_PHASE_TEXT.failed });

    const complete = projectControllerStream({
      ...EMPTY,
      latestSeq: 9,
      completed: true,
    }, { cursor: 8, text: CONTROLLER_PHASE_TEXT.responding, phase: "responding" });
    expect(complete).toMatchObject({ phase: "complete", text: CONTROLLER_PHASE_TEXT.complete });
  });

  it("normalizes replayed legacy text from the durable phase without advancing", () => {
    const prior = { cursor: 13, text: "raw pre-cutover provider prose", phase: "responding" as ControllerStreamPhase };
    const projected = projectControllerStream({
      ...EMPTY,
      latestSeq: 13,
      assistantOutputObserved: true,
    }, prior);

    expect(projected).toEqual({
      cursor: 13,
      phase: "responding",
      text: CONTROLLER_PHASE_TEXT.responding,
    });
  });

  it("never exposes raw assistant output in any projected text", () => {
    const projected = projectControllerStream({
      ...EMPTY,
      latestSeq: 2,
      inputAccepted: true,
      assistantOutputObserved: true,
    }, {
      cursor: 0,
      text: "pre-cutover stream_text that leaked before",
      phase: "thinking",
    });

    expect(projected.text).toBe(CONTROLLER_PHASE_TEXT.responding);
    expect(projected.text).not.toContain("pre-cutover");
    expect(projected.text).not.toContain("leaked");
  });
});
