import { describe, expect, it } from "vitest";
import { normalizeControllerEventObservation, projectControllerStream } from "../src/controller/stream";
import { CONTROLLER_PHASE_TEXT } from "../src/controller/models";

describe("controller stream projection", () => {
  it("has a nonempty exact Hanoon phase map", () => {
    expect(CONTROLLER_PHASE_TEXT).toEqual({
      queued: "Hanoon is queued…",
      connecting: "Hanoon is connecting…",
      thinking: "Hanoon is thinking…",
      using_tools: "Hanoon is using tools…",
      responding: "Hanoon is responding…",
      complete: "Hanoon completed.",
      failed: "Hanoon failed.",
    });
  });

  it("records assistant output as phase evidence without retaining provider prose", () => {
    const projected = projectControllerStream({
      latestSeq: 13,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: false,
      error: null,
      interactionReferences: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
    }, {
      cursor: 10,
      text: "",
      phase: "connecting",
    });

    expect(projected).toEqual({
      cursor: 13,
      text: "Hanoon is responding…",
      phase: "responding",
    });
  });

  it("ignores a replay at or behind the durable cursor", () => {
    const projected = projectControllerStream({
      latestSeq: 13,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: false,
      error: null,
      interactionReferences: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
    }, {
      cursor: 13,
      text: "Hello world",
      phase: "responding",
    });

    expect(projected).toEqual({
      cursor: 13,
      text: "Hello world",
      phase: "responding",
    });
  });

  it("uses deterministic tool phase text instead of provider output", () => {
    const projected = projectControllerStream({
      latestSeq: 2,
      inputAccepted: true,
      assistantOutputObserved: false,
      toolActivityObserved: true,
      completed: false,
      error: null,
      interactionReferences: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
    }, {
      cursor: 0,
      text: "",
      phase: "thinking",
    });

    expect(projected).toEqual({
      cursor: 2,
      text: "Hanoon is using tools…",
      phase: "using_tools",
    });
  });

  it("preserves bounded interaction references during live normalization", () => {
    expect(normalizeControllerEventObservation({
      latestSeq: 4,
      inputAccepted: true,
      assistantOutputObserved: false,
      toolActivityObserved: false,
      completed: false,
      error: null,
      interactionReferences: [{ interactionId: "interaction-1", kind: "approval", status: "pending" }],
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })).toMatchObject({
      interactionReferences: [{ interactionId: "interaction-1", kind: "approval", status: "pending" }],
    });
  });
});
