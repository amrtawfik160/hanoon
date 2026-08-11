import { describe, expect, it } from "vitest";
import { projectControllerStream } from "../src/controller/stream";

describe("controller stream projection", () => {
  it("appends only new assistant output and advances from thinking to responding", () => {
    const projected = projectControllerStream({
      latestSeq: 13,
      inputAccepted: true,
      assistantDelta: "Hello world",
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
      text: "Hello world",
      phase: "responding",
    });
  });

  it("ignores a replay at or behind the durable cursor", () => {
    const projected = projectControllerStream({
      latestSeq: 13,
      inputAccepted: true,
      assistantDelta: " duplicate",
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

  it("bounds preview text on Unicode character boundaries and preserves the newest output", () => {
    const projected = projectControllerStream({
      latestSeq: 2,
      inputAccepted: true,
      assistantDelta: `${"a".repeat(3_900)}🙂tail`,
      completed: false,
      error: null,
      pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0,
    }, {
      cursor: 0,
      text: "",
      phase: "thinking",
    });

    expect(Array.from(projected.text)).toHaveLength(3_900);
    expect(projected.text.endsWith("🙂tail")).toBe(true);
  });
});
