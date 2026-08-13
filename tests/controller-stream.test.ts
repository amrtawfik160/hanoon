import { describe, expect, it } from "vitest";
import { controllerDraftPreview, projectControllerStream } from "../src/controller/stream";

describe("controller draft preview", () => {
  it("keeps provider-neutral progress visible when no tokens have arrived", () => {
    expect(controllerDraftPreview({ streamText: "", streamPhase: "connecting" }))
      .toBe("Connecting…");
    expect(controllerDraftPreview({ streamText: "", streamPhase: "thinking" }))
      .toBe("Thinking…");
    expect(controllerDraftPreview({ streamText: "", streamPhase: "using_tools" }))
      .toBe("Working…");
    expect(controllerDraftPreview({
      streamText: "",
      streamPhase: "connecting",
      fallbackText: "Connecting…",
    })).toBe("Connecting…");
    expect(controllerDraftPreview({ streamText: "Checking the webhook", streamPhase: "thinking" }))
      .toBe("Checking the webhook");
  });
});

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

  it("streams a public thinking summary, then replaces it with the answer", () => {
    const thinking = projectControllerStream({
      latestSeq: 4,
      inputAccepted: true,
      assistantDelta: "",
      thinkingDelta: "Checking the webhook",
      completed: false,
      error: null,
      pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0,
    }, {
      cursor: 1,
      text: "",
      phase: "connecting",
    });
    expect(thinking).toEqual({
      cursor: 4,
      text: "Checking the webhook",
      phase: "thinking",
    });

    expect(projectControllerStream({
      latestSeq: 7,
      inputAccepted: true,
      assistantDelta: "I'll fix the signer.",
      thinkingDelta: "",
      completed: false,
      error: null,
      pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0,
    }, thinking)).toEqual({
      cursor: 7,
      text: "I'll fix the signer.",
      phase: "responding",
    });
  });

  it("marks a tool-using turn without treating it as a finished answer", () => {
    expect(projectControllerStream({
      latestSeq: 5,
      inputAccepted: true,
      assistantDelta: "",
      thinkingDelta: "",
      completed: false,
      error: null,
      pendingQuestion: null, toolCalls: 1, commandFailures: 0, totalTokens: 0,
    }, {
      cursor: 4,
      text: "Checking the webhook",
      phase: "thinking",
    })).toEqual({
      cursor: 5,
      text: "Checking the webhook",
      phase: "using_tools",
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
