import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { hashSecret } from "../src/crypto";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import {
  WorkArtifactCoordinator,
  WorkArtifactMutationIndeterminateError,
} from "../src/work-artifacts/coordinator";
import {
  stableWorkArtifactId,
  type WorkArtifactCapture,
} from "../src/work-artifacts/repository";
import {
  GitHubWorkTracker,
  type GitHubIssueGateway,
  type GitHubIssueRecord,
} from "../src/work-artifacts/github-tracker";
import { LocalMarkdownWorkTracker } from "../src/work-artifacts/local-markdown-tracker";
import { compareAndSwapLocalFile } from "../src/work-artifacts/local-file-cas";
import { sha256 } from "../src/work-artifacts/models";
import {
  blockersPayloadDigest,
  claimPayloadDigest,
  terminalPayloadDigest,
  TrackerConflictError,
  TrackerIdentityConflictError,
  type TrackerArtifact,
  type WorkTracker,
} from "../src/work-artifacts/tracker";

const temporaryDirectories: string[] = [];
let contractEvidenceNumber = 0;

function recordContractEvidence(
  store: TelegramAgentStore,
  input: Readonly<{
    artifactId: string;
    snapshotId: string;
    ownerId: string;
    generation: number;
    now: number;
    projectId: string;
  }>,
): `evidence:${number}` {
  contractEvidenceNumber += 1;
  const controllerKey = `tracker-contract-${contractEvidenceNumber}`;
  const turn = store.enqueueControllerTurn({
    controllerKey,
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 120_000 + contractEvidenceNumber,
    inputText: "Record terminal mutation evidence.",
    // Received before the claim's quiet gap; the executor's lease is 1s, so
    // the claim itself cannot move later.
    now: Math.max(0, input.now - 3_000),
  });
  const fence = { ownerId: input.ownerId, generation: input.generation, now: input.now };
  if (store.claimNextControllerTurn(fence)?.id !== turn.id) throw new Error("turn was not claimed");
  if (!store.reserveControllerSpawn({
    controllerKey,
    turnId: turn.id,
    projectId: input.projectId,
    hostId: "host_1",
    now: input.now,
  })) throw new Error("spawn was not reserved");
  if (!store.markControllerSpawned({
    ...fence,
    turnId: turn.id,
    projectId: input.projectId,
    hostId: "host_1",
    threadId: `thr_tracker_contract_${contractEvidenceNumber}`,
    spawnToken: turn.id,
  })) throw new Error("turn was not spawned");
  if (!store.markControllerTurnSubmitted({ ...fence, turnId: turn.id })) {
    throw new Error("turn was not submitted");
  }
  const result = store.recordControllerEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey,
    sourceKind: "hanoon_tool",
    sourceName: "work_artifact_acceptance",
    sourceItemId: null,
    outcome: "succeeded",
    argsSha256: "a".repeat(64),
    resultSha256: "b".repeat(64),
    proofKinds: ["obligation"],
    subjectRefs: [
      `work-artifact:${input.artifactId}`,
      `work-artifact-snapshot:${input.snapshotId}`,
    ],
  });
  if (result.outcome !== "recorded" && result.outcome !== "duplicate") {
    throw new Error(`evidence was ${result.outcome}`);
  }
  return result.evidence.ref;
}

function runCasProcess(input: Readonly<{
  path: string;
  expectedDigest: string;
  content: string;
}>): Promise<number | null> {
  const script = [
    "import { compareAndSwapLocalFile } from './src/work-artifacts/local-file-cas.ts';",
    "try {",
    "  await compareAndSwapLocalFile(process.env.CAS_PATH, process.env.CAS_EXPECTED, Buffer.from(process.env.CAS_CONTENT, 'base64').toString('utf8'));",
    "} catch {",
    "  process.exitCode = 17;",
    "}",
  ].join("\n");
  const child = spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    "--experimental-transform-types",
    "--input-type=module",
    "--eval",
    script,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CAS_PATH: input.path,
      CAS_EXPECTED: input.expectedDigest,
      CAS_CONTENT: Buffer.from(input.content, "utf8").toString("base64"),
    },
    stdio: "ignore",
  });
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectExit(new Error("local compare-and-swap process timed out"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function exerciseTracker(makeTracker: () => Promise<WorkTracker>): Promise<void> {
  const tracker = await makeTracker();
  const map = await tracker.create({
    operationId: "create-map",
    kind: "map",
    title: "Effort map",
    body: "# Outcome\n\nShip the workflow substrate.",
    acceptanceCriteria: ["The child tickets reach a terminal state"],
  });
  expect((await tracker.read(map.externalId)).kind).toBe("map");
  const parent = await tracker.create({
    operationId: "create-parent",
    kind: "specification",
    title: "Parent specification",
    body: "# Scope\n\nShip the workflow substrate.",
    acceptanceCriteria: ["The workflow is restart safe"],
  });
  const replay = await tracker.create({
    operationId: "create-parent",
    kind: "specification",
    title: "Parent specification",
    body: "# Scope\n\nShip the workflow substrate.",
    acceptanceCriteria: ["The workflow is restart safe"],
  });
  expect(replay.externalId).toBe(parent.externalId);
  expect((await tracker.reconcile({ operationId: "create-parent" }))?.externalId)
    .toBe(parent.externalId);
  await expect(tracker.create({
    operationId: "create-parent",
    kind: "specification",
    title: "Parent specification",
    body: "# Scope\n\nSilently replace the original requirements.",
    acceptanceCriteria: ["A different result is accepted"],
  })).rejects.toThrow(TrackerIdentityConflictError);

  const blocker = await tracker.create({
    operationId: "create-blocker",
    kind: "decision_ticket",
    title: "Settle the blocker",
    body: "# Question\n\nWhich durable identity should be used?",
    acceptanceCriteria: ["One identity is selected"],
  });
  let child = await tracker.create({
    operationId: "create-child",
    kind: "implementation_ticket",
    title: "Implement the slice",
    body: "# Goal\n\nImplement one tracer bullet.",
    acceptanceCriteria: ["Focused tests pass"],
  });
  child = await tracker.setParent({
    externalId: child.externalId,
    parentExternalId: parent.externalId,
    operationId: "parent-child",
    expectedRevision: child.revision,
  });
  child = await tracker.setBlockers({
    externalId: child.externalId,
    blockerExternalIds: [blocker.externalId],
    operationId: "block-child",
    expectedRevision: child.revision,
  });
  expect((await tracker.read(child.externalId)).parentExternalId).toBe(parent.externalId);
  expect((await tracker.read(child.externalId)).blockerExternalIds).toEqual([blocker.externalId]);
  expect((await tracker.read(parent.externalId)).childExternalIds).toContain(child.externalId);
  expect(await tracker.frontier({ parentExternalId: parent.externalId })).toEqual([]);

  const resolvedBlocker = await tracker.resolve({
    externalId: blocker.externalId,
    resolution: "Use the tracker identity and mirror it internally.",
    operationId: "resolve-blocker",
    expectedRevision: blocker.revision,
  });
  expect(resolvedBlocker.state).toBe("closed");
  expect((await tracker.frontier({ parentExternalId: parent.externalId })).map((item) => item.externalId))
    .toEqual([child.externalId]);

  child = await tracker.claim({
    externalId: child.externalId,
    assignee: "hanoon-bot",
    operationId: "claim-child",
    expectedRevision: child.revision,
  });
  expect(child.assignees).toEqual(["hanoon-bot"]);
  expect(await tracker.frontier({ parentExternalId: parent.externalId })).toEqual([]);
  child = await tracker.renew({
    externalId: child.externalId,
    assignee: "hanoon-bot",
    operationId: "renew-child",
    expectedRevision: child.revision,
  });
  child = await tracker.release({
    externalId: child.externalId,
    assignee: "hanoon-bot",
    operationId: "release-child",
    expectedRevision: child.revision,
  });
  expect(child.assignees).toEqual([]);

  const beforeEdit = child;
  child = await tracker.updateOwnedSection({
    externalId: child.externalId,
    sectionId: "implementation-notes",
    content: "The adapter owns only this bounded section.",
    operationId: "update-child-notes",
    expectedRevision: child.revision,
  });
  expect(child.body).toContain("The adapter owns only this bounded section.");
  await expect(tracker.updateOwnedSection({
    externalId: child.externalId,
    sectionId: "implementation-notes",
    content: "A stale writer must not win.",
    operationId: "stale-child-notes",
    expectedRevision: beforeEdit.revision,
  })).rejects.toThrow(TrackerConflictError);

  child = await tracker.comment({
    externalId: child.externalId,
    comment: "Focused verification passed.",
    operationId: "comment-child",
    expectedRevision: child.revision,
  });
  expect(child.comments).toContain("Focused verification passed.");

  const cancelled = await tracker.create({
    operationId: "create-cancelled",
    kind: "decision_ticket",
    title: "No longer needed",
    body: "# Decision\n\nThis path is obsolete.",
    acceptanceCriteria: [],
  });
  expect((await tracker.cancel({
    externalId: cancelled.externalId,
    reason: "Superseded by the accepted design.",
    operationId: "cancel-obsolete",
    expectedRevision: cancelled.revision,
  })).state).toBe("cancelled");
}

async function exerciseTerminalMutationContract(tracker: WorkTracker, prefix: string): Promise<void> {
  const resolved = await tracker.create({
    operationId: `${prefix}-resolved-create`,
    kind: "implementation_ticket",
    title: "Resolved terminal contract",
    body: "# Goal\n\nKeep resolved terminal state stable.",
    acceptanceCriteria: [],
  });
  const claimedResolved = await tracker.claim({
    externalId: resolved.externalId,
    assignee: "hanoon-bot",
    operationId: `${prefix}-resolved-initial-claim`,
    expectedRevision: resolved.revision,
  });
  const closed = await tracker.resolve({
    externalId: resolved.externalId,
    resolution: "The resolved path passed.",
    operationId: `${prefix}-resolve`,
    expectedRevision: claimedResolved.revision,
  });
  await expect(tracker.claim({
    externalId: resolved.externalId,
    assignee: "hanoon-bot",
    operationId: `${prefix}-claim-closed`,
    expectedRevision: closed.revision,
  })).rejects.toThrow(TrackerConflictError);
  await expect(tracker.renew({
    externalId: resolved.externalId,
    assignee: "hanoon-bot",
    operationId: `${prefix}-renew-closed`,
    expectedRevision: closed.revision,
  })).rejects.toThrow(TrackerConflictError);
  await expect(tracker.cancel({
    externalId: resolved.externalId,
    reason: "Do not replace the resolved outcome.",
    operationId: `${prefix}-cancel-resolved`,
    expectedRevision: closed.revision,
  })).rejects.toThrow(TrackerConflictError);
  expect((await tracker.release({
    externalId: resolved.externalId,
    assignee: "hanoon-bot",
    operationId: `${prefix}-release-closed`,
    expectedRevision: closed.revision,
  })).assignees).not.toContain("hanoon-bot");

  const cancelled = await tracker.create({
    operationId: `${prefix}-cancelled-create`,
    kind: "implementation_ticket",
    title: "Cancelled terminal contract",
    body: "# Goal\n\nKeep cancelled terminal state stable.",
    acceptanceCriteria: [],
  });
  const claimedCancelled = await tracker.claim({
    externalId: cancelled.externalId,
    assignee: "hanoon-bot",
    operationId: `${prefix}-cancelled-initial-claim`,
    expectedRevision: cancelled.revision,
  });
  const stopped = await tracker.cancel({
    externalId: cancelled.externalId,
    reason: "The cancelled path is not planned.",
    operationId: `${prefix}-cancel`,
    expectedRevision: claimedCancelled.revision,
  });
  await expect(tracker.claim({
    externalId: cancelled.externalId,
    assignee: "hanoon-bot",
    operationId: `${prefix}-claim-cancelled`,
    expectedRevision: stopped.revision,
  })).rejects.toThrow(TrackerConflictError);
  await expect(tracker.renew({
    externalId: cancelled.externalId,
    assignee: "hanoon-bot",
    operationId: `${prefix}-renew-cancelled`,
    expectedRevision: stopped.revision,
  })).rejects.toThrow(TrackerConflictError);
  await expect(tracker.resolve({
    externalId: cancelled.externalId,
    resolution: "Do not replace the cancelled outcome.",
    operationId: `${prefix}-resolve-cancelled`,
    expectedRevision: stopped.revision,
  })).rejects.toThrow(TrackerConflictError);
  expect((await tracker.release({
    externalId: cancelled.externalId,
    assignee: "hanoon-bot",
    operationId: `${prefix}-release-cancelled`,
    expectedRevision: stopped.revision,
  })).assignees).not.toContain("hanoon-bot");
}

async function exercisePayloadBoundReplays(tracker: WorkTracker, prefix: string): Promise<void> {
  const parentA = await tracker.create({
    operationId: `${prefix}-parent-a`,
    kind: "decision_ticket",
    title: "Payload parent A",
    body: "# Scope\n\nFirst parent.",
    acceptanceCriteria: [],
  });
  const parentB = await tracker.create({
    operationId: `${prefix}-parent-b`,
    kind: "decision_ticket",
    title: "Payload parent B",
    body: "# Scope\n\nSecond parent.",
    acceptanceCriteria: [],
  });
  const blockerA = await tracker.create({
    operationId: `${prefix}-blocker-a`,
    kind: "decision_ticket",
    title: "Payload blocker A",
    body: "# Decision\n\nFirst blocker.",
    acceptanceCriteria: [],
  });
  const blockerB = await tracker.create({
    operationId: `${prefix}-blocker-b`,
    kind: "decision_ticket",
    title: "Payload blocker B",
    body: "# Decision\n\nSecond blocker.",
    acceptanceCriteria: [],
  });
  let artifact = await tracker.create({
    operationId: `${prefix}-artifact`,
    kind: "implementation_ticket",
    title: "Payload-bound operations",
    body: "# Goal\n\nReject mismatched operation replays.",
    acceptanceCriteria: [],
  });

  artifact = await tracker.updateOwnedSection({
    externalId: artifact.externalId,
    sectionId: "notes",
    content: "Original notes.",
    operationId: `${prefix}-update`,
    expectedRevision: artifact.revision,
  });
  await expect(tracker.updateOwnedSection({
    externalId: artifact.externalId,
    sectionId: "notes",
    content: "Different notes.",
    operationId: `${prefix}-update`,
    expectedRevision: artifact.revision,
  })).rejects.toThrow(TrackerIdentityConflictError);

  artifact = await tracker.comment({
    externalId: artifact.externalId,
    comment: "Original comment.",
    operationId: `${prefix}-comment`,
    expectedRevision: artifact.revision,
  });
  await expect(tracker.comment({
    externalId: artifact.externalId,
    comment: "Different comment.",
    operationId: `${prefix}-comment`,
    expectedRevision: artifact.revision,
  })).rejects.toThrow(TrackerIdentityConflictError);

  artifact = await tracker.setParent({
    externalId: artifact.externalId,
    parentExternalId: parentA.externalId,
    operationId: `${prefix}-parent`,
    expectedRevision: artifact.revision,
  });
  await expect(tracker.setParent({
    externalId: artifact.externalId,
    parentExternalId: parentB.externalId,
    operationId: `${prefix}-parent`,
    expectedRevision: artifact.revision,
  })).rejects.toThrow(TrackerIdentityConflictError);

  artifact = await tracker.setBlockers({
    externalId: artifact.externalId,
    blockerExternalIds: [blockerA.externalId],
    operationId: `${prefix}-blockers`,
    expectedRevision: artifact.revision,
  });
  await expect(tracker.setBlockers({
    externalId: artifact.externalId,
    blockerExternalIds: [blockerB.externalId],
    operationId: `${prefix}-blockers`,
    expectedRevision: artifact.revision,
  })).rejects.toThrow(TrackerIdentityConflictError);

  artifact = await tracker.claim({
    externalId: artifact.externalId,
    assignee: "payload-owner-a",
    operationId: `${prefix}-claim`,
    expectedRevision: artifact.revision,
  });
  await expect(tracker.claim({
    externalId: artifact.externalId,
    assignee: "payload-owner-b",
    operationId: `${prefix}-claim`,
    expectedRevision: artifact.revision,
  })).rejects.toThrow(TrackerIdentityConflictError);

  artifact = await tracker.renew({
    externalId: artifact.externalId,
    assignee: "payload-owner-a",
    operationId: `${prefix}-renew`,
    expectedRevision: artifact.revision,
  });
  await expect(tracker.renew({
    externalId: artifact.externalId,
    assignee: "payload-owner-b",
    operationId: `${prefix}-renew`,
    expectedRevision: artifact.revision,
  })).rejects.toThrow(TrackerIdentityConflictError);

  artifact = await tracker.release({
    externalId: artifact.externalId,
    assignee: "payload-owner-a",
    operationId: `${prefix}-release`,
    expectedRevision: artifact.revision,
  });
  await expect(tracker.release({
    externalId: artifact.externalId,
    assignee: "payload-owner-b",
    operationId: `${prefix}-release`,
    expectedRevision: artifact.revision,
  })).rejects.toThrow(TrackerIdentityConflictError);

  let resolved = await tracker.create({
    operationId: `${prefix}-resolved`,
    kind: "implementation_ticket",
    title: "Payload-bound resolution",
    body: "# Goal\n\nBind resolution text.",
    acceptanceCriteria: [],
  });
  resolved = await tracker.resolve({
    externalId: resolved.externalId,
    resolution: "Original resolution.",
    operationId: `${prefix}-resolve`,
    expectedRevision: resolved.revision,
  });
  await expect(tracker.resolve({
    externalId: resolved.externalId,
    resolution: "Different resolution.",
    operationId: `${prefix}-resolve`,
    expectedRevision: resolved.revision,
  })).rejects.toThrow(TrackerIdentityConflictError);

  let cancelled = await tracker.create({
    operationId: `${prefix}-cancelled`,
    kind: "decision_ticket",
    title: "Payload-bound cancellation",
    body: "# Decision\n\nBind cancellation text.",
    acceptanceCriteria: [],
  });
  cancelled = await tracker.cancel({
    externalId: cancelled.externalId,
    reason: "Original cancellation.",
    operationId: `${prefix}-cancel`,
    expectedRevision: cancelled.revision,
  });
  await expect(tracker.cancel({
    externalId: cancelled.externalId,
    reason: "Different cancellation.",
    operationId: `${prefix}-cancel`,
    expectedRevision: cancelled.revision,
  })).rejects.toThrow(TrackerIdentityConflictError);
}

class MemoryGitHubGateway implements GitHubIssueGateway {
  public readonly namespace: string;
  private nextNumber = 1;
  private clock = 1;
  private readonly issues = new Map<string, GitHubIssueRecord>();

  public constructor(namespace = "github:acme/widgets") {
    this.namespace = namespace;
  }

  public async createIssue(input: Readonly<{ title: string; body: string }>): Promise<GitHubIssueRecord> {
    const number = String(this.nextNumber++);
    const issue: GitHubIssueRecord = {
      externalId: number,
      url: `https://github.com/acme/widgets/issues/${number}`,
      title: input.title,
      body: input.body,
      state: "open",
      stateReason: null,
      assignees: [],
      comments: [],
      parentExternalId: null,
      blockerExternalIds: [],
      childExternalIds: [],
      revision: String(this.clock++),
    };
    this.issues.set(number, issue);
    return issue;
  }

  public async readIssue(externalId: string): Promise<GitHubIssueRecord> {
    const issue = this.issues.get(externalId);
    if (!issue) throw new Error(`Issue ${externalId} does not exist`);
    return structuredClone(issue);
  }

  public async findIssuesByOperationMarker(marker: string): Promise<readonly GitHubIssueRecord[]> {
    return [...this.issues.values()]
      .filter((issue) => issue.body.includes(marker) || issue.comments.some((comment) => comment.includes(marker)))
      .map((issue) => structuredClone(issue));
  }

  public allIssues(): readonly GitHubIssueRecord[] {
    return [...this.issues.values()].map((issue) => structuredClone(issue));
  }

  public async replaceBodyAsHuman(externalId: string, body: string): Promise<void> {
    const current = await this.readIssue(externalId);
    await this.updateIssue(externalId, current.revision, { body });
  }

  public async replaceBlockersAsHuman(
    externalId: string,
    blockerExternalIds: readonly string[],
  ): Promise<void> {
    const current = await this.readIssue(externalId);
    await this.updateIssue(externalId, current.revision, { blockerExternalIds });
  }

  public async replaceParentAsHuman(
    externalId: string,
    parentExternalId: string | null,
  ): Promise<void> {
    const current = await this.readIssue(externalId);
    await this.updateIssue(externalId, current.revision, { parentExternalId });
  }

  public async replaceAssigneesAsHuman(
    externalId: string,
    assignees: readonly string[],
  ): Promise<void> {
    const current = await this.readIssue(externalId);
    await this.updateIssue(externalId, current.revision, { assignees });
  }

  public async reopenAsHuman(externalId: string): Promise<void> {
    const current = await this.readIssue(externalId);
    await this.updateIssue(externalId, current.revision, { state: "open", stateReason: null });
  }

  protected async updateIssue(
    externalId: string,
    expectedRevision: string,
    patch: Readonly<Partial<Pick<GitHubIssueRecord,
      "body" | "state" | "stateReason" | "assignees" | "parentExternalId" | "blockerExternalIds">>>,
  ): Promise<GitHubIssueRecord> {
    const current = await this.readIssue(externalId);
    if (current.revision !== expectedRevision) throw new TrackerConflictError(externalId);
    const next: GitHubIssueRecord = {
      ...current,
      ...patch,
      assignees: patch.assignees ? [...patch.assignees] : current.assignees,
      blockerExternalIds: patch.blockerExternalIds
        ? [...patch.blockerExternalIds]
        : current.blockerExternalIds,
      revision: String(this.clock++),
    };
    this.issues.set(externalId, next);
    if (patch.parentExternalId !== undefined) {
      for (const [id, issue] of this.issues) {
        const children = issue.childExternalIds.filter((child) => child !== externalId);
        if (id === patch.parentExternalId) children.push(externalId);
        this.issues.set(id, { ...issue, childExternalIds: children });
      }
    }
    return structuredClone(next);
  }

  public updateBody(
    externalId: string,
    expectedRevision: string,
    body: string,
  ): Promise<GitHubIssueRecord> {
    return this.updateIssue(externalId, expectedRevision, { body });
  }

  public addSubIssue(
    parentExternalId: string,
    childExternalId: string,
    expectedChildRevision: string,
  ): Promise<GitHubIssueRecord> {
    return this.updateIssue(childExternalId, expectedChildRevision, { parentExternalId });
  }

  public async addBlockedBy(
    externalId: string,
    expectedRevision: string,
    blockerExternalId: string,
  ): Promise<GitHubIssueRecord> {
    const current = await this.readIssue(externalId);
    return this.updateIssue(externalId, expectedRevision, {
      blockerExternalIds: [...new Set([...current.blockerExternalIds, blockerExternalId])],
    });
  }

  public async removeBlockedBy(
    externalId: string,
    expectedRevision: string,
    blockerExternalId: string,
  ): Promise<GitHubIssueRecord> {
    const current = await this.readIssue(externalId);
    return this.updateIssue(externalId, expectedRevision, {
      blockerExternalIds: current.blockerExternalIds.filter((id) => id !== blockerExternalId),
    });
  }

  public async addAssignee(
    externalId: string,
    expectedRevision: string,
    assignee: string,
  ): Promise<GitHubIssueRecord> {
    const current = await this.readIssue(externalId);
    return this.updateIssue(externalId, expectedRevision, {
      assignees: [...new Set([...current.assignees, assignee])],
    });
  }

  public async removeAssignee(
    externalId: string,
    expectedRevision: string,
    assignee: string,
  ): Promise<GitHubIssueRecord> {
    const current = await this.readIssue(externalId);
    return this.updateIssue(externalId, expectedRevision, {
      assignees: current.assignees.filter((login) => login !== assignee),
    });
  }

  public async addComment(
    externalId: string,
    expectedRevision: string,
    body: string,
  ): Promise<GitHubIssueRecord> {
    const current = await this.readIssue(externalId);
    return this.updateIssue(externalId, expectedRevision, { body: current.body }).then((updated) => {
      const next = { ...updated, comments: [...current.comments, body] };
      this.issues.set(externalId, next);
      return structuredClone(next);
    });
  }


  public closeIssue(
    externalId: string,
    expectedRevision: string,
    reason: "completed" | "not_planned",
  ): Promise<GitHubIssueRecord> {
    return this.updateIssue(externalId, expectedRevision, {
      state: reason === "completed" ? "closed" : "cancelled",
      stateReason: reason,
    });
  }
}

class InterruptingCreateGateway extends MemoryGitHubGateway {
  private interrupt = true;

  public override async createIssue(
    input: Readonly<{ title: string; body: string }>,
  ): Promise<GitHubIssueRecord> {
    const created = await super.createIssue(input);
    if (this.interrupt) {
      this.interrupt = false;
      throw new Error("provider response was interrupted");
    }
    return created;
  }
}

class CountingBodyWriteGateway extends MemoryGitHubGateway {
  public bodyWrites = 0;

  public override updateBody(
    externalId: string,
    expectedRevision: string,
    body: string,
  ): Promise<GitHubIssueRecord> {
    this.bodyWrites += 1;
    return super.updateBody(externalId, expectedRevision, body);
  }
}

class InterruptingParentGateway extends MemoryGitHubGateway {
  public parentWrites = 0;
  private interrupt = true;

  public override async addSubIssue(
    parentExternalId: string,
    childExternalId: string,
    expectedChildRevision: string,
  ): Promise<GitHubIssueRecord> {
    this.parentWrites += 1;
    const updated = await super.addSubIssue(parentExternalId, childExternalId, expectedChildRevision);
    if (this.interrupt) {
      this.interrupt = false;
      throw new Error("provider response was interrupted after the native parent write");
    }
    return updated;
  }
}

class InterruptingParentBeforeWriteGateway extends MemoryGitHubGateway {
  public parentWrites = 0;
  private interrupt = true;

  public override async addComment(
    externalId: string,
    expectedRevision: string,
    body: string,
  ): Promise<GitHubIssueRecord> {
    const updated = await super.addComment(externalId, expectedRevision, body);
    if (this.interrupt && body.includes("hanoon:overlay:parent:")) {
      this.interrupt = false;
      throw new Error("process stopped after the parent intent");
    }
    return updated;
  }

  public override addSubIssue(
    parentExternalId: string,
    childExternalId: string,
    expectedChildRevision: string,
  ): Promise<GitHubIssueRecord> {
    this.parentWrites += 1;
    return super.addSubIssue(parentExternalId, childExternalId, expectedChildRevision);
  }
}

class InterruptingAssigneeGateway extends MemoryGitHubGateway {
  public assigneeWrites = 0;
  private interrupt = true;

  public override async addAssignee(
    externalId: string,
    expectedRevision: string,
    assignee: string,
  ): Promise<GitHubIssueRecord> {
    this.assigneeWrites += 1;
    const updated = await super.addAssignee(externalId, expectedRevision, assignee);
    if (this.interrupt) {
      this.interrupt = false;
      throw new Error("provider response was interrupted after the native assignee write");
    }
    return updated;
  }
}

class InterruptingReleaseGateway extends MemoryGitHubGateway {
  private interrupt = true;

  public override async removeAssignee(
    externalId: string,
    expectedRevision: string,
    assignee: string,
  ): Promise<GitHubIssueRecord> {
    const updated = await super.removeAssignee(externalId, expectedRevision, assignee);
    if (this.interrupt) {
      this.interrupt = false;
      throw new Error("process stopped after the native assignee removal");
    }
    return updated;
  }
}

class InterruptingCloseGateway extends MemoryGitHubGateway {
  public closeWrites = 0;
  private interrupt = true;

  public override async closeIssue(
    externalId: string,
    expectedRevision: string,
    reason: "completed" | "not_planned",
  ): Promise<GitHubIssueRecord> {
    this.closeWrites += 1;
    const closed = await super.closeIssue(externalId, expectedRevision, reason);
    if (this.interrupt) {
      this.interrupt = false;
      throw new Error("provider response stopped after native close");
    }
    return closed;
  }
}

class InterruptingBlockersGateway extends MemoryGitHubGateway {
  private interrupt = false;
  public blockerWrites = 0;

  public arm(): void {
    this.interrupt = true;
  }

  public override async addBlockedBy(
    externalId: string,
    expectedRevision: string,
    blockerExternalId: string,
  ): Promise<GitHubIssueRecord> {
    this.blockerWrites += 1;
    const updated = await super.addBlockedBy(externalId, expectedRevision, blockerExternalId);
    if (this.interrupt) {
      this.interrupt = false;
      throw new Error("provider response was interrupted after the native blocker write");
    }
    return updated;
  }
}

class PartiallyInterruptingBlockersGateway extends MemoryGitHubGateway {
  private interrupt = false;

  public arm(): void {
    this.interrupt = true;
  }

  public override async removeBlockedBy(
    externalId: string,
    expectedRevision: string,
    blockerExternalId: string,
  ): Promise<GitHubIssueRecord> {
    const updated = await super.removeBlockedBy(externalId, expectedRevision, blockerExternalId);
    if (this.interrupt) {
      this.interrupt = false;
      throw new Error("provider response was interrupted after one native blocker write");
    }
    return updated;
  }
}

class HumanEditAfterBlockerWriteGateway extends MemoryGitHubGateway {
  private humanBlockerId: string | null = null;

  public injectHumanBlocker(externalId: string): void {
    this.humanBlockerId = externalId;
  }

  public override async addBlockedBy(
    externalId: string,
    expectedRevision: string,
    blockerExternalId: string,
  ): Promise<GitHubIssueRecord> {
    const replaced = await super.addBlockedBy(externalId, expectedRevision, blockerExternalId);
    if (!this.humanBlockerId) return replaced;
    const humanBlockerId = this.humanBlockerId;
    this.humanBlockerId = null;
    await this.replaceBlockersAsHuman(externalId, [blockerExternalId, humanBlockerId]);
    return this.readIssue(externalId);
  }
}

class ReopenedOriginalBlockerGateway extends MemoryGitHubGateway {
  private originalBlockerId: string | null = null;

  public arm(originalBlockerId: string): void {
    this.originalBlockerId = originalBlockerId;
  }

  public override async addBlockedBy(
    externalId: string,
    expectedRevision: string,
    blockerExternalId: string,
  ): Promise<GitHubIssueRecord> {
    const replaced = await super.addBlockedBy(externalId, expectedRevision, blockerExternalId);
    if (!this.originalBlockerId) return replaced;
    const originalBlockerId = this.originalBlockerId;
    this.originalBlockerId = null;
    await this.replaceBlockersAsHuman(externalId, [originalBlockerId, blockerExternalId]);
    throw new Error("provider response was interrupted before blocker completion");
  }
}

describe("work tracker contract", () => {
  it("runs through GitHub Issues with native hierarchy and blockers", async () => {
    await exerciseTracker(async () => new GitHubWorkTracker(new MemoryGitHubGateway()));
  });

  it("runs through atomic local Markdown artifacts with digest conflicts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-"));
    temporaryDirectories.push(directory);
    await exerciseTracker(async () => new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "workflow-refactor",
    }));
  });

  it("binds every replayable GitHub operation to its normalized payload", async () => {
    await exercisePayloadBoundReplays(
      new GitHubWorkTracker(new MemoryGitHubGateway()),
      "github-payload-replay",
    );
  });

  it("binds every replayable local operation to its normalized payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-payload-replay-"));
    temporaryDirectories.push(directory);
    await exercisePayloadBoundReplays(new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "payload-replay",
    }), "local-payload-replay");
  });

  it("enforces the shared terminal claim and opposite-transition contract for GitHub", async () => {
    await exerciseTerminalMutationContract(
      new GitHubWorkTracker(new MemoryGitHubGateway()),
      "github-terminal-contract",
    );
  });

  it("enforces the shared terminal claim and opposite-transition contract for local Markdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-terminal-contract-"));
    temporaryDirectories.push(directory);
    await exerciseTerminalMutationContract(new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "terminal-contract",
    }), "local-terminal-contract");
  });

  it("rejects self parent and blocker mutations at both tracker boundaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-self-relationship-"));
    temporaryDirectories.push(directory);
    const trackers: readonly WorkTracker[] = [
      new GitHubWorkTracker(new MemoryGitHubGateway()),
      new LocalMarkdownWorkTracker({
        repositoryRoot: directory,
        effortSlug: "self-relationship",
      }),
    ];
    for (const [index, tracker] of trackers.entries()) {
      const artifact = await tracker.create({
        operationId: `self-relationship-create-${index}`,
        kind: "implementation_ticket",
        title: "Self relationship",
        body: "# Goal\n\nReject semantic self edges.",
        acceptanceCriteria: [],
      });
      await expect(tracker.setParent({
        externalId: artifact.externalId,
        parentExternalId: artifact.externalId,
        operationId: `self-parent-${index}`,
        expectedRevision: artifact.revision,
      })).rejects.toThrow(TrackerConflictError);
      await expect(tracker.setBlockers({
        externalId: artifact.externalId,
        blockerExternalIds: [artifact.externalId],
        operationId: `self-blocker-${index}`,
        expectedRevision: artifact.revision,
      })).rejects.toThrow(TrackerConflictError);
    }
  });

  it.each([
    ["whitespace", "parent", (externalId: string) => `  ${externalId}\n`],
    ["NFKC", "parent", (externalId: string) => externalId.replace("/issues/", "/ｉｓｓｕｅｓ/")],
    ["whitespace", "blocker", (externalId: string) => `  ${externalId}\n`],
    ["NFKC", "blocker", (externalId: string) => externalId.replace("/issues/", "/ｉｓｓｕｅｓ/")],
  ] as const)("rejects %s-equivalent local self %s relationships", async (
    _equivalence,
    relationship,
    equivalentId,
  ) => {
    const directory = await mkdtemp(join(tmpdir(), `local-canonical-self-${relationship}-`));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: `canonical-self-${relationship}`,
    });
    const artifact = await tracker.create({
      operationId: `canonical-self-${relationship}-create-${temporaryDirectories.length}`,
      kind: "implementation_ticket",
      title: "Canonical self relationship",
      body: "# Goal\n\nReject canonically equivalent self edges.",
      acceptanceCriteria: [],
    });
    const externalId = equivalentId(artifact.externalId);

    const mutation = relationship === "parent"
      ? tracker.setParent({
        externalId,
        parentExternalId: artifact.externalId,
        operationId: `canonical-self-parent-${temporaryDirectories.length}`,
        expectedRevision: artifact.revision,
      })
      : tracker.setBlockers({
        externalId,
        blockerExternalIds: [artifact.externalId],
        operationId: `canonical-self-blocker-${temporaryDirectories.length}`,
        expectedRevision: artifact.revision,
      });
    await expect(mutation).rejects.toThrow(TrackerConflictError);
  });

  it.each([
    "dot segment",
    "duplicate separator",
    "absolute path",
    "wrong separator",
    "noncanonical issue number",
    "unsafe issue number",
    "malformed issue slug",
  ] as const)("rejects a %s local artifact ID", async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "local-exact-id-"));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "exact-id",
    });
    const artifact = await tracker.create({
      operationId: `exact-id-${scenario}`,
      kind: "implementation_ticket",
      title: "Canonical issue name",
      body: "# Goal\n\nAccept one exact local identity.",
      acceptanceCriteria: [],
    });
    const alternateId = (() => {
      switch (scenario) {
        case "dot segment":
          return artifact.externalId.replace("/issues/", "/issues/../issues/");
        case "duplicate separator":
          return artifact.externalId.replace("/issues/", "//issues/");
        case "absolute path":
          return join(directory, artifact.externalId);
        case "wrong separator":
          return artifact.externalId.replaceAll("/", "\\");
        case "noncanonical issue number":
          return artifact.externalId.replace("/01-", "/001-");
        case "unsafe issue number":
          return artifact.externalId.replace("/01-", "/9007199254740992-");
        case "malformed issue slug":
          return artifact.externalId.replace("canonical-issue", "canonical--issue");
      }
    })();

    await expect(tracker.read(alternateId)).rejects.toThrow(/canonical local artifact ID/iu);
  });

  it.each(["parent", "blocker"] as const)(
    "rejects a dot-segment self %s before a local relationship mutation",
    async (relationship) => {
      const directory = await mkdtemp(join(tmpdir(), `local-dot-self-${relationship}-`));
      temporaryDirectories.push(directory);
      const tracker = new LocalMarkdownWorkTracker({
        repositoryRoot: directory,
        effortSlug: `dot-self-${relationship}`,
      });
      const artifact = await tracker.create({
        operationId: `dot-self-${relationship}-create`,
        kind: "implementation_ticket",
        title: "Dot segment self edge",
        body: "# Goal\n\nReject a resolved self identity.",
        acceptanceCriteria: [],
      });
      const alias = artifact.externalId.replace("/issues/", "/issues/../issues/");
      const mutation = relationship === "parent"
        ? tracker.setParent({
            externalId: artifact.externalId,
            parentExternalId: alias,
            operationId: "dot-self-parent",
            expectedRevision: artifact.revision,
          })
        : tracker.setBlockers({
            externalId: artifact.externalId,
            blockerExternalIds: [alias],
            operationId: "dot-self-blocker",
            expectedRevision: artifact.revision,
          });

      await expect(mutation).rejects.toThrow(TrackerConflictError);
      expect((await tracker.read(artifact.externalId)).parentExternalId).toBeNull();
      expect((await tracker.read(artifact.externalId)).blockerExternalIds).toEqual([]);
    },
  );

  it.each(["parent", "blocker"] as const)(
    "rejects an aliased human-edited %s after a local tracker restart",
    async (relationship) => {
      const directory = await mkdtemp(join(tmpdir(), `local-restart-alias-${relationship}-`));
      temporaryDirectories.push(directory);
      const options = {
        repositoryRoot: directory,
        effortSlug: `restart-alias-${relationship}`,
      };
      const tracker = new LocalMarkdownWorkTracker(options);
      const artifact = await tracker.create({
        operationId: `restart-alias-${relationship}-create`,
        kind: "implementation_ticket",
        title: "Restart alias",
        body: "# Goal\n\nReject human-edited aliases after restart.",
        acceptanceCriteria: [],
      });
      const path = join(directory, artifact.externalId);
      const alias = artifact.externalId.replace("/issues/", "/issues/../issues/");
      const raw = await readFile(path, "utf8");
      const edited = relationship === "parent"
        ? raw.replace("Parent: none", `Parent: ${alias}`)
        : raw.replace("Blocked by: none", `Blocked by: ${alias}`);
      await writeFile(path, edited, "utf8");

      const restarted = new LocalMarkdownWorkTracker(options);
      await expect(restarted.read(artifact.externalId))
        .rejects.toThrow(/canonical local artifact ID/iu);
      expect(await readFile(path, "utf8")).toBe(edited);
    },
  );

  it("accepts the exact generated map, specification, and issue IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-valid-identities-"));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "valid-identities",
    });
    const created = [
      await tracker.create({
        operationId: "valid-map-id",
        kind: "map",
        title: "Map",
        body: "# Map\n\nIndex the effort.",
        acceptanceCriteria: [],
      }),
      await tracker.create({
        operationId: "valid-spec-id",
        kind: "specification",
        title: "Specification",
        body: "# Scope\n\nDefine the work.",
        acceptanceCriteria: [],
      }),
      await tracker.create({
        operationId: "valid-issue-id",
        kind: "implementation_ticket",
        title: "Valid issue",
        body: "# Goal\n\nUse the generated issue identity.",
        acceptanceCriteria: [],
      }),
    ];

    expect(created.map((artifact) => artifact.externalId)).toEqual([
      ".scratch/valid-identities/map.md",
      ".scratch/valid-identities/spec.md",
      ".scratch/valid-identities/issues/01-valid-issue.md",
    ]);
    await expect(Promise.all(created.map((artifact) => tracker.read(artifact.externalId))))
      .resolves.toHaveLength(3);
  });

  it("preserves native GitHub child priority through frontier traversal", async () => {
    const tracker = new GitHubWorkTracker(new MemoryGitHubGateway());
    const parent = await tracker.create({
      operationId: "native-child-order-parent",
      kind: "specification",
      title: "Ordered parent",
      body: "# Scope\n\nKeep provider child priority.",
      acceptanceCriteria: [],
    });
    let first = await tracker.create({
      operationId: "native-child-order-first",
      kind: "implementation_ticket",
      title: "Provider child two",
      body: "# Goal\n\nRun first.",
      acceptanceCriteria: [],
    });
    for (let number = 3; number < 10; number += 1) {
      await tracker.create({
        operationId: `native-child-order-filler-${number}`,
        kind: "decision_ticket",
        title: `Filler ${number}`,
        body: "# Decision\n\nRemain unrelated.",
        acceptanceCriteria: [],
      });
    }
    let second = await tracker.create({
      operationId: "native-child-order-second",
      kind: "implementation_ticket",
      title: "Provider child ten",
      body: "# Goal\n\nRun second.",
      acceptanceCriteria: [],
    });
    first = await tracker.setParent({
      externalId: first.externalId,
      parentExternalId: parent.externalId,
      operationId: "native-child-order-first-parent",
      expectedRevision: first.revision,
    });
    second = await tracker.setParent({
      externalId: second.externalId,
      parentExternalId: parent.externalId,
      operationId: "native-child-order-second-parent",
      expectedRevision: second.revision,
    });

    expect([first.externalId, second.externalId]).toEqual(["2", "10"]);
    expect((await tracker.frontier({ parentExternalId: parent.externalId }))
      .map((artifact) => artifact.externalId)).toEqual(["2", "10"]);
  });

  it("scopes coordinated GitHub create identity by project and preflights relationships", async () => {
    const { bb } = createFakePluginHost({ pluginId: "coordinated-github-project-identity" });
    const store = openStore(bb.storage, bb.storage.kv, () => 1_000);
    const gateway = new MemoryGitHubGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const lease = store.acquireExecutorLease("coordinated-github-executor", 1_000, 5_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => 1_000);
    const fence = { ownerId: "coordinated-github-executor", generation: lease.generation };
    const shared = {
      effortId: "effort_shared",
      operationId: "same-durable-operation",
      kind: "implementation_ticket" as const,
      status: "ready" as const,
      title: "Same visible ticket",
      body: "# Goal\n\nKeep project identities separate.",
      acceptanceCriteria: [] as readonly string[],
      relationships: [] as const,
      ...fence,
    };
    const first = await coordinator.create({ ...shared, projectId: "proj_a", now: 1_000 });
    const second = await coordinator.create({ ...shared, projectId: "proj_b", now: 1_001 });
    const replay = await coordinator.create({ ...shared, projectId: "proj_a", now: 1_002 });
    expect(first.artifact.externalId).not.toBe(second.artifact.externalId);
    expect(replay.artifact.externalId).toBe(first.artifact.externalId);
    expect(gateway.allIssues()).toHaveLength(2);

    const foreignParent = await coordinator.create({
      ...shared,
      projectId: "proj_a",
      effortId: "effort_foreign",
      operationId: "foreign-effort-parent",
      kind: "specification",
      title: "Foreign effort parent",
      now: 1_003,
    });
    const invalidChildId = stableWorkArtifactId("proj_a", "invalid-cross-effort-child");
    await expect(coordinator.create({
      ...shared,
      projectId: "proj_a",
      operationId: "invalid-cross-effort-child",
      relationships: [{
        kind: "parent",
        sourceArtifactId: invalidChildId,
        sourceRef: `artifact:${invalidChildId}`,
        targetArtifactId: foreignParent.artifact.id,
        targetRef: `artifact:${foreignParent.artifact.id}`,
      }],
      now: 1_004,
    })).rejects.toThrow(/same project, effort, and tracker/iu);
    expect(gateway.allIssues()).toHaveLength(3);
  });

  it("reconciles an interrupted GitHub create by marker without duplicating the issue", async () => {
    const gateway = new InterruptingCreateGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const input = {
      operationId: "interrupted-create",
      kind: "implementation_ticket" as const,
      title: "Create exactly once",
      body: "# Goal\n\nReconcile the ambiguous response.",
      acceptanceCriteria: ["Only one issue exists"],
    };

    await expect(tracker.create(input)).rejects.toThrow(/interrupted/u);
    expect((await tracker.create(input)).externalId).toBe("1");
    expect(gateway.allIssues()).toHaveLength(1);
  });

  it("rejects an invalid complete GitHub body before an owned-section write", async () => {
    const gateway = new CountingBodyWriteGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const created = await tracker.create({
      operationId: "preflight-owned-section-create",
      kind: "implementation_ticket",
      title: "Preflight owned section",
      body: "# Goal\n\nValidate the complete candidate before writing.",
      acceptanceCriteria: ["No malformed body reaches GitHub"],
    });
    const before = await gateway.readIssue(created.externalId);

    await expect(tracker.updateOwnedSection({
      externalId: created.externalId,
      sectionId: "acceptance-criteria",
      content: "This is not a checklist item.",
      operationId: "preflight-owned-section-update",
      expectedRevision: created.revision,
    })).rejects.toThrow(TrackerIdentityConflictError);

    expect(gateway.bodyWrites).toBe(0);
    expect((await gateway.readIssue(created.externalId)).body).toBe(before.body);

    await gateway.replaceBodyAsHuman(
      created.externalId,
      before.body.replace(
        "<!-- hanoon:owned:body:end -->",
        "<!-- hanoon:owned:body:end -->\n<!-- hanoon:owned:body:end -->",
      ),
    );
    const malformed = await gateway.readIssue(created.externalId);
    await expect(tracker.updateOwnedSection({
      externalId: created.externalId,
      sectionId: "notes",
      content: "This write must also be rejected.",
      operationId: "preflight-malformed-markers-update",
      expectedRevision: malformed.revision,
    })).rejects.toThrow(TrackerIdentityConflictError);
    expect(gateway.bodyWrites).toBe(0);
  });

  it("binds hidden create identity context without publishing it as prose", async () => {
    const gateway = new MemoryGitHubGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const input = {
      operationId: "relationship-bound-create",
      kind: "implementation_ticket" as const,
      title: "Relationship-bound create",
      body: "# Goal\n\nBind the initial graph to restart identity.",
      acceptanceCriteria: [] as readonly string[],
      identityContext: "relationships:a",
    };
    const created = await tracker.create(input);

    expect(created.body).not.toContain(input.identityContext);
    await expect(tracker.create({
      ...input,
      identityContext: "relationships:b",
    })).rejects.toThrow(TrackerIdentityConflictError);
    expect(gateway.allIssues()).toHaveLength(1);
  });

  it("binds initial status and tracker order across interrupted create replay", async () => {
    const { bb } = createFakePluginHost({ pluginId: "create-status-order-replay" });
    let clock = 4_000;
    const store = openStore(bb.storage, bb.storage.kv, () => clock);
    const gateway = new MemoryGitHubGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const firstLease = store.acquireExecutorLease("create-replay-a", clock, 100);
    if (!firstLease.acquired) throw new Error("first executor lease was not acquired");
    const firstFence = { ownerId: "create-replay-a", generation: firstLease.generation };
    let interrupt = true;
    const interruptingTracker = new Proxy(tracker, {
      get(target, property, receiver) {
        if (property === "create") {
          return async (input: Parameters<WorkTracker["create"]>[0]) => {
            const created = await target.create(input);
            if (interrupt) {
              interrupt = false;
              throw new Error("process stopped after external create");
            }
            return created;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;
    const firstCoordinator = new WorkArtifactCoordinator(store, interruptingTracker, () => clock);
    const base = {
      projectId: "proj_create_replay",
      effortId: "effort_create_replay",
      operationId: "status-order-replay-create",
      kind: "implementation_ticket" as const,
      title: "Status and order replay",
      body: "# Goal\n\nBind the initial projection.",
      acceptanceCriteria: [] as readonly string[],
      relationships: [] as const,
    };
    await expect(firstCoordinator.create({
      ...base,
      status: "ready",
      trackerOrder: 4,
      ...firstFence,
      now: clock,
    })).rejects.toThrow(/stopped after external create/iu);
    expect(gateway.allIssues()).toHaveLength(1);
    expect(store.releaseExecutorLease(firstFence.ownerId, firstFence.generation, clock + 1)).toBe(true);
    clock += 200;
    const secondLease = store.acquireExecutorLease("create-replay-b", clock, 1_000);
    if (!secondLease.acquired) throw new Error("successor executor lease was not acquired");
    const secondFence = { ownerId: "create-replay-b", generation: secondLease.generation };
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => clock);
    await expect(coordinator.create({
      ...base,
      status: "open",
      trackerOrder: 4,
      ...secondFence,
      now: clock,
    })).rejects.toThrow(TrackerIdentityConflictError);
    await expect(coordinator.create({
      ...base,
      status: "ready",
      trackerOrder: 5,
      ...secondFence,
      now: clock,
    })).rejects.toThrow(TrackerIdentityConflictError);
    const replay = await coordinator.create({
      ...base,
      status: "ready",
      trackerOrder: 4,
      ...secondFence,
      now: clock,
    });
    expect(replay.artifact).toMatchObject({ status: "ready", trackerOrder: 4 });
    expect(gateway.allIssues()).toHaveLength(1);
  });

  it("persists create identity before the external effect and fences restart reconciliation", async () => {
    const { bb } = createFakePluginHost({ pluginId: "create-intent-restart-fence" });
    let clock = 4_500;
    const store = openStore(bb.storage, bb.storage.kv, () => clock);
    const originalGateway = new MemoryGitHubGateway("github:acme/widgets");
    const originalTracker = new GitHubWorkTracker(originalGateway);
    const firstLease = store.acquireExecutorLease("create-intent-first", clock, 100);
    if (!firstLease.acquired) throw new Error("first executor lease was not acquired");
    let interrupt = true;
    const interruptedTracker = new Proxy(originalTracker, {
      get(target, property, receiver) {
        if (property === "create") {
          return async (input: Parameters<WorkTracker["create"]>[0]) => {
            const created = await target.create(input);
            if (interrupt) {
              interrupt = false;
              throw new Error("process stopped after create intent effect");
            }
            return created;
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;
    const input = {
      projectId: "proj_create_intent",
      effortId: "effort_create_intent",
      operationId: "create-intent-operation",
      kind: "implementation_ticket" as const,
      status: "ready" as const,
      title: "Create intent restart",
      body: "# Goal\n\nReconcile only through the persisted tracker identity.",
      acceptanceCriteria: [] as readonly string[],
      relationships: [] as const,
    };
    const artifactId = stableWorkArtifactId(input.projectId, input.operationId);
    const firstCoordinator = new WorkArtifactCoordinator(store, interruptedTracker, () => clock);

    await expect(firstCoordinator.create({
      ...input,
      ownerId: "create-intent-first",
      generation: firstLease.generation,
      now: clock,
    })).rejects.toThrow(/stopped after create intent effect/iu);
    expect(originalGateway.allIssues()).toHaveLength(1);
    expect(store.getWorkArtifactCreateIntent(artifactId)).toMatchObject({
      artifactId,
      operationId: input.operationId,
      trackerKind: "github",
      trackerNamespace: "github:acme/widgets",
    });

    expect(store.releaseExecutorLease("create-intent-first", firstLease.generation, clock + 1)).toBe(true);
    clock += 200;
    const secondLease = store.acquireExecutorLease("create-intent-second", clock, 1_000);
    if (!secondLease.acquired) throw new Error("second executor lease was not acquired");
    const otherGateway = new MemoryGitHubGateway("github:acme/other");
    const otherCoordinator = new WorkArtifactCoordinator(
      store,
      new GitHubWorkTracker(otherGateway),
      () => clock,
    );
    await expect(otherCoordinator.create({
      ...input,
      ownerId: "create-intent-second",
      generation: secondLease.generation,
      now: clock,
    })).rejects.toThrow(TrackerIdentityConflictError);
    expect(otherGateway.allIssues()).toHaveLength(0);

    const restarted = new WorkArtifactCoordinator(store, originalTracker, () => clock);
    const captured = await restarted.create({
      ...input,
      ownerId: "create-intent-second",
      generation: secondLease.generation,
      now: clock,
    });
    expect(captured.artifact.externalId).toBe("1");
    expect(originalGateway.allIssues()).toHaveLength(1);
  });

  it("rejects same-kind related artifacts from another tracker namespace before create", async () => {
    const { bb } = createFakePluginHost({ pluginId: "cross-namespace-preflight" });
    const store = openStore(bb.storage, bb.storage.kv, () => 5_000);
    const sourceGateway = new MemoryGitHubGateway("github:acme/source");
    const targetGateway = new MemoryGitHubGateway("github:acme/target");
    const lease = store.acquireExecutorLease("namespace-executor", 5_000, 1_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const fence = { ownerId: "namespace-executor", generation: lease.generation };
    const source = new WorkArtifactCoordinator(
      store,
      new GitHubWorkTracker(sourceGateway),
      () => 5_000,
    );
    const target = new WorkArtifactCoordinator(
      store,
      new GitHubWorkTracker(targetGateway),
      () => 5_000,
    );
    const related = await source.create({
      projectId: "proj_namespace",
      effortId: "effort_namespace",
      operationId: "namespace-related",
      kind: "specification",
      status: "ready",
      title: "Foreign namespace artifact",
      body: "# Scope\n\nStay bound to the source tracker.",
      acceptanceCriteria: [],
      relationships: [],
      ...fence,
      now: 5_000,
    });
    const parentChildId = stableWorkArtifactId("proj_namespace", "namespace-parent-child");
    await expect(target.create({
      projectId: "proj_namespace",
      effortId: "effort_namespace",
      operationId: "namespace-parent-child",
      kind: "implementation_ticket",
      status: "ready",
      title: "Invalid parent namespace",
      body: "# Goal\n\nDo not create externally.",
      acceptanceCriteria: [],
      relationships: [{
        kind: "parent",
        sourceArtifactId: parentChildId,
        sourceRef: `artifact:${parentChildId}`,
        targetArtifactId: related.artifact.id,
        targetRef: `artifact:${related.artifact.id}`,
      }],
      ...fence,
      now: 5_001,
    })).rejects.toThrow(/another tracker/iu);
    const blockedChildId = stableWorkArtifactId("proj_namespace", "namespace-blocked-child");
    await expect(target.create({
      projectId: "proj_namespace",
      effortId: "effort_namespace",
      operationId: "namespace-blocked-child",
      kind: "implementation_ticket",
      status: "ready",
      title: "Invalid blocker namespace",
      body: "# Goal\n\nDo not create externally.",
      acceptanceCriteria: [],
      relationships: [{
        kind: "blocks",
        sourceArtifactId: related.artifact.id,
        sourceRef: `artifact:${related.artifact.id}`,
        targetArtifactId: blockedChildId,
        targetRef: `artifact:${blockedChildId}`,
      }],
      ...fence,
      now: 5_002,
    })).rejects.toThrow(/another tracker/iu);
    expect(targetGateway.allIssues()).toHaveLength(0);
  });

  it("reconciles an interrupted native parent write from exact observed state", async () => {
    const gateway = new InterruptingParentGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const parent = await tracker.create({
      operationId: "interrupted-parent-parent",
      kind: "specification",
      title: "Parent",
      body: "# Scope\n\nOwn the child.",
      acceptanceCriteria: [],
    });
    const child = await tracker.create({
      operationId: "interrupted-parent-child",
      kind: "implementation_ticket",
      title: "Child",
      body: "# Goal\n\nApply a parent exactly once.",
      acceptanceCriteria: [],
    });
    const mutation = {
      externalId: child.externalId,
      parentExternalId: parent.externalId,
      operationId: "interrupted-parent-write",
      expectedRevision: child.revision,
    };

    await expect(tracker.setParent(mutation)).rejects.toThrow(/native parent write/iu);
    expect((await gateway.readIssue(child.externalId)).parentExternalId).toBe(parent.externalId);
    expect((await tracker.setParent(mutation)).parentExternalId).toBe(parent.externalId);
    expect((await tracker.read(child.externalId)).parentExternalId).toBe(parent.externalId);
    expect(gateway.parentWrites).toBe(1);
  });

  it("does not settle a parent from evidence observed after the native edge was removed", async () => {
    const { bb } = createFakePluginHost({ pluginId: "parent-single-observation-evidence" });
    const store = openStore(bb.storage, bb.storage.kv, () => 12_000);
    const gateway = new MemoryGitHubGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const lease = store.acquireExecutorLease("parent-evidence-executor", 12_000, 1_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const fence = { ownerId: "parent-evidence-executor", generation: lease.generation };
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => 12_000);
    const parent = await coordinator.create({
      projectId: "proj_parent_evidence",
      effortId: "effort_parent_evidence",
      operationId: "parent-evidence-parent",
      kind: "specification",
      status: "ready",
      title: "Evidence parent",
      body: "# Scope\n\nOwn the child only while the native edge exists.",
      acceptanceCriteria: [],
      relationships: [],
      ...fence,
      now: 12_000,
    });
    const childOperationId = "parent-evidence-child";
    const childId = stableWorkArtifactId("proj_parent_evidence", childOperationId);
    const childInput = {
      projectId: "proj_parent_evidence",
      effortId: "effort_parent_evidence",
      operationId: childOperationId,
      kind: "implementation_ticket" as const,
      status: "ready" as const,
      title: "Evidence child",
      body: "# Goal\n\nDo not settle from stale native state.",
      acceptanceCriteria: [] as readonly string[],
      relationships: [{
        kind: "parent" as const,
        sourceArtifactId: childId,
        sourceRef: `artifact:${childId}`,
        targetArtifactId: parent.artifact.id,
        targetRef: `artifact:${parent.artifact.id}`,
      }],
      ...fence,
      now: 12_000,
    };
    let interrupt = true;
    const interruptedTracker = new Proxy(tracker, {
      get(target, property) {
        if (property === "setParent") {
          return async (input: Parameters<WorkTracker["setParent"]>[0]) => {
            const result = await target.setParent(input);
            if (interrupt) {
              interrupt = false;
              throw new Error("process stopped after final parent marker");
            }
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;
    await expect(new WorkArtifactCoordinator(store, interruptedTracker, () => 12_000)
      .create(childInput)).rejects.toThrow(/final parent marker/iu);
    const child = gateway.allIssues().find((issue) => issue.externalId !== parent.artifact.externalId);
    if (!child) throw new Error("child issue was not created");
    let removed = false;
    const interleavingTracker = new Proxy(tracker, {
      get(target, property) {
        if (property === "operationStatus") {
          return async (input: Parameters<WorkTracker["operationStatus"]>[0]) => {
            if (!removed && input.operationId.startsWith("tracker:parent:")) {
              removed = true;
              await gateway.replaceParentAsHuman(input.externalId, null);
            }
            return target.operationStatus(input);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;

    await expect(new WorkArtifactCoordinator(store, interleavingTracker, () => 12_001)
      .create({ ...childInput, now: 12_001 })).rejects.toThrow(WorkArtifactMutationIndeterminateError);
    expect((await tracker.read(child.externalId)).parentExternalId).toBeNull();
    expect(store.getWorkArtifact(childId)).toBeNull();
  });

  it("records one durable indeterminate parent outcome before any native parent call", async () => {
    const { bb } = createFakePluginHost({ pluginId: "indeterminate-parent-boundary" });
    let clock = 10_000;
    const store = openStore(bb.storage, bb.storage.kv, () => clock);
    const gateway = new InterruptingParentBeforeWriteGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const firstLease = store.acquireExecutorLease("parent-boundary-a", clock, 100);
    if (!firstLease.acquired) throw new Error("first executor lease was not acquired");
    const firstFence = { ownerId: "parent-boundary-a", generation: firstLease.generation };
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => clock);
    const parent = await coordinator.create({
      projectId: "proj_parent_boundary",
      effortId: "effort_parent_boundary",
      operationId: "parent-boundary-parent",
      kind: "specification",
      status: "ready",
      title: "Parent boundary",
      body: "# Scope\n\nOwn the child.",
      acceptanceCriteria: [],
      relationships: [],
      ...firstFence,
      now: clock,
    });
    const childOperationId = "parent-boundary-child";
    const childId = stableWorkArtifactId("proj_parent_boundary", childOperationId);
    const childInput = {
      projectId: "proj_parent_boundary",
      effortId: "effort_parent_boundary",
      operationId: childOperationId,
      kind: "implementation_ticket" as const,
      status: "ready" as const,
      title: "Child boundary",
      body: "# Goal\n\nFail closed before the native call.",
      acceptanceCriteria: [] as readonly string[],
      relationships: [{
        kind: "parent" as const,
        sourceArtifactId: childId,
        sourceRef: `artifact:${childId}`,
        targetArtifactId: parent.artifact.id,
        targetRef: `artifact:${parent.artifact.id}`,
      }],
    };

    await expect(coordinator.create({ ...childInput, ...firstFence, now: clock }))
      .rejects.toThrow(/parent intent/iu);
    expect(gateway.parentWrites).toBe(0);
    expect(store.getWorkArtifact(childId)).toBeNull();
    expect(store.releaseExecutorLease(firstFence.ownerId, firstFence.generation, clock + 1)).toBe(true);
    clock += 200;
    const secondLease = store.acquireExecutorLease("parent-boundary-b", clock, 1_000);
    if (!secondLease.acquired) throw new Error("successor executor lease was not acquired");
    const secondFence = { ownerId: "parent-boundary-b", generation: secondLease.generation };

    await expect(coordinator.create({ ...childInput, ...secondFence, now: clock }))
      .rejects.toThrow(WorkArtifactMutationIndeterminateError);
    const childIssue = gateway.allIssues().find((issue) => issue.externalId !== parent.artifact.externalId);
    if (!childIssue) throw new Error("child issue was not created");
    const operationId = `tracker:parent:${sha256(childOperationId).slice(0, 32)}`;
    const key = {
      trackerNamespace: tracker.namespace,
      externalId: childIssue.externalId,
      operationId,
    };
    expect(store.getWorkArtifactTrackerMutation(key)).toMatchObject({
      artifactId: childId,
      requestedParentExternalId: parent.artifact.externalId,
      originalParentExternalId: null,
      ownerId: firstFence.ownerId,
      generation: firstFence.generation,
      phase: "indeterminate",
      status: "indeterminate",
      lastObservedParentExternalId: null,
    });
    expect(gateway.parentWrites).toBe(0);
    expect((await tracker.read(childIssue.externalId)).parentExternalId).toBeNull();
    expect(store.getWorkArtifact(childId)).toBeNull();
    const firstOutcome = store.getWorkArtifactTrackerMutation(key);
    await expect(coordinator.create({ ...childInput, ...secondFence, now: clock + 1 }))
      .rejects.toThrow(WorkArtifactMutationIndeterminateError);
    expect(store.getWorkArtifactTrackerMutation(key)).toEqual(firstOutcome);
    expect(gateway.parentWrites).toBe(0);
  });

  it.each([
    ["github", "parent"],
    ["github", "resolve"],
    ["github", "cancel"],
    ["local_markdown", "parent"],
    ["local_markdown", "resolve"],
    ["local_markdown", "cancel"],
  ] as const)(
    "settles a %s %s operation after a crash following its final marker",
    async (adapter, mutationKind) => {
      const caseId = `${adapter}-${mutationKind}-final-marker`;
      const { bb } = createFakePluginHost({ pluginId: caseId });
      let clock = 40_000;
      const store = openStore(bb.storage, bb.storage.kv, () => clock);
      const pairingHash = hashSecret(`pair-${caseId}`);
      store.createPairingCode(pairingHash, clock - 10, clock + 10_000);
      expect(store.pairOwnerWithCode(pairingHash, "7", "7", clock - 9)).toEqual({ ok: true });
      let tracker: WorkTracker;
      if (adapter === "github") {
        tracker = new GitHubWorkTracker(new MemoryGitHubGateway(`github:acme/${mutationKind}`));
      } else {
        const directory = await mkdtemp(join(tmpdir(), `${caseId}-`));
        temporaryDirectories.push(directory);
        tracker = new LocalMarkdownWorkTracker({
          repositoryRoot: directory,
          effortSlug: `${mutationKind}-final-marker`,
        });
      }
      const firstLease = store.acquireExecutorLease(`${caseId}-a`, clock, 100);
      if (!firstLease.acquired) throw new Error("first executor lease was not acquired");
      const firstFence = { ownerId: `${caseId}-a`, generation: firstLease.generation };
      const coordinator = new WorkArtifactCoordinator(store, tracker, () => clock);
      const parent = mutationKind === "parent"
        ? await coordinator.create({
          projectId: `proj_${caseId}`,
          effortId: `effort_${caseId}`,
          operationId: `${caseId}-parent`,
          kind: "specification",
          status: "ready",
          title: "Crash-safe parent",
          body: "# Scope\n\nOwn the child after restart.",
          acceptanceCriteria: [],
          relationships: [],
          ...firstFence,
          now: clock,
        })
        : null;
      const artifactOperationId = `${caseId}-artifact`;
      const artifactId = stableWorkArtifactId(`proj_${caseId}`, artifactOperationId);
      const artifactInput = {
        projectId: `proj_${caseId}`,
        effortId: `effort_${caseId}`,
        operationId: artifactOperationId,
        kind: "implementation_ticket" as const,
        status: "ready" as const,
        title: "Crash-safe mutation",
        body: "# Goal\n\nSettle the final marker after restart.",
        acceptanceCriteria: [] as readonly string[],
        relationships: parent === null ? [] : [{
          kind: "parent" as const,
          sourceArtifactId: artifactId,
          sourceRef: `artifact:${artifactId}`,
          targetArtifactId: parent.artifact.id,
          targetRef: `artifact:${parent.artifact.id}`,
        }],
      };
      let interrupt = true;
      const interruptedTracker = new Proxy(tracker, {
        get(target, property, receiver) {
          if (property === mutationKind || (mutationKind === "parent" && property === "setParent")) {
            return async (input: Parameters<WorkTracker["resolve"]>[0]) => {
              const method = Reflect.get(target, property, receiver) as (
                value: typeof input,
              ) => Promise<TrackerArtifact>;
              const result = await method.call(target, input);
              if (interrupt) {
                interrupt = false;
                throw new Error("process stopped after the final tracker marker");
              }
              return result;
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as WorkTracker;
      const interruptedCoordinator = new WorkArtifactCoordinator(store, interruptedTracker, () => clock);
      let created: WorkArtifactCapture | null = null;
      let evidenceRef: `evidence:${number}` | null = null;
      const terminalOperationId = `${caseId}-terminal`;
      if (mutationKind === "parent") {
        await expect(interruptedCoordinator.create({
          ...artifactInput,
          ...firstFence,
          now: clock,
        })).rejects.toThrow(/stopped after the final tracker marker/iu);
      } else {
        created = await coordinator.create({
          ...artifactInput,
          ...firstFence,
          now: clock,
        });
        evidenceRef = recordContractEvidence(store, {
          artifactId: created.artifact.id,
          snapshotId: created.snapshot.id,
          projectId: created.artifact.projectId,
          ...firstFence,
          now: clock,
        });
        const effect = mutationKind === "resolve"
          ? interruptedCoordinator.resolve({
            artifactId: created.artifact.id,
            evidenceRefs: [evidenceRef],
            resolution: "The accepted snapshot passed.",
            operationId: terminalOperationId,
            ...firstFence,
            now: clock,
          })
          : interruptedCoordinator.cancel({
            artifactId: created.artifact.id,
            evidenceRefs: [evidenceRef],
            reason: "The accepted path is no longer planned.",
            operationId: terminalOperationId,
            ...firstFence,
            now: clock,
          });
        await expect(effect).rejects.toThrow(/stopped after the final tracker marker/iu);
      }
      expect(store.releaseExecutorLease(firstFence.ownerId, firstFence.generation, clock + 1)).toBe(true);
      clock += 200;
      const secondLease = store.acquireExecutorLease(`${caseId}-b`, clock, 1_000);
      if (!secondLease.acquired) throw new Error("successor executor lease was not acquired");
      const secondFence = { ownerId: `${caseId}-b`, generation: secondLease.generation };
      let operationId: string;
      if (mutationKind === "parent") {
        const recovered = await coordinator.create({
          ...artifactInput,
          ...secondFence,
          now: clock,
        });
        expect(recovered.snapshot.relationships).toHaveLength(1);
        operationId = `tracker:parent:${sha256(artifactOperationId).slice(0, 32)}`;
      } else if (mutationKind === "resolve") {
        if (created === null) throw new Error("terminal artifact was not created");
        const recovered = await coordinator.resolve({
          artifactId: created.artifact.id,
          evidenceRefs: [evidenceRef as `evidence:${number}`],
          resolution: "The accepted snapshot passed.",
          operationId: terminalOperationId,
          ...secondFence,
          now: clock,
        });
        expect(recovered.artifact.status).toBe("resolved");
        operationId = terminalOperationId;
      } else {
        if (created === null) throw new Error("terminal artifact was not created");
        const recovered = await coordinator.cancel({
          artifactId: created.artifact.id,
          evidenceRefs: [evidenceRef as `evidence:${number}`],
          reason: "The accepted path is no longer planned.",
          operationId: terminalOperationId,
          ...secondFence,
          now: clock,
        });
        expect(recovered.artifact.status).toBe("cancelled");
        operationId = terminalOperationId;
      }
      const externalId = mutationKind === "parent"
        ? store.getWorkArtifact(artifactId)?.externalId
        : created?.artifact.externalId;
      if (!externalId) throw new Error("recovered artifact has no external identity");
      expect(store.getWorkArtifactTrackerMutation({
        trackerNamespace: tracker.namespace,
        externalId,
        operationId,
      })).toMatchObject({ phase: "completed", status: "completed" });
    },
  );

  it.each(["resolve", "cancel"] as const)(
    "keeps a collaborator reopen after an interrupted GitHub %s close",
    async (outcome) => {
      const { bb } = createFakePluginHost({ pluginId: `indeterminate-${outcome}-boundary` });
      let clock = outcome === "resolve" ? 20_000 : 30_000;
      const store = openStore(bb.storage, bb.storage.kv, () => clock);
      const pairingHash = hashSecret(`pair-indeterminate-${outcome}`);
      store.createPairingCode(pairingHash, clock - 10, clock + 10_000);
      expect(store.pairOwnerWithCode(pairingHash, "7", "7", clock - 9)).toEqual({ ok: true });
      const gateway = new InterruptingCloseGateway();
      const tracker = new GitHubWorkTracker(gateway);
      const firstLease = store.acquireExecutorLease(`${outcome}-boundary-a`, clock, 100);
      if (!firstLease.acquired) throw new Error("first executor lease was not acquired");
      const firstFence = { ownerId: `${outcome}-boundary-a`, generation: firstLease.generation };
      const coordinator = new WorkArtifactCoordinator(store, tracker, () => clock);
      const created = await coordinator.create({
        projectId: `proj_${outcome}_boundary`,
        effortId: `effort_${outcome}_boundary`,
        operationId: `${outcome}-boundary-create`,
        kind: "implementation_ticket",
        status: "ready",
        title: `${outcome} boundary`,
        body: "# Goal\n\nKeep a collaborator reopen authoritative.",
        acceptanceCriteria: [],
        relationships: [],
        ...firstFence,
        now: clock,
      });
      const evidenceRef = recordContractEvidence(store, {
        artifactId: created.artifact.id,
        snapshotId: created.snapshot.id,
        projectId: created.artifact.projectId,
        ...firstFence,
        now: clock,
      });
      const operationId = `${outcome}-boundary-close`;
      const applyTerminal = (fence: typeof firstFence, now: number) => outcome === "resolve"
        ? coordinator.resolve({
          artifactId: created.artifact.id,
          evidenceRefs: [evidenceRef],
          resolution: "The accepted work passed.",
          operationId,
          ...fence,
          now,
        })
        : coordinator.cancel({
          artifactId: created.artifact.id,
          evidenceRefs: [evidenceRef],
          reason: "The accepted path is no longer planned.",
          operationId,
          ...fence,
          now,
        });

      await expect(applyTerminal(firstFence, clock))
        .rejects.toThrow(/stopped after native close/iu);
      expect(gateway.closeWrites).toBe(1);
      await gateway.reopenAsHuman(created.artifact.externalId);
      expect(store.releaseExecutorLease(firstFence.ownerId, firstFence.generation, clock + 1)).toBe(true);
      clock += 200;
      const secondLease = store.acquireExecutorLease(`${outcome}-boundary-b`, clock, 100);
      if (!secondLease.acquired) throw new Error("successor executor lease was not acquired");
      const secondFence = { ownerId: `${outcome}-boundary-b`, generation: secondLease.generation };

      await expect(applyTerminal(secondFence, clock))
        .rejects.toThrow(WorkArtifactMutationIndeterminateError);
      const key = {
        trackerNamespace: tracker.namespace,
        externalId: created.artifact.externalId,
        operationId,
      };
      const indeterminate = store.getWorkArtifactTrackerMutation(key);
      expect(indeterminate).toMatchObject({
        kind: outcome,
        phase: "indeterminate",
        status: "indeterminate",
        ownerId: firstFence.ownerId,
        generation: firstFence.generation,
        lastObservedRevision: expect.any(String),
      });
      expect(gateway.closeWrites).toBe(1);
      expect((await tracker.read(created.artifact.externalId)).state).toBe("open");
      expect(store.getWorkArtifact(created.artifact.id)?.status).toBe("ready");
      expect(store.getWorkArtifactResolution(created.artifact.id)).toBeNull();
      expect(store.releaseExecutorLease(secondFence.ownerId, secondFence.generation, clock + 1)).toBe(true);
      clock += 200;
      const thirdLease = store.acquireExecutorLease(`${outcome}-boundary-c`, clock, 1_000);
      if (!thirdLease.acquired) throw new Error("third executor lease was not acquired");
      const thirdFence = { ownerId: `${outcome}-boundary-c`, generation: thirdLease.generation };
      await expect(applyTerminal(thirdFence, clock))
        .rejects.toThrow(WorkArtifactMutationIndeterminateError);
      expect(store.getWorkArtifactTrackerMutation(key)).toEqual(indeterminate);
      expect(gateway.closeWrites).toBe(1);
    },
  );

  it("recovers a GitHub claim interrupted after its native assignee write", async () => {
    const gateway = new InterruptingAssigneeGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const artifact = await tracker.create({
      operationId: "interrupted-assignee-create",
      kind: "implementation_ticket",
      title: "Interrupted assignee",
      body: "# Goal\n\nRecover visible ownership from its durable intent.",
      acceptanceCriteria: [],
    });
    const mutation = {
      externalId: artifact.externalId,
      assignee: "hanoon-bot",
      operationId: "interrupted-assignee-claim",
      expectedRevision: artifact.revision,
    };

    await expect(tracker.claim(mutation)).rejects.toThrow(/native assignee write/iu);
    expect((await gateway.readIssue(artifact.externalId)).assignees).toEqual(["hanoon-bot"]);
    expect((await tracker.read(artifact.externalId)).assignees).toEqual(["hanoon-bot"]);
    expect((await tracker.operationStatus({
      externalId: artifact.externalId,
      operationId: mutation.operationId,
      payloadDigest: claimPayloadDigest("claim", mutation.assignee),
    })).status).toBe("pending");
    expect((await tracker.claim(mutation)).assignees).toEqual(["hanoon-bot"]);
    expect((await tracker.operationStatus({
      externalId: artifact.externalId,
      operationId: mutation.operationId,
      payloadDigest: claimPayloadDigest("claim", mutation.assignee),
    })).status).toBe("completed");
    expect(gateway.assigneeWrites).toBe(1);
  });

  it("fails closed and preserves a human co-assignee added during claim recovery", async () => {
    const gateway = new InterruptingAssigneeGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const artifact = await tracker.create({
      operationId: "interrupted-mixed-assignee-create",
      kind: "implementation_ticket",
      title: "Interrupted mixed assignee",
      body: "# Goal\n\nDo not overwrite concurrent human ownership.",
      acceptanceCriteria: [],
    });
    const mutation = {
      externalId: artifact.externalId,
      assignee: "hanoon-bot",
      operationId: "interrupted-mixed-assignee-claim",
      expectedRevision: artifact.revision,
    };

    await expect(tracker.claim(mutation)).rejects.toThrow(/native assignee write/iu);
    await gateway.replaceAssigneesAsHuman(artifact.externalId, ["hanoon-bot", "human-owner"]);
    await expect(tracker.claim(mutation)).rejects.toThrow(TrackerConflictError);
    expect((await tracker.read(artifact.externalId)).assignees)
      .toEqual(["hanoon-bot", "human-owner"]);
  });

  it("preserves unrelated native assignees across claim renewal and release", async () => {
    const gateway = new MemoryGitHubGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const artifact = await tracker.create({
      operationId: "preserved-native-assignee-create",
      kind: "implementation_ticket",
      title: "Preserved native assignee",
      body: "# Goal\n\nPreserve unrelated visible ownership.",
      acceptanceCriteria: [],
    });
    await gateway.addAssignee(artifact.externalId, artifact.revision, "human-owner");
    let current = await tracker.read(artifact.externalId);
    current = await tracker.claim({
      externalId: current.externalId,
      assignee: "hanoon-bot",
      operationId: "preserved-native-assignee-claim",
      expectedRevision: current.revision,
    });
    expect([...(await gateway.readIssue(current.externalId)).assignees].sort())
      .toEqual(["hanoon-bot", "human-owner"]);
    current = await tracker.renew({
      externalId: current.externalId,
      assignee: "hanoon-bot",
      operationId: "preserved-native-assignee-renew",
      expectedRevision: current.revision,
    });
    current = await tracker.release({
      externalId: current.externalId,
      assignee: "hanoon-bot",
      operationId: "preserved-native-assignee-release",
      expectedRevision: current.revision,
    });
    expect(current.assignees).toEqual(["human-owner"]);
    expect((await gateway.readIssue(current.externalId)).assignees).toEqual(["human-owner"]);
  });

  it("does not accept an old GitHub release marker after the bot is reassigned", async () => {
    const gateway = new MemoryGitHubGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const artifact = await tracker.create({
      operationId: "reassigned-release-create",
      kind: "implementation_ticket",
      title: "Reassigned release",
      body: "# Goal\n\nDo not strand visible ownership after release replay.",
      acceptanceCriteria: [],
    });
    const claimed = await tracker.claim({
      externalId: artifact.externalId,
      assignee: "hanoon-bot",
      operationId: "reassigned-release-claim",
      expectedRevision: artifact.revision,
    });
    const releaseInput = {
      externalId: claimed.externalId,
      assignee: "hanoon-bot",
      operationId: "reassigned-release-operation",
      expectedRevision: claimed.revision,
    };
    const released = await tracker.release(releaseInput);
    expect(released.assignees).toEqual([]);
    await gateway.replaceAssigneesAsHuman(artifact.externalId, ["hanoon-bot"]);

    await expect(tracker.release(releaseInput)).rejects.toThrow(TrackerConflictError);
    expect((await tracker.read(artifact.externalId)).assignees).toEqual(["hanoon-bot"]);
  });

  it("settles an interrupted GitHub release before observation invalidates the held claim", async () => {
    const { bb } = createFakePluginHost({ pluginId: "github-release-restart" });
    const store = openStore(bb.storage, bb.storage.kv, () => 50_000);
    store.createJob({
      id: "job_github_release_restart",
      sourceUpdateId: 150_000,
      requestText: "Execute the claimed GitHub workflow step.",
      now: 49_900,
    });
    bb.storage.database().prepare(
      "UPDATE jobs SET project_id = 'proj_github_release', state = 'implementing' WHERE id = ?",
    ).run("job_github_release_restart");
    const gateway = new InterruptingReleaseGateway("github:acme/release-restart");
    const tracker = new GitHubWorkTracker(gateway);
    const lease = store.acquireExecutorLease("github-release-executor", 49_990, 1_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const fence = { ownerId: "github-release-executor", generation: lease.generation };
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => 50_000);
    const created = await coordinator.create({
      projectId: "proj_github_release",
      effortId: "effort_github_release",
      operationId: "github-release-create",
      kind: "implementation_ticket",
      status: "ready",
      title: "GitHub release restart",
      body: "# Goal\n\nSettle the visible release after restart.",
      acceptanceCriteria: [],
      relationships: [],
      ...fence,
      now: 50_000,
    });
    const claimed = await coordinator.claim({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_github_release",
      jobId: "job_github_release_restart",
      assignee: "hanoon-bot",
      operationId: "github-release-claim",
      leaseMs: 500,
      ...fence,
      now: 50_000,
    });
    if (!claimed) throw new Error("artifact was not claimed");
    const release = {
      claimId: claimed.claim.id,
      operationId: "github-release-operation",
      reason: "workflow step completed",
      ...fence,
      now: 50_000,
    };

    await expect(coordinator.release(release)).rejects.toThrow(/native assignee removal/iu);
    expect(store.getWorkArtifactClaim(claimed.claim.id)?.state).toBe("held");
    expect((await gateway.readIssue(created.artifact.externalId)).assignees).toEqual([]);
    expect((await tracker.read(created.artifact.externalId)).assignees).toEqual([]);

    expect(await coordinator.release(release)).toBe(true);
    expect(store.getWorkArtifactClaim(claimed.claim.id)).toMatchObject({
      state: "released",
      releaseReason: release.reason,
    });
  });

  it("does not settle a release from evidence observed after the assignee was restored", async () => {
    const { bb } = createFakePluginHost({ pluginId: "release-single-observation-evidence" });
    const store = openStore(bb.storage, bb.storage.kv, () => 52_000);
    store.createJob({
      id: "job_release_single_observation",
      sourceUpdateId: 152_000,
      requestText: "Execute the claimed workflow step.",
      now: 51_900,
    });
    bb.storage.database().prepare(
      "UPDATE jobs SET project_id = 'proj_release_evidence', state = 'implementing' WHERE id = ?",
    ).run("job_release_single_observation");
    const gateway = new MemoryGitHubGateway("github:acme/release-evidence");
    const tracker = new GitHubWorkTracker(gateway);
    const lease = store.acquireExecutorLease("release-evidence-executor", 51_990, 1_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const fence = { ownerId: "release-evidence-executor", generation: lease.generation };
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => 52_000);
    const created = await coordinator.create({
      projectId: "proj_release_evidence",
      effortId: "effort_release_evidence",
      operationId: "release-evidence-create",
      kind: "implementation_ticket",
      status: "ready",
      title: "Release evidence",
      body: "# Goal\n\nKeep visible and internal ownership paired.",
      acceptanceCriteria: [],
      relationships: [],
      ...fence,
      now: 52_000,
    });
    const claimed = await coordinator.claim({
      artifactId: created.artifact.id,
      workflowStepId: "workflow_release_evidence",
      jobId: "job_release_single_observation",
      assignee: "hanoon-bot",
      operationId: "release-evidence-claim",
      leaseMs: 500,
      ...fence,
      now: 52_000,
    });
    if (!claimed) throw new Error("artifact was not claimed");
    const release = {
      claimId: claimed.claim.id,
      operationId: "release-evidence-operation",
      reason: "workflow step completed",
      ...fence,
      now: 52_000,
    };
    let interrupt = true;
    const interruptedTracker = new Proxy(tracker, {
      get(target, property) {
        if (property === "release") {
          return async (input: Parameters<WorkTracker["release"]>[0]) => {
            const result = await target.release(input);
            if (interrupt) {
              interrupt = false;
              throw new Error("process stopped after final release marker");
            }
            return result;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;
    await expect(new WorkArtifactCoordinator(store, interruptedTracker, () => 52_000)
      .release(release)).rejects.toThrow(/final release marker/iu);
    expect((await tracker.read(created.artifact.externalId)).assignees).toEqual([]);
    let restored = false;
    const interleavingTracker = new Proxy(tracker, {
      get(target, property) {
        if (property === "operationStatus") {
          return async (input: Parameters<WorkTracker["operationStatus"]>[0]) => {
            if (!restored && input.operationId === release.operationId) {
              restored = true;
              await gateway.replaceAssigneesAsHuman(input.externalId, ["hanoon-bot"]);
            }
            return target.operationStatus(input);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;

    await expect(new WorkArtifactCoordinator(store, interleavingTracker, () => 52_001)
      .release({ ...release, now: 52_001 })).rejects.toThrow(TrackerConflictError);
    expect(store.getWorkArtifactClaim(claimed.claim.id)?.state).toBe("held");
    expect((await tracker.read(created.artifact.externalId)).assignees).toEqual(["hanoon-bot"]);
  });

  it("finishes an interrupted blocker replacement from its durable intent marker", async () => {
    const gateway = new InterruptingBlockersGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const firstBlocker = await tracker.create({
      operationId: "interrupted-blockers-first",
      kind: "decision_ticket",
      title: "First blocker",
      body: "# Decision\n\nResolve the first dependency.",
      acceptanceCriteria: [],
    });
    const secondBlocker = await tracker.create({
      operationId: "interrupted-blockers-second",
      kind: "decision_ticket",
      title: "Second blocker",
      body: "# Decision\n\nResolve the replacement dependency.",
      acceptanceCriteria: [],
    });
    let child = await tracker.create({
      operationId: "interrupted-blockers-child",
      kind: "implementation_ticket",
      title: "Interrupted blocker child",
      body: "# Goal\n\nReconcile partial native dependency writes.",
      acceptanceCriteria: [],
    });
    child = await tracker.setBlockers({
      externalId: child.externalId,
      blockerExternalIds: [firstBlocker.externalId],
      operationId: "interrupted-blockers-initial-set",
      expectedRevision: child.revision,
    });
    gateway.arm();
    const mutation = {
      externalId: child.externalId,
      blockerExternalIds: [secondBlocker.externalId],
      operationId: "interrupted-blockers-replacement",
      expectedRevision: child.revision,
    };

    await expect(tracker.setBlockers(mutation)).rejects.toThrow(/native blocker write/iu);
    expect((await gateway.readIssue(child.externalId)).blockerExternalIds)
      .toEqual([secondBlocker.externalId]);
    expect((await tracker.read(child.externalId)).blockerExternalIds)
      .toEqual([secondBlocker.externalId]);
    expect((await tracker.operationStatus({
      externalId: child.externalId,
      operationId: mutation.operationId,
      payloadDigest: blockersPayloadDigest(mutation.blockerExternalIds),
    })).status).toBe("pending");
    expect((await tracker.setBlockers(mutation)).blockerExternalIds)
      .toEqual([secondBlocker.externalId]);
    expect((await tracker.operationStatus({
      externalId: child.externalId,
      operationId: mutation.operationId,
      payloadDigest: blockersPayloadDigest(mutation.blockerExternalIds),
    })).status).toBe("completed");
    expect(gateway.blockerWrites).toBe(2);
  });

  it("fails closed after a blocker replacement is interrupted in a partial native state", async () => {
    const gateway = new PartiallyInterruptingBlockersGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const blockers = await Promise.all(["A", "B", "C", "D"].map((title) => tracker.create({
      operationId: `partial-blocker-${title.toLocaleLowerCase("en-US")}`,
      kind: "decision_ticket" as const,
      title: `Blocker ${title}`,
      body: `# Decision\n\nResolve blocker ${title}.`,
      acceptanceCriteria: [],
    })));
    let child = await tracker.create({
      operationId: "partial-blockers-child",
      kind: "implementation_ticket",
      title: "Partially changed blocker child",
      body: "# Goal\n\nResume a multi-edge dependency update.",
      acceptanceCriteria: [],
    });
    child = await tracker.setBlockers({
      externalId: child.externalId,
      blockerExternalIds: [blockers[0].externalId, blockers[1].externalId],
      operationId: "partial-blockers-initial",
      expectedRevision: child.revision,
    });
    gateway.arm();
    const mutation = {
      externalId: child.externalId,
      blockerExternalIds: [blockers[2].externalId, blockers[3].externalId],
      operationId: "partial-blockers-replacement",
      expectedRevision: child.revision,
    };

    await expect(tracker.setBlockers(mutation)).rejects.toThrow(/one native blocker write/iu);
    expect((await tracker.read(child.externalId)).blockerExternalIds)
      .toEqual([blockers[1].externalId]);
    await expect(tracker.setBlockers(mutation)).rejects.toThrow(TrackerConflictError);
    expect((await gateway.readIssue(child.externalId)).blockerExternalIds)
      .toEqual([blockers[1].externalId]);
  });

  it("does not record blocker completion after a concurrent human edit", async () => {
    const gateway = new HumanEditAfterBlockerWriteGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const original = await tracker.create({
      operationId: "post-write-original-blocker",
      kind: "decision_ticket",
      title: "Original blocker",
      body: "# Decision\n\nResolve the original dependency.",
      acceptanceCriteria: [],
    });
    const desired = await tracker.create({
      operationId: "post-write-desired-blocker",
      kind: "decision_ticket",
      title: "Desired blocker",
      body: "# Decision\n\nResolve the desired dependency.",
      acceptanceCriteria: [],
    });
    const human = await tracker.create({
      operationId: "post-write-human-blocker",
      kind: "decision_ticket",
      title: "Human blocker",
      body: "# Decision\n\nPreserve the collaborator dependency.",
      acceptanceCriteria: [],
    });
    let child = await tracker.create({
      operationId: "post-write-blocker-child",
      kind: "implementation_ticket",
      title: "Post-write blocker child",
      body: "# Goal\n\nDo not certify a raced dependency write.",
      acceptanceCriteria: [],
    });
    child = await tracker.setBlockers({
      externalId: child.externalId,
      blockerExternalIds: [original.externalId],
      operationId: "post-write-blocker-initial",
      expectedRevision: child.revision,
    });
    gateway.injectHumanBlocker(human.externalId);
    const operationId = "post-write-blocker-replacement";
    const mutation = {
      externalId: child.externalId,
      blockerExternalIds: [desired.externalId],
      operationId,
      expectedRevision: child.revision,
    };

    await expect(tracker.setBlockers(mutation)).rejects.toThrow(TrackerConflictError);
    expect((await tracker.operationStatus({
      externalId: child.externalId,
      operationId,
      payloadDigest: blockersPayloadDigest(mutation.blockerExternalIds),
    })).status).toBe("pending");
    expect((await tracker.read(child.externalId)).blockerExternalIds)
      .toEqual([desired.externalId, human.externalId]);
    await expect(tracker.setBlockers(mutation)).rejects.toThrow(TrackerConflictError);
  });

  it("preserves an original blocker that a human reopens during recovery", async () => {
    const gateway = new ReopenedOriginalBlockerGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const original = await tracker.create({
      operationId: "reopened-original-blocker",
      kind: "decision_ticket",
      title: "Reopened original blocker",
      body: "# Decision\n\nKeep the dependency if a collaborator reopens it.",
      acceptanceCriteria: [],
    });
    const desired = await tracker.create({
      operationId: "reopened-desired-blocker",
      kind: "decision_ticket",
      title: "Reopened desired blocker",
      body: "# Decision\n\nAdd the replacement dependency.",
      acceptanceCriteria: [],
    });
    let child = await tracker.create({
      operationId: "reopened-blocker-child",
      kind: "implementation_ticket",
      title: "Reopened blocker child",
      body: "# Goal\n\nPreserve a same-intent-union human edit.",
      acceptanceCriteria: [],
    });
    child = await tracker.setBlockers({
      externalId: child.externalId,
      blockerExternalIds: [original.externalId],
      operationId: "reopened-blocker-initial",
      expectedRevision: child.revision,
    });
    const mutation = {
      externalId: child.externalId,
      blockerExternalIds: [desired.externalId],
      operationId: "reopened-blocker-replacement",
      expectedRevision: child.revision,
    };
    gateway.arm(original.externalId);

    await expect(tracker.setBlockers(mutation)).rejects.toThrow(/before blocker completion/iu);
    await expect(tracker.setBlockers(mutation)).rejects.toThrow(TrackerConflictError);
    expect((await tracker.read(child.externalId)).blockerExternalIds)
      .toEqual([original.externalId, desired.externalId]);
  });

  it("removes only owned native blockers and preserves unrelated blockers", async () => {
    const gateway = new MemoryGitHubGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const [owned, human] = await Promise.all(["Owned", "Human"].map((title) => tracker.create({
      operationId: `preserved-blocker-${title.toLocaleLowerCase("en-US")}`,
      kind: "decision_ticket" as const,
      title: `${title} blocker`,
      body: `# Decision\n\nPreserve the ${title.toLocaleLowerCase("en-US")} edge correctly.`,
      acceptanceCriteria: [],
    })));
    let child = await tracker.create({
      operationId: "preserved-blocker-child",
      kind: "implementation_ticket",
      title: "Preserved blocker child",
      body: "# Goal\n\nKeep human dependency state intact.",
      acceptanceCriteria: [],
    });
    child = await tracker.setBlockers({
      externalId: child.externalId,
      blockerExternalIds: [owned.externalId],
      operationId: "preserved-blocker-owned-set",
      expectedRevision: child.revision,
    });
    await gateway.addBlockedBy(child.externalId, child.revision, human.externalId);
    child = await tracker.read(child.externalId);
    child = await tracker.setBlockers({
      externalId: child.externalId,
      blockerExternalIds: [],
      operationId: "preserved-blocker-owned-remove",
      expectedRevision: child.revision,
    });
    expect(child.blockerExternalIds).toEqual([human.externalId]);
    expect((await gateway.readIssue(child.externalId)).blockerExternalIds)
      .toEqual([human.externalId]);
  });

  it("preserves a human blocker edit during an interrupted replacement", async () => {
    const gateway = new InterruptingBlockersGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const first = await tracker.create({
      operationId: "human-blockers-first",
      kind: "decision_ticket",
      title: "First blocker",
      body: "# Decision\n\nResolve the original dependency.",
      acceptanceCriteria: [],
    });
    const desired = await tracker.create({
      operationId: "human-blockers-desired",
      kind: "decision_ticket",
      title: "Desired blocker",
      body: "# Decision\n\nResolve the desired dependency.",
      acceptanceCriteria: [],
    });
    const human = await tracker.create({
      operationId: "human-blockers-added",
      kind: "decision_ticket",
      title: "Human blocker",
      body: "# Decision\n\nPreserve the collaborator dependency.",
      acceptanceCriteria: [],
    });
    let child = await tracker.create({
      operationId: "human-blockers-child",
      kind: "implementation_ticket",
      title: "Conflict-aware child",
      body: "# Goal\n\nDo not overwrite a collaborator edit.",
      acceptanceCriteria: [],
    });
    child = await tracker.setBlockers({
      externalId: child.externalId,
      blockerExternalIds: [first.externalId],
      operationId: "human-blockers-initial",
      expectedRevision: child.revision,
    });
    const mutation = {
      externalId: child.externalId,
      blockerExternalIds: [desired.externalId],
      operationId: "human-blockers-replacement",
      expectedRevision: child.revision,
    };
    gateway.arm();
    await expect(tracker.setBlockers(mutation)).rejects.toThrow(/native blocker write/iu);
    await gateway.replaceBlockersAsHuman(child.externalId, [human.externalId]);

    await expect(tracker.setBlockers(mutation)).rejects.toThrow(TrackerConflictError);
    expect((await tracker.read(child.externalId)).blockerExternalIds)
      .toEqual([human.externalId]);
  });

  it("does not project completion comments over removed native relationships", async () => {
    const gateway = new MemoryGitHubGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const parent = await tracker.create({
      operationId: "removed-relationship-parent",
      kind: "specification",
      title: "Relationship parent",
      body: "# Scope\n\nOwn the child.",
      acceptanceCriteria: [],
    });
    const blocker = await tracker.create({
      operationId: "removed-relationship-blocker",
      kind: "decision_ticket",
      title: "Relationship blocker",
      body: "# Decision\n\nBlock the child.",
      acceptanceCriteria: [],
    });
    let child = await tracker.create({
      operationId: "removed-relationship-child",
      kind: "implementation_ticket",
      title: "Relationship child",
      body: "# Goal\n\nReject stale relationship completion markers.",
      acceptanceCriteria: [],
    });
    const parentMutation = {
      externalId: child.externalId,
      parentExternalId: parent.externalId,
      operationId: "removed-relationship-set-parent",
      expectedRevision: child.revision,
    };
    child = await tracker.setParent(parentMutation);
    const blockerMutation = {
      externalId: child.externalId,
      blockerExternalIds: [blocker.externalId],
      operationId: "removed-relationship-set-blocker",
      expectedRevision: child.revision,
    };
    child = await tracker.setBlockers(blockerMutation);
    await gateway.replaceParentAsHuman(child.externalId, null);
    await gateway.replaceBlockersAsHuman(child.externalId, []);

    await expect(tracker.setParent(parentMutation)).rejects.toThrow(TrackerConflictError);
    await expect(tracker.setBlockers(blockerMutation)).rejects.toThrow(TrackerConflictError);
    expect((await tracker.read(child.externalId))).toMatchObject({
      parentExternalId: null,
      blockerExternalIds: [],
    });
  });

  it("reports a conflicting native parent and rejects replay of the old parent intent", async () => {
    const gateway = new MemoryGitHubGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const firstParent = await tracker.create({
      operationId: "conflicting-parent-first",
      kind: "specification",
      title: "First parent",
      body: "# Scope\n\nOwn the child through the tracker projection.",
      acceptanceCriteria: [],
    });
    const humanParent = await tracker.create({
      operationId: "conflicting-parent-human",
      kind: "specification",
      title: "Human parent",
      body: "# Scope\n\nRemain native and untouched.",
      acceptanceCriteria: [],
    });
    const child = await tracker.create({
      operationId: "conflicting-parent-child",
      kind: "implementation_ticket",
      title: "Conflicting parent child",
      body: "# Goal\n\nFail closed on incompatible ownership.",
      acceptanceCriteria: [],
    });
    await tracker.setParent({
      externalId: child.externalId,
      parentExternalId: firstParent.externalId,
      operationId: "conflicting-parent-set",
      expectedRevision: child.revision,
    });
    await gateway.replaceParentAsHuman(child.externalId, humanParent.externalId);

    expect((await tracker.read(child.externalId)).parentExternalId).toBe(humanParent.externalId);
    await expect(tracker.setParent({
      externalId: child.externalId,
      parentExternalId: firstParent.externalId,
      operationId: "conflicting-parent-set",
      expectedRevision: child.revision,
    })).rejects.toThrow(TrackerConflictError);
    expect((await gateway.readIssue(child.externalId)).parentExternalId).toBe(humanParent.externalId);
  });

  it("does not overwrite a collaborator reopen after GitHub terminal completion", async () => {
    const gateway = new MemoryGitHubGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const resolved = await tracker.create({
      operationId: "terminal-reopen-resolved-create",
      kind: "implementation_ticket",
      title: "Resolved then reopened",
      body: "# Goal\n\nKeep a collaborator reopen authoritative.",
      acceptanceCriteria: [],
    });
    const resolution = {
      externalId: resolved.externalId,
      resolution: "The accepted snapshot passed.",
      operationId: "terminal-reopen-resolve",
      expectedRevision: resolved.revision,
    };
    expect((await tracker.resolve(resolution)).state).toBe("closed");
    await gateway.reopenAsHuman(resolved.externalId);
    await expect(tracker.resolve(resolution)).rejects.toThrow(TrackerConflictError);
    expect((await tracker.read(resolved.externalId)).state).toBe("open");

    const cancelled = await tracker.create({
      operationId: "terminal-reopen-cancelled-create",
      kind: "decision_ticket",
      title: "Cancelled then reopened",
      body: "# Decision\n\nKeep a reopened cancellation authoritative.",
      acceptanceCriteria: [],
    });
    const cancellation = {
      externalId: cancelled.externalId,
      reason: "The decision was superseded.",
      operationId: "terminal-reopen-cancel",
      expectedRevision: cancelled.revision,
    };
    expect((await tracker.cancel(cancellation)).state).toBe("cancelled");
    await gateway.reopenAsHuman(cancelled.externalId);
    await expect(tracker.cancel(cancellation)).rejects.toThrow(TrackerConflictError);
    expect((await tracker.read(cancelled.externalId)).state).toBe("open");
  });

  it("records evidence-backed GitHub settlement after a matching manual close", async () => {
    const gateway = new MemoryGitHubGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const resolved = await tracker.create({
      operationId: "manual-resolved-create",
      kind: "implementation_ticket",
      title: "Manually resolved",
      body: "# Goal\n\nReconcile a matching manual close.",
      acceptanceCriteria: [],
    });
    const manuallyResolved = await gateway.closeIssue(
      resolved.externalId,
      resolved.revision,
      "completed",
    );
    const settledResolution = await tracker.resolve({
      externalId: resolved.externalId,
      resolution: "Durable evidence proves the accepted snapshot.",
      operationId: "manual-resolved-settlement",
      expectedRevision: manuallyResolved.revision,
    });
    expect(settledResolution.state).toBe("closed");
    expect((await tracker.operationStatus({
      externalId: resolved.externalId,
      operationId: "manual-resolved-settlement",
      payloadDigest: terminalPayloadDigest(
        "resolved",
        "Durable evidence proves the accepted snapshot.",
      ),
    })).status).toBe("completed");

    const cancelled = await tracker.create({
      operationId: "manual-cancelled-create",
      kind: "decision_ticket",
      title: "Manually cancelled",
      body: "# Decision\n\nReconcile a matching manual cancellation.",
      acceptanceCriteria: [],
    });
    const manuallyCancelled = await gateway.closeIssue(
      cancelled.externalId,
      cancelled.revision,
      "not_planned",
    );
    expect((await tracker.cancel({
      externalId: cancelled.externalId,
      reason: "Durable evidence records the cancellation.",
      operationId: "manual-cancelled-settlement",
      expectedRevision: manuallyCancelled.revision,
    })).state).toBe("cancelled");
  });

  it("rejects multiline acceptance criteria before creating tracker artifacts", async () => {
    const gateway = new MemoryGitHubGateway();
    const github = new GitHubWorkTracker(gateway);
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-multiline-criteria-"));
    temporaryDirectories.push(directory);
    const local = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "workflow-refactor",
    });
    const input = {
      operationId: "multiline-acceptance",
      kind: "implementation_ticket" as const,
      title: "Invalid checklist",
      body: "# Goal\n\nReject ambiguous checklist rendering.",
      acceptanceCriteria: ["First line\nSecond line"],
    };

    await expect(github.create(input)).rejects.toThrow(/one checklist item per value/iu);
    await expect(local.create(input)).rejects.toThrow(/one checklist item per value/iu);
    expect(gateway.allIssues()).toHaveLength(0);
    expect(await local.reconcile({ operationId: input.operationId })).toBeNull();
  });

  it("rejects oversized or marker-injected local files before publication", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-write-bound-"));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "write-bound",
    });
    await expect(tracker.create({
      operationId: "oversized-local-create",
      kind: "implementation_ticket",
      title: "Oversized local artifact",
      body: `# Goal\n\n${"x".repeat(1_048_500)}`,
      acceptanceCriteria: [],
    })).rejects.toThrow(/1048576 byte limit/iu);
    expect(await tracker.reconcile({ operationId: "oversized-local-create" })).toBeNull();
    await expect(tracker.create({
      operationId: "marker-injected-local-create",
      kind: "implementation_ticket",
      title: "Marker-injected local artifact",
      body: "# Goal\n\n<!-- hanoon:operation:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->",
      acceptanceCriteria: [],
    })).rejects.toThrow(/reserved tracker markers/iu);

    const artifact = await tracker.create({
      operationId: "bounded-local-create",
      kind: "implementation_ticket",
      title: "Bounded local artifact",
      body: `# Goal\n\n${"y".repeat(990_000)}`,
      acceptanceCriteria: [],
    });
    await expect(tracker.comment({
      externalId: artifact.externalId,
      comment: "z".repeat(65_536),
      operationId: "oversized-local-comment",
      expectedRevision: artifact.revision,
    })).rejects.toThrow(/1048576 byte limit/iu);
    expect((await tracker.read(artifact.externalId)).revision).toBe(artifact.revision);
    await expect(tracker.comment({
      externalId: artifact.externalId,
      comment: "<!-- hanoon:comment:end -->",
      operationId: "marker-injected-local-comment",
      expectedRevision: artifact.revision,
    })).rejects.toThrow(/reserved tracker markers/iu);
  });

  it("reads the current visible GitHub acceptance checklist", async () => {
    const gateway = new MemoryGitHubGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const artifact = await tracker.create({
      operationId: "editable-github-criteria",
      kind: "implementation_ticket",
      title: "Editable acceptance",
      body: "# Goal\n\nKeep the typed requirements current.",
      acceptanceCriteria: ["The original check passes"],
    });
    const edited = (await gateway.readIssue(artifact.externalId)).body
      .replace("- [ ] The original check passes", "- [x] The revised check passes\n- [ ] A new check passes");
    await gateway.replaceBodyAsHuman(artifact.externalId, edited);

    expect((await tracker.read(artifact.externalId)).acceptanceCriteria).toEqual([
      "The revised check passes",
      "A new check passes",
    ]);
  });

  it("reads the current visible local acceptance checklist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-criteria-"));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "workflow-refactor",
    });
    const artifact = await tracker.create({
      operationId: "editable-local-criteria",
      kind: "implementation_ticket",
      title: "Editable acceptance",
      body: "# Goal\n\nKeep the typed requirements current.",
      acceptanceCriteria: ["The original check passes"],
    });
    const path = join(directory, artifact.externalId);
    const edited = (await readFile(path, "utf8"))
      .replace("- [ ] The original check passes", "- [x] The revised check passes\n- [ ] A new check passes");
    await writeFile(path, edited, "utf8");

    expect((await tracker.read(artifact.externalId)).acceptanceCriteria).toEqual([
      "The revised check passes",
      "A new check passes",
    ]);
  });

  it.each(["read", "mutation", "relationship", "restart"] as const)(
    "rejects a one-digit local issue alias during %s",
    async (path) => {
      const directory = await mkdtemp(join(tmpdir(), `local-work-tracker-alias-${path}-`));
      temporaryDirectories.push(directory);
      const options = { repositoryRoot: directory, effortSlug: "canonical-identity" };
      const tracker = new LocalMarkdownWorkTracker(options);
      const artifact = await tracker.create({
        operationId: `canonical-local-${path}`,
        kind: "implementation_ticket",
        title: "Canonical local identity",
        body: "# Goal\n\nKeep one identity per local issue number.",
        acceptanceCriteria: [],
      });
      expect(artifact.externalId).toContain("/issues/01-");
      const alias = artifact.externalId.replace("/issues/01-", "/issues/1-");
      const canonicalPath = join(directory, artifact.externalId);
      const aliasPath = join(directory, alias);
      await writeFile(aliasPath, await readFile(canonicalPath, "utf8"), "utf8");

      if (path === "read") {
        await expect(tracker.read(alias)).rejects.toThrow(/canonical local artifact ID/iu);
      } else if (path === "mutation") {
        await expect(tracker.comment({
          externalId: alias,
          operationId: "reject-alias-mutation",
          expectedRevision: artifact.revision,
          comment: "This alias must never be mutated.",
        })).rejects.toThrow(/canonical local artifact ID/iu);
      } else if (path === "relationship") {
        await writeFile(
          canonicalPath,
          (await readFile(canonicalPath, "utf8")).replace("Parent: none", `Parent: ${alias}`),
          "utf8",
        );
        await expect(tracker.read(artifact.externalId))
          .rejects.toThrow(/canonical local artifact ID/iu);
      } else {
        await unlink(canonicalPath);
        const restarted = new LocalMarkdownWorkTracker(options);
        await expect(restarted.reconcile({ operationId: artifact.operationId }))
          .rejects.toThrow(/canonical local artifact ID/iu);
      }
    },
  );

  it.each([
    "0-invalid.md",
    "00-invalid.md",
    "001-invalid.md",
    "9007199254740992-invalid.md",
  ] as const)("rejects issue-shaped noncanonical identity %s during scans and allocation", async (fileName) => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-invalid-number-"));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "invalid-number",
    });
    await tracker.create({
      operationId: `invalid-number-seed-${fileName}`,
      kind: "implementation_ticket",
      title: "Valid seed",
      body: "# Goal\n\nSeed the issue directory.",
      acceptanceCriteria: [],
    });
    const issuesRoot = join(directory, ".scratch", "invalid-number", "issues");
    await writeFile(join(issuesRoot, fileName), "invalid identity", "utf8");
    const before = await readdir(issuesRoot);

    await expect(tracker.reconcile({ operationId: "missing-operation" }))
      .rejects.toThrow(/canonical local artifact ID/iu);
    await expect(tracker.create({
      operationId: `invalid-number-allocation-${fileName}`,
      kind: "implementation_ticket",
      title: "Blocked allocation",
      body: "# Goal\n\nDo not allocate around an invalid identity.",
      acceptanceCriteria: [],
    })).rejects.toThrow(/canonical local artifact ID/iu);
    expect(await readdir(issuesRoot)).toEqual(before);
  });

  it.each([
    "0-restarted.md",
    "00-restarted.md",
    "001-restarted.md",
    "9007199254740992-restarted.md",
  ] as const)("rejects marker-bearing noncanonical identity %s after restart", async (fileName) => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-invalid-restart-"));
    temporaryDirectories.push(directory);
    const options = { repositoryRoot: directory, effortSlug: "invalid-restart" };
    const tracker = new LocalMarkdownWorkTracker(options);
    const artifact = await tracker.create({
      operationId: `invalid-restart-${fileName}`,
      kind: "implementation_ticket",
      title: "Restart identity",
      body: "# Goal\n\nPreserve the marker through restart validation.",
      acceptanceCriteria: [],
    });
    const canonicalPath = join(directory, artifact.externalId);
    const issuesRoot = join(directory, ".scratch", "invalid-restart", "issues");
    await rename(canonicalPath, join(issuesRoot, fileName));
    const restarted = new LocalMarkdownWorkTracker(options);
    const before = await readdir(issuesRoot);

    await expect(restarted.reconcile({ operationId: artifact.operationId }))
      .rejects.toThrow(/canonical local artifact ID/iu);
    await expect(restarted.create({
      operationId: artifact.operationId,
      kind: artifact.kind,
      title: artifact.title,
      body: artifact.body,
      acceptanceCriteria: artifact.acceptanceCriteria,
    })).rejects.toThrow(/canonical local artifact ID/iu);
    expect(await readdir(issuesRoot)).toEqual(before);
  });

  it("rejects duplicate local issue numbers independently of slug", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-duplicate-number-"));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "duplicate-number",
    });
    const first = await tracker.create({
      operationId: "duplicate-number-first",
      kind: "implementation_ticket",
      title: "First numeric identity",
      body: "# Goal\n\nOwn issue number one.",
      acceptanceCriteria: [],
    });
    const second = await tracker.create({
      operationId: "duplicate-number-second",
      kind: "implementation_ticket",
      title: "Second numeric identity",
      body: "# Goal\n\nOwn issue number two.",
      acceptanceCriteria: [],
    });
    await rename(
      join(directory, second.externalId),
      join(directory, second.externalId.replace("/issues/02-", "/issues/01-")),
    );

    await expect(tracker.reconcile({ operationId: first.operationId }))
      .rejects.toThrow(/duplicate local issue number|canonical local artifact ID/iu);
  });

  it("rejects allocation beyond the maximum safe local issue number before writing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-maximum-number-"));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "maximum-number",
    });
    const artifact = await tracker.create({
      operationId: "maximum-number-seed",
      kind: "implementation_ticket",
      title: "Maximum number seed",
      body: "# Goal\n\nReach the safe integer boundary.",
      acceptanceCriteria: [],
    });
    const issuesRoot = join(directory, ".scratch", "maximum-number", "issues");
    await rename(
      join(directory, artifact.externalId),
      join(issuesRoot, "9007199254740991-maximum-number-seed.md"),
    );
    const before = await readdir(issuesRoot);

    await expect(tracker.create({
      operationId: "maximum-number-overflow",
      kind: "implementation_ticket",
      title: "Unsafe allocation",
      body: "# Goal\n\nReject the unsafe next number.",
      acceptanceCriteria: [],
    })).rejects.toThrow(/safe local issue number|canonical local artifact ID/iu);
    expect(await readdir(issuesRoot)).toEqual(before);
  });

  it("rejects replaced tracker identity markers on reads and effect results", async () => {
    const { bb } = createFakePluginHost({ pluginId: "tracker-identity-revalidation" });
    const store = openStore(bb.storage, bb.storage.kv, () => 40_000);
    const gateway = new MemoryGitHubGateway();
    const tracker = new GitHubWorkTracker(gateway);
    const lease = store.acquireExecutorLease("identity-executor", 40_000, 1_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const fence = { ownerId: "identity-executor", generation: lease.generation };
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => 40_000);
    const create = (operationId: string, title: string) => coordinator.create({
      projectId: "proj_identity",
      effortId: "effort_identity",
      operationId,
      kind: "implementation_ticket" as const,
      status: "ready" as const,
      title,
      body: "# Goal\n\nKeep the durable tracker identity stable.",
      acceptanceCriteria: [] as readonly string[],
      relationships: [] as const,
      ...fence,
      now: 40_000,
    });
    const first = await create("identity-first", "First identity");
    const second = await create("identity-second", "Second identity");
    const secondBody = (await gateway.readIssue(second.artifact.externalId)).body;
    const secondMarker = secondBody.match(/<!-- hanoon:artifact:[A-Za-z0-9_-]+ -->/u)?.[0];
    if (!secondMarker) throw new Error("second GitHub artifact marker was not found");
    const firstBody = (await gateway.readIssue(first.artifact.externalId)).body;
    await gateway.replaceBodyAsHuman(first.artifact.externalId, `${firstBody}\n${secondMarker}`);
    await expect(coordinator.observe({
      artifactId: first.artifact.id,
      ...fence,
      now: 40_001,
    })).rejects.toThrow(TrackerIdentityConflictError);
    await gateway.replaceBodyAsHuman(first.artifact.externalId, secondBody);
    await expect(coordinator.observe({
      artifactId: first.artifact.id,
      ...fence,
      now: 40_002,
    })).rejects.toThrow(TrackerConflictError);

    const parent = await create("identity-effect-parent", "Effect parent");
    const effectTracker = new Proxy(tracker, {
      get(target, property, receiver) {
        if (property === "setParent") {
          return async (input: Parameters<WorkTracker["setParent"]>[0]) => {
            const result = await target.setParent(input);
            return { ...result, operationId: "replaced-valid-operation-id" };
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as WorkTracker;
    const effectCoordinator = new WorkArtifactCoordinator(store, effectTracker, () => 40_000);
    const childId = stableWorkArtifactId("proj_identity", "identity-effect-child");
    await expect(effectCoordinator.create({
      projectId: "proj_identity",
      effortId: "effort_identity",
      operationId: "identity-effect-child",
      kind: "implementation_ticket",
      status: "ready",
      title: "Effect child",
      body: "# Goal\n\nReject a mismatched effect result.",
      acceptanceCriteria: [],
      relationships: [{
        kind: "parent",
        sourceArtifactId: childId,
        sourceRef: `artifact:${childId}`,
        targetArtifactId: parent.artifact.id,
        targetRef: `artifact:${parent.artifact.id}`,
      }],
      ...fence,
      now: 40_003,
    })).rejects.toThrow(TrackerConflictError);
    expect(store.getWorkArtifact(childId)).toBeNull();
  });

  it("rejects a replaced local tracker identity marker during observation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-identity-revalidation-"));
    temporaryDirectories.push(directory);
    const { bb } = createFakePluginHost({ pluginId: "local-identity-revalidation" });
    const store = openStore(bb.storage, bb.storage.kv, () => 50_000);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "identity-revalidation",
    });
    const lease = store.acquireExecutorLease("local-identity-executor", 50_000, 1_000);
    if (!lease.acquired) throw new Error("executor lease was not acquired");
    const fence = { ownerId: "local-identity-executor", generation: lease.generation };
    const coordinator = new WorkArtifactCoordinator(store, tracker, () => 50_000);
    const create = (operationId: string, title: string) => coordinator.create({
      projectId: "proj_local_identity",
      effortId: "effort_local_identity",
      operationId,
      kind: "implementation_ticket" as const,
      status: "ready" as const,
      title,
      body: "# Goal\n\nKeep the local marker stable.",
      acceptanceCriteria: [] as readonly string[],
      relationships: [] as const,
      ...fence,
      now: 50_000,
    });
    const first = await create("local-identity-first", "Local first identity");
    const second = await create("local-identity-second", "Local second identity");
    const firstPath = join(directory, first.artifact.externalId);
    const secondRaw = await readFile(join(directory, second.artifact.externalId), "utf8");
    const replacement = secondRaw.match(/<!-- hanoon:artifact:[A-Za-z0-9_-]+ -->/u)?.[0];
    if (!replacement) throw new Error("replacement artifact marker was not found");
    await writeFile(
      firstPath,
      (await readFile(firstPath, "utf8"))
        .replace(/<!-- hanoon:artifact:[A-Za-z0-9_-]+ -->/u, replacement),
      "utf8",
    );
    await expect(coordinator.observe({
      artifactId: first.artifact.id,
      ...fence,
      now: 50_001,
    })).rejects.toThrow(TrackerConflictError);
  });

  it("preserves a concurrent human edit in local Markdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-conflict-"));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "workflow-refactor",
    });
    const artifact = await tracker.create({
      operationId: "create-human-edit",
      kind: "specification",
      title: "Human editable specification",
      body: "# Scope\n\nKeep collaboration edits.",
      acceptanceCriteria: ["Concurrent edits fail closed"],
    });
    const path = join(directory, artifact.externalId);
    await writeFile(path, `${await readFile(path, "utf8")}\nHuman-owned note.\n`, "utf8");

    await expect(tracker.updateOwnedSection({
      externalId: artifact.externalId,
      sectionId: "agent-notes",
      content: "This stale update must not land.",
      operationId: "stale-after-human-edit",
      expectedRevision: artifact.revision,
    })).rejects.toThrow(TrackerConflictError);
    expect(await readFile(path, "utf8")).toContain("Human-owned note.");
  });

  it("rejects a local relationship replay after a collaborator removes the completed edges", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-relationship-replay-"));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "workflow-refactor",
    });
    const parent = await tracker.create({
      operationId: "local-replay-parent",
      kind: "specification",
      title: "Local replay parent",
      body: "# Scope\n\nOwn the child.",
      acceptanceCriteria: [],
    });
    const blocker = await tracker.create({
      operationId: "local-replay-blocker",
      kind: "decision_ticket",
      title: "Local replay blocker",
      body: "# Decision\n\nBlock the child.",
      acceptanceCriteria: [],
    });
    let child = await tracker.create({
      operationId: "local-replay-child",
      kind: "implementation_ticket",
      title: "Local replay child",
      body: "# Goal\n\nReject stale relationship markers.",
      acceptanceCriteria: [],
    });
    const parentMutation = {
      externalId: child.externalId,
      parentExternalId: parent.externalId,
      operationId: "local-replay-set-parent",
      expectedRevision: child.revision,
    };
    child = await tracker.setParent(parentMutation);
    const blockerMutation = {
      externalId: child.externalId,
      blockerExternalIds: [blocker.externalId],
      operationId: "local-replay-set-blocker",
      expectedRevision: child.revision,
    };
    child = await tracker.setBlockers(blockerMutation);
    const path = join(directory, child.externalId);
    const edited = (await readFile(path, "utf8"))
      .replace(`Parent: ${parent.externalId}`, "Parent: none")
      .replace(`Blocked by: ${blocker.externalId}`, "Blocked by: none");
    await writeFile(path, edited, "utf8");

    await expect(tracker.setParent(parentMutation)).rejects.toThrow(TrackerConflictError);
    await expect(tracker.setBlockers(blockerMutation)).rejects.toThrow(TrackerConflictError);
  });

  it("preserves a collaborator's local terminal status while releasing the bot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-terminal-release-"));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "workflow-refactor",
    });
    const created = await tracker.create({
      operationId: "local-terminal-release-create",
      kind: "implementation_ticket",
      title: "Local terminal release",
      body: "# Goal\n\nDo not reopen a collaborator's closure.",
      acceptanceCriteria: [],
    });
    const claimInput = {
      externalId: created.externalId,
      assignee: "hanoon-bot",
      operationId: "local-terminal-release-claim",
      expectedRevision: created.revision,
    };
    const claimed = await tracker.claim(claimInput);
    const path = join(directory, claimed.externalId);
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("Status: claimed", "Status: resolved"),
      "utf8",
    );
    const closed = await tracker.read(claimed.externalId);

    await expect(tracker.claim(claimInput)).rejects.toThrow(TrackerConflictError);
    const released = await tracker.release({
      externalId: closed.externalId,
      assignee: "hanoon-bot",
      operationId: "local-terminal-release-bot",
      expectedRevision: closed.revision,
    });
    expect(released.state).toBe("closed");
    expect(released.assignees).toEqual([]);
    expect(await readFile(path, "utf8")).toContain("Status: resolved");
  });

  it("verifies completed local terminal replay after manual reopen or opposite edit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-terminal-replay-"));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "terminal-replay",
    });
    const resolved = await tracker.create({
      operationId: "local-terminal-replay-resolved-create",
      kind: "implementation_ticket",
      title: "Resolved replay",
      body: "# Goal\n\nReject a manual reopen after completion.",
      acceptanceCriteria: [],
    });
    const resolution = {
      externalId: resolved.externalId,
      resolution: "The resolved path passed.",
      operationId: "local-terminal-replay-resolve",
      expectedRevision: resolved.revision,
    };
    const closed = await tracker.resolve(resolution);
    const resolvedPath = join(directory, resolved.externalId);
    await writeFile(
      resolvedPath,
      (await readFile(resolvedPath, "utf8")).replace("Status: resolved", "Status: ready"),
      "utf8",
    );
    await expect(tracker.resolve({ ...resolution, expectedRevision: closed.revision }))
      .rejects.toThrow(TrackerConflictError);

    const cancelled = await tracker.create({
      operationId: "local-terminal-replay-cancelled-create",
      kind: "implementation_ticket",
      title: "Cancelled replay",
      body: "# Goal\n\nReject an opposite edit after cancellation.",
      acceptanceCriteria: [],
    });
    const cancellation = {
      externalId: cancelled.externalId,
      reason: "The cancelled path is not planned.",
      operationId: "local-terminal-replay-cancel",
      expectedRevision: cancelled.revision,
    };
    const stopped = await tracker.cancel(cancellation);
    const cancelledPath = join(directory, cancelled.externalId);
    await writeFile(
      cancelledPath,
      (await readFile(cancelledPath, "utf8"))
        .replace("Status: cancelled", "Status: resolved"),
      "utf8",
    );
    await expect(tracker.cancel({ ...cancellation, expectedRevision: stopped.revision }))
      .rejects.toThrow(TrackerConflictError);
  });

  it("lets only one local writer commit from the same observed revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-writer-race-"));
    temporaryDirectories.push(directory);
    const first = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "workflow-refactor",
    });
    const second = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "workflow-refactor",
    });
    const artifact = await first.create({
      operationId: "create-writer-race",
      kind: "specification",
      title: "Single writer specification",
      body: "# Scope\n\nKeep one compare-and-swap winner.",
      acceptanceCriteria: [],
    });

    const settled = await Promise.allSettled([
      first.updateOwnedSection({
        externalId: artifact.externalId,
        sectionId: "writer-a",
        content: "Writer A landed.",
        operationId: "writer-a-operation",
        expectedRevision: artifact.revision,
      }),
      second.updateOwnedSection({
        externalId: artifact.externalId,
        sectionId: "writer-b",
        content: "Writer B landed.",
        operationId: "writer-b-operation",
        expectedRevision: artifact.revision,
      }),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    const body = (await first.read(artifact.externalId)).body;
    expect(Number(body.includes("Writer A landed.")) + Number(body.includes("Writer B landed."))).toBe(1);
  });

  it("lets only one independent local process commit from the same digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-process-race-"));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "workflow-refactor",
    });
    const artifact = await tracker.create({
      operationId: "create-process-race",
      kind: "specification",
      title: "Cross process specification",
      body: "# Scope\n\nKeep one filesystem compare-and-swap winner.",
      acceptanceCriteria: [],
    });
    const path = join(directory, artifact.externalId);
    const original = await readFile(path, "utf8");
    const results = await Promise.all([
      runCasProcess({
        path,
        expectedDigest: artifact.revision,
        content: `${original}\n\nWriter process A landed.`,
      }),
      runCasProcess({
        path,
        expectedDigest: artifact.revision,
        content: `${original}\n\nWriter process B landed.`,
      }),
    ]);

    expect(results.sort()).toEqual([0, 17]);
    const body = await readFile(path, "utf8");
    expect(Number(body.includes("process A landed")) + Number(body.includes("process B landed")))
      .toBe(1);
  });

  it("recovers a captured local artifact after the writer process dies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-recovery-"));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "workflow-refactor",
    });
    const artifact = await tracker.create({
      operationId: "create-recovery-artifact",
      kind: "specification",
      title: "Recoverable specification",
      body: "# Scope\n\nRestore the captured file after a crash.",
      acceptanceCriteria: [],
    });
    const path = join(directory, artifact.externalId);
    const token = "10000000-0000-4000-8000-000000000001";
    const previous = `${path}.hanoon-${token}.previous`;
    await rename(path, previous);
    await writeFile(`${path}.hanoon-cas-lock`, JSON.stringify({
      pid: 2_147_483_647,
      processIdentity: "2147483647:dead",
      token,
      expectedDigest: artifact.revision,
      createdAt: Date.now(),
    }), { mode: 0o600 });

    expect((await tracker.read(artifact.externalId)).revision).toBe(artifact.revision);
    expect(await readFile(path, "utf8")).toContain("Restore the captured file after a crash.");
  });

  it("recovers a CAS lock whose PID was reused by another process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-pid-reuse-"));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "workflow-refactor",
    });
    const artifact = await tracker.create({
      operationId: "create-pid-reuse-artifact",
      kind: "specification",
      title: "PID reuse specification",
      body: "# Scope\n\nRecover by process identity, not PID alone.",
      acceptanceCriteria: [],
    });
    const path = join(directory, artifact.externalId);
    const token = "20000000-0000-4000-8000-000000000002";
    await rename(path, `${path}.hanoon-${token}.previous`);
    await writeFile(`${path}.hanoon-cas-lock`, JSON.stringify({
      pid: process.pid,
      processIdentity: `${process.pid}:0`,
      token,
      expectedDigest: artifact.revision,
      createdAt: Date.now(),
    }), { mode: 0o600 });

    expect((await tracker.read(artifact.externalId)).revision).toBe(artifact.revision);
  });

  it("rejects a symlinked tracker directory before touching its target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-symlink-root-"));
    const outside = await mkdtemp(join(tmpdir(), "local-work-tracker-symlink-target-"));
    temporaryDirectories.push(directory, outside);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "workflow-refactor",
    });
    const artifact = await tracker.create({
      operationId: "create-symlink-containment-artifact",
      kind: "implementation_ticket",
      title: "Contained artifact",
      body: "# Goal\n\nNever write through a replaced directory.",
      acceptanceCriteria: [],
    });
    const issuesRoot = join(directory, ".scratch", "workflow-refactor", "issues");
    await rename(issuesRoot, `${issuesRoot}.captured`);
    const outsideArtifact = join(outside, artifact.externalId.split("/").at(-1) ?? "artifact.md");
    await writeFile(outsideArtifact, "outside sentinel", "utf8");
    await symlink(outside, issuesRoot, "dir");

    await expect(tracker.comment({
      externalId: artifact.externalId,
      operationId: "symlink-containment-comment",
      expectedRevision: artifact.revision,
      comment: "This must not land outside the repository.",
    })).rejects.toThrow(/not a regular directory/iu);
    expect(await readFile(outsideArtifact, "utf8")).toBe("outside sentinel");
  });

  it("keeps a local mutation in its captured directory when the path is swapped", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-directory-race-"));
    const outside = await mkdtemp(join(tmpdir(), "local-work-tracker-directory-race-target-"));
    temporaryDirectories.push(directory, outside);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "workflow-refactor",
    });
    const artifact = await tracker.create({
      operationId: "directory-race-artifact",
      kind: "implementation_ticket",
      title: "Directory race artifact",
      body: "# Goal\n\nKeep the write attached to its opened directory.",
      acceptanceCriteria: [],
    });
    const path = join(directory, artifact.externalId);
    const issuesRoot = join(directory, ".scratch", "workflow-refactor", "issues");
    const capturedRoot = `${issuesRoot}.captured`;
    const fileName = artifact.externalId.split("/").at(-1) ?? "artifact.md";
    const outsideArtifact = join(outside, fileName);
    await writeFile(outsideArtifact, "outside sentinel", "utf8");
    const original = await readFile(path, "utf8");
    const replacement = `${original}\n\n${"x".repeat(900_000 - original.length)}`;
    const mutation = compareAndSwapLocalFile(path, artifact.revision, replacement);
    let lockObserved = false;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const entries = await readdir(issuesRoot);
      if (entries.some((name) => name.endsWith(".hanoon-cas-lock"))) {
        lockObserved = true;
        break;
      }
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    }
    expect(lockObserved).toBe(true);
    await rename(issuesRoot, capturedRoot);
    await symlink(outside, issuesRoot, "dir");
    await mutation;

    expect(await readFile(join(capturedRoot, fileName), "utf8")).toBe(replacement);
    expect(await readFile(outsideArtifact, "utf8")).toBe("outside sentinel");
  });

  it("rejects a CAS parent redirected outside its captured repository root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-containment-race-"));
    const outside = await mkdtemp(join(tmpdir(), "local-work-tracker-containment-target-"));
    temporaryDirectories.push(directory, outside);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "workflow-refactor",
    });
    const artifact = await tracker.create({
      operationId: "containment-race-artifact",
      kind: "implementation_ticket",
      title: "Containment race artifact",
      body: "# Goal\n\nReject a parent redirected after validation.",
      acceptanceCriteria: [],
    });
    const repositoryStats = await lstat(directory);
    const containment = { root: directory, dev: repositoryStats.dev, ino: repositoryStats.ino };
    const scratchRoot = join(directory, ".scratch");
    const capturedScratchRoot = `${scratchRoot}.captured`;
    const outsideIssues = join(outside, "workflow-refactor", "issues");
    await mkdir(outsideIssues, { recursive: true });
    const fileName = artifact.externalId.split("/").at(-1) ?? "artifact.md";
    const outsideArtifact = join(outsideIssues, fileName);
    await writeFile(outsideArtifact, "outside sentinel", "utf8");
    await rename(scratchRoot, capturedScratchRoot);
    await symlink(outside, scratchRoot, "dir");

    await expect(compareAndSwapLocalFile(
      join(directory, artifact.externalId),
      artifact.revision,
      "redirected write",
      containment,
    )).rejects.toThrow(/escaped containment/iu);
    expect(await readFile(outsideArtifact, "utf8")).toBe("outside sentinel");
    expect(await readFile(join(capturedScratchRoot, "workflow-refactor", "issues", fileName), "utf8"))
      .toContain("Reject a parent redirected after validation.");
  });

  it("fails closed when a local blocker disappears from the tracker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "local-work-tracker-missing-blocker-"));
    temporaryDirectories.push(directory);
    const tracker = new LocalMarkdownWorkTracker({
      repositoryRoot: directory,
      effortSlug: "workflow-refactor",
    });
    const parent = await tracker.create({
      operationId: "missing-blocker-parent",
      kind: "specification",
      title: "Parent",
      body: "# Scope\n\nKeep missing dependencies blocked.",
      acceptanceCriteria: [],
    });
    const blocker = await tracker.create({
      operationId: "missing-blocker-source",
      kind: "decision_ticket",
      title: "Blocker",
      body: "# Decision\n\nChoose a path.",
      acceptanceCriteria: [],
    });
    let child = await tracker.create({
      operationId: "missing-blocker-child",
      kind: "implementation_ticket",
      title: "Child",
      body: "# Goal\n\nWait for the dependency.",
      acceptanceCriteria: [],
    });
    child = await tracker.setParent({
      externalId: child.externalId,
      parentExternalId: parent.externalId,
      operationId: "missing-blocker-set-parent",
      expectedRevision: child.revision,
    });
    await tracker.setBlockers({
      externalId: child.externalId,
      blockerExternalIds: [blocker.externalId],
      operationId: "missing-blocker-set-blocker",
      expectedRevision: child.revision,
    });
    await unlink(join(directory, blocker.externalId));

    expect(await tracker.frontier({ parentExternalId: parent.externalId })).toEqual([]);
  });
});
