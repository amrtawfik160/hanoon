import { z } from "zod";
import type { ProjectPolicy } from "../domain/models";
import type { CommandResult, TerminalObservation } from "../bb/terminal-command";

const MAX_COMMAND_LENGTH = 500;
const MAX_OUTPUT_LENGTH = 4_000;
const MAX_SNAPSHOT_BYTES = 60_000;

export type ProductionPhase = "deploy" | "canary";

export type ProductionCommandReceipt = {
  name: string;
  command: string;
  outcome: "pass" | "fail" | "timed_out" | "aborted";
  exitCode: number | null;
  output: string;
};

export type ProductionStageSnapshot = {
  phase: ProductionPhase;
  outcome: "pass" | "fail";
  summary: string;
  failedCommand: string | null;
  commandReceipts: ProductionCommandReceipt[];
  terminalIds: string[];
  completedAt: string;
};

const productionCommandReceiptSchema = z.object({
  name: z.string().min(1).max(40),
  command: z.string().min(1).max(MAX_COMMAND_LENGTH),
  outcome: z.enum(["pass", "fail", "timed_out", "aborted"]),
  exitCode: z.number().int().min(0).max(255).nullable(),
  output: z.string().max(MAX_OUTPUT_LENGTH),
}).strict();

const productionStageSnapshotSchema = z.object({
  phase: z.enum(["deploy", "canary"]),
  outcome: z.enum(["pass", "fail"]),
  summary: z.string().min(1).max(500),
  failedCommand: z.string().min(1).max(40).nullable(),
  commandReceipts: z.array(productionCommandReceiptSchema).min(1).max(21),
  terminalIds: z.array(z.string().min(1).max(256)).max(21),
  completedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((snapshot, context) => {
  const lastReceipt = snapshot.commandReceipts.at(-1);
  if (snapshot.outcome === "pass") {
    if (snapshot.failedCommand !== null || snapshot.commandReceipts.some((entry) => entry.outcome !== "pass")) {
      context.addIssue({ code: "custom", message: "Passing production evidence contains a failed command" });
    }
  } else if (
    snapshot.failedCommand === null ||
    lastReceipt?.name !== snapshot.failedCommand ||
    lastReceipt.outcome === "pass"
  ) {
    context.addIssue({ code: "custom", message: "Failed production evidence does not identify its terminal command" });
  }
});

export function parseProductionStageSnapshot(value: unknown, phase: ProductionPhase): ProductionStageSnapshot {
  const snapshot = productionStageSnapshotSchema.parse(value);
  if (snapshot.phase !== phase) throw new TypeError("production stage evidence phase is invalid");
  return snapshot;
}

type ProductionCommandRunner = {
  run(input: {
    scope: { kind: "environment"; environmentId: string };
    title: string;
    command: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onObservation?: (observation: TerminalObservation) => void;
  }): Promise<CommandResult>;
};

export type RunProductionStageInput = {
  runner: ProductionCommandRunner;
  environmentId: string;
  expectedHeadSha: string;
  policy: ProjectPolicy;
  phase: ProductionPhase;
  signal?: AbortSignal;
  onTerminalObservation?: (observation: TerminalObservation) => void;
  now?: () => number;
};

function bounded(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function checkoutGuard(expectedHeadSha: string): { name: string; command: string; timeoutMs: number } {
  if (!/^[0-9a-f]{40}$/.test(expectedHeadSha)) {
    throw new TypeError("production stage requires an exact merged commit SHA");
  }
  return {
    name: "verify-merged-checkout",
    command: `test "$(git rev-parse --verify HEAD)" = ${shellSingleQuote(expectedHeadSha)}`,
    timeoutMs: 30_000,
  };
}

function redactor(patterns: readonly string[]): (value: string) => string {
  const configured = patterns.map((pattern) => new RegExp(pattern, "g"));
  const generic = [
    /\bBearer\s+[^\s]+/gi,
    /\b(?:github_pat|gh[pousr])_[A-Za-z0-9_]+/g,
    /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*[^\s]+/gi,
    /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
  ];
  const allPatterns = [...generic, ...configured];
  return (value: string): string => {
    let result = value;
    for (const pattern of allPatterns) result = result.replace(pattern, "[REDACTED]");
    return result;
  };
}

export function productionCommandIdentity(input: Readonly<{
  name: string;
  command: string;
  outputRedactionPatterns: readonly string[];
}>): Pick<ProductionCommandReceipt, "name" | "command"> {
  const redact = redactor(input.outputRedactionPatterns);
  return {
    name: bounded(redact(input.name), 40),
    command: bounded(redact(input.command), MAX_COMMAND_LENGTH),
  };
}

function boundSnapshot(snapshot: ProductionStageSnapshot): ProductionStageSnapshot {
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") <= MAX_SNAPSHOT_BYTES) return snapshot;
  const withoutOutput = {
    ...snapshot,
    commandReceipts: snapshot.commandReceipts.map((entry) => ({ ...entry, output: "[TRUNCATED]" })),
  };
  if (Buffer.byteLength(JSON.stringify(withoutOutput), "utf8") <= MAX_SNAPSHOT_BYTES) return withoutOutput;
  return {
    ...withoutOutput,
    commandReceipts: withoutOutput.commandReceipts.map((entry) => ({
      ...entry,
      command: bounded(entry.command, 100),
    })),
  };
}

function receipt(
  identity: Pick<ProductionCommandReceipt, "name" | "command">,
  result: CommandResult,
  redact: (value: string) => string,
): ProductionCommandReceipt {
  return {
    ...identity,
    outcome: result.outcome === "exited" ? (result.exitCode === 0 ? "pass" : "fail") : result.outcome,
    exitCode: result.outcome === "exited" ? result.exitCode : null,
    output: result.outcome === "exited" ? bounded(redact(result.output), MAX_OUTPUT_LENGTH) : "",
  };
}

export async function runProductionStage(input: RunProductionStageInput): Promise<ProductionStageSnapshot> {
  if (!input.environmentId) throw new TypeError("production stage requires an owned environment");
  const production = input.policy.production;
  if (!production) throw new TypeError("production deployment and canary are not configured");
  const configuredCommands = input.phase === "deploy" ? production.deployCommands : production.canaryCommands;
  const commands = [checkoutGuard(input.expectedHeadSha), ...configuredCommands];
  const redact = redactor(input.policy.outputRedactionPatterns);
  const commandReceipts: ProductionCommandReceipt[] = [];
  const terminalIds = new Set<string>();
  let failedCommand: string | null = null;

  for (const entry of commands) {
    const observe = (observation: TerminalObservation): void => {
      terminalIds.add(observation.id);
      input.onTerminalObservation?.(observation);
    };
    let result: CommandResult;
    try {
      result = await input.runner.run({
        scope: { kind: "environment", environmentId: input.environmentId },
        title: `Telegram production ${input.phase}: ${bounded(redact(entry.name), 40)}`,
        command: entry.command,
        timeoutMs: entry.timeoutMs,
        signal: input.signal,
        onObservation: observe,
      });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const safe = redact(raw.split(entry.command).join(redact(entry.command)));
      result = { outcome: "exited", exitCode: 1, output: bounded(safe, MAX_OUTPUT_LENGTH) };
    }
    const identity = productionCommandIdentity({
      name: entry.name,
      command: entry.command,
      outputRedactionPatterns: input.policy.outputRedactionPatterns,
    });
    const commandReceipt = receipt(identity, result, redact);
    commandReceipts.push(commandReceipt);
    if (commandReceipt.outcome !== "pass") {
      failedCommand = commandReceipt.name;
      break;
    }
  }

  const now = (input.now ?? Date.now)();
  if (!Number.isInteger(now) || now < 0) throw new TypeError("production clock must be a non-negative integer");
  const passed = failedCommand === null && commandReceipts.length === commands.length;
  return boundSnapshot({
    phase: input.phase,
    outcome: passed ? "pass" : "fail",
    summary: passed
      ? `${configuredCommands.length}/${configuredCommands.length} production ${input.phase} commands passed at ${input.expectedHeadSha.slice(0, 12)}`
      : `Production ${input.phase} command ${failedCommand ?? "unknown"} failed`,
    failedCommand,
    commandReceipts,
    terminalIds: [...terminalIds],
    completedAt: new Date(now).toISOString(),
  });
}
