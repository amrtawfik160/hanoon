import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect } from "vitest";
import { hashSecret } from "../../src/crypto";
import type { ControllerTurnRecord } from "../../src/controller/models";
import { openStore } from "../../src/storage/store";

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
