import { describe, expect, it, vi } from "vitest";
import {
  assertAutomationMatches,
  buildAutomationRunsCommand,
  buildCreateAutomationCommand,
  buildUpdateAutomationCommand,
  BbAutomationNotFoundError,
  TerminalBbAutomationAdapter,
  type BbAgentAutomationDefinition,
  type BbAutomation,
} from "../src/bb/automation";
import type { CommandResult } from "../src/bb/terminal-command";

const definition: BbAgentAutomationDefinition = {
  mode: "agent",
  projectId: "proj_owner",
  name: "Owner's morning check",
  trigger: { kind: "cron", cron: "0 9 * * *", timezone: "Etc/UTC" },
  prompt: "Check deploys; don't guess. $(touch /tmp/nope)",
  providerId: "codex-provider",
  model: "gpt-5.6-sol",
  reasoningLevel: "high",
  serviceTier: "fast",
  permissionMode: "full",
  target: { kind: "environment", environmentId: "env_owner" },
  timeoutMs: 900_000,
  resultContract: { kind: "bounded-text", maximumBytes: 32_768 },
};

function observed(overrides: Partial<BbAutomation> = {}): BbAutomation {
  return {
    id: "auto_1",
    projectId: definition.projectId,
    name: definition.name,
    enabled: true,
    trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "Etc/UTC" },
    execution: {
      mode: "agent",
      prompt: definition.prompt,
      providerId: definition.providerId,
      model: definition.model,
      reasoningLevel: definition.reasoningLevel,
      serviceTier: definition.serviceTier,
      permissionMode: definition.permissionMode,
      environment: { type: "reuse", environmentId: "env_owner" },
    },
    origin: "agent",
    createdByThreadId: "thr_controller",
    nextRunAt: 2_000,
    lastRunAt: null,
    runCount: 0,
    lastRunStatus: null,
    lastRunThreadId: null,
    lastError: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("BB automation adapter", () => {
  it("quotes every owner-controlled value and always binds the BB project", () => {
    const command = buildCreateAutomationCommand(definition);

    expect(command).toContain("bb automation create");
    expect(command).toContain("--project 'proj_owner'");
    expect(command).toContain("--name 'Owner'\"'\"'s morning check'");
    expect(command).toContain("--prompt 'Check deploys; don'\"'\"'t guess. $(touch /tmp/nope)'");
    expect(command).toContain("--environment 'env_owner'");
    expect(command).not.toContain("--timeout");
    expect(command).not.toContain("result-contract");
    expect(command.endsWith("--json")).toBe(true);
    expect(buildAutomationRunsCommand("proj_owner", "auto_1", 20))
      .toBe("bb automation runs 'auto_1' --project 'proj_owner' --limit '20' --json");
    expect(new TerminalBbAutomationAdapter({ run: vi.fn() }).agentAutomationCapabilities).toEqual({
      executionTimeout: false,
      resultContract: false,
      preRunAuthority: false,
    });
  });

  it("builds a complete project-bound definition update", () => {
    const command = buildUpdateAutomationCommand("auto_1", {
      ...definition,
      name: "Updated morning check",
      trigger: { kind: "cron", cron: "30 9 * * *", timezone: "Etc/UTC" },
    });

    expect(command).toContain("bb automation update 'auto_1'");
    expect(command).toContain("--project 'proj_owner'");
    expect(command).toContain("--name 'Updated morning check'");
    expect(command).toContain("--cron '30 9 * * *'");
    expect(command.endsWith("--json")).toBe(true);
  });

  it("returns the provider create acknowledgement before read-back", async () => {
    const results: CommandResult[] = [
      { outcome: "exited", exitCode: 0, output: JSON.stringify(observed()) },
    ];
    const run = vi.fn(async (_input: unknown) => results.shift()!);
    const adapter = new TerminalBbAutomationAdapter({ run });

    await expect(adapter.create({
      scope: { kind: "environment", environmentId: "env_owner" },
      definition,
      identity: { operationId: "managed-operation-1", ownershipMarker: "hanoon:marker-1" },
    })).resolves.toMatchObject({ version: 1, operationId: "managed-operation-1", providerAutomationId: "auto_1" });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("translates a BB response into provider-neutral Hanoon observation values", async () => {
    const adapter = new TerminalBbAutomationAdapter({
      run: async () => ({ outcome: "exited", exitCode: 0, output: JSON.stringify(observed()) }),
    });

    const result = await adapter.show({
      scope: { kind: "environment", environmentId: "env_owner" },
      projectId: definition.projectId,
      automationId: "auto_1",
    });

    expect(result).toMatchObject({
      providerAutomationId: "auto_1",
      projectId: definition.projectId,
      name: definition.name,
      enabled: true,
      trigger: { kind: "cron", cron: "0 9 * * *", timezone: "Etc/UTC" },
      mode: "agent",
      target: { kind: "environment", environmentId: "env_owner" },
    });
    expect(result).not.toHaveProperty("triggerType");
    expect(result).not.toHaveProperty("execution");
    expect(result).not.toHaveProperty("origin");
  });

  it("returns an acknowledged create receipt without compensating for read-back", async () => {
    const run = vi.fn(async () => ({
      outcome: "exited" as const,
      exitCode: 0,
      output: JSON.stringify(observed()),
    }));
    const adapter = new TerminalBbAutomationAdapter({ run });

    await expect(adapter.create({
      scope: { kind: "environment", environmentId: "env_owner" },
      definition,
      identity: { operationId: "managed-operation-1", ownershipMarker: "hanoon:marker-1" },
    })).resolves.toMatchObject({
      version: 1,
      operationId: "managed-operation-1",
      ownershipMarker: "hanoon:marker-1",
      providerAutomationId: "auto_1",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fails closed when BB reads back a different schedule", async () => {
    const results: CommandResult[] = [
      { outcome: "exited", exitCode: 0, output: JSON.stringify(observed({
        trigger: { triggerType: "schedule", cron: "0 10 * * *", timezone: "Etc/UTC" },
      })) },
    ];
    const adapter = new TerminalBbAutomationAdapter({ run: async () => results.shift()! });

    await expect(adapter.show({
      scope: { kind: "environment", environmentId: "env_owner" },
      projectId: definition.projectId,
      automationId: "auto_1",
      expectedDefinition: definition,
    })).rejects.toThrow("schedule did not reconcile");
  });

  it("verifies the provider definition after an update", async () => {
    const results: CommandResult[] = [
      { outcome: "exited", exitCode: 0, output: JSON.stringify(observed()) },
      { outcome: "exited", exitCode: 0, output: JSON.stringify(observed({
        trigger: { triggerType: "schedule", cron: "0 10 * * *", timezone: "Etc/UTC" },
      })) },
    ];
    const adapter = new TerminalBbAutomationAdapter({ run: async () => results.shift()! });

    await expect(adapter.update({
      scope: { kind: "environment", environmentId: "env_owner" },
      definition,
      automationId: "auto_1",
      expectedEnabled: true,
    })).rejects.toThrow("schedule did not reconcile");
  });

  it("can reconcile an intentionally paused automation without treating it as drift", () => {
    expect(() => assertAutomationMatches(definition, observed({ enabled: false, nextRunAt: null }), false))
      .not.toThrow();
  });

  it("rejects a different agent target", () => {
    expect(() => assertAutomationMatches(definition, observed({
      execution: {
        mode: "agent",
        prompt: definition.prompt,
        providerId: definition.providerId,
        model: definition.model,
        reasoningLevel: definition.reasoningLevel,
        serviceTier: definition.serviceTier,
        permissionMode: definition.permissionMode,
        environment: { type: "reuse", environmentId: "env_other" },
      },
    }))).toThrow("target did not reconcile");
  });

  it("checks the exact stored script and environment", () => {
    const scriptDefinition = {
      mode: "script" as const,
      projectId: "proj_owner",
      name: "Deterministic check",
      trigger: { kind: "cron" as const, cron: "0 9 * * *", timezone: "Etc/UTC" },
      source: { kind: "inline" as const, script: "printf 'ok\\n'" },
      interpreter: "bash" as const,
      timeoutMs: 30_000,
      env: { EXPECTED: "ok" },
    };
    const scriptAutomation = observed({
      name: scriptDefinition.name,
      execution: {
        mode: "script",
        interpreter: "bash",
        timeoutMs: 30_000,
        scriptFile: "script.sh",
        storedScriptPath: "/managed/script.sh",
        script: "printf 'different\\n'",
        env: { EXPECTED: "ok" },
      },
    });

    expect(() => assertAutomationMatches(scriptDefinition, scriptAutomation))
      .toThrow("source did not reconcile");
  });

  it("rejects unbounded run history requests", () => {
    expect(() => buildAutomationRunsCommand("proj_owner", "auto_1", 0)).toThrow("1-200");
    expect(() => buildAutomationRunsCommand("proj_owner", "auto_1", 201)).toThrow("1-200");
  });

  it("rejects agent definitions without a bounded execution and result contract", () => {
    expect(() => buildCreateAutomationCommand({ ...definition, timeoutMs: 0 }))
      .toThrow("agent automation timeout");
    expect(() => buildCreateAutomationCommand({
      ...definition,
      resultContract: { kind: "bounded-text", maximumBytes: 1_048_577 },
    })).toThrow("agent automation result contract");
  });

  it("classifies BB's exact already-absent delete response without hiding other command failures", async () => {
    const results: CommandResult[] = [
      { outcome: "exited", exitCode: 1, output: "Automation not found\n" },
      { outcome: "exited", exitCode: 1, output: "Permission denied\n" },
    ];
    const adapter = new TerminalBbAutomationAdapter({ run: async () => results.shift()! });
    const input = {
      scope: { kind: "environment" as const, environmentId: "env_owner" },
      projectId: "proj_owner",
      automationId: "auto_absent",
    };

    await expect(adapter.delete(input)).rejects.toBeInstanceOf(BbAutomationNotFoundError);
    await expect(adapter.delete(input)).rejects.toThrow("command exited 1");
  });
});
