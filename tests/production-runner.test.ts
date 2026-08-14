import { describe, expect, it, vi } from "vitest";
import { projectPolicySchema } from "../src/domain/models";
import { runProductionStage } from "../src/services/production-runner";
import { policyFixture } from "./helpers";

describe("production runner", () => {
  const mergedHead = "d".repeat(40);

  it("runs configured commands in order in the owned environment and records redacted receipts", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const observations: string[] = [];
    const runner = {
      run: vi.fn(async (input: Record<string, unknown>) => {
        calls.push(input);
        const observe = input.onObservation as ((value: { id: string; status: string; updatedAt: number }) => void);
        observe({ id: `term_${calls.length}`, status: "running", updatedAt: 1_000 + calls.length });
        observe({ id: `term_${calls.length}`, status: "exited", updatedAt: 2_000 + calls.length });
        return { outcome: "exited" as const, exitCode: 0, output: `token=secret-${calls.length}\nok` };
      }),
    };
    const policy = policyFixture({
      outputRedactionPatterns: ["secret-[0-9]+"],
      production: {
        deployCommands: [
          { name: "migrate", command: "./deploy migrate", timeoutMs: 60_000 },
          { name: "release", command: "./deploy release", timeoutMs: 120_000 },
        ],
        canaryCommands: [{ name: "canary", command: "./verify", timeoutMs: 60_000 }],
        convexDeployRequired: false,
      },
    });

    const result = await runProductionStage({
      runner,
      environmentId: "env_owned",
      expectedHeadSha: mergedHead,
      policy,
      phase: "deploy",
      now: () => 3_000,
      onTerminalObservation: (observation) => observations.push(observation.id),
    });

    expect(result.outcome).toBe("pass");
    expect(calls.map((call) => call.scope)).toEqual([
      { kind: "environment", environmentId: "env_owned" },
      { kind: "environment", environmentId: "env_owned" },
      { kind: "environment", environmentId: "env_owned" },
    ]);
    expect(calls.map((call) => call.command)).toEqual([
      `test "$(git rev-parse --verify HEAD)" = '${mergedHead}'`,
      "./deploy migrate",
      "./deploy release",
    ]);
    expect(result.terminalIds).toEqual(["term_1", "term_2", "term_3"]);
    expect(observations).toEqual(["term_1", "term_1", "term_2", "term_2", "term_3", "term_3"]);
    expect(result.commandReceipts).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain("secret-1");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("stops on the first failed command and rolls back rather than running the rest", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ outcome: "exited", exitCode: 0, output: "checkout verified" })
      .mockResolvedValueOnce({ outcome: "exited", exitCode: 1, output: "deploy failed" })
      .mockResolvedValueOnce({ outcome: "exited", exitCode: 0, output: "reverted" });
    const policy = policyFixture({
      production: {
        deployCommands: [
          { name: "release", command: "./deploy release", timeoutMs: 60_000 },
          { name: "never", command: "./deploy second", timeoutMs: 60_000 },
        ],
        canaryCommands: [{ name: "canary", command: "./verify", timeoutMs: 60_000 }],
        rollbackCommand: { name: "rollback", command: "./rollback", timeoutMs: 60_000 },
        convexDeployRequired: false,
      },
    });

    const result = await runProductionStage({
      runner: { run },
      environmentId: "env_owned",
      expectedHeadSha: mergedHead,
      policy,
      phase: "deploy",
      now: () => 3_000,
    });

    expect(result).toMatchObject({ outcome: "fail", failedCommand: "release" });
    // The command after the failure is skipped; the rollback is not.
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.map((call) => call[0].command)).not.toContain("./deploy second");
    expect(run.mock.calls[2]?.[0].command).toBe("./rollback");
    expect(result.rollback).toMatchObject({ outcome: "pass" });
  });

  it("requires an explicit Convex CLI deploy command when configured", () => {
    const policy = policyFixture();
    policy.production = {
      deployCommands: [{ name: "deploy", command: "npm run deploy", timeoutMs: 60_000 }],
      canaryCommands: [{ name: "canary", command: "npm run canary", timeoutMs: 60_000 }],
      convexDeployRequired: true,
    };

    expect(projectPolicySchema.safeParse(policy).success).toBe(false);
    policy.production.deployCommands[0]!.command = "echo convex deploy";
    expect(projectPolicySchema.safeParse(policy).success).toBe(false);
    policy.production.deployCommands[0]!.command = "bunx convex deploy --yes";
    expect(projectPolicySchema.safeParse(policy).success).toBe(true);
  });

  it("bounds the complete persisted snapshot even when terminal output expands during JSON encoding", async () => {
    const policy = policyFixture({
      production: {
        deployCommands: Array.from({ length: 20 }, (_, index) => ({
          name: `deploy-${index}`,
          command: `./deploy ${index}`,
          timeoutMs: 60_000,
        })),
        canaryCommands: [{ name: "canary", command: "./verify", timeoutMs: 60_000 }],
        convexDeployRequired: false,
      },
    });
    const result = await runProductionStage({
      runner: { run: async () => ({ outcome: "exited", exitCode: 0, output: "\u0000".repeat(4_000) }) },
      environmentId: "env_owned",
      expectedHeadSha: mergedHead,
      policy,
      phase: "deploy",
      now: () => 3_000,
    });

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(60_000);
    expect(result.commandReceipts).toHaveLength(21);
  });

  describe("automatic rollback", () => {
    const failingPolicy = (rollback: boolean) => policyFixture({
      production: {
        deployCommands: [{ name: "release", command: "./deploy", timeoutMs: 60_000 }],
        canaryCommands: [{ name: "canary", command: "./verify", timeoutMs: 60_000 }],
        ...(rollback
          ? { rollbackCommand: { name: "revert", command: "./rollback", timeoutMs: 60_000 } }
          : {}),
        convexDeployRequired: false,
      },
    });

    it("reverts production as soon as a deploy command fails", async () => {
      const commands: string[] = [];
      const result = await runProductionStage({
        runner: {
          run: async (input: { command: string }) => {
            commands.push(input.command);
            return input.command === "./rollback"
              ? { outcome: "exited" as const, exitCode: 0, output: "reverted" }
              : { outcome: "exited" as const, exitCode: 1, output: "boom" };
          },
        },
        environmentId: "env_owned",
        expectedHeadSha: mergedHead,
        policy: failingPolicy(true),
        phase: "deploy",
        now: () => 3_000,
      });

      expect(result.outcome).toBe("fail");
      expect(commands).toContain("./rollback");
      expect(result.rollback).toMatchObject({ name: "revert", outcome: "pass" });
      expect(result.summary).toContain("production was rolled back");
    });

    it("reverts production when the canary fails, not only the deploy", async () => {
      const result = await runProductionStage({
        runner: {
          run: async (input: { command: string }) => (input.command === "./rollback"
            ? { outcome: "exited" as const, exitCode: 0, output: "reverted" }
            : input.command === "./verify"
              ? { outcome: "exited" as const, exitCode: 1, output: "unhealthy" }
              : { outcome: "exited" as const, exitCode: 0, output: "ok" }),
        },
        environmentId: "env_owned",
        expectedHeadSha: mergedHead,
        policy: failingPolicy(true),
        phase: "canary",
        now: () => 3_000,
      });

      expect(result.outcome).toBe("fail");
      expect(result.rollback?.outcome).toBe("pass");
    });

    it("says so plainly when the rollback command itself fails", async () => {
      const result = await runProductionStage({
        runner: { run: async () => ({ outcome: "exited" as const, exitCode: 1, output: "boom" }) },
        environmentId: "env_owned",
        expectedHeadSha: mergedHead,
        policy: failingPolicy(true),
        phase: "deploy",
        now: () => 3_000,
      });

      expect(result.rollback?.outcome).toBe("fail");
      expect(result.summary).toContain("the rollback command also failed");
    });

    it("does not invent a rollback when the project configured none", async () => {
      const result = await runProductionStage({
        runner: { run: async () => ({ outcome: "exited" as const, exitCode: 1, output: "boom" }) },
        environmentId: "env_owned",
        expectedHeadSha: mergedHead,
        policy: failingPolicy(false),
        phase: "deploy",
        now: () => 3_000,
      });

      expect(result.rollback ?? null).toBeNull();
      expect(result.summary).toContain("no rollback command is configured");
    });

    it("never runs a rollback after a stage that passed", async () => {
      const commands: string[] = [];
      const result = await runProductionStage({
        runner: {
          run: async (input: { command: string }) => {
            commands.push(input.command);
            return { outcome: "exited" as const, exitCode: 0, output: "ok" };
          },
        },
        environmentId: "env_owned",
        expectedHeadSha: mergedHead,
        policy: failingPolicy(true),
        phase: "deploy",
        now: () => 3_000,
      });

      expect(result.outcome).toBe("pass");
      expect(commands).not.toContain("./rollback");
      expect(result.rollback ?? null).toBeNull();
    });
  });
});
