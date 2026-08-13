import { describe, expect, it } from "vitest";
import {
  CONTROLLER_UNWATCHED_PROMISE_RESPONSE,
  enforceControllerPromiseGate,
  hasFutureFollowUpPromise,
} from "../src/controller/promise-gate";

describe("controller promise gate", () => {
  it.each([
    "I'll follow up when it finishes.",
    "I will check back shortly.",
    "I’ll keep an eye on it and let you know.",
    "We'll message you when the tests finish.",
  ])("detects an unsupported future check-in: %s", (response) => {
    expect(hasFutureFollowUpPromise(response)).toBe(true);
  });

  it.each([
    "This is not done yet.",
    "I checked it; the tests are still running.",
    "I won't claim this is finished.",
  ])("does not reject a present-tense status: %s", (response) => {
    expect(hasFutureFollowUpPromise(response)).toBe(false);
  });

  it("replaces an empty promise with an explicit not-done response", () => {
    expect(enforceControllerPromiseGate("I'll get back to you.", [])).toEqual({
      response: CONTROLLER_UNWATCHED_PROMISE_RESPONSE,
      replaced: true,
    });
  });

  it("allows a promise only after a durable watch receipt", () => {
    const response = "I'll let you know when the worker finishes.";
    expect(enforceControllerPromiseGate(response, [{
      toolName: "telegram_agent_watch",
      state: "completed",
      result: JSON.stringify({
        watching: { id: "monitor_1", kind: "thread_idle", state: "armed", threadId: "thr_1" },
      }),
    }])).toEqual({ response, replaced: false });
  });

  it("does not treat a repeating schedule as a live-work completion watch", () => {
    const response = "I'll keep checking the job every 30 minutes and let you know when it finishes.";
    expect(enforceControllerPromiseGate(response, [{
      toolName: "telegram_agent_watch",
      state: "completed",
      result: JSON.stringify({
        watching: {
          id: "monitor_1",
          kind: "schedule",
          state: "armed",
          cron: "*/30 * * * *",
          instruction: "Check whether the queued job is still blocked, then retry it.",
        },
      }),
    }])).toEqual({ response: CONTROLLER_UNWATCHED_PROMISE_RESPONSE, replaced: true });
  });

  it("does not trust failed or malformed watch receipts", () => {
    const response = "I'll follow up.";
    expect(enforceControllerPromiseGate(response, [{
      toolName: "telegram_agent_watch",
      state: "failed",
      result: null,
    }]).replaced).toBe(true);
    expect(enforceControllerPromiseGate(response, [{
      toolName: "telegram_agent_watch",
      state: "completed",
      result: "{}",
    }]).replaced).toBe(true);
  });
});
