import { expect, it } from "vitest";
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
