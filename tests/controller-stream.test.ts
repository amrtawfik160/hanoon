import { describe, expect, it } from "vitest";
import { projectControllerStream } from "../src/controller/stream";

describe("controller stream projection", () => {
  it("records assistant output as phase evidence without retaining provider prose", () => {
    const projected = projectControllerStream({
      latestSeq: 13,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: false,
      error: null,
      pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0,
    }, {
      cursor: 10,
      text: "",
      phase: "connecting",
    });

    expect(projected).toEqual({
      cursor: 13,
      text: "Luna Max is responding…",
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
      pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0,
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
      pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0,
    }, {
      cursor: 0,
      text: "",
      phase: "thinking",
    });

    expect(projected).toEqual({
      cursor: 2,
      text: "Luna Max is using tools…",
      phase: "using_tools",
    });
  });
});
