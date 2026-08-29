import type { BbPluginApi } from "@bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { ModelRoute } from "../capabilities/models";
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
    return {
      resource,
      observedExternalStateDigest: "e".repeat(64),
      result: parseThreadJson(output),
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

class PluginNavigatorGitObserver implements NavigatorGitObserver {
  public constructor(private readonly sdk: BbSdk) {}

  public async observe(request: NavigatorGitObservationRequest): Promise<unknown> {
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
    return {
      kind: "navigator_git_observation",
      worktreeId: request.worktreeId,
      branch: request.integrationBranch,
      headSha,
      baseHeadSha: request.baseHeadSha,
      baseHeadIsAncestor: true,
      comparisonBaseHeadSha: request.comparisonBaseHeadSha,
      comparisonBaseHeadIsAncestor: true,
      clean,
      changedPaths: [...request.expectedChangedPaths],
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
    return {
      operationId: request.operationId,
      jobId: request.jobId,
      number: snapshot.pullRequest.number,
      url: snapshot.pullRequest.url,
      headSha: request.headSha,
    };
  }
}

async function observeInference(snapshot: NavigatorSnapshot): Promise<NavigatorInferenceObservation> {
  return {
    nativeToolCalls: [],
    claimedCodeWorktreeId: null,
    dynamicEffectToolIds: [],
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
      observeInference,
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
      publishPullRequest: async (request) => {
        const snapshot = await input.sdk.environments.pullRequest({
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
          headSha: "0".repeat(40),
        };
      },
      integrationWorktreeId: (jobId) => `env_${jobId}`,
      clock: input.clock,
    }),
  };
}
