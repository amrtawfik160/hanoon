import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_POOL_REGISTRY } from "../src/capabilities/models";
import { hashSecret } from "../src/crypto";
import {
  createNavigatorRuntime,
  PluginNavigatorGitObserver,
  publishPluginNavigatorPullRequest,
} from "../src/navigator/plugin-runtime";
import { openStore } from "../src/storage/store";
import { stableWorkArtifactId } from "../src/work-artifacts/repository";
import { policyFixture } from "./helpers";

const BASE_HEAD = "1".repeat(40);
const WORKTREE_HEAD = "2".repeat(40);
const REMOTE_HEAD = "ab".repeat(20);
const EXTERNAL_DIGEST = "e".repeat(64);

let fixtureSequence = 0;

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
}>) {
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
      checkout: { kind: "branch" as const, branchName: "hanoon/job", headSha: input.headSha },
      branch: { currentBranch: "hanoon/job", defaultBranch: "main" },
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
});

describe("plugin navigator inference and release adapters", () => {
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
