import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { ModelRoute } from "../capabilities/models";
import { buildPublishPullRequestCommand, parsePublishedPullRequest } from "../bb/pr-publish";
import { PR_HEAD_COMMAND, parseLsRemoteHead } from "../bb/validation";
import { TerminalCommandRunner, shellSingleQuote, type CommandResult } from "../bb/terminal-command";
import { modelRouteSpawnArgs } from "../domain/stage-execution";
import type { TelegramAgentStore } from "../storage/store";
import type { WorkArtifactSnapshot } from "../work-artifacts/models";
import {
  NavigatorWorkflowExecutor,
  type NavigatorSkillRunner,
  type WorkflowNavigator,
} from "./executor";
import {
  NavigatorImplementationExecutor,
  type NavigatorPullRequestPublisher,
  type NavigatorTicketWorkerAttempt,
} from "./implementation-executor";
import {
  createNavigatorTicketEffectAdapter,
  NavigatorTicketWorkerPermanentError,
  NavigatorTicketWorkerRetryableError,
  NavigatorTicketWorkerUnavailableError,
  type NavigatorGitObserver,
  type NavigatorGitObservationRequest,
  type NavigatorTicketWorkerInput,
  type NavigatorTicketWorkerOperation,
  type NavigatorTicketWorkerRun,
} from "./ticket-adapter";
import { navigatorReleaseTitle, NavigatorReleaseExecutor } from "./release-executor";
import {
  navigatorReleaseOperationId,
  type NavigatorReleaseEntryRequest,
} from "./release-contracts";
import {
  NavigatorEffectProtocol,
  type NavigatorEffectAdapter,
  type NavigatorEffectOutcome,
} from "./effect-protocol";
import type {
  NavigatorEffectContext,
  NavigatorReleaseEffectContext,
  NavigatorReleaseReceipt,
  NavigatorTicketEffectContext,
} from "./effect-contracts";
import { navigatorReleaseReceiptSchema } from "./effect-contracts";
import { DeterministicWorkflowNavigator } from "./deterministic-navigator";
import type { NavigatorInferenceObservation, NavigatorSkillAttempt, NavigatorSnapshot } from "./models";
import {
  navigatorAcceptanceCriteria,
  type NavigatorPullRequestRecord,
  type NavigatorPullRequestRequest,
} from "./implementation-contracts";

export { createNavigatorTicketEffectAdapter } from "./ticket-adapter";

type BbSdk = BbPluginApi["sdk"];

const GIT_SHA = /^[0-9a-f]{40}$/u;
const NATIVE_TOOL_ITEM_TYPES: Readonly<Record<string, string>> = {
  commandExecution: "shell",
  toolCall: "toolCall",
  fileChange: "fileChange",
  webSearch: "webSearch",
  backgroundTask: "backgroundTask",
};

export type NavigatorPluginRuntime = Readonly<{
  effects: NavigatorEffectProtocol;
  navigator: NavigatorWorkflowExecutor;
  implementation: NavigatorImplementationExecutor;
  release: NavigatorReleaseExecutor;
}>;

type NavigatorReleaseEntryOperation = Pick<
  NavigatorReleaseExecutor,
  "executeEntry" | "reconcileEntry" | "integrationEnvironmentId"
>;

function releaseEntryRequest(context: NavigatorReleaseEffectContext): NavigatorReleaseEntryRequest {
  return {
    operationId: navigatorReleaseOperationId(context.effect.jobId),
    jobId: context.effect.jobId,
    title: navigatorReleaseTitle(context.job.requestText),
    body: "Exact-head release of the accepted implementation tickets.",
  };
}

function releaseReceipt(
  context: NavigatorReleaseEffectContext,
  published: NavigatorPullRequestRecord,
  environmentId: string,
): NavigatorReleaseReceipt | null {
  const parsed = navigatorReleaseReceiptSchema.safeParse({
    kind: "run_navigator_release",
    effectIdempotencyKey: context.effect.idempotencyKey,
    attemptId: context.attempt.id,
    jobId: published.jobId,
    operationId: published.operationId,
    resource: { kind: "environment", id: environmentId },
    number: published.number,
    url: published.url,
    environmentId,
  });
  return parsed.success ? parsed.data : null;
}

function releaseEntryOutcome(
  context: NavigatorReleaseEffectContext,
  published: NavigatorPullRequestRecord,
  environmentId: string,
): NavigatorEffectOutcome {
  if (
    published.jobId !== context.effect.jobId ||
    published.operationId !== navigatorReleaseOperationId(context.effect.jobId)
  ) return { outcome: "permanent", reason: "Navigator release entry identity is invalid" };
  const receipt = releaseReceipt(context, published, environmentId);
  return receipt === null
    ? { outcome: "permanent", reason: "Navigator release entry receipt is invalid" }
    : { outcome: "completed", receipt };
}

async function executeReleaseAdapter(
  operation: NavigatorReleaseEntryOperation,
  context: NavigatorEffectContext,
): Promise<NavigatorEffectOutcome> {
  if (context.kind !== "run_navigator_release") {
    return { outcome: "permanent", reason: "Navigator release adapter received another effect kind" };
  }
  const published = await operation.executeEntry(releaseEntryRequest(context), context.signal);
  const environmentId = operation.integrationEnvironmentId(context.effect.jobId);
  return releaseEntryOutcome(context, published, environmentId);
}

async function reconcileReleaseAdapter(
  operation: NavigatorReleaseEntryOperation,
  context: NavigatorEffectContext,
): Promise<NavigatorEffectOutcome> {
  if (context.kind !== "run_navigator_release") {
    return { outcome: "permanent", reason: "Navigator release adapter received another effect kind" };
  }
  const published = await operation.reconcileEntry(releaseEntryRequest(context), context.signal);
  const environmentId = operation.integrationEnvironmentId(context.effect.jobId);
  return releaseEntryOutcome(context, published, environmentId);
}

export function createNavigatorReleaseEffectAdapter(
  operation: NavigatorReleaseEntryOperation,
): NavigatorEffectAdapter {
  return {
    kind: "run_navigator_release",
    execute: (context) => executeReleaseAdapter(operation, context),
    reconcile: (context) => reconcileReleaseAdapter(operation, context),
  };
}

function parseThreadJson(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return {};
  const output = "output" in raw ? raw.output : raw;
  if (typeof output !== "string") return output ?? {};
  try {
    return JSON.parse(output);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > 256) continue;
    items.push(trimmed);
    if (items.length >= limit) break;
  }
  return items;
}

function projectRelativePaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const path = line.trim();
    if (path.length === 0 || path.startsWith("/") || path.includes("\0")) continue;
    const segments = path.split(/[\\/]/u);
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) continue;
    if (path.length > 4_096) continue;
    paths.push(path);
    if (paths.length >= 512) break;
  }
  return paths;
}

function gitIsAncestor(result: CommandResult): boolean {
  return result.outcome === "exited" && result.exitCode === 0;
}

function throwIfWorkerSignalAborted(signal: AbortSignal, fallback: unknown): void {
  if (signal.aborted) throw signal.reason ?? fallback ?? new Error("navigator ticket worker was cancelled");
}

function boundedWorkerErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Navigator ticket worker failed";
  return message.replace(/[^\x20-\x7E]/gu, " ").trim().slice(0, 500) || "Navigator ticket worker failed";
}

function classifyWorkerError(
  error: unknown,
  resource: NavigatorTicketWorkerRun["resource"] | null,
): NavigatorTicketWorkerUnavailableError | NavigatorTicketWorkerRetryableError | NavigatorTicketWorkerPermanentError {
  if (error instanceof NavigatorTicketWorkerUnavailableError) {
    return new NavigatorTicketWorkerUnavailableError(error.reason, resource ?? error.resource);
  }
  if (error instanceof NavigatorTicketWorkerPermanentError) {
    return new NavigatorTicketWorkerPermanentError(boundedWorkerErrorMessage(error), resource ?? error.resource);
  }
  if (error instanceof NavigatorTicketWorkerRetryableError) {
    return new NavigatorTicketWorkerRetryableError(boundedWorkerErrorMessage(error), resource ?? error.resource);
  }
  return new NavigatorTicketWorkerRetryableError(boundedWorkerErrorMessage(error), resource);
}

function workerInstruction(attempt: NavigatorTicketWorkerAttempt): string {
  const assignments = attempt.profile.assignments.map((entry) => `/${entry.capabilityId}`).join(", ");
  const contract = attempt.kind === "implementation"
    ? [
      "Implement only the attached ticket in the reused integration worktree.",
      "Run focused and full verification, commit the finished change on the existing branch, and leave the worktree clean.",
      "Do not push, open or edit a pull request, merge, deploy, or use credentials outside the worktree.",
      "Return exactly one JSON object matching navigator-implementation-result-v1. Do not use Markdown fences or commentary.",
    ]
    : [
      attempt.workOrder.verificationOf === undefined
        ? "Review the attached ticket against both its accepted requirements and the listed repository guards at the exact current head."
        : "Independently verify only the reported root causes in workOrder.verificationOf against the exact current head. Return only root causes you can confirm with fresh evidence.",
      "Do not edit files, commit, push, open or edit a pull request, merge, deploy, or use credentials.",
      "Return exactly one JSON object matching navigator-code-review-result-v1. Do not use Markdown fences or commentary.",
    ];
  return [
    ...contract,
    `Required capabilities: ${assignments}.`,
    "The attached packet is immutable. Treat its work order, specification, ticket, acceptance criteria, profiles, and result schema as authoritative.",
  ].join("\n");
}

function workerPacket(
  input: NavigatorTicketWorkerInput,
): Readonly<{ filename: string; bytes: Uint8Array }> {
  const { attempt, specification, ticket } = input;
  const acceptanceCriteria = navigatorAcceptanceCriteria(ticket);
  const resultContract = attempt.kind === "implementation"
    ? {
      kind: "implementation_result",
      baseHeadSha: attempt.workOrder.baseHeadSha,
      headSha: "40-character Git commit SHA after the implementation commit",
      summary: "plain-language outcome",
      changedPaths: ["project-relative/path"],
      focusedVerification: [{ command: "exact command", outcome: "passed" }],
      fullVerification: [{ command: "exact command", outcome: "passed" }],
      acceptanceCriteria: acceptanceCriteria.map((criterion) => ({
        criterionId: criterion.id,
        outcome: "passed",
        evidenceRefs: [`acceptance:${criterion.id}`],
      })),
      capabilityOutcomes: attempt.profile.assignments.map((entry) => ({
        capabilityId: entry.capabilityId,
        outcome: "passed",
        evidenceRefs: [`worker:${attempt.id}:${entry.capabilityId}`],
      })),
    }
    : {
      kind: "code_review_result",
      reviewedHeadSha: attempt.workOrder.baseHeadSha,
      outcome: "passed or findings",
      summary: "plain-language review result",
      axes: {
        requirements: { outcome: "passed or findings", evidenceRefs: ["requirements evidence"] },
        standards: { outcome: "passed or findings", evidenceRefs: ["standards evidence"] },
      },
      findings: [{
        rootCauseId: "stable-root-cause-id",
        capabilityId: "selected guard capability id",
        ruleId: "stable-rule-id",
        severity: "critical, high, medium, or low",
        subject: "project-relative/path",
        line: null,
        requirementId: null,
        summary: "one independently checkable root cause",
        evidenceRefs: ["file:path:line or command evidence"],
      }],
      capabilityOutcomes: attempt.profile.assignments.map((entry) => ({
        capabilityId: entry.capabilityId,
        outcome: "passed",
        evidenceRefs: [`worker:${attempt.id}:${entry.capabilityId}`],
      })),
    };
  const bytes = Buffer.from(JSON.stringify({
    kind: "navigator_ticket_worker_packet",
    attemptId: attempt.id,
    workOrder: attempt.workOrder,
    workOrderDigest: attempt.workOrderDigest,
    stepContract: attempt.stepContract,
    profile: attempt.profile,
    ticketClaim: input.ticketClaim,
    resourceClaims: input.resourceClaims,
    capabilityEvidence: input.capabilityEvidence,
    specification,
    ticket,
    acceptanceCriteria,
    resultContract,
  }, null, 2), "utf8");
  return { filename: `${attempt.id}.json`, bytes };
}

async function waitForWorker(
  sdk: BbSdk,
  threadId: string,
  signal: AbortSignal,
): Promise<void> {
  let current: Awaited<ReturnType<BbSdk["threads"]["get"]>>;
  try {
    current = await sdk.threads.get({ threadId, signal });
  } catch (error) {
    throwIfWorkerSignalAborted(signal, error);
    throw new NavigatorTicketWorkerUnavailableError("missing");
  }
  throwIfWorkerSignalAborted(signal, new Error("navigator ticket worker was cancelled"));
  if (current.status === "idle") return;
  if (current.status === "error") throw new Error("navigator ticket worker ended in error");
  const settled = new AbortController();
  const waitSignal = AbortSignal.any([signal, settled.signal]);
  try {
    await Promise.race([
      sdk.threads.wait({ threadId, status: "idle", signal: waitSignal }),
      sdk.threads.wait({ threadId, status: "error", signal: waitSignal }).then(() => {
        throw new Error("navigator ticket worker ended in error");
      }),
    ]);
  } finally {
    settled.abort();
  }
}

type TicketWorkerResource = NavigatorTicketWorkerRun["resource"];

function workerTitle(attempt: NavigatorTicketWorkerAttempt): string {
  return `Hanoon ${attempt.kind} ${attempt.id}`.slice(0, 120);
}

async function findExistingWorker(
  sdk: BbSdk,
  input: NavigatorTicketWorkerInput,
  signal: AbortSignal,
): Promise<TicketWorkerResource | null> {
  const threads = await sdk.threads.list({
    projectId: input.attempt.workOrder.projectPolicy.projectId,
    includeHidden: true,
    archived: false,
    limit: 100,
    signal,
  });
  const matching = threads.filter((thread) =>
    thread.title === workerTitle(input.attempt) && thread.environmentId === input.attempt.workOrder.worktreeId &&
    thread.deletedAt === null && thread.archivedAt === null);
  throwIfWorkerSignalAborted(signal, new Error("navigator ticket worker preparation was cancelled"));
  if (matching.length > 1) throw new Error("navigator worker recovery found duplicate BB threads");
  return matching.length === 1 ? { kind: "bb_thread", id: matching[0]!.id } : null;
}

async function spawnTicketWorker(
  sdk: BbSdk,
  input: NavigatorTicketWorkerInput,
  signal: AbortSignal,
): Promise<TicketWorkerResource> {
  throwIfWorkerSignalAborted(signal, new Error("navigator ticket worker was cancelled before spawn"));
  const packet = workerPacket(input);
  const uploaded = await sdk.projects.attachments.upload({
    projectId: input.attempt.workOrder.projectPolicy.projectId,
    clientFile: packet.bytes,
    filename: packet.filename,
    mimeType: "application/json",
  });
  throwIfWorkerSignalAborted(signal, new Error("navigator ticket worker was cancelled before spawn"));
  if (uploaded.type !== "localFile") throw new Error("navigator worker packet upload did not return a local file");
  const route = input.attempt.modelRoute;
  const permissionMode = input.attempt.kind === "implementation"
    ? input.attempt.workOrder.projectPolicy.implementation.permissionMode
    : input.attempt.workOrder.projectPolicy.review.permissionMode;
  const thread = await sdk.threads.spawn({
    projectId: input.attempt.workOrder.projectPolicy.projectId,
    title: workerTitle(input.attempt),
    visibility: "hidden",
    input: [
      { type: "text", text: workerInstruction(input.attempt), mentions: [] },
      uploaded,
    ],
    environment: { type: "reuse", environmentId: input.attempt.workOrder.worktreeId },
    ...modelRouteSpawnArgs({
      providerId: route.providerId,
      modelId: route.modelId,
      reasoning: route.reasoning,
      serviceTier: route.serviceTier,
      ...(permissionMode === undefined ? {} : { permissionMode }),
    }),
  } as Parameters<BbSdk["threads"]["spawn"]>[0]);
  return { kind: "bb_thread", id: thread.id };
}

async function prepareWorkerResource(
  sdk: BbSdk,
  input: NavigatorTicketWorkerInput,
  signal: AbortSignal,
): Promise<TicketWorkerResource> {
  throwIfWorkerSignalAborted(signal, new Error("navigator ticket worker preparation was cancelled"));
  if (input.attempt.resource !== null) return input.attempt.resource;
  const existing = await findExistingWorker(sdk, input, signal);
  return existing ?? spawnTicketWorker(sdk, input, signal);
}

async function readWorker(
  sdk: BbSdk,
  resource: TicketWorkerResource,
  signal: AbortSignal,
): Promise<NavigatorTicketWorkerRun> {
  await waitForWorker(sdk, resource.id, signal);
  throwIfWorkerSignalAborted(signal, new Error("navigator ticket worker wait was cancelled"));
  const output = await sdk.threads.output({ threadId: resource.id, signal });
  return { resource, result: parseThreadJson(output) };
}

function unavailableWorkerRun(
  resource: TicketWorkerResource,
  error: NavigatorTicketWorkerUnavailableError,
): NavigatorTicketWorkerRun {
  return {
    resource,
    result: {
      kind: "worker_unavailable",
      reason: error.reason,
      resourceObservation: {
        resource,
        state: error.reason === "missing" ? "missing" : "terminal",
        evidenceRef: `bb-resource:${resource.id}:${error.reason}`,
        observedAt: Date.now(),
      },
    },
  };
}

class PluginNavigatorSkillRunner implements NavigatorSkillRunner {
  public constructor(private readonly sdk: BbSdk) {}

  public async run(
    attempt: NavigatorSkillAttempt,
    hooks: Readonly<{ bindResource(resource: { kind: "bb_thread"; id: string }): Promise<void> }>,
    signal: AbortSignal,
  ): Promise<Readonly<{
    resource: { kind: "bb_thread"; id: string };
    observedExternalStateDigest: string;
    result: unknown;
  }>> {
    const resource = attempt.resource ?? { kind: "bb_thread" as const, id: `thr_navigator_${attempt.id}` };
    await hooks.bindResource(resource);
    const output = await this.sdk.threads.output({ threadId: resource.id, signal }).catch(() => ({ output: "{}" }));
    const parsed = parseThreadJson(output);
    const observed = asRecord(parsed);
    const nativeToolCalls = stringList(observed.nativeToolCalls, 32);
    if (nativeToolCalls.length > 0) {
      throw new Error("policy_native_tool_use");
    }
    const digest = typeof observed.externalStateDigest === "string" &&
      /^[0-9a-f]{64}$/u.test(observed.externalStateDigest)
      ? observed.externalStateDigest
      : "e".repeat(64);
    return {
      resource,
      observedExternalStateDigest: digest,
      result: parsed,
    };
  }
}

export class PluginNavigatorTicketWorkerRunner {
  public constructor(private readonly sdk: BbSdk) {}

  public async prepare(
    input: NavigatorTicketWorkerInput,
    signal: AbortSignal,
  ): Promise<TicketWorkerResource> {
    let resource = input.attempt.resource;
    try {
      resource = await prepareWorkerResource(this.sdk, input, signal);
      return resource;
    } catch (error) {
      throwIfWorkerSignalAborted(signal, error);
      throw classifyWorkerError(error, resource);
    }
  }

  public async wait(
    input: NavigatorTicketWorkerInput,
    signal: AbortSignal,
  ): Promise<NavigatorTicketWorkerRun> {
    const resource = input.attempt.resource;
    if (resource === null) throw new NavigatorTicketWorkerUnavailableError("missing");
    try {
      return await readWorker(this.sdk, resource, signal);
    } catch (error) {
      throwIfWorkerSignalAborted(signal, error);
      throw classifyWorkerError(error, resource);
    }
  }

  public async run(
    input: NavigatorTicketWorkerInput,
    signal: AbortSignal,
  ): Promise<NavigatorTicketWorkerRun> {
    let resource = input.attempt.resource;
    try {
      resource = await this.prepare(input, signal);
      return await readWorker(this.sdk, resource, signal);
    } catch (error) {
      throwIfWorkerSignalAborted(signal, error);
      throw classifyWorkerError(error, resource);
    }
  }

  public async reconcile(
    input: NavigatorTicketWorkerInput,
    signal: AbortSignal,
  ): Promise<NavigatorTicketWorkerRun> {
    const resource = input.attempt.resource;
    if (resource === null) throw new NavigatorTicketWorkerUnavailableError("missing");
    try {
      return await readWorker(this.sdk, resource, signal);
    } catch (error) {
      throwIfWorkerSignalAborted(signal, error);
      if (!(error instanceof NavigatorTicketWorkerUnavailableError)) {
        throw classifyWorkerError(error, resource);
      }
      return unavailableWorkerRun(resource, error);
    }
  }
}

export class PluginNavigatorGitObserver implements NavigatorGitObserver {
  public constructor(private readonly sdk: BbSdk) {}

  public async observe(request: NavigatorGitObservationRequest, signal?: AbortSignal): Promise<unknown> {
    const runner = new TerminalCommandRunner(this.sdk);
    const status = await this.sdk.environments.status({ environmentId: request.worktreeId, signal });
    if (status.outcome !== "available" || status.workspace.checkout.kind !== "branch" ||
      status.workspace.checkout.branchName !== request.integrationBranch ||
      typeof status.workspace.checkout.headSha !== "string" ||
      !GIT_SHA.test(status.workspace.checkout.headSha)) {
      throw new Error("navigator worktree is not on the requested integration branch");
    }
    const checkout = status.workspace.checkout;
    const headSha = checkout.headSha;
    const clean = status.workspace.workingTree.state === "clean";
    const ancestry = async (commit: string): Promise<boolean> => {
      if (!GIT_SHA.test(commit)) return false;
      const result = await runner.run({
        scope: { kind: "environment", environmentId: request.worktreeId },
        title: "Navigator git ancestry",
        command: `git merge-base --is-ancestor ${shellSingleQuote(commit)} HEAD`,
        timeoutMs: 60_000,
        signal,
      }).catch((): CommandResult => ({ outcome: "aborted" }));
      return gitIsAncestor(result);
    };
    const diff = await runner.run({
      scope: { kind: "environment", environmentId: request.worktreeId },
      title: "Navigator git changed paths",
      command: `git diff --name-only ${shellSingleQuote(request.baseHeadSha)} HEAD`,
      timeoutMs: 60_000,
      signal,
    }).catch((): CommandResult => ({ outcome: "aborted" }));
    const changedPaths = diff.outcome === "exited" && diff.exitCode === 0
      ? projectRelativePaths(diff.output)
      : [];
    return {
      kind: "navigator_git_observation",
      worktreeId: request.worktreeId,
      branch: checkout.branchName,
      headSha,
      baseHeadSha: request.baseHeadSha,
      baseHeadIsAncestor: await ancestry(request.baseHeadSha),
      comparisonBaseHeadSha: request.comparisonBaseHeadSha,
      comparisonBaseHeadIsAncestor: await ancestry(request.comparisonBaseHeadSha),
      clean,
      changedPaths,
      evidenceRef: `git-observation:${headSha}:${request.worktreeId}`,
      observedAt: Date.now(),
    };
  }
}

export class PluginNavigatorPullRequestPublisher implements NavigatorPullRequestPublisher {
  public constructor(private readonly sdk: BbSdk) {}

  public async createOrRefresh(request: NavigatorPullRequestRequest): Promise<NavigatorPullRequestRecord> {
    const status = await this.sdk.environments.status({ environmentId: request.gitObservation.worktreeId });
    const checkout = status.outcome === "available" ? status.workspace.checkout : null;
    const workingTreeState = status.outcome === "available" ? status.workspace.workingTree.state : null;
    if (
      checkout === null || checkout.kind !== "branch" ||
      checkout.branchName !== request.integrationBranch || checkout.headSha !== request.headSha ||
      workingTreeState !== "clean"
    ) throw new Error("navigator pull request checkout changed before publication");
    const publish = await new TerminalCommandRunner(this.sdk).run({
      scope: { kind: "environment", environmentId: request.gitObservation.worktreeId },
      title: `Navigator publish pull request ${request.jobId}`,
      command: buildPublishPullRequestCommand({
        baseBranch: request.baseBranch,
        title: request.title,
        body: request.body,
      }),
      timeoutMs: 180_000,
    });
    const parsed = publish.outcome === "exited" && publish.exitCode === 0
      ? parsePublishedPullRequest(publish.output)
      : null;
    if (parsed === null) throw new Error("navigator pull request could not be created or refreshed");
    const snapshot = await this.sdk.environments.pullRequest({
      environmentId: request.gitObservation.worktreeId,
    });
    if (
      snapshot.outcome !== "available" || snapshot.pullRequest.number !== parsed.number ||
      snapshot.pullRequest.url !== parsed.url || snapshot.pullRequest.baseRefName !== request.baseBranch ||
      snapshot.pullRequest.headRefName !== request.integrationBranch
    ) {
      throw new Error("navigator pull request snapshot is unavailable");
    }
    const headSha = await readPullRequestHeadSha(this.sdk, {
      environmentId: request.gitObservation.worktreeId,
      number: snapshot.pullRequest.number,
    });
    return {
      operationId: request.operationId,
      jobId: request.jobId,
      number: parsed.number,
      url: parsed.url,
      headSha,
    };
  }
}

async function readPullRequestHeadSha(
  sdk: BbSdk,
  input: Readonly<{ environmentId: string; number: number }>,
): Promise<string> {
  const result = await new TerminalCommandRunner(sdk).run({
    scope: { kind: "environment", environmentId: input.environmentId },
    title: `Navigator pull-request head ${String(input.number)}`,
    command: PR_HEAD_COMMAND(input.number),
    timeoutMs: 60_000,
  });
  if (result.outcome !== "exited" || result.exitCode !== 0) {
    throw new Error("navigator pull-request head is unavailable from git");
  }
  return parseLsRemoteHead(result.output, input.number);
}

export async function publishPluginNavigatorPullRequest(
  sdk: BbSdk,
  request: NavigatorReleaseEntryRequest,
): Promise<NavigatorPullRequestRecord> {
  const snapshot = await sdk.environments.pullRequest({
    environmentId: `env_${request.jobId}`,
  });
  if (snapshot.outcome !== "available") {
    throw new Error("navigator release pull request snapshot is unavailable");
  }
  return {
    operationId: request.operationId,
    jobId: request.jobId,
    number: snapshot.pullRequest.number,
    url: snapshot.pullRequest.url,
    headSha: await readPullRequestHeadSha(sdk, {
      environmentId: `env_${request.jobId}`,
      number: snapshot.pullRequest.number,
    }),
  };
}

function nativeToolCallsFromEvents(rows: readonly unknown[]): string[] {
  const calls: string[] = [];
  for (const row of rows) {
    const event = asRecord(row);
    if (event.type !== "item/started") continue;
    const item = asRecord(asRecord(event.data).item);
    const mapped = typeof item.type === "string" ? NATIVE_TOOL_ITEM_TYPES[item.type] : undefined;
    if (!mapped) continue;
    const named = typeof item.name === "string" && item.name.trim().length > 0 ? item.name.trim() : mapped;
    calls.push(named.slice(0, 256));
    if (calls.length >= 32) break;
  }
  return calls;
}

async function observeBoundThread(
  sdk: BbSdk,
  threadId: string,
): Promise<Readonly<{
  nativeToolCalls: readonly string[];
  claimedCodeWorktreeId: string | null;
  dynamicEffectToolIds: readonly string[];
}>> {
  const output = await sdk.threads.output({ threadId }).catch(() => ({ output: "{}" }));
  const parsed = asRecord(parseThreadJson(output));
  const fromOutput = stringList(parsed.nativeToolCalls, 32);
  let fromEvents: string[] = [];
  try {
    const rows = await sdk.threads.events.list({
      threadId,
      afterSeq: "0",
      limit: "100",
    });
    fromEvents = nativeToolCallsFromEvents(rows);
  } catch {
    fromEvents = [];
  }
  const claimed = parsed.claimedCodeWorktreeId;
  return {
    nativeToolCalls: [...new Set([...fromOutput, ...fromEvents])].slice(0, 32),
    claimedCodeWorktreeId: typeof claimed === "string" && claimed.trim().length > 0 ? claimed.trim().slice(0, 256) : null,
    dynamicEffectToolIds: stringList(parsed.dynamicEffectToolIds, 32),
  };
}

async function observePluginNavigatorInference(
  store: TelegramAgentStore,
  sdk: BbSdk,
  snapshot: NavigatorSnapshot,
): Promise<NavigatorInferenceObservation> {
  const job = store.getJob(snapshot.identity.jobId);
  const threadIds = [
    job?.implementationThreadId,
    job?.reviewThreadId,
    job?.documentationThreadId,
  ].filter((threadId): threadId is string => typeof threadId === "string" && threadId.length > 0);
  const nativeToolCalls: string[] = [];
  let claimedCodeWorktreeId: string | null = null;
  const dynamicEffectToolIds: string[] = [];
  for (const threadId of threadIds) {
    const observed = await observeBoundThread(sdk, threadId);
    nativeToolCalls.push(...observed.nativeToolCalls);
    if (claimedCodeWorktreeId === null) claimedCodeWorktreeId = observed.claimedCodeWorktreeId;
    dynamicEffectToolIds.push(...observed.dynamicEffectToolIds);
  }
  return {
    nativeToolCalls: [...new Set(nativeToolCalls)].slice(0, 32),
    claimedCodeWorktreeId,
    dynamicEffectToolIds: [...new Set(dynamicEffectToolIds)].slice(0, 32),
    externalStateDigest: snapshot.externalStateDigest,
  };
}

export function createNavigatorRuntime(input: Readonly<{
  store: TelegramAgentStore;
  database: Database.Database;
  sdk: BbSdk;
  modelRoute(): ModelRoute;
  clock: { now(): number };
  navigator?: WorkflowNavigator;
}>): NavigatorPluginRuntime {
  const skillRunner = new PluginNavigatorSkillRunner(input.sdk);
  const navigator = new NavigatorWorkflowExecutor({
      store: input.store,
      navigator: input.navigator ?? new DeterministicWorkflowNavigator(),
      observeInference: (snapshot) => observePluginNavigatorInference(input.store, input.sdk, snapshot),
      skillRunner,
      modelRoute: input.modelRoute,
      clock: input.clock,
    });
  const ticketWorker = new PluginNavigatorTicketWorkerRunner(input.sdk);
  const ticketOperation: NavigatorTicketWorkerOperation = {
    prepare: (workerInput, signal) => ticketWorker.prepare(workerInput, signal),
    run: (workerInput, signal) => ticketWorker.wait(workerInput, signal),
    reconcile: (workerInput, signal) => ticketWorker.reconcile(workerInput, signal),
    observe: (request, signal) => new PluginNavigatorGitObserver(input.sdk).observe(request, signal),
  };
  const implementation = new NavigatorImplementationExecutor({
      store: input.store,
      gitObserver: new PluginNavigatorGitObserver(input.sdk),
      pullRequests: new PluginNavigatorPullRequestPublisher(input.sdk),
      modelRoute: () => input.modelRoute(),
      clock: input.clock,
    });
  const release = new NavigatorReleaseExecutor({
      publishPullRequest: (request) => publishPluginNavigatorPullRequest(input.sdk, request),
      integrationWorktreeId: (jobId) => `env_${jobId}`,
    });
  const skillAdapter: NavigatorEffectAdapter = {
    kind: "run_navigator_skill",
    execute: async (context) => {
      if (context.kind !== "run_navigator_skill") {
        return { outcome: "permanent", reason: "Navigator skill adapter received another effect kind" };
      }
      const run = await skillRunner.run(context.attempt, { bindResource: async () => undefined }, context.signal);
      return {
        outcome: "completed",
        receipt: {
          kind: "run_navigator_skill" as const,
          effectIdempotencyKey: context.effect.idempotencyKey,
          attemptId: context.attempt.id,
          resource: run.resource,
          observedExternalStateDigest: run.observedExternalStateDigest,
          result: run.result,
        },
      };
    },
  };
  return {
    effects: new NavigatorEffectProtocol({
      store: input.store,
      clock: input.clock,
      adapters: [
        skillAdapter,
        createNavigatorTicketEffectAdapter(ticketOperation),
        createNavigatorReleaseEffectAdapter(release),
      ],
    }),
    navigator,
    implementation,
    release,
  };
}
