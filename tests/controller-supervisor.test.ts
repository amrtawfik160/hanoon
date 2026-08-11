import type { BbPluginApi } from "@bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import { BbControllerAdapter } from "../src/controller/bb-controller";
import { DEFAULT_CONTROLLER_EXECUTION_PROFILE } from "../src/controller/execution-profile";
import {
  evaluateSupervisor,
  SUPERVISOR_HARD_TOKENS,
  SUPERVISOR_HARD_TOOL_CALLS,
  SUPERVISOR_MAX_STEERS_PER_TURN,
  SUPERVISOR_SOFT_COMMAND_FAILURES,
  SUPERVISOR_SOFT_TOKENS,
  SUPERVISOR_SOFT_TOOL_CALLS,
  type SupervisorSignals,
} from "../src/controller/supervisor";

const quiet: SupervisorSignals = {
  toolCalls: 0,
  totalTokens: 0,
  commandFailures: 0,
  steersIssued: 0,
  steeredReasons: [],
};

it("lets an ordinary turn run", () => {
  expect(evaluateSupervisor(quiet)).toEqual({ kind: "continue" });
});

it("lets a turn one call short of the soft budget run", () => {
  expect(evaluateSupervisor({ ...quiet, toolCalls: SUPERVISOR_SOFT_TOOL_CALLS - 1 }))
    .toEqual({ kind: "continue" });
});

it.each([
  ["tool_budget", { toolCalls: SUPERVISOR_SOFT_TOOL_CALLS }],
  ["token_budget", { totalTokens: SUPERVISOR_SOFT_TOKENS }],
  ["command_failures", { commandFailures: SUPERVISOR_SOFT_COMMAND_FAILURES }],
] as const)("steers once at the %s soft budget", (reason, signals) => {
  expect(evaluateSupervisor({ ...quiet, ...signals })).toMatchObject({ kind: "steer", reason });
});

it("does not repeat a steer for a reason already used", () => {
  expect(evaluateSupervisor({
    ...quiet,
    toolCalls: SUPERVISOR_SOFT_TOOL_CALLS,
    steersIssued: 1,
    steeredReasons: ["tool_budget"],
  })).toEqual({ kind: "continue" });
});

it("still steers for a different reason after one is spent", () => {
  expect(evaluateSupervisor({
    ...quiet,
    toolCalls: SUPERVISOR_SOFT_TOOL_CALLS,
    commandFailures: SUPERVISOR_SOFT_COMMAND_FAILURES,
    steersIssued: 1,
    steeredReasons: ["tool_budget"],
  })).toMatchObject({ kind: "steer", reason: "command_failures" });
});

it("stops nudging once every steer is spent", () => {
  expect(evaluateSupervisor({
    ...quiet,
    commandFailures: SUPERVISOR_SOFT_COMMAND_FAILURES,
    steersIssued: SUPERVISOR_MAX_STEERS_PER_TURN,
    steeredReasons: ["tool_budget", "token_budget"],
  })).toEqual({ kind: "continue" });
});

it.each([
  ["tool_budget", { toolCalls: SUPERVISOR_HARD_TOOL_CALLS }],
  ["token_budget", { totalTokens: SUPERVISOR_HARD_TOKENS }],
] as const)("stops at the %s hard budget even when its steer was spent", (reason, signals) => {
  expect(evaluateSupervisor({
    ...quiet,
    ...signals,
    steersIssued: SUPERVISOR_MAX_STEERS_PER_TURN,
    steeredReasons: ["tool_budget", "token_budget"],
  })).toMatchObject({ kind: "stop", reason });
});

it("never stops for command failures alone", () => {
  expect(evaluateSupervisor({
    ...quiet,
    commandFailures: SUPERVISOR_SOFT_COMMAND_FAILURES * 100,
    steersIssued: SUPERVISOR_MAX_STEERS_PER_TURN,
    steeredReasons: ["command_failures"],
  })).toEqual({ kind: "continue" });
});

function event(seq: number, type: string, data: unknown) {
  return { id: `e${seq}`, threadId: "thr_controller", seq, createdAt: seq, scope: { kind: "thread" }, type, data };
}

function observingAdapter(pages: readonly (readonly unknown[])[]) {
  let page = 0;
  const sdk = {
    threads: { events: { list: vi.fn(async () => pages[page++] ?? []) } },
  } as unknown as BbPluginApi["sdk"];
  return new BbControllerAdapter({
    sdk,
    pluginId: "telegram-agent",
    executionProfile: () => DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  });
}

it("counts tool starts, failed commands, and the cumulative token total", async () => {
  const adapter = observingAdapter([[
    event(1, "item/started", { item: { type: "commandExecution", id: "c1" } }),
    event(2, "item/started", { item: { type: "reasoning", id: "r1" } }),
    event(3, "item/started", { item: { type: "toolCall", id: "t1" } }),
    event(4, "item/completed", { item: { type: "commandExecution", id: "c1", exitCode: 2 } }),
    event(5, "item/completed", { item: { type: "commandExecution", id: "c2", exitCode: 0 } }),
    event(6, "thread/tokenUsage/updated", { tokenUsage: { total: { totalTokens: 4_211 } } }),
    event(7, "thread/tokenUsage/updated", { tokenUsage: { total: { totalTokens: 9_004 } } }),
  ]]);

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation).toMatchObject({ toolCalls: 2, commandFailures: 1, totalTokens: 9_004 });
});

it("reports no usage for a window that carried none", async () => {
  const adapter = observingAdapter([[event(1, "item/agentMessage/delta", { delta: "hi" })]]);

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation).toMatchObject({ toolCalls: 0, commandFailures: 0, totalTokens: 0 });
});
