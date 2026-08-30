import type { BbPluginApi } from "@bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { ModelRoute } from "../capabilities/models";
import { PR_HEAD_COMMAND, parseLsRemoteHead } from "../bb/validation";
import { TerminalCommandRunner, shellSingleQuote, type CommandResult } from "../bb/terminal-command";
import type { TelegramAgentStore } from "../storage/store";
import {
  NavigatorWorkflowExecutor,
  type NavigatorSkillRunner,
  type WorkflowNavigator,
} from "./executor";
import {
  NavigatorImplementationExecutor,
  type NavigatorGitObserver,
  type NavigatorGitObservationRequest,
  type NavigatorPullRequestPublisher,
  type NavigatorTicketWorkerAttempt,
  type NavigatorTicketWorkerRunner,
} from "./implementation-executor";
import { NavigatorReleaseExecutor } from "./release-executor";
import { DeterministicWorkflowNavigator } from "./deterministic-navigator";
import type { NavigatorInferenceObservation, NavigatorSkillAttempt, NavigatorSnapshot } from "./models";
import type { NavigatorPullRequestRecord, NavigatorPullRequestRequest } from "./implementation-contracts";

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

class PluginNavigatorTicketWorkerRunner implements NavigatorTicketWorkerRunner {
  public constructor(private readonly sdk: BbSdk) {}

  public async run(
    attempt: NavigatorTicketWorkerAttempt,
    hooks: Readonly<{ bindResource(resource: { kind: "bb_thread"; id: string }): Promise<void> }>,
    signal: AbortSignal,
  ): Promise<Readonly<{
    resource: { kind: "bb_thread"; id: string };
    result: unknown;
  }>> {
    const resource = attempt.resource ?? { kind: "bb_thread" as const, id: `thr_ticket_${attempt.id}` };
    await hooks.bindResource(resource);
    const output = await this.sdk.threads.output({ threadId: resource.id, signal }).catch(() => ({ output: "{}" }));
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
    let headSha = request.expectedHeadSha;
    let clean = false;
    if (status.outcome === "available") {
      const checkout = status.workspace.checkout;
      if ((checkout.kind === "branch" || checkout.kind === "detached") && checkout.headSha) {
        headSha = checkout.headSha;
      }
      clean = status.workspace.workingTree.state === "clean";
    }
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
      branch: request.integrationBranch,
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

class PluginNavigatorPullRequestPublisher implements NavigatorPullRequestPublisher {
  public constructor(private readonly sdk: BbSdk) {}

  public async createOrRefresh(request: NavigatorPullRequestRequest): Promise<NavigatorPullRequestRecord> {
    const snapshot = await this.sdk.environments.pullRequest({
      environmentId: request.gitObservation.worktreeId,
    });
    if (snapshot.outcome !== "available") {
      throw new Error("navigator pull request snapshot is unavailable");
    }
    const headSha = await readPullRequestHeadSha(this.sdk, {
      environmentId: request.gitObservation.worktreeId,
      number: snapshot.pullRequest.number,
    });
    return {
      operationId: request.operationId,
      jobId: request.jobId,
      number: snapshot.pullRequest.number,
      url: snapshot.pullRequest.url,
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
  return {
    navigator: new NavigatorWorkflowExecutor({
      store: input.store,
      navigator: input.navigator ?? new DeterministicWorkflowNavigator(),
      observeInference: (snapshot) => observePluginNavigatorInference(input.store, input.sdk, snapshot),
      skillRunner: new PluginNavigatorSkillRunner(input.sdk),
      modelRoute: input.modelRoute,
      clock: input.clock,
    }),
    implementation: new NavigatorImplementationExecutor({
      store: input.store,
      database: input.database,
      workerRunner: new PluginNavigatorTicketWorkerRunner(input.sdk),
      gitObserver: new PluginNavigatorGitObserver(input.sdk),
      pullRequests: new PluginNavigatorPullRequestPublisher(input.sdk),
      modelRoute: () => input.modelRoute(),
      clock: input.clock,
    }),
    release: new NavigatorReleaseExecutor({
      store: input.store,
      publishPullRequest: (request) => publishPluginNavigatorPullRequest(input.sdk, request),
      integrationWorktreeId: (jobId) => `env_${jobId}`,
      clock: input.clock,
    }),
  };
}
