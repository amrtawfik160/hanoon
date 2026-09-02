import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL_POOL_REGISTRY } from "../src/capabilities/models";
import { hashSecret } from "../src/crypto";
import {
  createNavigatorReleaseEffectAdapter,
  createNavigatorRuntime,
  createNavigatorTicketEffectAdapter,
  PluginNavigatorGitObserver,
  PluginNavigatorPullRequestPublisher,
  PluginNavigatorTicketWorkerRunner,
  publishPluginNavigatorPullRequest,
} from "../src/navigator/plugin-runtime";
import {
  NAVIGATOR_TICKET_STEP_CONTRACTS,
  navigatorJsonDigest,
  navigatorTicketWorkerProfile,
  navigatorTicketWorkOrderSchema,
} from "../src/navigator/implementation-contracts";
import type {
  NavigatorTicketWorkerAttempt,
  NavigatorTicketWorkerExecution,
} from "../src/navigator/implementation-executor";
import type {
  NavigatorReleaseEffectContext,
  NavigatorTicketEffectContext,
} from "../src/navigator/effect-protocol";
import { openStore } from "../src/storage/store";
import { stableWorkArtifactId } from "../src/work-artifacts/repository";
import { policyFixture } from "./helpers";

const BASE_HEAD = "1".repeat(40);
const WORKTREE_HEAD = "2".repeat(40);
const REMOTE_HEAD = "ab".repeat(20);
const EXTERNAL_DIGEST = "e".repeat(64);

let fixtureSequence = 0;

function ticketAdapterContext(): NavigatorTicketEffectContext {
  return {
    kind: "run_navigator_ticket_worker",
    effect: { idempotencyKey: "effect-ticket-adapter", jobId: "job-ticket-adapter" } as NavigatorTicketEffectContext["effect"],
    ticket: { attempt: { id: "attempt-ticket-adapter" } } as NavigatorTicketEffectContext["ticket"],
  } as NavigatorTicketEffectContext;
}

function releaseAdapterContext(): NavigatorReleaseEffectContext {
  return {
    kind: "run_navigator_release",
    effect: { idempotencyKey: "effect-release-adapter", jobId: "job-release-adapter" } as NavigatorReleaseEffectContext["effect"],
    job: { requestText: "Ship the accepted change" } as NavigatorReleaseEffectContext["job"],
    attempt: { id: "attempt-release-adapter" } as NavigatorReleaseEffectContext["attempt"],
  } as NavigatorReleaseEffectContext;
}

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function stubGitTerminals(
  answers: ReadonlyArray<Readonly<{ match: string; exitCode: number; output: string }>>,
) {
  const outputs = new Map<string, string>();
  let terminalNumber = 0;
  return {
    create: async (args: { start?: { mode?: string; command?: string } }) => {
      const command = args.start?.command ?? "";
      const id = `git-terminal-${++terminalNumber}`;
      const marker = /__BB_TELEGRAM_AGENT_RESULT_[0-9a-f]+__/.exec(command)?.[0] ?? "";
      const answer = answers.find((entry) => command.includes(entry.match));
      const body = answer?.output ?? "";
      const exitCode = answer?.exitCode ?? 1;
      outputs.set(id, `${body}${body.endsWith("\n") || body.length === 0 ? "" : "\n"}${marker}:${String(exitCode)}\n`);
      return { id };
    },
    get: async () => ({ status: "running", exitCode: null }),
    output: async ({ terminalId }: { terminalId: string }) => ({
      chunks: [{ seq: 0, dataBase64: encoded(outputs.get(terminalId) ?? "") }],
      nextSeq: 1,
      truncated: false,
    }),
    close: async () => undefined,
    input: async () => undefined,
  };
}

function environmentStatus(input: Readonly<{
  headSha: string;
  clean: boolean;
  branch?: string;
  detached?: boolean;
}>) {
  const branch = input.branch ?? "hanoon/job-43";
  return {
    outcome: "available" as const,
    workspace: {
      workingTree: {
        insertions: 0,
        deletions: 0,
        lineStatsComplete: true,
        files: [],
        hasUncommittedChanges: !input.clean,
        state: input.clean ? "clean" as const : "dirty_uncommitted" as const,
      },
      checkout: input.detached
        ? { kind: "detached" as const, headSha: input.headSha }
        : { kind: "branch" as const, branchName: branch, headSha: input.headSha },
      branch: { currentBranch: branch, defaultBranch: "main" },
      mergeBase: null,
    },
  };
}

function observationRequest(overrides: Partial<{
  expectedHeadSha: string;
  expectedChangedPaths: readonly string[];
  baseHeadSha: string;
  comparisonBaseHeadSha: string;
}> = {}) {
  return {
    purpose: "implementation" as const,
    worktreeId: "env_job_43",
    integrationBranch: "hanoon/job-43",
    expectedHeadSha: overrides.expectedHeadSha ?? WORKTREE_HEAD,
    baseHeadSha: overrides.baseHeadSha ?? BASE_HEAD,
    comparisonBaseHeadSha: overrides.comparisonBaseHeadSha ?? BASE_HEAD,
    expectedChangedPaths: overrides.expectedChangedPaths ?? ["src/app.ts"],
  };
}

describe("plugin navigator git observer", () => {
  it("derives ancestry from git merge-base rather than substituting true", async () => {
    const { bb } = createFakePluginHost({
      pluginId: `navigator-plugin-git-ancestry-${++fixtureSequence}`,
      sdk: {
        environments: {
          status: async () => environmentStatus({ headSha: WORKTREE_HEAD, clean: true }),
        },
        terminals: stubGitTerminals([
          { match: "git merge-base --is-ancestor", exitCode: 1, output: "" },
          { match: "git diff --name-only", exitCode: 0, output: "src/app.ts\n" },
        ]),
      },
    });
    const observer = new PluginNavigatorGitObserver(bb.sdk);
    const observation = await observer.observe(observationRequest());

    expect(observation).toMatchObject({
      kind: "navigator_git_observation",
      headSha: WORKTREE_HEAD,
      baseHeadSha: BASE_HEAD,
      baseHeadIsAncestor: false,
      comparisonBaseHeadIsAncestor: false,
      clean: true,
    });
  });

  it("reads changed paths from git diff instead of echoing the claimed list", async () => {
    const { bb } = createFakePluginHost({
      pluginId: `navigator-plugin-git-paths-${++fixtureSequence}`,
      sdk: {
        environments: {
          status: async () => environmentStatus({ headSha: WORKTREE_HEAD, clean: true }),
        },
        terminals: stubGitTerminals([
          { match: "git merge-base --is-ancestor", exitCode: 0, output: "" },
          { match: "git diff --name-only", exitCode: 0, output: "lib/other.ts\nREADME.md\n" },
        ]),
      },
    });
    const observer = new PluginNavigatorGitObserver(bb.sdk);
    const observation = await observer.observe(observationRequest({
      expectedChangedPaths: ["src/app.ts"],
    }));

    expect(observation).toMatchObject({
      kind: "navigator_git_observation",
      baseHeadIsAncestor: true,
      comparisonBaseHeadIsAncestor: true,
      changedPaths: ["lib/other.ts", "README.md"],
    });
  });

  it.each([
    ["a mismatched branch", environmentStatus({ headSha: WORKTREE_HEAD, clean: true, branch: "hanoon/other" })],
    ["a detached checkout", environmentStatus({ headSha: WORKTREE_HEAD, clean: true, detached: true })],
  ])("rejects %s instead of echoing the requested integration branch", async (_label, status) => {
    const { bb } = createFakePluginHost({
      pluginId: `navigator-plugin-git-branch-${++fixtureSequence}`,
      sdk: {
        environments: { status: async () => status },
        terminals: stubGitTerminals([]),
      },
    });
    const observer = new PluginNavigatorGitObserver(bb.sdk);

    await expect(observer.observe(observationRequest())).rejects.toThrow("integration branch");
  });
});

describe("plugin navigator inference and release adapters", () => {
  it("spawns one real BB ticket worker with immutable artifact contents and reuses the integration worktree", async () => {
    const spawned: Record<string, unknown>[] = [];
    const uploads: Array<{ clientFile: Uint8Array }> = [];
    const { bb } = createFakePluginHost({
      pluginId: `navigator-plugin-worker-${++fixtureSequence}`,
      sdk: {
        projects: {
          attachments: {
            upload: async (args) => {
              uploads.push({ clientFile: args.clientFile as Uint8Array });
              return { type: "localFile" as const, path: `/tmp/${args.filename ?? "packet.json"}` };
            },
          },
        },
        threads: {
          list: async () => [],
          spawn: async (args) => {
            spawned.push(args as unknown as Record<string, unknown>);
            return { id: "thr_real_worker", environmentId: "env_job_43" };
          },
          get: async () => ({ status: "idle" }),
          output: async () => ({ output: JSON.stringify({ kind: "implementation_result" }) }),
        },
      },
    });
    const store = openStore(bb.storage);
    const policy = policyFixture();
    const specification = store.captureWorkArtifact({
      artifactId: stableWorkArtifactId("proj_1", `worker-spec-${fixtureSequence}`),
      projectId: "proj_1",
      effortId: "effort_worker",
      operationId: `worker-spec-${fixtureSequence}`,
      kind: "specification",
      status: "ready",
      trackerKind: "github",
      trackerNamespace: "github:acme/cyndra",
      externalId: `worker-spec-${fixtureSequence}`,
      externalUrl: null,
      externalRevision: "1",
      externalStatus: "open",
      assignees: [],
      title: "Worker specification",
      trackerOrder: 0,
      content: "# Worker specification\n\nKeep the exact accepted contract.",
      acceptanceCriteria: ["The contract remains exact"],
      relationships: [],
      capturedAt: 30_000,
    });
    const ticket = store.captureWorkArtifact({
      artifactId: stableWorkArtifactId("proj_1", `worker-ticket-${fixtureSequence}`),
      projectId: "proj_1",
      effortId: "effort_worker",
      operationId: `worker-ticket-${fixtureSequence}`,
      kind: "implementation_ticket",
      status: "ready",
      trackerKind: "github",
      trackerNamespace: "github:acme/cyndra",
      externalId: `worker-ticket-${fixtureSequence}`,
      externalUrl: null,
      externalRevision: "1",
      externalStatus: "open",
      assignees: [],
      title: "Worker ticket",
      trackerOrder: 1,
      content: "# Worker ticket\n\nImplement the real worker path.",
      acceptanceCriteria: ["A real BB worker is created"],
      relationships: [{
        kind: "parent",
        sourceArtifactId: stableWorkArtifactId("proj_1", `worker-ticket-${fixtureSequence}`),
        sourceRef: `artifact:${stableWorkArtifactId("proj_1", `worker-ticket-${fixtureSequence}`)}`,
        targetArtifactId: specification.artifact.id,
        targetRef: `artifact:${specification.artifact.id}`,
      }],
      capturedAt: 30_001,
    });
    const workOrder = navigatorTicketWorkOrderSchema.parse({
      kind: "navigator_ticket_work_order",
      jobId: "job_worker_43",
      integrationBranch: "hanoon/job-43",
      baseBranch: "main",
      worktreeId: "env_job_43",
      baseHeadSha: BASE_HEAD,
      comparisonBaseHeadSha: BASE_HEAD,
      projectPolicyVersion: 1,
      projectPolicy: policy,
      projectPolicyDigest: navigatorJsonDigest(policy),
      specification: {
        artifactId: specification.artifact.id,
        snapshotId: specification.snapshot.id,
        snapshotDigest: specification.snapshot.snapshotDigest,
      },
      ticket: {
        artifactId: ticket.artifact.id,
        snapshotId: ticket.snapshot.id,
        snapshotDigest: ticket.snapshot.snapshotDigest,
      },
      taskEvidence: [],
      evidenceRefs: ["ticket:accepted"],
      changedPaths: [],
    });
    const profile = navigatorTicketWorkerProfile({ kind: "implementation", taskEvidence: [], changedPaths: [] });
    const attempt: NavigatorTicketWorkerAttempt = {
      id: "navworker_job_43",
      jobId: "job_worker_43",
      sliceId: "navslice_job_43",
      kind: "implementation",
      ordinal: 1,
      effectIdempotencyKey: "job_worker_43:navigator-ticket:navworker_job_43",
      workOrder,
      workOrderDigest: navigatorJsonDigest(workOrder),
      stepContract: NAVIGATOR_TICKET_STEP_CONTRACTS.implementation,
      profile,
      modelRoute: { pool: "standard", ...DEFAULT_MODEL_POOL_REGISTRY.worker.standard },
      resource: null,
      createdAt: 30_002,
      updatedAt: 30_002,
    };
    const bindings: string[] = [];
    const result = await new PluginNavigatorTicketWorkerRunner(bb.sdk, store).run(attempt, {
      bindResource: async (resource) => { bindings.push(resource.id); },
    }, new AbortController().signal);

    expect(bindings).toEqual(["thr_real_worker"]);
    expect(result.resource).toEqual({ kind: "bb_thread", id: "thr_real_worker" });
    expect(spawned[0]).toMatchObject({
      projectId: "proj_1",
      visibility: "hidden",
      environment: { type: "reuse", environmentId: "env_job_43" },
      providerId: DEFAULT_MODEL_POOL_REGISTRY.worker.standard.providerId,
      model: DEFAULT_MODEL_POOL_REGISTRY.worker.standard.modelId,
    });
    const packet = JSON.parse(Buffer.from(uploads[0]!.clientFile).toString("utf8")) as Record<string, any>;
    expect(packet.specification.content).toContain("exact accepted contract");
    expect(packet.ticket.content).toContain("real worker path");
  });

  it("returns a typed ticket receipt without settling durable state through processLeased", async () => {
    const durableState = { workflow: "pending", effect: "leased", outbox: [] as string[] };
    const before = structuredClone(durableState);
    const processLeased = vi.fn(async () => true);
    const execution: NavigatorTicketWorkerExecution = {
      resource: { kind: "bb_thread", id: "thr_ticket_adapter" },
      exactHeadSha: WORKTREE_HEAD,
      result: { kind: "implementation_result" },
      gitObservation: null,
    };
    const executeAttempt = vi.fn(async () => execution);
    const operation = { executeAttempt, processLeased };
    const adapter = createNavigatorTicketEffectAdapter(operation);

    const outcome = await adapter.execute(ticketAdapterContext());

    expect(outcome).toEqual({
      outcome: "completed",
      receipt: {
        kind: "run_navigator_ticket_worker",
        effectIdempotencyKey: "effect-ticket-adapter",
        attemptId: "attempt-ticket-adapter",
        resource: execution.resource,
        exactHeadSha: WORKTREE_HEAD,
        result: execution.result,
        gitObservation: null,
      },
    });
    expect(executeAttempt).toHaveBeenCalledTimes(1);
    expect(processLeased).not.toHaveBeenCalled();
    expect(durableState).toEqual(before);
  });

  it("returns a typed release receipt without settling durable state through processLeased", async () => {
    const durableState = { workflow: "pending", effect: "leased", outbox: [] as string[] };
    const before = structuredClone(durableState);
    const processLeased = vi.fn(async () => true);
    const executeEntry = vi.fn(async () => ({
      operationId: "pr-adapter",
      jobId: "job-release-adapter",
      number: 43,
      url: "https://github.com/acme/cyndra/pull/43",
      headSha: REMOTE_HEAD,
    }));
    const integrationEnvironmentId = vi.fn(() => "env_release_adapter");
    const operation = { executeEntry, integrationEnvironmentId, processLeased };
    const adapter = createNavigatorReleaseEffectAdapter(operation);

    const outcome = await adapter.execute(releaseAdapterContext());

    expect(outcome).toEqual({
      outcome: "completed",
      receipt: {
        kind: "run_navigator_release",
        effectIdempotencyKey: "effect-release-adapter",
        attemptId: "attempt-release-adapter",
        resource: { kind: "environment", id: "env_release_adapter" },
        number: 43,
        url: "https://github.com/acme/cyndra/pull/43",
        environmentId: "env_release_adapter",
      },
    });
    expect(executeEntry).toHaveBeenCalledTimes(1);
    expect(processLeased).not.toHaveBeenCalled();
    expect(durableState).toEqual(before);
  });

  it("publishes one pull request and verifies the remote base, branch, and exact head", async () => {
    const { bb } = createFakePluginHost({
      pluginId: `navigator-plugin-publisher-${++fixtureSequence}`,
      sdk: {
        environments: {
          status: async () => environmentStatus({ headSha: REMOTE_HEAD, clean: true, branch: "hanoon/job-43" }),
          pullRequest: async () => ({
            outcome: "available",
            pullRequest: {
              number: 43,
              url: "https://github.com/acme/cyndra/pull/43",
              baseRefName: "main",
              headRefName: "hanoon/job-43",
            },
          }),
        },
        terminals: stubGitTerminals([
          {
            match: "gh pr create",
            exitCode: 0,
            output: '{"number":43,"url":"https://github.com/acme/cyndra/pull/43"}\n',
          },
          {
            match: "git ls-remote --exit-code origin refs/pull/43/head",
            exitCode: 0,
            output: `${REMOTE_HEAD}\trefs/pull/43/head\n`,
          },
        ]),
      },
    });
    const gitObservation = {
      kind: "navigator_git_observation" as const,
      worktreeId: "env_job_43",
      branch: "hanoon/job-43",
      headSha: REMOTE_HEAD,
      baseHeadSha: BASE_HEAD,
      baseHeadIsAncestor: true,
      comparisonBaseHeadSha: BASE_HEAD,
      comparisonBaseHeadIsAncestor: true,
      clean: true,
      changedPaths: ["src/app.ts"],
      evidenceRef: "git:job-43",
      observedAt: 31_000,
    };
    const record = await new PluginNavigatorPullRequestPublisher(bb.sdk).createOrRefresh({
      operationId: "navigator-pr-job-43",
      jobId: "job_43",
      baseBranch: "main",
      integrationBranch: "hanoon/job-43",
      headSha: REMOTE_HEAD,
      title: "Publish the navigator change",
      body: "One final integration pull request.",
      gitObservation,
      gitObservationDigest: navigatorJsonDigest(gitObservation),
      evidenceRefs: ["git:job-43"],
    });

    expect(record).toEqual({
      operationId: "navigator-pr-job-43",
      jobId: "job_43",
      number: 43,
      url: "https://github.com/acme/cyndra/pull/43",
      headSha: REMOTE_HEAD,
    });
  });

  it("rejects a proposal when the bound thread used a native tool", async () => {
    const { bb } = createFakePluginHost({
      pluginId: `navigator-plugin-native-tools-${++fixtureSequence}`,
      sdk: {
        threads: {
          output: async () => ({
            output: JSON.stringify({ nativeToolCalls: ["shell"] }),
          }),
          events: {
            list: async () => [{
              seq: 1,
              type: "item/started",
              data: { item: { type: "commandExecution" } },
            }],
          },
        },
      },
    });
    const store = openStore(bb.storage);
    store.createPairingCode(hashSecret("pair"), 1_000, 20_000);
    if (!store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001).ok) {
      throw new Error("owner pairing failed");
    }
    store.upsertProjectPolicy(policyFixture(), 1_002);
    const now = 20_000 + fixtureSequence;
    const ticketId = stableWorkArtifactId("proj_1", `native-tool-${fixtureSequence}`);
    const ticket = store.captureWorkArtifact({
      artifactId: ticketId,
      projectId: "proj_1",
      effortId: "effort_native",
      operationId: `ticket-native-${fixtureSequence}`,
      kind: "implementation_ticket",
      status: "ready",
      trackerKind: "github",
      trackerNamespace: "github:acme/cyndra",
      externalId: `ticket-native-${fixtureSequence}`,
      externalUrl: `https://github.com/acme/cyndra/issues/${fixtureSequence}`,
      externalRevision: "1",
      externalStatus: "open",
      assignees: [],
      title: "Observe native tools",
      trackerOrder: 0,
      content: "# Observe native tools\n\nFail closed when the thread used shell.",
      acceptanceCriteria: ["Native tool use is rejected"],
      relationships: [],
      capturedAt: now,
    });
    const draft = store.createJob({
      id: `job_native_${fixtureSequence}`,
      sourceUpdateId: 70_000 + fixtureSequence,
      requestText: "Navigate with a native tool in the thread.",
      workflow: { engine: "navigator-v1", mode: "deterministic" },
      now,
    });
    const selected = store.applyJobEvent(draft.id, draft.version, {
      type: "PROJECT_SELECTED",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture(),
    }, now + 1);
    store.bindNavigatorJobArtifacts({
      jobId: selected.id,
      expectedVersion: selected.version,
      artifactBindings: [{
        artifactId: ticket.artifact.id,
        snapshotId: ticket.snapshot.id,
        snapshotDigest: ticket.snapshot.snapshotDigest,
      }],
      now: now + 2,
    });
    bb.storage.database().prepare(
      "UPDATE jobs SET implementation_thread_id = ? WHERE id = ?",
    ).run("thr_native_shell", selected.id);
    const runtime = createNavigatorRuntime({
      store,
      database: bb.storage.database(),
      sdk: bb.sdk,
      modelRoute: () => ({ pool: "strong", ...DEFAULT_MODEL_POOL_REGISTRY.worker.strong }),
      clock: { now: () => now + 3 },
    });

    const decision = await runtime.navigator.proposeNext({
      jobId: selected.id,
      externalStateDigest: EXTERNAL_DIGEST,
      evidenceRefs: ["eval:native-tool"],
    });

    expect(decision).toMatchObject({
      decision: "rejected",
      reasonCode: "policy_native_tool_use",
    });
  });

  it("returns the git ls-remote pull-request head instead of a zero SHA", async () => {
    const { bb } = createFakePluginHost({
      pluginId: `navigator-plugin-pr-head-${++fixtureSequence}`,
      sdk: {
        environments: {
          pullRequest: async () => ({
            outcome: "available",
            pullRequest: {
              number: 43,
              title: "Disposable dual-engine tickets",
              state: "open",
              url: "https://github.com/acme/cyndra/pull/43",
              baseRefName: "main",
              headRefName: "hanoon/job-43",
              updatedAt: "2026-08-29T00:00:00.000Z",
              checks: {
                state: "passing",
                totalCount: 1,
                passedCount: 1,
                failedCount: 0,
                pendingCount: 0,
              },
              review: { state: "approved", reviewRequestCount: 0 },
              mergeability: {
                state: "mergeable",
                mergeStateStatus: "CLEAN",
                mergeable: "MERGEABLE",
              },
              attention: "ready_to_merge",
            },
          }),
        },
        terminals: stubGitTerminals([
          {
            match: "git ls-remote --exit-code origin refs/pull/43/head",
            exitCode: 0,
            output: `${REMOTE_HEAD}\trefs/pull/43/head\n`,
          },
        ]),
      },
    });
    const record = await publishPluginNavigatorPullRequest(bb.sdk, {
      jobId: "job_pr_head",
      title: "Ship accepted navigator tickets",
      body: "Exact-head release of the accepted implementation tickets.",
    });

    expect(record).toMatchObject({
      jobId: "job_pr_head",
      number: 43,
      url: "https://github.com/acme/cyndra/pull/43",
      headSha: REMOTE_HEAD,
    });
    expect(record.headSha).not.toBe("0".repeat(40));
  });
});
