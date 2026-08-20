import type {
  BbPluginApi,
  PluginCliContext,
  PluginCliResult,
} from "@bb/plugin-sdk";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createSecret, hashSecret } from "./crypto";
import {
  projectPolicySchema,
  type Job,
  type ProjectPolicy,
} from "./domain/models";
import { TelegramClient } from "./telegram/client";
import {
  OWNER_MEMORY_SCOPE,
  type Owner,
  type OwnerMemoryImportInput,
  type TelegramAgentStore,
} from "./storage/store";
import { MAX_REFERENCE_SEARCH_RESULTS } from "./storage/reference-repository";
import { summariseStageSpend } from "./storage/stage-execution-repository";
import { TerminalCommandRunner } from "./bb/terminal-command";
import {
  branchProtectionRemedy,
  inspectBranchProtection,
  terminalProtectionProbe,
  type BranchProtectionVerdict,
} from "./bb/github-protection";
import { projectResourceWait } from "./storage/autonomy-repository";
import {
  RECIPE_PROMOTION_ORDER,
  RecipePromotionIncompleteError,
  type RecipePromotionService,
} from "./capabilities/promotion";
import { TASK_RECIPES, type TaskRecipe } from "./domain/recipes";
import { BROKER_BINDING_STATES, type BrokerBindingState } from "./credentials/protocol";
import type { CredentialReadinessCheck } from "./credentials/topology";
import type { CredentialAccessService } from "./credentials/service";
import { activationSummary, type ActivationHealth } from "./services/runtime-identity";

type BbSdk = BbPluginApi["sdk"];

export type TelegramAgentCliDependencies = {
  store: TelegramAgentStore;
  sdk: BbSdk;
  terminal: TerminalCommandRunner;
  now: () => number;
  getBotToken: () => string | undefined;
  createTelegramClient: (token: string) => Pick<TelegramClient, "getMe">;
  revokeAllApprovals: (now: number) => number;
  capabilityPromotions: Pick<
    RecipePromotionService,
    "status" | "promote" | "rollback" | "routingStatus" | "listDecisions"
  >;
  capabilitySettings: () => Readonly<{
    jobGraph: "adaptive" | "legacy";
    controllerTools: "bundled" | "all-tools";
    modelRouting: "adaptive" | "strong-only";
  }>;
  credentialAccess: Pick<CredentialAccessService, "list" | "status">;
  runtime: () => ActivationHealth;
  unpairNonceKey: string;
  recordOperatorAudit(input: Readonly<{
    schemaVersion: 1;
    operation: "unpair";
    outcome: "confirmed";
    occurredAt: number;
    affectedTelegramIdentity: Readonly<{ userId: string; chatId: string; pairedAt: number }>;
    operatorContext: Readonly<{ threadId: string | null; projectId: string | null }>;
  }>): Promise<void>;
  notify?: () => void;
};

type FlagSpec = {
  kind: "value" | "flag";
  repeatable?: boolean;
};

type ParsedFlags = {
  positionals: string[];
  values: Map<string, string>;
  repeated: Map<string, string[]>;
  flags: Set<string>;
  seen: Set<string>;
};

type JsonRecord = Record<string, unknown>;

class CliInputError extends Error {}

/**
 * A command whose arguments parsed but whose world does not permit them. It
 * shares the argument error's exit code on purpose: from a script's point of
 * view "you asked for something this repository is not configured for" is the
 * same class of answer as "that flag does not exist" — the request has to
 * change, and retrying it unchanged will fail identically.
 */
class CliPreconditionError extends CliInputError {}

class CliOperationError extends Error {}

const JSON_FLAG: FlagSpec = { kind: "flag" };

const TOP_LEVEL_FLAGS: Record<string, FlagSpec> = { json: JSON_FLAG };
const UNPAIR_FLAGS: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  confirm: { kind: "value" },
};

const MEMORY_IMPORT_FLAGS: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  file: { kind: "value" },
  host: { kind: "value" },
  scope: { kind: "value" },
};

/** Bounds one import so a malformed or runaway file cannot fill the store in a
 *  single call. Memory eviction still applies per scope afterwards. */
const MAX_IMPORTED_MEMORIES = 200;

const PROJECT_ENABLE_FLAGS: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  "policy-json": { kind: "value" },
  "policy-file": { kind: "value" },
  host: { kind: "value" },
  alias: { kind: "value" },
  base: { kind: "value" },
  "merge-method": { kind: "value" },
  "validation-json": { kind: "value", repeatable: true },
  "deploy-json": { kind: "value", repeatable: true },
  "canary-json": { kind: "value", repeatable: true },
  "production-target-key": { kind: "value" },
  "rollback-json": { kind: "value" },
  "convex-deploy-required": { kind: "flag" },
  // `mergeWithoutProduction` has no flag on purpose: it requires a regression
  // policy, which only the policy file can express, so a flag for it could
  // never parse.
  "unattended-merge": { kind: "flag" },
  "required-check": { kind: "value", repeatable: true },
  "redact-pattern": { kind: "value", repeatable: true },
  "worker-liveness-watchdog-ms": { kind: "value" },
  "max-review-cycles": { kind: "value" },
  "implementation-provider": { kind: "value" },
  "implementation-model": { kind: "value" },
  "implementation-reasoning": { kind: "value" },
  "implementation-service-tier": { kind: "value" },
  "implementation-permission-mode": { kind: "value" },
  "review-provider": { kind: "value" },
  "review-model": { kind: "value" },
  "review-reasoning": { kind: "value" },
  "review-service-tier": { kind: "value" },
  "review-permission-mode": { kind: "value" },
};

const PROJECT_LIST_FLAGS: Record<string, FlagSpec> = { json: JSON_FLAG };
const PROJECT_DISABLE_FLAGS: Record<string, FlagSpec> = { json: JSON_FLAG };
const JOB_LIST_FLAGS: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  limit: { kind: "value" },
};
const JOB_ID_FLAGS: Record<string, FlagSpec> = { json: JSON_FLAG };
const DOCTOR_FLAGS: Record<string, FlagSpec> = { json: JSON_FLAG };
const CAPABILITY_STATUS_FLAGS: Record<string, FlagSpec> = { json: JSON_FLAG };
const CAPABILITY_INVENTORY_FLAGS: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  host: { kind: "value" },
  limit: { kind: "value" },
};
const CAPABILITY_RECEIPT_FLAGS: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  limit: { kind: "value" },
};
const CAPABILITY_RECIPE_FLAGS: Record<string, FlagSpec> = { json: JSON_FLAG };
const ACCESS_LIST_FLAGS: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  state: { kind: "value" },
  after: { kind: "value" },
  limit: { kind: "value" },
};
const ACCESS_STATUS_FLAGS: Record<string, FlagSpec> = { json: JSON_FLAG };
const REFERENCE_SEARCH_FLAGS: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  project: { kind: "value" },
  limit: { kind: "value" },
};
const REFERENCE_LIST_FLAGS: Record<string, FlagSpec> = { json: JSON_FLAG, project: { kind: "value" } };
const REFERENCE_SHOW_FLAGS: Record<string, FlagSpec> = { json: JSON_FLAG, project: { kind: "value" } };

const MAX_COLLECTION_SIZE = 100;
const MAX_ACCESS_LIST_LIMIT = 10;
const PAIRING_TTL_MS = 10 * 60 * 1_000;
const MAX_ERROR_LENGTH = 240;
const CLI_HELP = `Usage: bb telegram-agent <command> [options]

Commands:
  pair [--json]
  unpair [--confirm <nonce>] [--json]
  project list [--json]
  project enable <project-id> [options]
  project disable <project-id> [--json]
  job list [--limit <1-100>] [--json]
  job show <job-id> [--json]
  job spend <job-id> [--json]
  job retry <job-id> [--json]
  job cancel <job-id> [--json]
  capability status [recipe] [--json]
  capability inventory [--host <scope>] [--limit <1-100>] [--json]
  capability receipts <profile-id> [--limit <1-100>] [--json]
  memory import --file <absolute-path> [--host <host-id>] [--scope <scope>] [--json]
  capability promote <recipe> [--json]
  capability rollback <recipe> [--json]
  access list [--state <state>] [--after <binding-id>] [--limit <1-10>] [--json]
  access status [binding-id] [--json]
  reference <search|show|list> ... [--project <project-id>] [--json]
  doctor [project-id] [--json]
`;
const CREDENTIAL_TEXT = [
  /\bbearer\s+\S+/i,
  /\b(?:api[_-]?key|password|secret|token|credential)\s*[:=]\s*\S+/i,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{10,}\b/i,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSummary(value: unknown, fallback: string): string {
  const text = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  const oneLine = text.replace(/[\r\n\t]+/g, " ").trim();
  if (!oneLine || CREDENTIAL_TEXT.some((pattern) => pattern.test(oneLine))) return fallback;
  return oneLine.slice(0, MAX_ERROR_LENGTH) || fallback;
}

function jsonRequested(argv: readonly string[]): boolean {
  return argv.includes("--json");
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function success(value: unknown, human: string, json: boolean): PluginCliResult {
  return json
    ? { exitCode: 0, stdout: serialize(value) }
    : { exitCode: 0, stdout: `${human}\n` };
}

function failure(exitCode: 1 | 2, message: string, json: boolean): PluginCliResult {
  const safe = safeSummary(message, exitCode === 2 ? "Invalid command arguments" : "Operation failed safely");
  return json
    ? { exitCode, stdout: serialize({ error: safe }), stderr: "" }
    : { exitCode, stdout: "", stderr: `${safe}\n` };
}

function parseFlags(argv: readonly string[], specs: Record<string, FlagSpec>): ParsedFlags {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const flags = new Set<string>();
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") || token === "--") {
      if (token === "--") throw new CliInputError("Unexpected argument separator");
      positionals.push(token);
      continue;
    }

    const equals = token.indexOf("=");
    const name = token.slice(2, equals === -1 ? undefined : equals);
    const inlineValue = equals === -1 ? undefined : token.slice(equals + 1);
    const spec = specs[name];
    if (!spec) throw new CliInputError(`Unknown flag --${name}`);
    if (!spec.repeatable && seen.has(name)) throw new CliInputError(`Duplicate flag --${name}`);
    seen.add(name);

    if (spec.kind === "flag") {
      if (inlineValue !== undefined) throw new CliInputError(`Flag --${name} does not take a value`);
      flags.add(name);
      continue;
    }

    const value = inlineValue ?? argv[++index];
    if (value === undefined || (inlineValue === undefined && value.startsWith("--"))) {
      throw new CliInputError(`Flag --${name} requires a value`);
    }
    if (spec.repeatable) {
      const current = repeated.get(name) ?? [];
      current.push(value);
      repeated.set(name, current);
    } else {
      values.set(name, value);
    }
  }

  return { positionals, values, repeated, flags, seen };
}

function onePositional(parsed: ParsedFlags, label: string): string {
  if (parsed.positionals.length !== 1 || !parsed.positionals[0]) {
    throw new CliInputError(`${label} requires exactly one positional value`);
  }
  return parsed.positionals[0];
}

function noPositionals(parsed: ParsedFlags): void {
  if (parsed.positionals.length !== 0) throw new CliInputError("Unexpected positional argument");
}

function boundedInteger(value: string, label: string, minimum: number, maximum: number): number {
  if (!/^[0-9]+$/.test(value)) throw new CliInputError(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliInputError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function readOptionalInteger(
  parsed: ParsedFlags,
  name: string,
  label: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = parsed.values.get(name);
  return value === undefined ? undefined : boundedInteger(value, label, minimum, maximum);
}

function parseJsonValue(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new CliOperationError(`${label} is not valid JSON`);
  }
}

function parseJsonRecord(value: string, label: string): JsonRecord {
  const parsed = parseJsonValue(value, label);
  if (!isRecord(parsed)) throw new CliOperationError(`${label} must be a JSON object`);
  return parsed;
}

function isAbsoluteHostPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function canonicalGithubRepository(remote: unknown): string | null {
  if (typeof remote !== "string") return null;
  const value = remote.trim();
  const match = value.match(
    /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

function projectSources(project: JsonRecord): JsonRecord[] {
  return Array.isArray(project.sources)
    ? project.sources.filter(isRecord).filter((source) => source.type === "local_path" || source.type === "clone")
    : [];
}

function selectedSource(project: JsonRecord): JsonRecord | null {
  return projectSources(project).find((source) => source.isDefault === true) ?? projectSources(project)[0] ?? null;
}

function safeJob(store: TelegramAgentStore, job: Job, now: number): JsonRecord {
  const admission = store.getAdmission(job.id);
  const queueEnd = admission?.admittedAt ?? admission?.releasedAt ?? now;
  const held = store.listCurrentHeldResourceClaims(job.id, 8).map((claim) => ({
    kind: claim.resourceKind,
    key: claim.resourceKey,
  }));
  const waiting = job.policy
    ? projectResourceWait({
      jobId: job.id,
      policy: job.policy,
      claims: store.listCurrentHeldMergeResourceClaims({ jobId: job.id, policy: job.policy, limit: 8 }),
    }).slice(0, Math.max(0, 8 - held.length))
    : [];
  return {
    id: job.id,
    state: job.state,
    recipe: {
      id: job.taskRecipe,
      version: job.recipeVersion,
      promotionCount: job.recipePromotionCount,
      routingMode: job.routingMode,
    },
    projectId: job.projectId,
    origin: job.origin,
    autonomousOrigin: job.autonomousOrigin,
    environmentId: job.environmentId,
    implementationThreadId: job.implementationThreadId,
    reviewThreadId: job.reviewThreadId,
    prNumber: job.prNumber,
    prUrl: job.prUrl,
    prHeadSha: job.prHeadSha,
    mergeCommitSha: job.mergeCommitSha,
    mergedAt: job.mergedAt,
    deploymentSummary: job.deploymentSummary,
    canarySummary: job.canarySummary,
    reviewCycle: job.reviewCycle,
    cancelRequested: job.cancelRequestedAt !== null,
    blockedReason: job.blockedReason,
    lastError: job.lastError,
    version: job.version,
    updatedAt: job.updatedAt,
    admission: admission ? {
      state: admission.state,
      queueSequence: admission.queueSeq,
      queueAgeMs: Math.max(0, queueEnd - admission.queuedAt),
      releaseReason: admission.releaseReason,
    } : null,
    resources: { held, waiting },
  };
}

function policySummary(record: { policy: ProjectPolicy; version: number }): JsonRecord {
  return {
    projectId: record.policy.projectId,
    alias: record.policy.alias,
    enabled: record.policy.enabled,
    githubRepository: record.policy.githubRepository,
    baseBranch: record.policy.baseBranch,
    mergeMethod: record.policy.mergeMethod,
    productionConfigured: record.policy.production !== undefined,
    version: record.version,
  };
}

async function readRemoteJsonFile(
  deps: TelegramAgentCliDependencies,
  path: string,
  explicitHostId: string | undefined,
  context: PluginCliContext,
): Promise<JsonRecord> {
  let hostId = explicitHostId;
  if (hostId === undefined && context.threadId !== undefined) {
    const thread = await deps.sdk.threads.get({ threadId: context.threadId, signal: context.signal });
    const threadRecord = thread as unknown as JsonRecord;
    if (typeof threadRecord.environmentId !== "string" || threadRecord.environmentId.length === 0) {
      throw new CliOperationError("The invoking thread has no environment host");
    }
    const environment = await deps.sdk.environments.get({
      environmentId: threadRecord.environmentId,
      signal: context.signal,
    });
    const environmentRecord = environment as unknown as JsonRecord;
    if (typeof environmentRecord.hostId !== "string" || environmentRecord.hostId.length === 0) {
      throw new CliOperationError("The invoking environment has no host");
    }
    hostId = environmentRecord.hostId;
  }

  const response = await deps.sdk.files.read({
    ...(hostId === undefined ? {} : { hostId }),
    path,
    signal: context.signal,
  });
  const file = response as unknown as JsonRecord;
  if (typeof file.content !== "string") throw new CliOperationError("BB file read returned no content");
  const content = file.contentEncoding === "base64"
    ? Buffer.from(file.content, "base64").toString("utf8")
    : file.content;
  return parseJsonRecord(content, "Policy file");
}

async function liveProjectContext(
  deps: TelegramAgentCliDependencies,
  projectId: string,
  context: PluginCliContext,
): Promise<{ project: JsonRecord; repository: string; source: JsonRecord }> {
  const project = await deps.sdk.projects.get({ projectId, signal: context.signal }) as unknown as JsonRecord;
  if (project.id !== projectId) throw new CliOperationError("BB returned a different project");
  if (project.kind !== "standard") throw new CliOperationError("Only standard Git projects can be enabled");
  const repository = canonicalGithubRepository(project.gitRemoteUrl);
  if (repository === null) throw new CliOperationError("The project does not have a GitHub remote");
  const source = selectedSource(project);
  if (source === null) throw new CliOperationError("The project has no local or cloned source");

  const branches = await deps.sdk.projects.branches({
    projectId,
    hostId: typeof source.hostId === "string" ? source.hostId : "",
    signal: context.signal,
  });
  return { project, repository, source: { ...source, branches } };
}

function profileFromFlags(parsed: ParsedFlags, prefix: "implementation" | "review"): JsonRecord {
  const profile: JsonRecord = {};
  const mappings = [
    ["provider", "providerId"],
    ["model", "model"],
    ["reasoning", "reasoningLevel"],
    ["service-tier", "serviceTier"],
    ["permission-mode", "permissionMode"],
  ] as const;
  for (const [suffix, key] of mappings) {
    const value = parsed.values.get(`${prefix}-${suffix}`);
    if (value !== undefined) profile[key] = value;
  }
  return profile;
}

function individualPolicy(
  parsed: ParsedFlags,
  projectId: string,
  repository: string,
): ProjectPolicy {
  const alias = parsed.values.get("alias");
  const baseBranch = parsed.values.get("base");
  const mergeMethod = parsed.values.get("merge-method");
  if (!alias || !baseBranch || !mergeMethod) {
    throw new CliInputError("Individual policy mode requires --alias, --base, and --merge-method");
  }
  const validationCommands = (parsed.repeated.get("validation-json") ?? []).map((value) => {
    const parsedValue = parseJsonValue(value, "--validation-json");
    if (!isRecord(parsedValue)) throw new CliOperationError("--validation-json must contain objects");
    return parsedValue;
  });
  const parseCommands = (name: "deploy-json" | "canary-json"): JsonRecord[] =>
    (parsed.repeated.get(name) ?? []).map((value) => {
      const parsedValue = parseJsonValue(value, `--${name}`);
      if (!isRecord(parsedValue)) throw new CliOperationError(`--${name} must contain objects`);
      return parsedValue;
    });
  const deployCommands = parseCommands("deploy-json");
  const canaryCommands = parseCommands("canary-json");
  const productionTargetKey = parsed.values.get("production-target-key");
  const rollbackValue = parsed.values.get("rollback-json");
  const rollbackCommand = rollbackValue === undefined ? undefined : parseJsonValue(rollbackValue, "--rollback-json");
  if (rollbackCommand !== undefined && !isRecord(rollbackCommand)) {
    throw new CliOperationError("--rollback-json must contain an object");
  }
  if (productionTargetKey !== undefined && (deployCommands.length === 0 || canaryCommands.length === 0)) {
    throw new CliInputError("--production-target-key requires both --deploy-json and --canary-json");
  }
  const hasProduction = deployCommands.length > 0 ||
    canaryCommands.length > 0 ||
    productionTargetKey !== undefined ||
    rollbackCommand !== undefined ||
    parsed.flags.has("convex-deploy-required");
  const candidate: JsonRecord = {
    projectId,
    alias,
    enabled: true,
    githubRepository: repository,
    baseBranch,
    implementation: profileFromFlags(parsed, "implementation"),
    review: profileFromFlags(parsed, "review"),
    validationCommands,
    ...(hasProduction ? {
      production: {
        ...(productionTargetKey === undefined ? {} : { targetKey: productionTargetKey }),
        deployCommands,
        canaryCommands,
        ...(rollbackCommand === undefined ? {} : { rollbackCommand }),
        convexDeployRequired: parsed.flags.has("convex-deploy-required"),
      },
    } : {}),
    ...(parsed.flags.has("unattended-merge") ? { autonomy: { unattendedMerge: true } } : {}),
    requiredChecks: parsed.repeated.get("required-check") ?? [],
    outputRedactionPatterns: parsed.repeated.get("redact-pattern") ?? [],
    workerLivenessWatchdogMs: readOptionalInteger(parsed, "worker-liveness-watchdog-ms", "--worker-liveness-watchdog-ms", 60_000, 3_600_000),
    maxReviewCycles: readOptionalInteger(parsed, "max-review-cycles", "--max-review-cycles", 1, 10),
    mergeMethod,
  };
  return projectPolicySchema.parse(candidate);
}

function policyFromObject(
  input: JsonRecord,
  projectId: string,
  repository: string,
): ProjectPolicy {
  if (input.projectId !== projectId) throw new CliOperationError("Policy projectId must exactly match the positional project-id");
  if (input.githubRepository !== undefined && input.githubRepository !== repository) {
    throw new CliOperationError("Policy githubRepository does not match the live GitHub remote");
  }
  try {
    return projectPolicySchema.parse({
      ...input,
      githubRepository: repository,
      enabled: true,
    });
  } catch {
    throw new CliOperationError("Policy schema is invalid");
  }
}

/** The host and checkout a `gh` command for this project can run in. */
function sourceCommandScope(source: JsonRecord | null): Readonly<{ hostId: string; cwd: string }> | null {
  const hostId = source?.hostId;
  const path = source?.path;
  if (typeof hostId !== "string" || hostId.length === 0) return null;
  if (typeof path !== "string" || path.length === 0) return null;
  return { hostId, cwd: path };
}

/**
 * What GitHub enforces on this policy's base branch, or `unavailable` when
 * there is nowhere to ask from. Every caller here treats an unreadable answer
 * as an unprotected branch, which is the only safe reading: the question being
 * asked is "will something other than this plugin refuse a bad merge", and
 * silence is not a yes.
 */
async function baseBranchProtection(
  deps: TelegramAgentCliDependencies,
  input: Readonly<{
    repository: string;
    branch: string;
    scope: Readonly<{ hostId: string; cwd: string }> | null;
    signal?: AbortSignal;
  }>,
): Promise<BranchProtectionVerdict> {
  if (input.scope === null) return { outcome: "unavailable" };
  return inspectBranchProtection({
    probe: terminalProtectionProbe({
      run: (command) => deps.terminal.run(command),
      hostId: input.scope.hostId,
      cwd: input.scope.cwd,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }),
    repository: input.repository,
    branch: input.branch,
  });
}

/** Whether this policy asks to merge on its own authority. */
function declaresMergeAutonomy(policy: ProjectPolicy): boolean {
  return policy.autonomy?.unattendedMerge === true || policy.autonomy?.mergeWithoutProduction === true;
}

/**
 * Refuses to store a merge grant the repository does not back.
 *
 * A standing grant replaces the owner's signature, and the owner is the last
 * check that is not this plugin's own. Requiring GitHub to hold at least one
 * required status check keeps a second, independent refusal in the path, so a
 * bug in this codebase cannot be the only thing standing between a broken
 * change and the trunk.
 *
 * Returns the warnings the operator should see on an accepted enable.
 */
async function assertAutonomyPreconditions(
  deps: TelegramAgentCliDependencies,
  policy: ProjectPolicy,
  source: JsonRecord,
  context: PluginCliContext,
): Promise<string[]> {
  if (!declaresMergeAutonomy(policy)) return [];
  const verdict = await baseBranchProtection(deps, {
    repository: policy.githubRepository,
    branch: policy.baseBranch,
    scope: sourceCommandScope(source),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
  });
  const remedy = branchProtectionRemedy({
    verdict,
    repository: policy.githubRepository,
    branch: policy.baseBranch,
  });
  if (verdict.outcome !== "enforced") {
    throw new CliPreconditionError(remedy ?? "Unattended merging requires a protected base branch");
  }
  // Protection exists but does not bind administrators. The merge runs under an
  // owner-scoped token, so this is a real gap — and it is the repository's to
  // close, not something this command can fix by refusing.
  return remedy === null ? [] : [remedy];
}

async function enableProject(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  context: PluginCliContext,
  json: boolean,
): Promise<PluginCliResult> {
  const projectId = onePositional(parsed, "project enable");
  const hasJson = parsed.values.has("policy-json");
  const hasFile = parsed.values.has("policy-file");
  if (hasJson && hasFile) throw new CliInputError("--policy-json and --policy-file are mutually exclusive");
  if (parsed.values.has("host") && !hasFile) throw new CliInputError("--host requires --policy-file");

  const individualNames = [
    "alias",
    "base",
    "merge-method",
    "validation-json",
    "deploy-json",
    "canary-json",
    "production-target-key",
    "rollback-json",
    "convex-deploy-required",
    "unattended-merge",
    "required-check",
    "redact-pattern",
    "worker-liveness-watchdog-ms",
    "max-review-cycles",
    "implementation-provider",
    "implementation-model",
    "implementation-reasoning",
    "implementation-service-tier",
    "implementation-permission-mode",
    "review-provider",
    "review-model",
    "review-reasoning",
    "review-service-tier",
    "review-permission-mode",
  ];
  const hasIndividual = individualNames.some((name) => parsed.seen.has(name));
  if ((hasJson || hasFile) && hasIndividual) {
    throw new CliInputError("Policy input modes are mutually exclusive");
  }
  if (!hasJson && !hasFile && !hasIndividual) {
    throw new CliInputError("Project enable requires a policy input mode");
  }

  const inputPolicy = hasFile
    ? await (async () => {
        const path = parsed.values.get("policy-file");
        if (!path || !isAbsoluteHostPath(path)) throw new CliOperationError("--policy-file must be an absolute host path");
        return readRemoteJsonFile(deps, path, parsed.values.get("host"), context);
      })()
    : hasJson
      ? parseJsonRecord(parsed.values.get("policy-json") ?? "", "--policy-json")
      : null;
  const live = await liveProjectContext(deps, projectId, context);
  const branchRecord = live.source.branches as unknown as JsonRecord;
  const baseBranch = hasIndividual
    ? parsed.values.get("base")
    : isRecord(inputPolicy) ? inputPolicy.baseBranch : undefined;
  if (typeof baseBranch !== "string" || baseBranch.length === 0) {
    throw new CliOperationError("Policy base branch is missing");
  }
  if (!Array.isArray(branchRecord.branches) || !branchRecord.branches.includes(baseBranch)) {
    throw new CliOperationError("Policy base branch is not available in the project");
  }

  const policy = hasIndividual
    ? individualPolicy(parsed, projectId, live.repository)
    : policyFromObject(inputPolicy ?? {}, projectId, live.repository);
  const warnings = await assertAutonomyPreconditions(deps, policy, live.source, context);
  const stored = deps.store.upsertProjectPolicy(policy, deps.now());
  return success(
    { ...policySummary(stored), warnings },
    [`Enabled ${stored.policy.alias} (${stored.policy.projectId})`, ...warnings.map((warning) => `Warning: ${warning}`)]
      .join("\n"),
    json,
  );
}

async function runPair(
  deps: TelegramAgentCliDependencies,
  context: PluginCliContext,
  json: boolean,
): Promise<PluginCliResult> {
  if (deps.store.getOwner() !== null) throw new CliOperationError("Telegram is already paired");
  const token = deps.getBotToken();
  if (!token) throw new CliOperationError("Telegram bot token is not configured");
  const identity = await deps.createTelegramClient(token).getMe(context.signal);
  const now = deps.now();
  const bind = deps.store.bindTelegramIdentity({
    botId: String(identity.id),
    username: identity.username,
    now,
    hasActiveJob: deps.store.hasUnreleasedAdmissions(),
  });
  if (bind === "active_job_conflict") throw new CliOperationError("Cannot change Telegram identity while a job is active");
  const secret = createSecret(24);
  deps.store.createPairingCode(hashSecret(secret), now, now + PAIRING_TTL_MS);
  const url = `https://t.me/${identity.username}?start=${secret}`;
  return success(
    { url, username: identity.username, sensitive: true, expiresInSeconds: 600 },
    `Pairing link (sensitive; expires in 10 minutes): ${url}`,
    json,
  );
}

/**
 * One entry of an owner import file. The file is external input, so its shape is
 * checked here; lengths, kinds, and scope bounds stay the store's to enforce so
 * there is one authority on what a memory may contain.
 */
function parseMemoryImportEntry(
  value: unknown,
  index: number,
  defaultScope: string,
): OwnerMemoryImportInput {
  if (!isRecord(value)) throw new CliOperationError(`Entry ${index} must be a JSON object`);
  const { subject, body, kind, scope, importance } = value;
  if (typeof subject !== "string") throw new CliOperationError(`Entry ${index} needs a subject`);
  if (typeof body !== "string") throw new CliOperationError(`Entry ${index} needs a body`);
  if (kind !== undefined && typeof kind !== "string") {
    throw new CliOperationError(`Entry ${index} kind must be a string`);
  }
  if (scope !== undefined && typeof scope !== "string") {
    throw new CliOperationError(`Entry ${index} scope must be a string`);
  }
  if (importance !== undefined && typeof importance !== "number") {
    throw new CliOperationError(`Entry ${index} importance must be a number`);
  }
  return {
    scope: scope ?? defaultScope,
    kind: (kind ?? "fact") as OwnerMemoryImportInput["kind"],
    subject,
    body,
    importance,
    now: 0,
  };
}

/**
 * Loads a file of standing information the owner wants the agent to have. It
 * runs on the protected host under the owner's own identity, which is what makes
 * it the one write allowed to carry secret-shaped text — the agent reaches these
 * rows only by asking for them, and never writes one itself.
 */
async function runMemoryImport(
  deps: TelegramAgentCliDependencies,
  argv: readonly string[],
  context: PluginCliContext,
): Promise<PluginCliResult> {
  const parsed = parseFlags(argv, MEMORY_IMPORT_FLAGS);
  noPositionals(parsed);
  const json = parsed.flags.has("json");
  const path = parsed.values.get("file");
  if (!path || !isAbsoluteHostPath(path)) {
    throw new CliOperationError("--file must be an absolute host path");
  }
  const document = await readRemoteJsonFile(deps, path, parsed.values.get("host"), context);
  if (!Array.isArray(document.entries)) throw new CliOperationError("The file needs an entries array");
  if (document.entries.length === 0) throw new CliOperationError("The file has no entries");
  if (document.entries.length > MAX_IMPORTED_MEMORIES) {
    throw new CliOperationError(`The file has more than ${MAX_IMPORTED_MEMORIES} entries`);
  }
  const defaultScope = parsed.values.get("scope") ?? OWNER_MEMORY_SCOPE;
  const entries = document.entries.map((entry, index) => parseMemoryImportEntry(entry, index, defaultScope));
  const now = deps.now();
  const imported = entries.map((entry) => deps.store.importOwnerMemory({ ...entry, now }).id);
  return success(
    { imported: imported.length },
    `Imported ${imported.length} ${imported.length === 1 ? "memory" : "memories"}`,
    json,
  );
}

type UnpairNoncePayload = Readonly<{
  operation: "unpair";
  userId: string;
  chatId: string;
  pairedAt: number;
  expiresAt: number;
  salt: string;
}>;

type ConfirmUnpairInput = Readonly<{
  owner: Owner;
  nonce: string;
  now: number;
  context: PluginCliContext;
  json: boolean;
}>;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function signUnpairPayload(encodedPayload: string, key: string): string {
  return createHmac("sha256", key).update(encodedPayload, "utf8").digest("base64url");
}

function createUnpairNonce(
  owner: Owner,
  now: number,
  key: string,
): string {
  const payload: UnpairNoncePayload = {
    operation: "unpair",
    userId: owner.userId,
    chatId: owner.chatId,
    pairedAt: owner.pairedAt,
    expiresAt: now + PAIRING_TTL_MS,
    salt: createSecret(12),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${signUnpairPayload(encodedPayload, key)}`;
}

function invalidUnpairNonce(): never {
  throw new CliOperationError("Unpair confirmation nonce is invalid");
}

function parseUnpairPayload(encodedPayload: string): UnpairNoncePayload {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as unknown;
  } catch {
    invalidUnpairNonce();
  }
  if (
    !isRecord(payload) || Object.keys(payload).sort().join(",") !== "chatId,expiresAt,operation,pairedAt,salt,userId" ||
    payload.operation !== "unpair" || typeof payload.userId !== "string" ||
    typeof payload.chatId !== "string" || !Number.isSafeInteger(payload.pairedAt) ||
    !Number.isSafeInteger(payload.expiresAt) || typeof payload.salt !== "string"
  ) invalidUnpairNonce();
  return payload as UnpairNoncePayload;
}

function validUnpairSignature(encodedPayload: string, encodedSignature: string, key: string): boolean {
  const expectedSignature = Buffer.from(signUnpairPayload(encodedPayload, key), "base64url");
  const suppliedSignature = Buffer.from(encodedSignature, "base64url");
  return expectedSignature.length === suppliedSignature.length &&
    timingSafeEqual(expectedSignature, suppliedSignature);
}

function validateUnpairNonce(
  nonce: string,
  owner: Owner,
  now: number,
  key: string,
): void {
  if (nonce.length > 1_024) invalidUnpairNonce();
  const [encodedPayload, encodedSignature, extra] = nonce.split(".");
  if (
    extra !== undefined || !encodedPayload || !encodedSignature ||
    !BASE64URL_PATTERN.test(encodedPayload) || !BASE64URL_PATTERN.test(encodedSignature) ||
    !validUnpairSignature(encodedPayload, encodedSignature, key)
  ) invalidUnpairNonce();
  const payload = parseUnpairPayload(encodedPayload);
  if (now >= payload.expiresAt) throw new CliOperationError("Unpair confirmation nonce expired");
  if (
    payload.userId !== owner.userId || payload.chatId !== owner.chatId ||
    payload.pairedAt !== owner.pairedAt
  ) throw new CliOperationError("Unpair confirmation nonce does not match the paired Telegram identity");
}

function unpairChallenge(
  deps: TelegramAgentCliDependencies,
  owner: Owner,
  now: number,
  json: boolean,
): PluginCliResult {
  const nonce = createUnpairNonce(owner, now, deps.unpairNonceKey);
  return success(
    {
      confirmationRequired: true,
      nonce,
      owner,
      sensitive: true,
      expiresInSeconds: PAIRING_TTL_MS / 1_000,
    },
    `Unpair Telegram user ${owner.userId} in private chat ${owner.chatId}. ` +
      `Confirm within 10 minutes: bb telegram-agent unpair --confirm ${nonce}`,
    json,
  );
}

function sameOwner(current: Owner | null, expected: Owner): boolean {
  return current !== null && current.userId === expected.userId &&
    current.chatId === expected.chatId && current.pairedAt === expected.pairedAt;
}

async function confirmUnpair(
  deps: TelegramAgentCliDependencies,
  input: ConfirmUnpairInput,
): Promise<PluginCliResult> {
  validateUnpairNonce(input.nonce, input.owner, input.now, deps.unpairNonceKey);
  await deps.recordOperatorAudit({
    schemaVersion: 1,
    operation: "unpair",
    outcome: "confirmed",
    occurredAt: input.now,
    affectedTelegramIdentity: input.owner,
    operatorContext: {
      threadId: input.context.threadId ?? null,
      projectId: input.context.projectId ?? null,
    },
  });
  if (!sameOwner(deps.store.getOwner(), input.owner) || !deps.store.revokeOwner(input.now)) {
    throw new CliOperationError("The paired Telegram identity changed before unpair could complete");
  }
  const approvalsRevoked = deps.revokeAllApprovals(input.now);
  return success({ revoked: true, approvalsRevoked }, "Telegram owner unpaired", input.json);
}

async function runUnpair(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  context: PluginCliContext,
  json: boolean,
): Promise<PluginCliResult> {
  const now = deps.now();
  const owner = deps.store.getOwner();
  if (!owner) {
    if (parsed.values.has("confirm")) throw new CliOperationError("No Telegram owner is paired");
    return success({ revoked: false, confirmationRequired: false }, "Telegram owner was already unpaired", json);
  }
  const confirmation = parsed.values.get("confirm");
  if (confirmation === undefined) return unpairChallenge(deps, owner, now, json);
  return await confirmUnpair(deps, { owner, nonce: confirmation, now, context, json });
}

function runProjectList(
  deps: TelegramAgentCliDependencies,
  json: boolean,
): PluginCliResult {
  const projects = deps.store.listEnabledProjectPolicies().slice(0, MAX_COLLECTION_SIZE).map(policySummary);
  return success(
    { projects },
    projects.map((project) => `${String(project.alias)}\t${String(project.projectId)}\t${String(project.baseBranch)}`).join("\n"),
    json,
  );
}

function runProjectDisable(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): PluginCliResult {
  const projectId = onePositional(parsed, "project disable");
  const record = deps.store.getProjectPolicy(projectId);
  if (!record) throw new CliOperationError("Project policy was not found");
  const stored = deps.store.upsertProjectPolicy({ ...record.policy, enabled: false }, deps.now());
  return success(policySummary(stored), `Disabled ${stored.policy.alias} (${stored.policy.projectId})`, json);
}

function jobList(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): PluginCliResult {
  noPositionals(parsed);
  const limit = parsed.values.has("limit")
    ? boundedInteger(parsed.values.get("limit") ?? "", "--limit", 1, MAX_COLLECTION_SIZE)
    : MAX_COLLECTION_SIZE;
  const now = deps.now();
  const jobs = deps.store.listJobs(limit).map((job) => safeJob(deps.store, job, now));
  return success(
    { jobs },
    jobs.map((job) => {
      const admission = job.admission as JsonRecord | null;
      return `${String(job.id)}\t${String(job.state)}\t${String(admission?.state ?? "none")}\t${String(job.projectId ?? "unselected")}`;
    }).join("\n"),
    json,
  );
}

function jobShow(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): PluginCliResult {
  const jobId = onePositional(parsed, "job show");
  const job = deps.store.getJob(jobId);
  if (!job) throw new CliOperationError("Job was not found");
  const output = safeJob(deps.store, job, deps.now());
  // Provenance belongs on the plain line too. Someone reading a job they do not
  // recognise is exactly who needs to be told nobody asked for it, and they are
  // the least likely person to have passed --json.
  const line = [
    String(output.id),
    String(output.state),
    `version=${String(output.version)}`,
    ...(job.autonomousOrigin === null ? [] : [`startedBy=${job.autonomousOrigin}`]),
  ].join("\t");
  return success(output, line, json);
}

/**
 * What every stage of one job actually ran on, and what it consumed. Tiering is
 * only worth tuning against observed numbers, so this reads the ledger rather
 * than restating the policy that happened to be current.
 */
function jobSpend(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): PluginCliResult {
  const jobId = onePositional(parsed, "job spend");
  if (!deps.store.getJob(jobId)) throw new CliOperationError("Job was not found");
  const records = deps.store.listStageExecutions(jobId);
  const summary = summariseStageSpend(records);
  const stages = records.map((record) => ({
    stage: record.stage,
    attempt: record.attemptOrdinal,
    tier: record.tier,
    baseTier: record.baseTier,
    escalated: record.escalated,
    source: record.source,
    providerId: record.providerId,
    model: record.modelId,
    reasoningLevel: record.reasoningLevel,
    serviceTier: record.serviceTier,
    totalTokens: record.usage?.totalTokens ?? null,
    costMicroUsd: record.costMicroUsd,
    durationMs: record.durationMs,
    outcome: record.outcome,
  }));
  const lines = stages.map((stage) => [
    stage.stage,
    `attempt=${String(stage.attempt)}`,
    `${stage.providerId}/${stage.model}/${stage.reasoningLevel}`,
    `tier=${stage.tier}${stage.escalated ? ` (from ${stage.baseTier})` : ""}`,
    `serviceTier=${stage.serviceTier}`,
    `tokens=${stage.totalTokens === null ? "unmeasured" : String(stage.totalTokens)}`,
    `cost=${stage.costMicroUsd === null ? "unpriced" : `${String(stage.costMicroUsd)}µUSD`}`,
    `durationMs=${stage.durationMs === null ? "open" : String(stage.durationMs)}`,
  ].join("\t"));
  return success(
    { jobId, ...summary, stages },
    lines.length === 0 ? `No stage attempts recorded for ${jobId}` : lines.join("\n"),
    json,
  );
}

function jobRetry(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): PluginCliResult {
  const jobId = onePositional(parsed, "job retry");
  const current = deps.store.getJob(jobId);
  if (!current) throw new CliOperationError("Job was not found");
  const retryResult = deps.store.retryFailedJob(jobId, current.version, deps.now());
  if (retryResult.outcome === "unavailable") throw new CliOperationError("Job is not retryable");
  deps.notify?.();
  const output = safeJob(deps.store, retryResult.job, deps.now());
  const message = retryResult.outcome !== "retried"
    ? `Retry queued for ${jobId}`
    : `Retried ${jobId} (${retryResult.job.state})`;
  return success(output, message, json);
}

function jobCancel(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): PluginCliResult {
  const jobId = onePositional(parsed, "job cancel");
  const current = deps.store.getJob(jobId);
  if (!current) throw new CliOperationError("Job was not found");
  const activeWorkers = deps.store.getCurrentWorkerLiveness(jobId);
  const next = deps.store.applyJobEvent(
    jobId,
    current.version,
    activeWorkers === null
      ? { type: "CANCEL_REQUESTED" }
      : { type: "CANCEL_REQUESTED", activeWorker: activeWorkers[0] ?? null, activeWorkers },
    deps.now(),
  );
  const output = { ...safeJob(deps.store, next, deps.now()), cancelRequested: next.cancelRequestedAt !== null };
  return success(output, `Cancellation requested for ${jobId}`, json);
}

/**
 * `warn` is for something an operator should know and nothing here can fix — a
 * repository setting, or an optional safety net a policy left out. It never
 * changes the exit code, because a doctor that fails on advice trains people to
 * ignore the rows that mean the project genuinely cannot work.
 */
type DoctorCheck = {
  name: string;
  status: "pass" | "warn" | "fail" | "disabled";
  summary: string;
};

const DOCTOR_SUMMARY_LIMIT = 200;

function addCheck(
  checks: DoctorCheck[],
  name: string,
  passed: boolean,
  passSummary: string,
  failSummary: string,
): void {
  checks.push({ name, status: passed ? "pass" : "fail", summary: passed ? passSummary : failSummary });
}

function addRow(checks: DoctorCheck[], name: string, status: DoctorCheck["status"], summary: string): void {
  checks.push({ name, status, summary: summary.slice(0, DOCTOR_SUMMARY_LIMIT) });
}

function doctorPassed(check: DoctorCheck): boolean {
  return check.status === "pass" || check.status === "warn" || check.status === "disabled";
}

/** Bounded, secret-free labels only — never the configured endpoint, cert, or a raw broker error. */
const CREDENTIAL_CHECK_LABELS: Record<CredentialReadinessCheck, string> = {
  trust_kernel: "credential: trust kernel",
  controller_permission: "credential: controller permission",
  isolated_configuration: "credential: isolated configuration",
  topology_receipt: "credential: topology receipt",
  broker_tls: "credential: broker tls",
  broker_identity: "credential: broker identity",
  protocol_version: "credential: protocol version",
  installation_identity: "credential: installation identity",
  broker_audit: "credential: broker audit",
  onepassword_adapter: "credential: onepassword adapter",
};

/**
 * Runs the diagnostic status check (never a vault resolve) and adds one
 * "disabled" row when credential mode is off, or one row per readiness check
 * the frozen readiness evaluator actually reached otherwise. A short-circuited
 * evaluation legitimately reports fewer rows than the full ten — that is the
 * evaluator declining to claim it checked something it never reached, not a
 * bug here.
 */
async function addCredentialChecks(deps: TelegramAgentCliDependencies, checks: DoctorCheck[]): Promise<void> {
  const status = await deps.credentialAccess.status({});
  if (status.readiness.state === "disabled") {
    checks.push({ name: "credential broker", status: "disabled", summary: "disabled" });
    return;
  }
  for (const check of status.readiness.checks) {
    addCheck(checks, CREDENTIAL_CHECK_LABELS[check.check], check.passed, "ready", "not ready");
  }
}

/**
 * What an unattended merge on this project is currently resting on.
 *
 * Read-only and advisory: nothing here changes a policy or a repository. The
 * rows exist because every one of these is a thing an operator set up once,
 * months before the night a merge lands on it without them, and the only honest
 * moment to notice a missing rollback command is before that night.
 */
async function addAutonomyChecks(
  deps: TelegramAgentCliDependencies,
  checks: DoctorCheck[],
  input: Readonly<{
    policy: ProjectPolicy;
    repository: string | null;
    scope: Readonly<{ hostId: string; cwd: string }> | null;
    signal?: AbortSignal;
  }>,
): Promise<void> {
  const { policy } = input;
  if (policy.autonomy === undefined) return;

  if (!declaresMergeAutonomy(policy)) {
    addRow(checks, "autonomy: branch protection", "disabled", "no unattended merge grant");
  } else if (input.repository === null) {
    addRow(checks, "autonomy: branch protection", "fail", "the project's GitHub remote could not be read");
  } else {
    const verdict = await baseBranchProtection(deps, {
      repository: input.repository,
      branch: policy.baseBranch,
      scope: input.scope,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const branch = policy.baseBranch.slice(0, 60);
    if (verdict.outcome === "unavailable") {
      addRow(checks, "autonomy: branch protection", "fail", `no readable protection or ruleset on ${branch}`);
    } else if (verdict.outcome === "no_required_checks") {
      addRow(checks, "autonomy: branch protection", "fail", `no required status check on ${branch}`);
    } else {
      const found = `${verdict.requiredChecks} required check(s) via ${verdict.source}`;
      addRow(
        checks,
        "autonomy: branch protection",
        verdict.adminEnforced ? "pass" : "warn",
        verdict.adminEnforced ? found : `${found}; admin enforcement is off`,
      );
    }
  }

  addRow(
    checks,
    "autonomy: required checks",
    policy.requiredChecks.length > 0 ? "pass" : "warn",
    policy.requiredChecks.length > 0 ? `${policy.requiredChecks.length} configured` : "none configured",
  );

  // A project that deploys is a project an unattended merge can break, and the
  // rollback is the only thing that turns that into a recovery. The policy
  // schema already refuses this combination, so a failing row here means a
  // stored policy predates that rule or was written around it.
  if (policy.autonomy.unattendedMerge && policy.production !== undefined) {
    const rollback = policy.production.rollbackCommand !== undefined;
    addRow(
      checks,
      "autonomy: rollback command",
      rollback ? "pass" : "fail",
      rollback ? "configured" : "missing; an unattended merge would have no way back",
    );
    const health = policy.production.healthCommands?.length ?? 0;
    addRow(
      checks,
      "autonomy: production health checks",
      health > 0 ? "pass" : "warn",
      health > 0 ? `${health} configured` : "none configured; a crash between deploys is not noticed",
    );
  }

  const regression = policy.regression?.commands.length ?? 0;
  addRow(
    checks,
    "autonomy: regression checks",
    regression > 0 ? "pass" : "warn",
    regression > 0 ? `${regression} configured` : "none configured; nothing checks this project between jobs",
  );
}

async function doctor(
  deps: TelegramAgentCliDependencies,
  projectId: string | undefined,
  context: PluginCliContext,
  json: boolean,
): Promise<PluginCliResult> {
  const checks: DoctorCheck[] = [];
  const activation = deps.runtime();
  addCheck(
    checks,
    "plugin activation",
    activation.ok,
    activationSummary(activation),
    `${activationSummary(activation)}; ${activation.problems.join("; ")}`,
  );
  addCheck(checks, "token presence", Boolean(deps.getBotToken()), "configured", "missing");
  addCheck(checks, "owner pairing", deps.store.getOwner() !== null, "paired", "not paired");
  if (projectId === undefined) {
    const policies = deps.store.listEnabledProjectPolicies();
    addCheck(
      checks,
      "enabled projects",
      policies.length > 0,
      `${policies.length} enabled`,
      "none enabled",
    );
    for (const { policy } of policies) {
      addCheck(
        checks,
        `${policy.alias} production`,
        policy.production !== undefined,
        "configured",
        "missing; merge approval is blocked",
      );
    }
    await addCredentialChecks(deps, checks);
    const output = success(
      { checks },
      checks.map((check) => `${check.name}: ${check.status} (${check.summary})`).join("\n"),
      json,
    );
    return checks.every(doctorPassed) ? output : { ...output, exitCode: 1 };
  }

  const policyRecord = deps.store.getProjectPolicy(projectId);
  addCheck(
    checks,
    "enabled project",
    policyRecord?.policy.enabled === true,
    "enabled",
    "no enabled policy",
  );
  addCheck(
    checks,
    "production deployment and canary",
    policyRecord?.policy.production !== undefined,
    "configured",
    "missing; merge approval is blocked",
  );

  let project: JsonRecord | null = null;
  let repository: string | null = null;
  let source: JsonRecord | null = null;
  try {
    project = await deps.sdk.projects.get({ projectId, signal: context.signal }) as unknown as JsonRecord;
    repository = canonicalGithubRepository(project.gitRemoteUrl);
    source = selectedSource(project);
  } catch {
    project = null;
  }
  const standardReady = project?.id === projectId && project.kind === "standard" && repository !== null && source !== null;
  addCheck(
    checks,
    "standard Git project/source",
    standardReady,
    "standard Git project and source found",
    "standard Git project/source unavailable",
  );

  let defaults: JsonRecord | null = null;
  try {
    const result = await deps.sdk.projects.defaultExecutionOptions({ projectId, signal: context.signal });
    defaults = isRecord(result) ? result : null;
  } catch {
    defaults = null;
  }
  addCheck(
    checks,
    "default execution options",
    defaults !== null,
    "available",
    "missing",
  );

  let providers: JsonRecord[] = [];
  try {
    const result = await deps.sdk.providers.list(source && typeof source.hostId === "string"
      ? { hostId: source.hostId, signal: context.signal }
      : { signal: context.signal });
    providers = Array.isArray(result) ? result.filter(isRecord) : [];
  } catch {
    providers = [];
  }
  const requiredProviderIds = new Set<string>();
  if (typeof defaults?.providerId === "string") requiredProviderIds.add(defaults.providerId);
  if (policyRecord) {
    for (const profile of [policyRecord.policy.implementation, policyRecord.policy.review]) {
      if (profile.providerId) requiredProviderIds.add(profile.providerId);
    }
  }
  const providerReady = requiredProviderIds.size > 0 && [...requiredProviderIds].every((id) => providers.some((item) => item.id === id && item.available !== false));
  addCheck(checks, "provider availability", providerReady, "required providers available", "required provider unavailable");

  let sourceHostReady = false;
  if (source && typeof source.hostId === "string" && typeof source.path === "string" && source.path.length > 0) {
    try {
      const host = await deps.sdk.hosts.get({ hostId: source.hostId, signal: context.signal });
      const hostRecord = host as unknown as JsonRecord;
      sourceHostReady = hostRecord.status === "connected";
    } catch {
      sourceHostReady = false;
    }
  }
  addCheck(checks, "source host/path", sourceHostReady, "connected source host and path", "source host/path unavailable");

  const terminalScope = sourceHostReady && source && typeof source.hostId === "string" && typeof source.path === "string"
    ? { kind: "host_path" as const, hostId: source.hostId, cwd: source.path }
    : null;
  const runGitHubCommand = async (name: string, command: string): Promise<boolean> => {
    if (!terminalScope) return false;
    try {
      const result = await deps.terminal.run({
        scope: terminalScope,
        title: `Telegram Agent doctor: ${name}`,
        command,
        timeoutMs: 30_000,
        signal: context.signal,
      });
      return result.outcome === "exited" && result.exitCode === 0;
    } catch {
      return false;
    }
  };
  const authReady = await runGitHubCommand("gh auth status", "gh auth status");
  addCheck(checks, "gh auth status", authReady, "authenticated", "authentication check failed");
  const repoReady = repository !== null && await runGitHubCommand("gh repo view", `gh repo view ${repository} --json nameWithOwner`);
  addCheck(checks, "gh repo view", repoReady, "repository accessible", "repository check failed");
  addCheck(
    checks,
    "PR merge SDK availability",
    typeof deps.sdk.environments.mergePullRequest === "function",
    "available",
    "unavailable",
  );
  if (policyRecord) {
    await addAutonomyChecks(deps, checks, {
      policy: policyRecord.policy,
      repository,
      scope: terminalScope === null ? null : { hostId: terminalScope.hostId, cwd: terminalScope.cwd },
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
  }

  const output = success(
    { checks },
    checks.map((check) => `${check.name}: ${check.status} (${check.summary})`).join("\n"),
    json,
  );
  return checks.every(doctorPassed) ? output : { ...output, exitCode: 1 };
}

async function runProject(
  deps: TelegramAgentCliDependencies,
  argv: readonly string[],
  context: PluginCliContext,
): Promise<PluginCliResult> {
  if (argv.length === 0) throw new CliInputError("project requires a subcommand");
  const subcommand = argv[0];
  if (subcommand === "list") {
    const parsed = parseFlags(argv.slice(1), PROJECT_LIST_FLAGS);
    noPositionals(parsed);
    return runProjectList(deps, parsed.flags.has("json"));
  }
  if (subcommand === "enable") {
    const parsed = parseFlags(argv.slice(1), PROJECT_ENABLE_FLAGS);
    return enableProject(deps, parsed, context, parsed.flags.has("json"));
  }
  if (subcommand === "disable") {
    const parsed = parseFlags(argv.slice(1), PROJECT_DISABLE_FLAGS);
    return runProjectDisable(deps, parsed, parsed.flags.has("json"));
  }
  throw new CliInputError(`Unknown project subcommand ${subcommand}`);
}

function accessBindingState(value: string, label: string): BrokerBindingState {
  if (!(BROKER_BINDING_STATES as readonly string[]).includes(value)) {
    throw new CliInputError(`${label} must be one of ${BROKER_BINDING_STATES.join(", ")}`);
  }
  return value as BrokerBindingState;
}

/** Local, secret-free projections only — never dispatches to the broker. */
function accessList(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): PluginCliResult {
  noPositionals(parsed);
  const state = parsed.values.has("state")
    ? accessBindingState(parsed.values.get("state") ?? "", "--state")
    : undefined;
  const limit = readOptionalInteger(parsed, "limit", "--limit", 1, MAX_ACCESS_LIST_LIMIT) ?? MAX_ACCESS_LIST_LIMIT;
  const result = deps.credentialAccess.list({ state, afterBindingId: parsed.values.get("after"), limit });
  const summaryLine = result.available
    ? `${result.bindings.length} binding(s)${result.truncated ? " (truncated)" : ""}`
    : "credential broker disabled";
  return success(
    result,
    [
      summaryLine,
      ...result.bindings.map((binding) =>
        `${binding.bindingId}\t${binding.label}\t${binding.state}\tgeneration=${binding.generation}\trisk=${binding.risk}`),
    ].join("\n"),
    json,
  );
}

/**
 * Runs the same allowed diagnostic `broker.health` the doctor uses, plus one
 * selected binding's secret-free metadata. Never resolves or verifies a
 * credential — that stays out of the operator CLI by design.
 */
async function accessStatus(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): Promise<PluginCliResult> {
  if (parsed.positionals.length > 1) throw new CliInputError("access status accepts at most one binding-id");
  const bindingId = parsed.positionals[0];
  const result = await deps.credentialAccess.status({ bindingId });
  const lines = [
    `readiness: ${result.readiness.state}`,
    ...result.readiness.checks.map((check) => `  ${check.check}: ${check.passed ? "pass" : "fail"}`),
  ];
  if (result.health) {
    lines.push(`broker: adapter=${result.health.adapterState} bindings=${result.health.bindingCount} auditWritable=${result.health.auditWritable}`);
  }
  if (result.binding) {
    lines.push(`binding: ${result.binding.bindingId} state=${result.binding.state} generation=${result.binding.generation}`);
  } else if (bindingId) {
    lines.push(`binding: ${bindingId} not found`);
  }
  return success(result, lines.join("\n"), json);
}

async function runAccess(
  deps: TelegramAgentCliDependencies,
  argv: readonly string[],
): Promise<PluginCliResult> {
  if (argv.length === 0) throw new CliInputError("access requires a subcommand");
  const subcommand = argv[0];
  if (subcommand === "list") {
    const parsed = parseFlags(argv.slice(1), ACCESS_LIST_FLAGS);
    return accessList(deps, parsed, parsed.flags.has("json"));
  }
  if (subcommand === "status") {
    const parsed = parseFlags(argv.slice(1), ACCESS_STATUS_FLAGS);
    return accessStatus(deps, parsed, parsed.flags.has("json"));
  }
  throw new CliInputError(`Unknown access subcommand ${subcommand}`);
}

/**
 * How a pipeline worker reads the specification it is building against. It is a
 * command rather than a tool because a worker is a separate BB thread that
 * never opens this plugin's database, and rather than a file on disk because a
 * second copy of a specification is a copy that drifts.
 *
 * Read-only by construction: there is no reference subcommand here that writes.
 * Filing a document is the owner's act, through Telegram.
 */
async function runReference(
  deps: TelegramAgentCliDependencies,
  argv: readonly string[],
  context: PluginCliContext,
): Promise<PluginCliResult> {
  if (argv.length === 0) throw new CliInputError("reference requires a subcommand");
  const subcommand = argv[0];
  if (subcommand === "search") {
    const parsed = parseFlags(argv.slice(1), REFERENCE_SEARCH_FLAGS);
    const json = parsed.flags.has("json");
    const query = onePositional(parsed, "query");
    const limit = readOptionalInteger(parsed, "limit", "--limit", 1, MAX_REFERENCE_SEARCH_RESULTS)
      ?? MAX_REFERENCE_SEARCH_RESULTS;
    const projectId = referenceProjectScope(parsed, context);
    const passages = deps.store.searchReferencePassages({
      query,
      projectId,
      limit,
    });
    return success(
      { passages },
      passages.length === 0
        ? "no matching passage"
        : passages.map((passage) =>
          `${passage.id}\t${passage.documentTitle}\t${passage.sectionPath}\n${passage.body}`).join("\n\n"),
      json,
    );
  }
  if (subcommand === "show") {
    const parsed = parseFlags(argv.slice(1), REFERENCE_SHOW_FLAGS);
    const json = parsed.flags.has("json");
    const projectId = referenceProjectScope(parsed, context);
    const passage = deps.store.getReferencePassage(onePositional(parsed, "passage-id"), projectId);
    if (passage === null) throw new CliOperationError("No such passage");
    return success(passage, `${passage.documentTitle}\t${passage.sectionPath}\n${passage.body}`, json);
  }
  if (subcommand === "list") {
    const parsed = parseFlags(argv.slice(1), REFERENCE_LIST_FLAGS);
    const json = parsed.flags.has("json");
    noPositionals(parsed);
    const documents = deps.store.listReferenceDocuments(referenceProjectScope(parsed, context));
    return success(
      { documents },
      documents.length === 0
        ? "no reference document"
        : documents.map((document) =>
          `${document.title}\t${document.scope}\tv${document.version}\t${document.map.length} sections`).join("\n"),
      json,
    );
  }
  throw new CliInputError(`Unknown reference subcommand ${subcommand}`);
}

function referenceProjectScope(parsed: ParsedFlags, context: PluginCliContext): string | null {
  const requested = parsed.values.get("project") ?? null;
  const bound = context.projectId ?? null;
  if (bound !== null && requested !== null && requested !== bound) {
    throw new CliInputError("--project must match the invoking thread's project");
  }
  return bound ?? requested;
}

function capabilityRecipe(value: string, label: string): TaskRecipe {
  if (!(TASK_RECIPES as readonly string[]).includes(value)) {
    throw new CliInputError(`${label} must be one of ${RECIPE_PROMOTION_ORDER.join(", ")}`);
  }
  return value as TaskRecipe;
}

function boundedCapabilityId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) {
    throw new CliInputError(`${label} is invalid`);
  }
  return value;
}

async function capabilityStatus(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): Promise<PluginCliResult> {
  if (parsed.positionals.length > 1) throw new CliInputError("capability status accepts at most one recipe");
  const recipes = parsed.positionals[0]
    ? [capabilityRecipe(parsed.positionals[0], "recipe")]
    : [...RECIPE_PROMOTION_ORDER];
  const settings = deps.capabilitySettings();
  const rows = await Promise.all(recipes.map(async (recipe) => {
    const promotion = await deps.capabilityPromotions.status(recipe);
    const routing = deps.capabilityPromotions.routingStatus(recipe, settings.jobGraph);
    return {
      recipe,
      routingMode: routing.routingMode,
      promotion: {
        status: promotion.status,
        ready: promotion.ready,
        reasonCodes: promotion.reasonCodes.slice(0, 32),
        evidenceDigest: promotion.evidenceDigest,
        candidateSuccesses: promotion.candidateSuccesses,
        baselineSuccesses: promotion.baselineSuccesses,
      },
      decision: routing.decision ? {
        id: routing.decision.id,
        action: routing.decision.action,
        reasonCode: routing.decision.reasonCode,
        evidenceDigest: routing.decision.evidenceDigest,
        createdAt: routing.decision.createdAt,
      } : null,
    };
  }));
  return success(
    { settings, recipes: rows },
    rows.map((row) =>
      `${row.recipe}: ${row.routingMode}; promotion ${row.promotion.status}` +
      (row.decision ? ` (${row.decision.action})` : ""),
    ).join("\n"),
    json,
  );
}

function capabilityInventory(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): PluginCliResult {
  noPositionals(parsed);
  const hostScope = boundedCapabilityId(parsed.values.get("host") ?? "primary", "--host");
  const limit = readOptionalInteger(parsed, "limit", "--limit", 1, MAX_COLLECTION_SIZE) ?? 50;
  const items = deps.store.listExternalCapabilityInventory(hostScope, limit).map((item) => ({
    capabilityId: item.capabilityId,
    capabilityKind: item.capabilityKind,
    version: item.version,
    digest: item.digest,
    status: item.status,
    discoveredAt: item.discoveredAt,
  }));
  const health = deps.store.getExternalCapabilityInventoryHealth(hostScope);
  const projectedHealth = health ? {
    status: health.status,
    errorClass: health.errorClass,
    refreshedAt: health.refreshedAt,
  } : null;
  return success(
    { hostScope, health: projectedHealth, items },
    [`${hostScope}: ${projectedHealth?.status ?? "not-refreshed"}`, ...items.map((item) =>
      `${item.capabilityId} (${item.capabilityKind}, ${item.status})`)].join("\n"),
    json,
  );
}

function capabilityReceipts(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): PluginCliResult {
  const profileId = boundedCapabilityId(onePositional(parsed, "capability receipts"), "profile-id");
  const limit = readOptionalInteger(parsed, "limit", "--limit", 1, MAX_COLLECTION_SIZE) ?? 50;
  const profile = deps.store.getCapabilityProfileById(profileId);
  if (!profile) throw new CliOperationError("Capability profile was not found");
  const receipts = deps.store.listCapabilityReceipts(profileId, limit).map((receipt) => ({
    id: receipt.id,
    profileRevision: receipt.profileRevision,
    capabilityId: receipt.capabilityId,
    capabilityKind: receipt.capabilityKind,
    eventType: receipt.eventType,
    reasonCode: receipt.reasonCode,
    mandatory: receipt.mandatory,
    outcome: receipt.outcome,
    evidenceCount: receipt.evidenceRefs.length,
    createdAt: receipt.createdAt,
  }));
  const projectedProfile = {
    id: profile.id,
    revision: profile.revision,
    recipeId: profile.recipeId,
    recipeVersion: profile.recipeVersion,
    mode: profile.mode,
    registryDigest: profile.registryDigest,
    graphDigest: profile.graphDigest,
    model: profile.model,
    selectedCount: profile.assignments.length,
  };
  return success(
    { profile: projectedProfile, receipts },
    [
      `${profile.id}: ${profile.recipeId}@${profile.recipeVersion} revision ${profile.revision}`,
      `${profile.model.providerId}/${profile.model.modelId} ${profile.model.reasoning} ${profile.model.serviceTier}`,
      ...receipts.map((receipt) =>
        `${receipt.capabilityId}: ${receipt.outcome ?? receipt.eventType} (${receipt.evidenceCount} evidence refs)`),
    ].join("\n"),
    json,
  );
}

async function capabilityPromote(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): Promise<PluginCliResult> {
  const recipe = capabilityRecipe(onePositional(parsed, "capability promote"), "recipe");
  try {
    const decision = await deps.capabilityPromotions.promote(recipe);
    deps.notify?.();
    return success(decision, `${recipe} is active for new attempts`, json);
  } catch (error) {
    if (!(error instanceof RecipePromotionIncompleteError)) throw error;
    const output = {
      recipe,
      status: error.assessment.status,
      ready: false,
      reasonCodes: error.assessment.reasonCodes.slice(0, 32),
      evidenceDigest: error.assessment.evidenceDigest,
    };
    return json
      ? { exitCode: 1, stdout: serialize(output), stderr: "" }
      : {
          exitCode: 1,
          stdout: "",
          stderr: `Promotion ${error.assessment.status}: ${error.assessment.reasonCodes.slice(0, 8).join(", ")}\n`,
        };
  }
}

function capabilityRollback(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): PluginCliResult {
  const recipe = capabilityRecipe(onePositional(parsed, "capability rollback"), "recipe");
  const decision = deps.capabilityPromotions.rollback(recipe);
  deps.notify?.();
  return success(decision, `${recipe} is shadow-only for new attempts`, json);
}

async function runCapability(
  deps: TelegramAgentCliDependencies,
  argv: readonly string[],
): Promise<PluginCliResult> {
  if (argv.length === 0) throw new CliInputError("capability requires a subcommand");
  const subcommand = argv[0];
  if (subcommand === "status") {
    const parsed = parseFlags(argv.slice(1), CAPABILITY_STATUS_FLAGS);
    return capabilityStatus(deps, parsed, parsed.flags.has("json"));
  }
  if (subcommand === "inventory") {
    const parsed = parseFlags(argv.slice(1), CAPABILITY_INVENTORY_FLAGS);
    return capabilityInventory(deps, parsed, parsed.flags.has("json"));
  }
  if (subcommand === "receipts") {
    const parsed = parseFlags(argv.slice(1), CAPABILITY_RECEIPT_FLAGS);
    return capabilityReceipts(deps, parsed, parsed.flags.has("json"));
  }
  if (subcommand === "promote" || subcommand === "rollback") {
    const parsed = parseFlags(argv.slice(1), CAPABILITY_RECIPE_FLAGS);
    return subcommand === "promote"
      ? capabilityPromote(deps, parsed, parsed.flags.has("json"))
      : capabilityRollback(deps, parsed, parsed.flags.has("json"));
  }
  throw new CliInputError(`Unknown capability subcommand ${subcommand}`);
}

async function runJob(
  deps: TelegramAgentCliDependencies,
  argv: readonly string[],
): Promise<PluginCliResult> {
  if (argv.length === 0) throw new CliInputError("job requires a subcommand");
  const subcommand = argv[0];
  if (subcommand === "list") {
    const parsed = parseFlags(argv.slice(1), JOB_LIST_FLAGS);
    return jobList(deps, parsed, parsed.flags.has("json"));
  }
  if (subcommand === "show" || subcommand === "spend" || subcommand === "retry" || subcommand === "cancel") {
    const parsed = parseFlags(argv.slice(1), JOB_ID_FLAGS);
    const json = parsed.flags.has("json");
    if (subcommand === "show") return jobShow(deps, parsed, json);
    if (subcommand === "spend") return jobSpend(deps, parsed, json);
    if (subcommand === "retry") return jobRetry(deps, parsed, json);
    return jobCancel(deps, parsed, json);
  }
  throw new CliInputError(`Unknown job subcommand ${subcommand}`);
}

export async function runTelegramAgentCli(
  deps: TelegramAgentCliDependencies,
  argv: readonly string[],
  context: PluginCliContext,
): Promise<PluginCliResult> {
  const json = jsonRequested(argv);
  try {
    if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "help")) {
      return { exitCode: 0, stdout: CLI_HELP, stderr: "" };
    }
    if (argv.length === 0) throw new CliInputError("A telegram-agent command is required");
    const command = argv[0];
    if (command === "pair") {
      const parsed = parseFlags(argv.slice(1), TOP_LEVEL_FLAGS);
      noPositionals(parsed);
      return await runPair(deps, context, parsed.flags.has("json"));
    }
    if (command === "unpair") {
      const parsed = parseFlags(argv.slice(1), UNPAIR_FLAGS);
      noPositionals(parsed);
      return await runUnpair(deps, parsed, context, parsed.flags.has("json"));
    }
    if (command === "memory") {
      if (argv[1] !== "import") throw new CliInputError("Unknown memory command");
      return await runMemoryImport(deps, argv.slice(2), context);
    }
    if (command === "project") return await runProject(deps, argv.slice(1), context);
    if (command === "job") return await runJob(deps, argv.slice(1));
    if (command === "capability") return await runCapability(deps, argv.slice(1));
    if (command === "access") return await runAccess(deps, argv.slice(1));
    if (command === "reference") return await runReference(deps, argv.slice(1), context);
    if (command === "doctor") {
      const parsed = parseFlags(argv.slice(1), DOCTOR_FLAGS);
      if (parsed.positionals.length > 1) throw new CliInputError("doctor accepts at most one project-id");
      return doctor(deps, parsed.positionals[0], context, parsed.flags.has("json"));
    }
    throw new CliInputError(`Unknown command ${command}`);
  } catch (error) {
    if (error instanceof CliInputError) return failure(2, error.message, json);
    if (error instanceof CliOperationError) return failure(1, error.message, json);
    return failure(1, "Operation failed safely", json);
  }
}
