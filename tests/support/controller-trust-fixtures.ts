import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { expect, vi } from "vitest";
import { hashSecret } from "../../src/crypto";
import type { ControllerLeaseFence, ControllerTurnRecord } from "../../src/controller/models";
import { registerControllerTools } from "../../src/controller/tools";
import { BUNDLED_SKILL_IDS } from "../../src/agent-skills/role-resolver";
import { openStore, type TelegramAgentStore } from "../../src/storage/store";
import { policyFixture } from "../helpers";
import { createTestManagedAutomations } from "./managed-automation-fixture";

let fixtureNumber = 0;
type DisposableControllerFixture = Readonly<{ dispose(): Promise<void> }>;
const activeControllerFixtures = new Set<DisposableControllerFixture>();

export async function disposeControllerTrustFixtures(): Promise<void> {
  const fixtures = [...activeControllerFixtures];
  let firstError: unknown;
  for (const fixture of fixtures) {
    try {
      await fixture.dispose();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError !== undefined) throw firstError;
}

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
    agentSkillIds: [...BUNDLED_SKILL_IDS],
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
  // The claim waits out the burst quiet gap past the 2_000 receipt.
  expect(store.claimNextControllerTurn({ ...fence, now: 5_000 })?.id).toBe(queued.id);
  expect(store.reserveControllerSpawn({
    controllerKey: queued.controllerKey,
    turnId: queued.id,
    projectId: "proj_1",
    hostId: "host_1",
    now: fence.now,
  })).toBe(true);
  expect(store.markControllerSpawned({
    ...fence,
    turnId: queued.id,
    projectId: "proj_1",
    hostId: "host_1",
    threadId: `thr_controller_trust_${fixtureNumber}`,
    spawnToken: queued.id,
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
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    try {
      await harness.lifecycle.dispose();
    } finally {
      activeControllerFixtures.delete(disposable);
    }
  };
  const disposable = { dispose };
  activeControllerFixtures.add(disposable);
  return {
    bb,
    harness,
    db: bb.storage.database(),
    store,
    turn,
    fence,
    replacementFence,
    reopen: () => openStore(bb.storage, bb.storage.kv, () => 2_000),
    ...disposable,
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

export function completeAcceptedControllerTurn(
  store: TelegramAgentStore,
  turnOrId: ControllerTurnRecord | string,
  fence: ControllerLeaseFence,
  responseText: string,
): void {
  // Kept for controller-store/controller-service completion coverage only;
  // downstream consumers use seedCompletedControllerTurn below.
  const turn = typeof turnOrId === "string" ? store.getControllerTurn(turnOrId) : turnOrId;
  if (!turn) throw new Error("controller completion fixture turn is missing");
  if (!store.adoptSubmittedControllerTurnFence({ ...fence, turnId: turn.id })) {
    throw new Error("controller completion fixture could not adopt the submitted turn");
  }
  const accepted = store.proposeControllerFinalization({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: responseText }],
      obligationRefs: [],
    },
  });
  if (accepted.outcome !== "accepted") {
    throw new Error(`controller completion fixture finalization was ${accepted.outcome}`);
  }
  const current = store.getControllerTurn(turn.id);
  if (!current) throw new Error("controller completion fixture turn disappeared");
  const completed = store.completeControllerTurnFromFinalization({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    bbHighWaterSeq: current.evidenceEventSeq,
  });
  if (completed !== "completed") throw new Error(`controller completion fixture returned ${completed}`);
}

/**
 * Completes a submitted turn through the same accepted-finalization gate used
 * by production. Kept as a compatibility fixture for the deployed-line tests
 * that predate the more explicit `completeAcceptedControllerTurn` helper.
 */
export function completeTurnThroughFinalization(
  store: TelegramAgentStore,
  fence: ControllerLeaseFence,
  input: Readonly<{ turnId: string; controllerKey: string; responseText: string }>,
): void {
  if (!store.adoptSubmittedControllerTurnFence({ ...fence, turnId: input.turnId })) {
    throw new Error("submitted controller turn could not be adopted");
  }
  const turn = store.getControllerTurn(input.turnId);
  if (!turn) throw new Error("submitted controller turn disappeared before evidence");
  const mutationClaim = /\b(?:queued|started|stopped|restarted|retried|cancelled|canceled|resumed|paused|created|deleted|removed)\b/i
    .test(input.responseText);
  const claimKind = mutationClaim ? "external_mutation" : "pipeline_outcome";
  const evidence = store.recordControllerEvidence({
    ...validEvidenceInput(turn),
    outcome: "succeeded",
    proofKinds: [claimKind],
    ...fence,
    now: fence.now,
  });
  if (evidence.outcome !== "recorded" && evidence.outcome !== "duplicate") {
    throw new Error(`controller completion fixture evidence was ${evidence.outcome}`);
  }
  const evidenceId = evidence.evidence.id;
  const proposed = store.proposeControllerFinalization({
    ...fence,
    turnId: input.turnId,
    controllerKey: input.controllerKey,
    candidate: {
      disposition: "answered",
      segments: [{
        type: "claim",
        text: input.responseText,
        kind: claimKind,
        outcome: "succeeded",
        subjectRef: "project:proj_1",
        evidenceRefs: [`evidence:${evidenceId}`],
      }],
      obligationRefs: [],
    },
  });
  if (proposed.outcome !== "accepted") {
    throw new Error(`finalization was not accepted: ${JSON.stringify(proposed)}`);
  }
  const current = store.getControllerTurn(input.turnId);
  if (!current) throw new Error("submitted controller turn disappeared");
  const completed = store.completeControllerTurnFromFinalization({
    ...fence,
    turnId: input.turnId,
    controllerKey: input.controllerKey,
    bbHighWaterSeq: current.evidenceEventSeq,
  });
  if (completed !== "completed") throw new Error(`turn was not completed: ${completed}`);
}

/**
 * Seeds the durable state consumed by downstream tests without exercising the
 * completion implementation they are meant to observe. Completion-specific
 * tests should continue to use completeAcceptedControllerTurn above.
 */
export function seedCompletedControllerTurn(
  db: Database.Database,
  turnOrId: ControllerTurnRecord | string,
  responseText: string,
  now = 2_000,
): void {
  const turnId = typeof turnOrId === "string" ? turnOrId : turnOrId.id;
  const row = db.prepare(
    `SELECT turn.id, turn.controller_key, turn.ordinal, turn.input_text,
            controller.telegram_chat_id, turn.state
       FROM controller_turns AS turn
       JOIN controller_threads AS controller ON controller.controller_key = turn.controller_key
      WHERE turn.id = ?`,
  ).get(turnId) as {
    id: string;
    controller_key: string;
    ordinal: number;
    input_text: string;
    telegram_chat_id: string;
    state: string;
  } | undefined;
  if (!row) throw new Error("controller seed turn is missing");
  if (row.state !== "submitted") throw new Error(`controller seed turn is ${row.state}, not submitted`);

  const payloadJson = JSON.stringify({ text: responseText, disable_web_page_preview: true });
  db.transaction(() => {
    const completed = db.prepare(
      `UPDATE controller_turns
          SET state = 'completed', response_text = ?, stream_text = '',
              stream_phase = 'complete', last_error = NULL, completed_at = ?, updated_at = ?
        WHERE id = ? AND state = 'submitted'`,
    ).run(responseText, now, now, row.id);
    if (completed.changes !== 1) throw new Error("controller seed turn was not submitted at write time");

    db.prepare(
      `INSERT INTO controller_digest (controller_key, ordinal, owner_text, agent_text, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (controller_key, ordinal) DO UPDATE
         SET owner_text = excluded.owner_text, agent_text = excluded.agent_text`,
    ).run(row.controller_key, row.ordinal, row.input_text, responseText, now);

    db.prepare(
      `INSERT INTO outbox (
         logical_key, chat_id, message_id, payload_json, status, attempts,
         next_attempt_at, created_at, updated_at
       ) VALUES (?, ?, NULL, ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT(logical_key) DO UPDATE SET
         chat_id = excluded.chat_id,
         payload_json = excluded.payload_json,
         status = 'pending',
         attempts = 0,
         next_attempt_at = excluded.next_attempt_at,
         last_error = NULL,
         updated_at = excluded.updated_at`,
    ).run(`controller:${row.id}:reply`, row.telegram_chat_id, payloadJson, now, now, now);
  }).immediate();
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
  const automations = createTestManagedAutomations();
  registerControllerTools(fixture.bb, {
    store: fixture.store,
    sdk: fixture.bb.sdk,
    threadOperations: { request },
    health,
    notify,
    now: () => 2_000,
    controllerProviderId: () => "codex",
    controllerExecution: () => ({
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "default",
      permissionMode: "auto",
    }),
    automations,
  });
  return {
    ...fixture,
    request,
    notify,
    health,
    automations,
    toolContext: {
      threadId: controller.threadId,
      projectId: controller.projectId,
      signal: new AbortController().signal,
    },
  };
}

/** A registered controller with the full BB configuration context available. */
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
    provider: {
      id: "codex",
      model: "gpt-5.6-luna",
      capabilities: { supportsNativeUserQuestion: false },
    },
    origin: { kind: null, pluginId: fixture.bb.pluginId },
  };
  return {
    ...fixture,
    controllerContext: context,
    resolveConfiguration: (overrides: Record<string, unknown> = {}) =>
      fixture.harness.behavior.resolveAgentConfiguration({ ...context, ...overrides } as never),
  };
}
