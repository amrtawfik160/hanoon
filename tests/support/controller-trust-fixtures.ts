import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { expect, vi } from "vitest";
import { hashSecret } from "../../src/crypto";
import type { ControllerTurnRecord } from "../../src/controller/models";
import { registerControllerTools } from "../../src/controller/tools";
import { openStore } from "../../src/storage/store";
import { policyFixture } from "../helpers";

let fixtureNumber = 0;

type SubmittedTurnColumns = Readonly<{
  evidenceEventSeq?: number;
  completionContinuations?: number;
  acceptedFinalizationId?: number | null;
  evidenceLimitExceededAt?: number | null;
}>;

export type SubmittedControllerFixtureOptions = Readonly<{
  turnColumns?: SubmittedTurnColumns;
  releaseLease?: boolean;
  replacementLease?: Readonly<{ ownerId: string; now: number; leaseMs: number }>;
}>;

export function submittedControllerFixture(options: SubmittedControllerFixtureOptions = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: `telegram-controller-trust-${fixtureNumber++}`,
  });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair-controller-trust"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(
    hashSecret("pair-controller-trust"),
    "7",
    "7",
    1_001,
  )).toEqual({ ok: true });

  const queued = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 10_000 + fixtureNumber,
    inputText: "Inspect the current project state.",
    now: 2_000,
  });
  const lease = store.acquireExecutorLease("executor", 2_000, 30_000);
  if (!lease.acquired) throw new Error("executor lease was not acquired");
  const fence = {
    ownerId: "executor",
    generation: lease.generation,
    now: 2_000,
  };
  expect(store.claimNextControllerTurn(fence)?.id).toBe(queued.id);
  expect(store.markControllerSpawned({
    ...fence,
    turnId: queued.id,
    projectId: "proj_1",
    hostId: "host_1",
    threadId: `thr_controller_trust_${fixtureNumber}`,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, turnId: queued.id })).toBe(true);

  const columns = options.turnColumns;
  if (columns) {
    bb.storage.database().prepare(
      `UPDATE controller_turns
          SET evidence_event_seq = ?, completion_continuations = ?,
              accepted_finalization_id = ?, evidence_limit_exceeded_at = ?
        WHERE id = ?`,
    ).run(
      columns.evidenceEventSeq ?? 0,
      columns.completionContinuations ?? 0,
      columns.acceptedFinalizationId ?? null,
      columns.evidenceLimitExceededAt ?? null,
      queued.id,
    );
  }
  if (options.releaseLease || options.replacementLease) {
    expect(store.releaseExecutorLease(fence.ownerId, fence.generation, fence.now)).toBe(true);
  }
  let replacementFence: typeof fence | null = null;
  if (options.replacementLease) {
    const replacement = store.acquireExecutorLease(
      options.replacementLease.ownerId,
      options.replacementLease.now,
      options.replacementLease.leaseMs,
    );
    if (!replacement.acquired) throw new Error("replacement lease was not acquired");
    replacementFence = {
      ownerId: options.replacementLease.ownerId,
      generation: replacement.generation,
      now: options.replacementLease.now,
    };
  }

  const turn = store.getControllerTurn(queued.id);
  if (!turn) throw new Error("submitted controller turn disappeared");
  return {
    bb,
    harness,
    db: bb.storage.database(),
    store,
    turn,
    fence,
    replacementFence,
    reopen: () => openStore(bb.storage, bb.storage.kv, () => 2_000),
  };
}

export function validEvidenceInput(turn: ControllerTurnRecord) {
  return {
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    sourceKind: "hanoon_tool" as const,
    sourceName: "telegram_agent_list_projects",
    sourceItemId: null,
    outcome: "observed" as const,
    argsSha256: "a".repeat(64),
    resultSha256: "b".repeat(64),
    proofKinds: ["project_state"] as const,
    subjectRefs: ["project:proj_1"] as const,
  };
}

export function insertControllerTestJob(
  db: Database.Database,
  input: Readonly<{
    id: string;
    state: string;
    sourceUpdateId?: number;
    projectId?: string;
    version?: number;
    prHeadSha?: string | null;
    admissionState?: "queued" | "admitted" | "draining" | "released";
  }>,
): void {
  db.prepare(
    `INSERT INTO jobs (
       id, source_update_id, request_text, state, project_id, pr_head_sha,
       version, created_at, updated_at
     ) VALUES (?, ?, 'Controller trust fixture', ?, ?, ?, ?, 1, 1)`,
  ).run(
    input.id,
    input.sourceUpdateId ?? 50_000 + fixtureNumber,
    input.state,
    input.projectId ?? "proj_1",
    input.prHeadSha ?? null,
    input.version ?? 1,
  );
  if (input.admissionState) {
    db.prepare(
      `INSERT INTO job_admissions (
         job_id, project_id, queue_seq, state, resume_event, queued_at
       ) VALUES (?, ?, ?, ?, 'CONFIRMED', 1)`,
    ).run(
      input.id,
      input.projectId ?? "proj_1",
      50_000 + fixtureNumber,
      input.admissionState,
    );
  }
}

export function registeredControllerFixture(options: { staleLease?: boolean } = {}) {
  const fixture = submittedControllerFixture({ releaseLease: options.staleLease });
  fixture.store.upsertProjectPolicy(policyFixture(), 1_500);
  const controller = fixture.store.getControllerForOwner("7", "7");
  if (!controller?.threadId || !controller.projectId) throw new Error("controller fixture is incomplete");
  let operationNumber = 0;
  const request = vi.fn(async (input: {
    kind: "steer_thread" | "stop_thread" | "retry_thread";
    threadId: string;
    text?: string;
  }) => {
    operationNumber += 1;
    const id = `operation_${operationNumber}`;
    fixture.store.createThreadOperation({
      id,
      nonceHash: operationNumber.toString(16).padStart(64, "0"),
      ownerUserId: "7",
      ownerChatId: "7",
      kind: input.kind,
      threadId: input.threadId,
      text: input.kind === "steer_thread" ? input.text ?? "steer" : null,
      expiresAt: 62_000,
      now: 1_900,
    });
    const operation = fixture.store.markThreadOperationConfirmationSent(id, operationNumber, 1_901);
    return {
      id: operation.id,
      kind: operation.kind,
      threadId: operation.threadId,
      state: operation.state,
      expiresAt: operation.expiresAt,
    };
  });
  const notify = vi.fn();
  const health = vi.fn(() => ({ ok: true }));
  registerControllerTools(fixture.bb, {
    store: fixture.store,
    sdk: fixture.bb.sdk,
    threadOperations: { request },
    health,
    notify,
    now: () => 2_000,
  });
  return {
    ...fixture,
    request,
    notify,
    health,
    toolContext: {
      threadId: controller.threadId,
      projectId: controller.projectId,
      signal: new AbortController().signal,
    },
  };
}

/**
 * A registered controller whose agent configuration can be resolved exactly as
 * BB would resolve it, so `bb.agents.configure` can be tested as the single
 * standing-instruction source rather than through the strings it composes from.
 */
export function configuredControllerFixture(options: { staleLease?: boolean } = {}) {
  const fixture = registeredControllerFixture(options);
  const controller = fixture.store.getControllerForOwner("7", "7");
  if (!controller?.threadId || !controller.projectId || !controller.hostId) {
    throw new Error("configured controller fixture is incomplete");
  }
  const context = {
    thread: {
      id: controller.threadId,
      title: `Telegram Codex controller ${controller.controllerKey}`,
      parentThreadId: null,
      sourceThreadId: null,
    },
    project: { id: controller.projectId, kind: "personal" as const, name: "Personal", gitRemoteUrl: null },
    environment: {
      id: "env_personal",
      name: null,
      path: "/private/path",
      workspaceProvisionType: "personal" as const,
      branchName: null,
    },
    host: { id: controller.hostId, name: "Host" },
    provider: { id: "codex", model: "gpt-5.6-luna" },
    origin: { kind: null, pluginId: fixture.bb.pluginId },
  };
  return {
    ...fixture,
    controllerContext: context,
    resolveConfiguration: (overrides: Record<string, unknown> = {}) =>
      fixture.harness.behavior.resolveAgentConfiguration({ ...context, ...overrides } as never),
  };
}

/**
 * Completes a submitted turn the only way production can: an accepted
 * structured finalization, then its consumption. Tests used to call the raw
 * completion API, which wrote an answer with no finalization behind it.
 */
export function completeTurnThroughFinalization(
  store: ReturnType<typeof openStore>,
  fence: Readonly<{ ownerId: string; generation: number; now: number }>,
  input: Readonly<{ turnId: string; controllerKey: string; responseText: string }>,
): void {
  // The real path adopts the submitted turn under the current executor lease
  // before any finalization work, so the helper does too.
  if (!store.adoptSubmittedControllerTurnFence({ ...fence, turnId: input.turnId })) {
    throw new Error("submitted controller turn could not be adopted");
  }
  const proposed = store.proposeControllerFinalization({
    ...fence,
    turnId: input.turnId,
    controllerKey: input.controllerKey,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: input.responseText }],
      obligationRefs: [],
    },
  });
  if (proposed.outcome !== "accepted") {
    throw new Error(`finalization was not accepted: ${JSON.stringify(proposed)}`);
  }
  const completion = store.completeControllerTurnFromFinalization({
    ...fence,
    turnId: input.turnId,
    controllerKey: input.controllerKey,
  });
  if (completion !== "completed") throw new Error(`turn was not completed: ${completion}`);
}
