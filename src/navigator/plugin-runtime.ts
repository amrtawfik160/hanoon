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
  NavigatorTicketWorkerUnavailableError,
  type NavigatorGitObserver,
  type NavigatorGitObservationRequest,
  type NavigatorPullRequestPublisher,
  type NavigatorTicketWorkerAttempt,
  type NavigatorTicketWorkerRunner,
} from "./implementation-executor";
import { NavigatorReleaseExecutor } from "./release-executor";
import {
  createNavigatorCompatibilityAdapter,
  NavigatorEffectProtocol,
  type NavigatorEffectAdapter,
} from "./effect-protocol";
import { DeterministicWorkflowNavigator } from "./deterministic-navigator";
import type { NavigatorInferenceObservation, NavigatorSkillAttempt, NavigatorSnapshot } from "./models";
import {
  navigatorAcceptanceCriteria,
  type NavigatorPullRequestRecord,
  type NavigatorPullRequestRequest,
} from "./implementation-contracts";

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

function workerSnapshot(
  store: TelegramAgentStore,
  binding: Readonly<{ artifactId: string; snapshotId: string; snapshotDigest: string }>,
  label: string,
): WorkArtifactSnapshot {
  const snapshot = store.getWorkArtifactSnapshot(binding.snapshotId);
  if (
    snapshot === null || snapshot.artifactId !== binding.artifactId ||
    snapshot.snapshotDigest !== binding.snapshotDigest ||
    !store.isWorkArtifactSnapshotValid(binding.snapshotId)
  ) throw new Error(`navigator ${label} snapshot is unavailable or stale`);
  return snapshot;
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
  store: TelegramAgentStore,
  attempt: NavigatorTicketWorkerAttempt,
): Readonly<{ filename: string; bytes: Uint8Array }> {
  const specification = workerSnapshot(store, attempt.workOrder.specification, "specification");
  const ticket = workerSnapshot(store, attempt.workOrder.ticket, "ticket");
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
  } catch {
    throw new NavigatorTicketWorkerUnavailableError("missing");
  }
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

export class PluginNavigatorTicketWorkerRunner implements NavigatorTicketWorkerRunner {
  public constructor(
    private readonly sdk: BbSdk,
    private readonly store: TelegramAgentStore,
  ) {}

  public async run(
    attempt: NavigatorTicketWorkerAttempt,
    hooks: Readonly<{ bindResource(resource: { kind: "bb_thread"; id: string }): Promise<void> }>,
    signal: AbortSignal,
  ): Promise<Readonly<{
    resource: { kind: "bb_thread"; id: string };
    result: unknown;
  }>> {
    let resource = attempt.resource;
    if (resource === null) {
      const title = `Hanoon ${attempt.kind} ${attempt.id}`.slice(0, 120);
      const matching = (await this.sdk.threads.list({
        projectId: attempt.workOrder.projectPolicy.projectId,
        includeHidden: true,
        archived: false,
        limit: 100,
        signal,
      })).filter((thread) =>
        thread.title === title && thread.environmentId === attempt.workOrder.worktreeId &&
        thread.deletedAt === null && thread.archivedAt === null);
      if (matching.length > 1) throw new Error("navigator worker recovery found duplicate BB threads");
      if (matching.length === 1) {
        resource = { kind: "bb_thread", id: matching[0]!.id };
      } else {
        const packet = workerPacket(this.store, attempt);
        const uploaded = await this.sdk.projects.attachments.upload({
          projectId: attempt.workOrder.projectPolicy.projectId,
          clientFile: packet.bytes,
          filename: packet.filename,
          mimeType: "application/json",
        });
        if (uploaded.type !== "localFile") throw new Error("navigator worker packet upload did not return a local file");
        const route = attempt.modelRoute;
        const permissionMode = attempt.kind === "implementation"
          ? attempt.workOrder.projectPolicy.implementation.permissionMode
          : attempt.workOrder.projectPolicy.review.permissionMode;
        const thread = await this.sdk.threads.spawn({
          projectId: attempt.workOrder.projectPolicy.projectId,
          title,
          visibility: "hidden",
          input: [
            { type: "text", text: workerInstruction(attempt), mentions: [] },
            uploaded,
          ],
          environment: { type: "reuse", environmentId: attempt.workOrder.worktreeId },
          ...modelRouteSpawnArgs({
            providerId: route.providerId,
            modelId: route.modelId,
            reasoning: route.reasoning,
            serviceTier: route.serviceTier,
            ...(permissionMode === undefined ? {} : { permissionMode }),
          }),
        } as Parameters<BbSdk["threads"]["spawn"]>[0]);
        resource = { kind: "bb_thread", id: thread.id };
      }
    }
    await hooks.bindResource(resource);
    await waitForWorker(this.sdk, resource.id, signal);
    const output = await this.sdk.threads.output({ threadId: resource.id, signal });
    return { resource, result: parseThreadJson(output) };
  }

  public async reconcileUnavailableResource(
    resource: { kind: "bb_thread"; id: string },
    reason: "missing" | "stale",
    _signal: AbortSignal,
  ): Promise<Readonly<{
    resource: { kind: "bb_thread"; id: string };
    state: "terminal" | "missing";
    evidenceRef: string;
    observedAt: number;
  }>> {
    return {
      resource,
      state: reason === "missing" ? "missing" : "terminal",
      evidenceRef: `bb-resource:${resource.id}:${reason}`,
      observedAt: Date.now(),
    };
  }
}

export class PluginNavigatorGitObserver implements NavigatorGitObserver {
  public constructor(private readonly sdk: BbSdk) {}

  public async observe(request: NavigatorGitObservationRequest): Promise<unknown> {
    const runner = new TerminalCommandRunner(this.sdk);
    const status = await this.sdk.environments.status({ environmentId: request.worktreeId });
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
      }).catch((): CommandResult => ({ outcome: "aborted" }));
      return gitIsAncestor(result);
    };
    const diff = await runner.run({
      scope: { kind: "environment", environmentId: request.worktreeId },
      title: "Navigator git changed paths",
      command: `git diff --name-only ${shellSingleQuote(request.baseHeadSha)} HEAD`,
      timeoutMs: 60_000,
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
  request: Readonly<{ jobId: string; title: string; body: string }>,
): Promise<NavigatorPullRequestRecord> {
  const snapshot = await sdk.environments.pullRequest({
    environmentId: `env_${request.jobId}`,
  });
  if (snapshot.outcome !== "available") {
    throw new Error("navigator release pull request snapshot is unavailable");
  }
  return {
    operationId: `release:${request.jobId}`,
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
  const navigator = new NavigatorWorkflowExecutor({
      store: input.store,
      navigator: input.navigator ?? new DeterministicWorkflowNavigator(),
      observeInference: (snapshot) => observePluginNavigatorInference(input.store, input.sdk, snapshot),
      skillRunner: new PluginNavigatorSkillRunner(input.sdk),
      modelRoute: input.modelRoute,
      clock: input.clock,
    });
  const implementation = new NavigatorImplementationExecutor({
      store: input.store,
      database: input.database,
      workerRunner: new PluginNavigatorTicketWorkerRunner(input.sdk, input.store),
      gitObserver: new PluginNavigatorGitObserver(input.sdk),
      pullRequests: new PluginNavigatorPullRequestPublisher(input.sdk),
      modelRoute: () => input.modelRoute(),
      clock: input.clock,
    });
  const release = new NavigatorReleaseExecutor({
      store: input.store,
      publishPullRequest: (request) => publishPluginNavigatorPullRequest(input.sdk, request),
      integrationWorktreeId: (jobId) => `env_${jobId}`,
      clock: input.clock,
    });
  const skillAdapter: NavigatorEffectAdapter = {
    kind: "run_navigator_skill",
    execute: async (context) => {
      const processed = await navigator.processLeased(
        context.effect,
        { ...context.fence, signal: context.signal },
        context.signal,
      );
      return processed
        ? { outcome: "completed" }
        : { outcome: "transient", reason: "navigator skill adapter did not settle" };
    },
  };
  return {
    effects: new NavigatorEffectProtocol({
      store: input.store,
      clock: input.clock,
      adapters: [
        skillAdapter,
        createNavigatorCompatibilityAdapter(
          "run_navigator_ticket_worker",
          (effect, fence, signal) => implementation.processLeased(effect, fence, signal),
        ),
        createNavigatorCompatibilityAdapter(
          "run_navigator_release",
          (effect, fence, signal) => release.processLeased(effect, fence, signal),
        ),
      ],
    }),
    navigator,
    implementation,
    release,
  };
}
