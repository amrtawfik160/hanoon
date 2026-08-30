import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import {
  parseCommandJson,
  shellSingleQuote,
  type CommandResult,
  type TerminalScope,
} from "./terminal-command";

const automationTriggerSchema = z.discriminatedUnion("triggerType", [
  z.object({
    triggerType: z.literal("schedule"),
    cron: z.string().min(1),
    timezone: z.string().min(1),
  }).passthrough(),
  z.object({
    triggerType: z.literal("once"),
    runAt: z.number().int().positive(),
  }).passthrough(),
]);

const automationExecutionSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("agent"),
    prompt: z.string().min(1),
    providerId: z.string().min(1),
    model: z.string().min(1),
    reasoningLevel: z.string().min(1).optional(),
    serviceTier: z.string().min(1).optional(),
    permissionMode: z.enum(["accept-edits", "auto", "full"]),
    targetThreadId: z.string().min(1).optional(),
    environment: z.discriminatedUnion("type", [
      z.object({ type: z.literal("project-default") }).passthrough(),
      z.object({
        type: z.literal("reuse"),
        environmentId: z.string().min(1),
      }).passthrough(),
      z.object({
        type: z.literal("host"),
        hostId: z.string().min(1),
        workspace: z.object({
          type: z.literal("managed-worktree"),
          baseBranch: z.object({
            kind: z.literal("named"),
            name: z.string().min(1),
          }).passthrough(),
        }).passthrough(),
      }).passthrough(),
    ]),
  }).passthrough(),
  z.object({
    mode: z.literal("script"),
    interpreter: z.enum(["bash", "sh", "node", "python3"]).optional(),
    timeoutMs: z.number().int().positive(),
    scriptFile: z.string().min(1).optional(),
    storedScriptPath: z.string().min(1).optional(),
    script: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  }).passthrough(),
]);

export const bbAutomationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  trigger: automationTriggerSchema,
  execution: automationExecutionSchema,
  origin: z.enum(["human", "app", "agent"]),
  createdByThreadId: z.string().min(1).nullable(),
  nextRunAt: z.number().int().nonnegative().nullable(),
  lastRunAt: z.number().int().nonnegative().nullable(),
  runCount: z.number().int().nonnegative(),
  lastRunStatus: z.enum(["running", "succeeded", "failed", "skipped"]).nullable(),
  lastRunThreadId: z.string().min(1).nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).passthrough();

export type BbAutomation = z.infer<typeof bbAutomationSchema>;

export const bbAutomationRunSchema = z.object({
  id: z.string().min(1),
  automationId: z.string().min(1),
  runMode: z.enum(["agent", "script"]),
  threadId: z.string().min(1).nullable(),
  status: z.enum(["running", "succeeded", "failed", "skipped"]),
  trigger: z.enum(["schedule", "manual"]),
  skipReason: z.string().nullable(),
  error: z.string().nullable(),
  output: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  scheduledFor: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative(),
  finishedAt: z.number().int().nonnegative().nullable(),
}).passthrough();

export type BbAutomationRun = z.infer<typeof bbAutomationRunSchema>;

export type BbAutomationTrigger =
  | Readonly<{ kind: "cron"; cron: string; timezone: string }>
  | Readonly<{ kind: "once"; at: string }>;

export type BbAutomationTarget =
  | Readonly<{ kind: "project-default" }>
  | Readonly<{ kind: "target-thread"; threadId: string }>
  | Readonly<{ kind: "environment"; environmentId: string }>
  | Readonly<{ kind: "new-worktree"; baseBranch: string }>;

export type BbAgentAutomationDefinition = Readonly<{
  mode: "agent";
  projectId: string;
  name: string;
  trigger: BbAutomationTrigger;
  prompt: string;
  providerId: string;
  model: string;
  reasoningLevel?: string;
  serviceTier?: "default" | "fast";
  permissionMode: "accept-edits" | "auto" | "full";
  target: BbAutomationTarget;
}>;

export type BbScriptAutomationDefinition = Readonly<{
  mode: "script";
  projectId: string;
  name: string;
  trigger: BbAutomationTrigger;
  source: Readonly<
    | { kind: "inline"; script: string }
    | { kind: "file"; path: string; sha256: string; hostId?: string }
  >;
  interpreter: "bash" | "sh" | "node" | "python3";
  timeoutMs: number;
  env?: Readonly<Record<string, string>>;
}>;

export type BbAutomationDefinition = BbAgentAutomationDefinition | BbScriptAutomationDefinition;

export type AutomationCommandRunner = Readonly<{
  run(input: {
    scope: TerminalScope;
    title: string;
    command: string;
    timeoutMs: number;
    maxOutputBytes?: number;
    signal?: AbortSignal;
  }): Promise<CommandResult>;
}>;

function flag(name: string, value: string): string[] {
  return [`--${name}`, shellSingleQuote(value)];
}

function triggerArgs(trigger: BbAutomationTrigger): string[] {
  return trigger.kind === "cron"
    ? [...flag("cron", trigger.cron), ...flag("timezone", trigger.timezone)]
    : [...flag("at", trigger.at)];
}

function targetArgs(target: BbAutomationTarget): string[] {
  switch (target.kind) {
    case "project-default": return [];
    case "target-thread": return flag("target-thread", target.threadId);
    case "environment": return flag("environment", target.environmentId);
    case "new-worktree": return ["--new-environment", "worktree", ...flag("base-branch", target.baseBranch)];
  }
}

function definitionArgs(definition: BbAutomationDefinition): string[] {
  const common = [
    ...flag("project", definition.projectId),
    ...flag("name", definition.name),
    ...triggerArgs(definition.trigger),
  ];
  if (definition.mode === "agent") {
    return [
      ...common,
      ...flag("prompt", definition.prompt),
      ...flag("provider", definition.providerId),
      ...flag("model", definition.model),
      ...(definition.reasoningLevel ? flag("reasoning", definition.reasoningLevel) : []),
      ...(definition.serviceTier ? flag("service-tier", definition.serviceTier) : []),
      ...flag("permission-mode", definition.permissionMode),
      ...targetArgs(definition.target),
    ];
  }
  return [
    ...common,
    ...(definition.source.kind === "inline"
      ? flag("script", definition.source.script)
      : [
          ...flag("script-file", definition.source.path),
          ...(definition.source.hostId ? flag("host", definition.source.hostId) : []),
        ]),
    ...flag("interpreter", definition.interpreter),
    ...flag("timeout", String(definition.timeoutMs)),
    ...(definition.env ? flag("env-json", JSON.stringify(definition.env)) : []),
  ];
}

function command(subcommand: string, args: readonly string[]): string {
  return ["bb", "automation", subcommand, ...args, "--json"].join(" ");
}

export function buildCreateAutomationCommand(definition: BbAutomationDefinition): string {
  return command("create", definitionArgs(definition));
}

export function buildShowAutomationCommand(projectId: string, automationId: string): string {
  return command("show", [shellSingleQuote(automationId), ...flag("project", projectId)]);
}

export function buildAutomationActionCommand(
  action: "pause" | "resume" | "delete",
  projectId: string,
  automationId: string,
): string {
  return command(action, [
    shellSingleQuote(automationId),
    ...flag("project", projectId),
    ...(action === "delete" ? ["--yes"] : []),
  ]);
}

export function buildRunAutomationCommand(
  projectId: string,
  automationId: string,
  idempotencyKey: string,
): string {
  return command("run", [
    shellSingleQuote(automationId),
    ...flag("project", projectId),
    ...flag("idempotency-key", idempotencyKey),
  ]);
}

export function buildAutomationRunsCommand(projectId: string, automationId: string, limit = 20): string {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError("automation run limit must be 1-200");
  return command("runs", [
    shellSingleQuote(automationId),
    ...flag("project", projectId),
    ...flag("limit", String(limit)),
  ]);
}

function commandFailure(title: string, result: CommandResult): Error {
  if (result.outcome === "timed_out") return new Error(`${title}: BB automation command timed out`);
  if (result.outcome === "aborted") return new Error(`${title}: BB automation command was aborted`);
  return new Error(`${title}: BB automation command exited ${result.exitCode}`);
}

export class TerminalBbAutomationAdapter {
  public constructor(private readonly runner: AutomationCommandRunner) {}

  private async execute<T>(input: {
    scope: TerminalScope;
    title: string;
    command: string;
    schema: z.ZodType<T>;
    signal?: AbortSignal;
  }): Promise<T> {
    const result = await this.runner.run({
      scope: input.scope,
      title: input.title,
      command: input.command,
      timeoutMs: 120_000,
      maxOutputBytes: 1_048_576,
      signal: input.signal,
    });
    if (result.outcome !== "exited" || result.exitCode !== 0) throw commandFailure(input.title, result);
    return input.schema.parse(parseCommandJson<unknown>(result.output, input.title));
  }

  public async create(input: {
    scope: TerminalScope;
    definition: BbAutomationDefinition;
    signal?: AbortSignal;
  }): Promise<BbAutomation> {
    const created = await this.execute({
      ...input,
      title: "Create BB automation",
      command: buildCreateAutomationCommand(input.definition),
      schema: bbAutomationSchema,
    });
    try {
      const observed = await this.show({
        scope: input.scope,
        projectId: input.definition.projectId,
        automationId: created.id,
        signal: input.signal,
      });
      assertAutomationMatches(input.definition, observed);
      return observed;
    } catch (error) {
      // A create acknowledgement is not acceptance. Remove a definition BB
      // cannot read back exactly so a hidden, untrusted schedule is not left.
      try {
        await this.delete({
          scope: input.scope,
          projectId: input.definition.projectId,
          automationId: created.id,
          signal: input.signal,
        });
      } catch {
        // Preserve the mismatch as the primary failure; the service records a
        // closed error class and reconciliation will keep the binding blocked.
      }
      throw error;
    }
  }

  public show(input: {
    scope: TerminalScope;
    projectId: string;
    automationId: string;
    signal?: AbortSignal;
  }): Promise<BbAutomation> {
    return this.execute({
      ...input,
      title: "Read BB automation",
      command: buildShowAutomationCommand(input.projectId, input.automationId),
      schema: bbAutomationSchema,
    });
  }

  public async setEnabled(input: {
    scope: TerminalScope;
    projectId: string;
    automationId: string;
    enabled: boolean;
    signal?: AbortSignal;
  }): Promise<BbAutomation> {
    await this.execute({
      ...input,
      title: input.enabled ? "Resume BB automation" : "Pause BB automation",
      command: buildAutomationActionCommand(input.enabled ? "resume" : "pause", input.projectId, input.automationId),
      schema: bbAutomationSchema,
    });
    const observed = await this.show(input);
    if (observed.enabled !== input.enabled) throw new Error("BB automation enabled state did not reconcile");
    return observed;
  }

  public async runNow(input: {
    scope: TerminalScope;
    projectId: string;
    automationId: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<BbAutomationRun> {
    const response = await this.execute({
      ...input,
      title: "Run BB automation",
      command: buildRunAutomationCommand(input.projectId, input.automationId, input.idempotencyKey),
      schema: z.object({ run: bbAutomationRunSchema }).passthrough(),
    });
    return response.run;
  }

  public async runs(input: {
    scope: TerminalScope;
    projectId: string;
    automationId: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<readonly BbAutomationRun[]> {
    const response = await this.execute({
      ...input,
      title: "Read BB automation runs",
      command: buildAutomationRunsCommand(input.projectId, input.automationId, input.limit),
      schema: z.object({ runs: z.array(bbAutomationRunSchema), nextCursor: z.string().nullable() }).passthrough(),
    });
    return response.runs;
  }

  public async delete(input: {
    scope: TerminalScope;
    projectId: string;
    automationId: string;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.execute({
      ...input,
      title: "Delete BB automation",
      command: buildAutomationActionCommand("delete", input.projectId, input.automationId),
      schema: z.object({ ok: z.literal(true), id: z.literal(input.automationId) }).passthrough(),
    });
  }
}

export function assertAutomationMatches(
  expected: BbAutomationDefinition,
  observed: BbAutomation,
  expectedEnabled = true,
): void {
  if (observed.projectId !== expected.projectId || observed.name !== expected.name ||
    observed.enabled !== expectedEnabled) {
    throw new Error("BB automation identity did not reconcile");
  }
  if (expected.trigger.kind === "cron") {
    if (observed.trigger.triggerType !== "schedule" || observed.trigger.cron !== expected.trigger.cron ||
      observed.trigger.timezone !== expected.trigger.timezone || (expectedEnabled && observed.nextRunAt === null)) {
      throw new Error("BB automation schedule did not reconcile");
    }
  } else {
    const expectedRunAt = Date.parse(expected.trigger.at);
    if (observed.trigger.triggerType !== "once" || !Number.isFinite(expectedRunAt) ||
      observed.trigger.runAt !== expectedRunAt) {
      throw new Error("BB automation one-shot trigger did not reconcile");
    }
  }
  if (observed.execution.mode !== expected.mode) throw new Error("BB automation execution mode did not reconcile");
  if (expected.mode === "agent" && observed.execution.mode === "agent") {
    if (observed.execution.prompt !== expected.prompt || observed.execution.providerId !== expected.providerId ||
      observed.execution.model !== expected.model || observed.execution.permissionMode !== expected.permissionMode) {
      throw new Error("BB agent automation execution did not reconcile");
    }
    if (expected.reasoningLevel && observed.execution.reasoningLevel !== expected.reasoningLevel) {
      throw new Error("BB agent automation reasoning level did not reconcile");
    }
    if (expected.serviceTier && observed.execution.serviceTier !== expected.serviceTier) {
      throw new Error("BB agent automation service tier did not reconcile");
    }
    const environment = observed.execution.environment;
    switch (expected.target.kind) {
      case "project-default":
        if (observed.execution.targetThreadId !== undefined || environment.type !== "project-default") {
          throw new Error("BB agent automation target did not reconcile");
        }
        break;
      case "target-thread":
        if (observed.execution.targetThreadId !== expected.target.threadId) {
          throw new Error("BB agent automation target did not reconcile");
        }
        break;
      case "environment":
        if (observed.execution.targetThreadId !== undefined || environment.type !== "reuse" ||
          environment.environmentId !== expected.target.environmentId) {
          throw new Error("BB agent automation target did not reconcile");
        }
        break;
      case "new-worktree":
        if (observed.execution.targetThreadId !== undefined || environment.type !== "host" ||
          environment.workspace.type !== "managed-worktree" ||
          environment.workspace.baseBranch.kind !== "named" ||
          environment.workspace.baseBranch.name !== expected.target.baseBranch) {
          throw new Error("BB agent automation target did not reconcile");
        }
        break;
    }
  }
  if (expected.mode === "script" && observed.execution.mode === "script") {
    if (observed.execution.interpreter !== expected.interpreter || observed.execution.timeoutMs !== expected.timeoutMs) {
      throw new Error("BB script automation execution did not reconcile");
    }
    const script = observed.execution.script;
    if (script === undefined || (expected.source.kind === "inline"
      ? script !== expected.source.script
      : observed.execution.scriptFile !== basename(expected.source.path) ||
        createHash("sha256").update(script, "utf8").digest("hex") !== expected.source.sha256)) {
      throw new Error("BB script automation source did not reconcile");
    }
    const observedEnv = observed.execution.env ?? {};
    const expectedEnv = expected.env ?? {};
    if (JSON.stringify(Object.entries(observedEnv).sort()) !== JSON.stringify(Object.entries(expectedEnv).sort())) {
      throw new Error("BB script automation environment did not reconcile");
    }
  }
}
