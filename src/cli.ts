import type {
  BbPluginApi,
  PluginCliContext,
  PluginCliResult,
} from "@bb/plugin-sdk";
import { createSecret, hashSecret } from "./crypto";
import {
  projectPolicySchema,
  type Job,
  type ProjectPolicy,
} from "./domain/models";
import { TelegramClient } from "./telegram/client";
import type { TelegramAgentStore } from "./storage/store";
import { TerminalCommandRunner } from "./bb/terminal-command";

type BbSdk = BbPluginApi["sdk"];

export type TelegramAgentCliDependencies = {
  store: TelegramAgentStore;
  sdk: BbSdk;
  terminal: TerminalCommandRunner;
  now: () => number;
  getBotToken: () => string | undefined;
  createTelegramClient: (token: string) => Pick<TelegramClient, "getMe">;
  revokeAllApprovals: (now: number) => number;
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

class CliOperationError extends Error {}

const JSON_FLAG: FlagSpec = { kind: "flag" };

const TOP_LEVEL_FLAGS: Record<string, FlagSpec> = { json: JSON_FLAG };

const PROJECT_ENABLE_FLAGS: Record<string, FlagSpec> = {
  json: JSON_FLAG,
  "policy-json": { kind: "value" },
  "policy-file": { kind: "value" },
  host: { kind: "value" },
  alias: { kind: "value" },
  base: { kind: "value" },
  "merge-method": { kind: "value" },
  "validation-json": { kind: "value", repeatable: true },
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

const MAX_COLLECTION_SIZE = 100;
const PAIRING_TTL_MS = 10 * 60 * 1_000;
const MAX_ERROR_LENGTH = 240;
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

function safeJob(job: Job): JsonRecord {
  return {
    id: job.id,
    state: job.state,
    projectId: job.projectId,
    environmentId: job.environmentId,
    implementationThreadId: job.implementationThreadId,
    reviewThreadId: job.reviewThreadId,
    prNumber: job.prNumber,
    prUrl: job.prUrl,
    prHeadSha: job.prHeadSha,
    reviewCycle: job.reviewCycle,
    cancelRequested: job.cancelRequestedAt !== null,
    blockedReason: job.blockedReason,
    lastError: job.lastError,
    version: job.version,
    updatedAt: job.updatedAt,
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
    version: record.version,
  };
}

async function readRemotePolicyFile(
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
  const candidate: JsonRecord = {
    projectId,
    alias,
    enabled: true,
    githubRepository: repository,
    baseBranch,
    implementation: profileFromFlags(parsed, "implementation"),
    review: profileFromFlags(parsed, "review"),
    validationCommands,
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
        return readRemotePolicyFile(deps, path, parsed.values.get("host"), context);
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
  const stored = deps.store.upsertProjectPolicy(policy, deps.now());
  return success(policySummary(stored), `Enabled ${stored.policy.alias} (${stored.policy.projectId})`, json);
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
    hasActiveJob: deps.store.getActiveJob() !== null,
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

function runUnpair(
  deps: TelegramAgentCliDependencies,
  json: boolean,
): PluginCliResult {
  const now = deps.now();
  const revoked = deps.store.revokeOwner(now);
  const approvalsRevoked = deps.revokeAllApprovals(now);
  return success(
    { revoked, approvalsRevoked },
    revoked ? "Telegram owner unpaired" : "Telegram owner was already unpaired",
    json,
  );
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
  const jobs = deps.store.listJobs(limit).slice(0, MAX_COLLECTION_SIZE).map(safeJob);
  return success({ jobs }, jobs.map((job) => `${String(job.id)}\t${String(job.state)}`).join("\n"), json);
}

function jobShow(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): PluginCliResult {
  const jobId = onePositional(parsed, "job show");
  const job = deps.store.getJob(jobId);
  if (!job) throw new CliOperationError("Job was not found");
  const output = safeJob(job);
  return success(output, `${String(output.id)}\t${String(output.state)}\tversion=${String(output.version)}`, json);
}

function jobRetry(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): PluginCliResult {
  const jobId = onePositional(parsed, "job retry");
  const current = deps.store.getJob(jobId);
  if (!current) throw new CliOperationError("Job was not found");
  const next = deps.store.applyJobEvent(jobId, current.version, { type: "RETRY" }, deps.now());
  const output = safeJob(next);
  return success(output, `Retried ${jobId} (${next.state})`, json);
}

function jobCancel(
  deps: TelegramAgentCliDependencies,
  parsed: ParsedFlags,
  json: boolean,
): PluginCliResult {
  const jobId = onePositional(parsed, "job cancel");
  const current = deps.store.getJob(jobId);
  if (!current) throw new CliOperationError("Job was not found");
  const next = deps.store.applyJobEvent(
    jobId,
    current.version,
    { type: "CANCEL_REQUESTED", activeWorker: deps.store.getWorkerLiveness(jobId) },
    deps.now(),
  );
  const output = { ...safeJob(next), cancelRequested: next.cancelRequestedAt !== null };
  return success(output, `Cancellation requested for ${jobId}`, json);
}

type DoctorCheck = {
  name: string;
  status: "pass" | "fail";
  summary: string;
};

function addCheck(
  checks: DoctorCheck[],
  name: string,
  passed: boolean,
  passSummary: string,
  failSummary: string,
): void {
  checks.push({ name, status: passed ? "pass" : "fail", summary: passed ? passSummary : failSummary });
}

async function doctor(
  deps: TelegramAgentCliDependencies,
  projectId: string | undefined,
  context: PluginCliContext,
  json: boolean,
): Promise<PluginCliResult> {
  const checks: DoctorCheck[] = [];
  addCheck(checks, "token presence", Boolean(deps.getBotToken()), "configured", "missing");
  addCheck(checks, "owner pairing", deps.store.getOwner() !== null, "paired", "not paired");
  if (projectId === undefined) {
    const output = success(
      { checks },
      checks.map((check) => `${check.name}: ${check.status} (${check.summary})`).join("\n"),
      json,
    );
    return checks.every((check) => check.status === "pass") ? output : { ...output, exitCode: 1 };
  }

  const policyRecord = deps.store.getProjectPolicy(projectId);
  addCheck(
    checks,
    "enabled project",
    policyRecord?.policy.enabled === true,
    "enabled",
    "no enabled policy",
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

  const allPassed = checks.every((check) => check.status === "pass");
  const output = success(
    { checks },
    checks.map((check) => `${check.name}: ${check.status} (${check.summary})`).join("\n"),
    json,
  );
  return allPassed ? output : { ...output, exitCode: 1 };
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
  if (subcommand === "show" || subcommand === "retry" || subcommand === "cancel") {
    const parsed = parseFlags(argv.slice(1), JOB_ID_FLAGS);
    const json = parsed.flags.has("json");
    if (subcommand === "show") return jobShow(deps, parsed, json);
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
    if (argv.length === 0) throw new CliInputError("A telegram-agent command is required");
    const command = argv[0];
    if (command === "pair") {
      const parsed = parseFlags(argv.slice(1), TOP_LEVEL_FLAGS);
      noPositionals(parsed);
      return await runPair(deps, context, parsed.flags.has("json"));
    }
    if (command === "unpair") {
      const parsed = parseFlags(argv.slice(1), TOP_LEVEL_FLAGS);
      noPositionals(parsed);
      return runUnpair(deps, parsed.flags.has("json"));
    }
    if (command === "project") return await runProject(deps, argv.slice(1), context);
    if (command === "job") return await runJob(deps, argv.slice(1));
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
