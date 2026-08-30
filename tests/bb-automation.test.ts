import { describe, expect, it, vi } from "vitest";
import {
  assertAutomationMatches,
  buildAutomationRunsCommand,
  buildCreateAutomationCommand,
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
    expect(command.endsWith("--json")).toBe(true);
    expect(buildAutomationRunsCommand("proj_owner", "auto_1", 20))
      .toBe("bb automation runs 'auto_1' --project 'proj_owner' --limit '20' --json");
  });

  it("does not accept create success until an exact show read-back passes", async () => {
    const results: CommandResult[] = [
      { outcome: "exited", exitCode: 0, output: JSON.stringify(observed()) },
      { outcome: "exited", exitCode: 0, output: JSON.stringify(observed()) },
    ];
    const run = vi.fn(async (_input: unknown) => results.shift()!);
    const adapter = new TerminalBbAutomationAdapter({ run });

    await expect(adapter.create({
      scope: { kind: "environment", environmentId: "env_owner" },
      definition,
    })).resolves.toMatchObject({ id: "auto_1", enabled: true });

    expect(run).toHaveBeenCalledTimes(2);
    expect((run.mock.calls[1]?.[0] as { command: string } | undefined)?.command)
      .toBe("bb automation show 'auto_1' --project 'proj_owner' --json");
  });

  it("fails closed when BB reads back a different schedule", async () => {
    const results: CommandResult[] = [
      { outcome: "exited", exitCode: 0, output: JSON.stringify(observed()) },
      { outcome: "exited", exitCode: 0, output: JSON.stringify(observed({
        trigger: { triggerType: "schedule", cron: "0 10 * * *", timezone: "Etc/UTC" },
      })) },
    ];
    const adapter = new TerminalBbAutomationAdapter({ run: async () => results.shift()! });

    await expect(adapter.create({
      scope: { kind: "environment", environmentId: "env_owner" },
      definition,
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
});
