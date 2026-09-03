import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import {
  parseCommandJson,
  shellSingleQuote,
  type CommandResult,
  type TerminalScope,
} from "./terminal-command";
import type {
  ManagedAutomationAgentDefinition,
  ManagedAutomationCapabilities,
  ManagedAutomationCreateReceipt,
  ManagedAutomationDefinition,
  ManagedAutomationObservation,
  ManagedAutomationProviderIdentity,
  ManagedAutomationRun,
  ManagedAutomationScope,
  ManagedAutomationTarget,
  ManagedAutomationTrigger,
} from "../domain/managed-automation";

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

const bbAutomationSchema = z.object({
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

const bbAutomationRunSchema = z.object({
  id: z.string().min(1),
  automationId: z.string().min(1),
  idempotencyKey: z.string().min(1).max(256).nullable().optional(),
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

export type BbAutomationRun = ManagedAutomationRun;

export type BbAutomationTrigger = ManagedAutomationTrigger;
export type BbAutomationTarget = ManagedAutomationTarget;
export type BbAgentAutomationDefinition = ManagedAutomationAgentDefinition;

export const DEFAULT_BB_AGENT_AUTOMATION_TIMEOUT_MS = 900_000;
export const DEFAULT_BB_AGENT_AUTOMATION_RESULT_CONTRACT = Object.freeze({
  kind: "bounded-text" as const,
  maximumBytes: 32_768,
});

export type BbScriptAutomationDefinition = Extract<ManagedAutomationDefinition, { mode: "script" }>;
export type BbAutomationDefinition = ManagedAutomationDefinition;
export type BbAgentAutomationCapabilities = ManagedAutomationCapabilities;

/**
 * BB runs an agent automation without a wall-clock bound or an output bound,
 * and starts a scheduled run without asking Hanoon first. Hanoon therefore
 * enforces the declared execution contract itself: every observed run is
 * classified against `timeoutMs` and `resultContract` before its evidence or
 * controller handoff is recorded, and a binding whose authority is no longer
 * current is paused at the next reconciliation sweep. Neither is a claim that
 * BB stopped the run; both are truthful classifications of what BB did.
 */
export const INSTALLED_BB_AGENT_AUTOMATION_CAPABILITIES: BbAgentAutomationCapabilities = Object.freeze({
  executionTimeout: false,
  resultContract: false,
  preRunAuthority: false,
});


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

function terminalScope(scope: ManagedAutomationScope): TerminalScope {
  return scope.kind === "host"
    ? { kind: "host_path", hostId: scope.hostId, cwd: scope.cwd }
    : scope;
}

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
    if (!Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 1 || definition.timeoutMs > 14_400_000) {
      throw new TypeError("agent automation timeout must be 1-14400000 milliseconds");
    }
    if (definition.resultContract.kind !== "bounded-text" ||
      !Number.isSafeInteger(definition.resultContract.maximumBytes) ||
      definition.resultContract.maximumBytes < 1 || definition.resultContract.maximumBytes > 1_048_576) {
      throw new TypeError("agent automation result contract must bound text to 1-1048576 bytes");
    }
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

export function buildUpdateAutomationCommand(
  automationId: string,
  definition: BbAutomationDefinition,
): string {
  return command("update", [shellSingleQuote(automationId), ...definitionArgs(definition)]);
}

export function buildShowAutomationCommand(projectId: string, automationId: string): string {
  return command("show", [shellSingleQuote(automationId), ...flag("project", projectId)]);
}

export function buildListAutomationsCommand(projectId: string): string {
  return command("list", flag("project", projectId));
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

function providerDefinition(
  definition: BbAutomationDefinition,
  identity?: ManagedAutomationProviderIdentity,
): BbAutomationDefinition {
  if (!identity) return definition;
  const suffix = ` [${identity.ownershipMarker}]`;
  const name = `${definition.name}${suffix}`;
  if (name.length > 200) throw new TypeError("managed automation ownership marker makes the provider name too long");
  return { ...definition, name };
}

function managedAutomationTarget(
  execution: BbAutomation["execution"],
): ManagedAutomationTarget | null {
  if (execution.mode === "script") return null;
  if (execution.targetThreadId) return { kind: "target-thread", threadId: execution.targetThreadId };
  switch (execution.environment.type) {
    case "project-default": return { kind: "project-default" };
    case "reuse": return { kind: "environment", environmentId: execution.environment.environmentId };
    case "host":
      return {
        kind: "new-worktree",
        baseBranch: execution.environment.workspace.baseBranch.name,
      };
  }
}

function toManagedAutomationObservation(
  observed: BbAutomation,
  expectedDefinition?: BbAutomationDefinition,
): ManagedAutomationObservation {
  const trigger = observed.trigger.triggerType === "schedule"
    ? {
        kind: "cron" as const,
        cron: observed.trigger.cron,
        timezone: observed.trigger.timezone,
      }
    : {
        kind: "once" as const,
        at: new Date(observed.trigger.runAt).toISOString(),
      };
  return {
    providerAutomationId: observed.id,
    projectId: observed.projectId,
    name: expectedDefinition?.name ?? observed.name,
    enabled: observed.enabled,
    trigger,
    mode: observed.execution.mode,
    target: managedAutomationTarget(observed.execution),
    nextRunAt: observed.nextRunAt,
    lastRunAt: observed.lastRunAt,
    runCount: observed.runCount,
    lastRunStatus: observed.lastRunStatus,
    lastRunThreadId: observed.lastRunThreadId,
    lastError: observed.lastError,
    createdAt: observed.createdAt,
    updatedAt: observed.updatedAt,
  };
}

export class BbAutomationNotFoundError extends Error {
  public constructor() {
    super("BB automation is already absent");
    this.name = "BbAutomationNotFoundError";
  }
}

/**
 * BB's automations plugin refuses some projects outright; BB's personal
 * project is one (it answers "Project not found"). That is a standing property
 * of the project, not a transient failure, so callers can keep a plugin-local
 * schedule instead of retrying BB.
 */
export class BbAutomationProjectUnavailableError extends Error {
  public constructor(public readonly projectId: string) {
    super(`BB automations are not available for project ${projectId}`);
    this.name = "BbAutomationProjectUnavailableError";
  }
}

const PROJECT_UNAVAILABLE_OUTPUT = /^Project (\S+) is not available: HTTP 404: Project not found\s*$/u;

export class TerminalBbAutomationAdapter {
  public readonly agentAutomationCapabilities = INSTALLED_BB_AGENT_AUTOMATION_CAPABILITIES;

  public constructor(private readonly runner: AutomationCommandRunner) {}

  private async execute<T>(input: {
    scope: TerminalScope;
    title: string;
    command: string;
    schema: z.ZodType<T>;
    classifyNotFound?: boolean;
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
    if (result.outcome !== "exited" || result.exitCode !== 0) {
      if (input.classifyNotFound === true && result.outcome === "exited" &&
        result.output.trim() === "Automation not found") {
        throw new BbAutomationNotFoundError();
      }
      const unavailable = result.outcome === "exited"
        ? PROJECT_UNAVAILABLE_OUTPUT.exec(result.output.trim())
        : null;
      if (unavailable?.[1]) throw new BbAutomationProjectUnavailableError(unavailable[1]);
      throw commandFailure(input.title, result);
    }
    return input.schema.parse(parseCommandJson<unknown>(result.output, input.title));
  }

  /**
   * Returns BB's create acknowledgement only, as a receipt carrying the
   * operation's ownership marker. Acceptance is the service's job: it persists
   * the returned provider id before the exact read-back, so a crash between the
   * two cannot leave a live BB schedule that no binding knows about.
   */
  public async create(input: {
    scope: ManagedAutomationScope;
    definition: BbAutomationDefinition;
    identity: ManagedAutomationProviderIdentity;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationCreateReceipt> {
    const created = await this.execute({
      scope: terminalScope(input.scope),
      title: "Create BB automation",
      command: buildCreateAutomationCommand(providerDefinition(input.definition, input.identity)),
      schema: bbAutomationSchema,
      signal: input.signal,
    });
    return {
      version: 1,
      operationId: input.identity.operationId,
      ownershipMarker: input.identity.ownershipMarker,
      providerAutomationId: created.id,
    };
  }

  private async listRaw(input: {
    scope: ManagedAutomationScope;
    projectId: string;
    signal?: AbortSignal;
  }): Promise<readonly BbAutomation[]> {
    const response = await this.execute({
      scope: terminalScope(input.scope),
      title: "List BB automations",
      command: buildListAutomationsCommand(input.projectId),
      schema: z.union([
        z.object({ automations: z.array(z.unknown()) }).passthrough(),
        z.array(z.unknown()),
      ]),
      signal: input.signal,
    });
    const rows = Array.isArray(response) ? response : response.automations;
    // BB keeps damaged records visible under a `problem` discriminator. A
    // record Hanoon cannot read exactly is never a candidate for adoption.
    return rows.flatMap((row) => {
      const parsed = bbAutomationSchema.safeParse(row);
      return parsed.success && !("problem" in parsed.data) ? [parsed.data] : [];
    });
  }

  public async findByDefinition(input: {
    scope: ManagedAutomationScope;
    definition: BbAutomationDefinition;
    identity: ManagedAutomationProviderIdentity;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationObservation | null> {
    const expectedDefinition = providerDefinition(input.definition, input.identity);
    const candidates = await this.listRaw({
      scope: input.scope,
      projectId: input.definition.projectId,
      signal: input.signal,
    });
    for (const candidate of candidates) {
      try {
        assertAutomationMatches(expectedDefinition, candidate);
        return toManagedAutomationObservation(candidate, input.definition);
      } catch {
        // The list is an observation set; only an exact definition match closes
        // an ambiguous create attempt.
      }
    }
    return null;
  }

  public async update(input: {
    scope: ManagedAutomationScope;
    definition: BbAutomationDefinition;
    automationId: string;
    expectedEnabled: boolean;
    identity?: ManagedAutomationProviderIdentity;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationObservation> {
    const expectedDefinition = providerDefinition(input.definition, input.identity);
    await this.execute({
      scope: terminalScope(input.scope),
      title: "Update BB automation",
      command: buildUpdateAutomationCommand(input.automationId, expectedDefinition),
      schema: bbAutomationSchema,
      signal: input.signal,
    });
    const observed = await this.show({
      scope: input.scope,
      projectId: input.definition.projectId,
      automationId: input.automationId,
      expectedDefinition: input.definition,
      expectedEnabled: input.expectedEnabled,
      identity: input.identity,
      signal: input.signal,
    });
    return observed;
  }

  public show(input: {
    scope: ManagedAutomationScope;
    projectId: string;
    automationId: string;
    expectedDefinition?: BbAutomationDefinition;
    expectedEnabled?: boolean;
    identity?: ManagedAutomationProviderIdentity;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationObservation> {
    const expectedDefinition = input.expectedDefinition
      ? providerDefinition(input.expectedDefinition, input.identity)
      : undefined;
    return this.execute({
      scope: terminalScope(input.scope),
      title: "Read BB automation",
      command: buildShowAutomationCommand(input.projectId, input.automationId),
      schema: bbAutomationSchema,
      signal: input.signal,
    }).then((observed) => {
      if (expectedDefinition) {
        assertAutomationMatches(expectedDefinition, observed, input.expectedEnabled ?? true);
      }
      return toManagedAutomationObservation(observed, input.expectedDefinition);
    });
  }

  public async setEnabled(input: {
    scope: ManagedAutomationScope;
    projectId: string;
    automationId: string;
    enabled: boolean;
    expectedDefinition?: BbAutomationDefinition;
    identity?: ManagedAutomationProviderIdentity;
    signal?: AbortSignal;
  }): Promise<ManagedAutomationObservation> {
    await this.execute({
      scope: terminalScope(input.scope),
      title: input.enabled ? "Resume BB automation" : "Pause BB automation",
      command: buildAutomationActionCommand(input.enabled ? "resume" : "pause", input.projectId, input.automationId),
      schema: bbAutomationSchema,
      signal: input.signal,
    });
    const observed = await this.show({ ...input, expectedEnabled: input.enabled });
    if (observed.enabled !== input.enabled) throw new Error("BB automation enabled state did not reconcile");
    return observed;
  }

  public async runNow(input: {
    scope: ManagedAutomationScope;
    projectId: string;
    automationId: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<BbAutomationRun> {
    const response = await this.execute({
      scope: terminalScope(input.scope),
      title: "Run BB automation",
      command: buildRunAutomationCommand(input.projectId, input.automationId, input.idempotencyKey),
      schema: z.object({ run: bbAutomationRunSchema }).passthrough(),
      signal: input.signal,
    });
    if (response.run.idempotencyKey !== undefined && response.run.idempotencyKey !== null &&
      response.run.idempotencyKey !== input.idempotencyKey) {
      throw new TypeError("BB automation run acknowledgement identity did not match its idempotency key");
    }
    return response.run.idempotencyKey === input.idempotencyKey
      ? response.run
      : { ...response.run, idempotencyKey: input.idempotencyKey };
  }

  public async runs(input: {
    scope: ManagedAutomationScope;
    projectId: string;
    automationId: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<readonly BbAutomationRun[]> {
    const response = await this.execute({
      scope: terminalScope(input.scope),
      title: "Read BB automation runs",
      command: buildAutomationRunsCommand(input.projectId, input.automationId, input.limit),
      schema: z.object({ runs: z.array(bbAutomationRunSchema), nextCursor: z.string().nullable() }).passthrough(),
      signal: input.signal,
    });
    return response.runs;
  }

  public async delete(input: {
    scope: ManagedAutomationScope;
    projectId: string;
    automationId: string;
    signal?: AbortSignal;
  }): Promise<void> {
    await this.execute({
      scope: terminalScope(input.scope),
      title: "Delete BB automation",
      command: buildAutomationActionCommand("delete", input.projectId, input.automationId),
      schema: z.object({ ok: z.literal(true), id: z.literal(input.automationId) }).passthrough(),
      classifyNotFound: true,
      signal: input.signal,
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
