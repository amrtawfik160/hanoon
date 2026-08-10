import { z } from "zod";
import type { Job, ProjectPolicy } from "../domain/models";
import type { CommandResult } from "./terminal-command";

export const GIT_REMOTE_COMMAND = "git remote get-url origin";
export const PR_HEAD_COMMAND = (number: number): string =>
  `git ls-remote --exit-code origin refs/pull/${String(number)}/head`;
export const PR_VIEW_COMMAND = (number: number): string =>
  `gh pr view ${String(number)} --json number,url,state,isDraft,baseRefName,headRefName,mergeStateStatus,mergeable,reviewDecision,changedFiles,additions,deletions,mergeCommit,mergedAt`;
export const PR_CHECKS_COMMAND = (number: number): string =>
  `gh pr checks ${String(number)} --required --json name,bucket,state,link`;

const SHA = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

export type ValidationErrorCode =
  | "invalid_remote"
  | "repository_mismatch"
  | "invalid_ls_remote"
  | "wrong_ls_remote_ref"
  | "multiple_ls_remote_rows"
  | "missing_ls_remote_row"
  | "head_mismatch"
  | "head_moved"
  | "environment_unavailable"
  | "environment_dirty"
  | "checkout_not_branch"
  | "head_missing"
  | "command_timeout"
  | "command_aborted"
  | "command_failed"
  | "invalid_pr_number"
  | "invalid_json"
  | "invalid_checks_exit"
  | "invalid_redaction_pattern";

export class ValidationError extends Error {
  public constructor(public readonly code: ValidationErrorCode, message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface GitHubPrSnapshot {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  mergeStateStatus: string;
  mergeable: string | null;
  reviewDecision: string | null;
  changedFiles: number;
  additions: number;
  deletions: number;
  mergeCommit: unknown;
  mergedAt: string | null;
}

export interface RequiredCheck {
  name: string;
  bucket: string;
  state: string;
  link: string | null;
}

export interface CommandReceipt {
  command: string;
  outcome: "pass" | "fail" | "timed_out" | "aborted";
  exitCode: number | null;
  output: string;
}

export interface ValidationSnapshot {
  headSha: string;
  originRepository: string;
  commandReceipts: CommandReceipt[];
  githubPr?: GitHubPrSnapshot;
  requiredChecks: RequiredCheck[];
  validationOutcome: "pass" | "fail";
  completedAt: string;
  reviewAttemptId?: string;
}

type CommandRunner = {
  run(input: {
    scope: { kind: "environment"; environmentId: string };
    title: string;
    command: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<CommandResult>;
};

type EnvironmentApi = {
  status(input: { environmentId: string; mergeBaseBranch?: string; signal?: AbortSignal }): Promise<unknown>;
};

export interface ValidationInput {
  runner: CommandRunner;
  environments: EnvironmentApi;
  environmentId: string;
  job: Pick<Job, "id" | "version" | "policy" | "prNumber"> & {
    policy: ProjectPolicy;
    prNumber: number;
  };
  currentReviewAttempt?: { id: string };
  signal?: AbortSignal;
}

export interface PrHeadResolutionInput {
  runner: CommandRunner;
  environments: EnvironmentApi;
  environmentId: string;
  prNumber: number;
  githubRepository: string;
  signal?: AbortSignal;
}

export type PrHeadResolution =
  | { event: "PR_HEAD_RESOLVED"; headSha: string; remoteHeadSha: string; originRepository: string }
  | { event: "PR_HEAD_RESOLUTION_FAILED"; code: ValidationErrorCode; reason: string };

type EnvironmentEvidence = { clean: boolean; branch: string; headSha: string };
type ReceiptCollector = { receipts: CommandReceipt[]; redactor: (value: string) => string };

const githubPrSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string().min(1),
    state: z.string().min(1),
    isDraft: z.boolean(),
    baseRefName: z.string().min(1),
    headRefName: z.string().min(1),
    mergeStateStatus: z.string().min(1),
    mergeable: z.string().nullable(),
    reviewDecision: z.string().nullable(),
    changedFiles: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    mergeCommit: z.unknown(),
    mergedAt: z.string().nullable(),
  })
  .strict();

const requiredCheckSchema = z
  .object({
    name: z.string().min(1),
    bucket: z.string().min(1),
    state: z.string(),
    link: z.string().nullable(),
  })
  .strict();

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function fail(code: ValidationErrorCode, message: string): never {
  throw new ValidationError(code, message);
}

function validatePrNumber(number: unknown): asserts number is number {
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) {
    fail("invalid_pr_number", "Pull-request number must be a positive integer");
  }
}

function repositoryFromPath(pathname: string): string {
  const path = pathname.replace(/^\/+|\/+$/g, "");
  const withoutGit = path.endsWith(".git") ? path.slice(0, -4) : path;
  const parts = withoutGit.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail("invalid_remote", "Origin is not a supported GitHub repository");
  const repository = `${parts[0]}/${parts[1]}`.toLowerCase();
  if (!REPOSITORY.test(repository)) fail("invalid_remote", "Origin is not a supported GitHub repository");
  return repository;
}

export function parseGitHubRemote(rawRemote: string): string {
  if (typeof rawRemote !== "string") fail("invalid_remote", "Origin is not a supported GitHub repository");
  const remote = rawRemote.trim();
  if (!remote) fail("invalid_remote", "Origin is not a supported GitHub repository");

  const scp = remote.match(/^git@github\.com:([^\s?#]+)$/i);
  if (scp) return repositoryFromPath(scp[1]);

  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    fail("invalid_remote", "Origin is not a supported GitHub repository");
  }
  if (parsed.hostname.toLowerCase() !== "github.com" || parsed.search || parsed.hash) {
    fail("invalid_remote", "Origin is not a supported GitHub repository");
  }
  if (parsed.protocol === "ssh:") {
    if (parsed.username !== "git" || parsed.password || (parsed.port && parsed.port !== "22")) {
      fail("invalid_remote", "Origin is not a supported GitHub repository");
    }
    return repositoryFromPath(parsed.pathname);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    fail("invalid_remote", "Origin is not a supported GitHub repository");
  }
  return repositoryFromPath(parsed.pathname);
}

export function parseLsRemoteHead(output: string, prNumber: number): string {
  validatePrNumber(prNumber);
  const expectedRef = `refs/pull/${String(prNumber)}/head`;
  const rows = output
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row.length > 0);
  if (rows.length === 0) fail("missing_ls_remote_row", "Git remote did not return the pull-request head");
  if (rows.length !== 1) fail("multiple_ls_remote_rows", "Git remote returned multiple pull-request head rows");
  const fields = rows[0].split(/\s+/);
  if (fields.length !== 2 || !SHA.test(fields[0])) fail("invalid_ls_remote", "Git remote returned a malformed pull-request head row");
  if (fields[1] !== expectedRef) fail("wrong_ls_remote_ref", "Git remote returned an unexpected pull-request ref");
  return fields[0].toLowerCase();
}

function buildRedactor(patterns: readonly string[]): (value: string) => string {
  const configured: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      configured.push(new RegExp(pattern, "g"));
    } catch {
      fail("invalid_redaction_pattern", "Configured output redaction pattern is not a valid regular expression");
    }
  }
  const generic = [
    /\bBearer\s+[^\s]+/gi,
    /\b(?:github_pat|gh[pousr])_[A-Za-z0-9_]+/g,
    /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*[^\s]+/gi,
    /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
  ];
  return (value: string): string => {
    let redacted = value;
    for (const pattern of [...generic, ...configured]) redacted = redacted.replace(pattern, "[REDACTED]");
    return redacted;
  };
}

function receiptFor(
  collector: ReceiptCollector,
  command: string,
  result: CommandResult,
): void {
  collector.receipts.push({
    command,
    outcome:
      result.outcome === "exited" ? (result.exitCode === 0 ? "pass" : "fail") : result.outcome,
    exitCode: result.outcome === "exited" ? result.exitCode : null,
    output: result.outcome === "exited" ? collector.redactor(result.output) : "",
  });
}

async function runCommand(
  runner: CommandRunner,
  collector: ReceiptCollector,
  scopeEnvironmentId: string,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Extract<CommandResult, { outcome: "exited" }>> {
  const result = await runner.run({
    scope: { kind: "environment", environmentId: scopeEnvironmentId },
    title: `Telegram validation: ${command.slice(0, 80)}`,
    command,
    timeoutMs,
    signal,
  });
  receiptFor(collector, command, result);
  if (result.outcome === "timed_out") fail("command_timeout", `Command timed out: ${command}`);
  if (result.outcome === "aborted") fail("command_aborted", `Command was aborted: ${command}`);
  return result;
}

function environmentEvidence(status: unknown): EnvironmentEvidence {
  const value = asRecord(status);
  if (value.available === false || value.outcome === "unavailable" || value.outcome === "not_applicable") {
    fail("environment_unavailable", "Environment status is unavailable");
  }

  const workspace = asRecord(value.workspace);
  const workingTree = asRecord(value.workingTree ?? workspace.workingTree);
  const checkout = asRecord(value.checkout ?? workspace.checkout);
  const clean =
    value.clean === true ||
    (workingTree.state === "clean" && workingTree.hasUncommittedChanges === false);
  if (!clean) fail("environment_dirty", "Environment worktree is not clean");
  if (checkout.kind !== "branch") fail("checkout_not_branch", "Environment checkout is not a named branch");
  const headSha = checkout.headSha;
  if (typeof headSha !== "string" || !SHA.test(headSha)) fail("head_missing", "Environment checkout has no full head SHA");
  const branch = checkout.branchName ?? checkout.branch;
  if (typeof branch !== "string" || branch.length === 0) fail("checkout_not_branch", "Environment checkout has no branch name");
  return { clean: true, branch, headSha };
}

async function getEnvironmentEvidence(
  environments: EnvironmentApi,
  environmentId: string,
  mergeBaseBranch: string | undefined,
  signal?: AbortSignal,
): Promise<EnvironmentEvidence> {
  return environmentEvidence(await environments.status({ environmentId, mergeBaseBranch, signal }));
}

async function collectHeadTruth(input: {
  runner: CommandRunner;
  environments: EnvironmentApi;
  environmentId: string;
  prNumber: number;
  expectedRepository: string;
  baseBranch?: string;
  signal?: AbortSignal;
  collector: ReceiptCollector;
  requireSecondLookup: boolean;
}): Promise<{ originRepository: string; remoteHeadSha: string; local: EnvironmentEvidence }> {
  validatePrNumber(input.prNumber);
  const local = await getEnvironmentEvidence(input.environments, input.environmentId, input.baseBranch, input.signal);
  const remoteResult = await runCommand(
    input.runner,
    input.collector,
    input.environmentId,
    GIT_REMOTE_COMMAND,
    60_000,
    input.signal,
  );
  if (remoteResult.exitCode !== 0) fail("command_failed", "Unable to read the origin repository");
  const originRepository = parseGitHubRemote(remoteResult.output);
  if (originRepository.toLowerCase() !== input.expectedRepository.toLowerCase()) {
    fail("repository_mismatch", "Origin repository does not match the immutable policy repository");
  }

  const first = await runCommand(
    input.runner,
    input.collector,
    input.environmentId,
    PR_HEAD_COMMAND(input.prNumber),
    60_000,
    input.signal,
  );
  if (first.exitCode !== 0) fail("command_failed", "Unable to read the pull-request head from git");
  const firstSha = parseLsRemoteHead(first.output, input.prNumber);
  if (firstSha !== local.headSha) fail("head_mismatch", "Local environment HEAD does not match the remote pull-request head");

  if (input.requireSecondLookup) {
    const second = await runCommand(
      input.runner,
      input.collector,
      input.environmentId,
      PR_HEAD_COMMAND(input.prNumber),
      60_000,
      input.signal,
    );
    if (second.exitCode !== 0) fail("command_failed", "Unable to re-read the pull-request head from git");
    const secondSha = parseLsRemoteHead(second.output, input.prNumber);
    if (secondSha !== firstSha) fail("head_moved", "The pull-request head changed during validation");
  }
  return { originRepository, remoteHeadSha: firstSha, local };
}

function validationCommands(policy: ProjectPolicy): Array<{ command: string; timeoutMs: number }> {
  return (policy.validationCommands as unknown as Array<unknown>).map((entry) => {
    if (typeof entry === "string") return { command: entry, timeoutMs: 3_600_000 };
    const value = asRecord(entry);
    if (typeof value.command !== "string" || value.command.length === 0) {
      throw new TypeError("Validation command must be an owner-authored command");
    }
    return {
      command: value.command,
      timeoutMs: typeof value.timeoutMs === "number" ? value.timeoutMs : 3_600_000,
    };
  });
}

function parseJson<T>(output: string, schema: z.ZodType<T>, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail("invalid_json", `${label} did not return valid JSON`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) fail("invalid_json", `${label} did not match its strict JSON schema`);
  return result.data;
}

function checksSchema(): z.ZodType<RequiredCheck[]> {
  return z.array(requiredCheckSchema);
}

export async function runValidation(input: ValidationInput): Promise<ValidationSnapshot> {
  validatePrNumber(input.job.prNumber);
  if (!input.job.policy) throw new TypeError("Validation requires an immutable project policy");
  const policy = input.job.policy;
  const redactor = buildRedactor(policy.outputRedactionPatterns);
  const collector: ReceiptCollector = { receipts: [], redactor };
  const head = await collectHeadTruth({
    runner: input.runner,
    environments: input.environments,
    environmentId: input.environmentId,
    prNumber: input.job.prNumber,
    expectedRepository: policy.githubRepository,
    baseBranch: policy.baseBranch,
    signal: input.signal,
    collector,
    requireSecondLookup: false,
  });

  for (const validation of validationCommands(policy)) {
    const result = await runCommand(
      input.runner,
      collector,
      input.environmentId,
      validation.command,
      validation.timeoutMs,
      input.signal,
    );
    if (result.exitCode !== 0) {
      return {
        headSha: head.remoteHeadSha,
        originRepository: head.originRepository,
        commandReceipts: collector.receipts,
        requiredChecks: [],
        validationOutcome: "fail",
        completedAt: new Date().toISOString(),
        reviewAttemptId: input.currentReviewAttempt?.id,
      };
    }
  }

  const pr = await runCommand(
    input.runner,
    collector,
    input.environmentId,
    PR_VIEW_COMMAND(input.job.prNumber),
    120_000,
    input.signal,
  );
  if (pr.exitCode !== 0) fail("command_failed", "GitHub pull-request metadata lookup failed");
  const githubPr = parseJson(pr.output, githubPrSchema, "GitHub pull-request metadata") as GitHubPrSnapshot;

  const checks = await runCommand(
    input.runner,
    collector,
    input.environmentId,
    PR_CHECKS_COMMAND(input.job.prNumber),
    120_000,
    input.signal,
  );
  if (![0, 1, 8].includes(checks.exitCode)) fail("invalid_checks_exit", "GitHub checks lookup returned an infrastructure failure");
  const requiredChecks = parseJson(checks.output, checksSchema(), "GitHub required checks");

  const second = await runCommand(
    input.runner,
    collector,
    input.environmentId,
    PR_HEAD_COMMAND(input.job.prNumber),
    60_000,
    input.signal,
  );
  if (second.exitCode !== 0) fail("command_failed", "Unable to re-read the pull-request head from git");
  const secondSha = parseLsRemoteHead(second.output, input.job.prNumber);
  if (secondSha !== head.remoteHeadSha) fail("head_moved", "The pull-request head changed during validation");
  const final = await getEnvironmentEvidence(input.environments, input.environmentId, policy.baseBranch, input.signal);
  if (final.headSha !== head.remoteHeadSha) fail("head_mismatch", "Environment HEAD changed during validation");

  return {
    headSha: head.remoteHeadSha,
    originRepository: head.originRepository,
    commandReceipts: collector.receipts,
    githubPr,
    requiredChecks,
    validationOutcome: "pass",
    completedAt: new Date().toISOString(),
    reviewAttemptId: input.currentReviewAttempt?.id,
  };
}

export async function resolvePrHead(input: PrHeadResolutionInput): Promise<PrHeadResolution> {
  const collector: ReceiptCollector = { receipts: [], redactor: (value) => value };
  try {
    const result = await collectHeadTruth({
      runner: input.runner,
      environments: input.environments,
      environmentId: input.environmentId,
      prNumber: input.prNumber,
      expectedRepository: input.githubRepository,
      signal: input.signal,
      collector,
      requireSecondLookup: true,
    });
    return {
      event: "PR_HEAD_RESOLVED",
      headSha: result.remoteHeadSha,
      remoteHeadSha: result.remoteHeadSha,
      originRepository: result.originRepository,
    };
  } catch (error) {
    if (error instanceof ValidationError) {
      return { event: "PR_HEAD_RESOLUTION_FAILED", code: error.code, reason: error.message };
    }
    return { event: "PR_HEAD_RESOLUTION_FAILED", code: "command_failed", reason: "PR head resolution failed" };
  }
}
