import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import {
  ControllerEvidenceRepository,
  type ControllerNativeEvidenceCandidate,
} from "../src/storage/controller-evidence-repository";
import {
  disposeControllerTrustFixtures,
  submittedControllerFixture,
  validEvidenceInput,
} from "./support/controller-trust-fixtures";

afterEach(async () => {
  await disposeControllerTrustFixtures();
});

function nativeEvidenceCandidate(sourceItemId: string): ControllerNativeEvidenceCandidate {
  return {
    sourceName: "command",
    sourceItemId,
    outcome: "succeeded" as const,
    argsSha256: "c".repeat(64),
    resultSha256: "d".repeat(64),
    proofKinds: ["command_result"] as const,
    subjectRefs: [`command:${sourceItemId}`] as const,
  };
}

function openEvidenceConnection(databasePath: string) {
  const db = new Database(databasePath);
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  return { db, repository: new ControllerEvidenceRepository(db) };
}

const nativeIdentityConflicts = [
  ["source name", { sourceName: "tool" }],
  ["outcome", { outcome: "failed" }],
  ["argument hash", { argsSha256: "e".repeat(64) }],
  ["result hash", { resultSha256: "f".repeat(64) }],
  ["proof-kind order", { proofKinds: ["tool_result", "command_result"] }],
  ["subject-ref order", { subjectRefs: ["project:proj_1", "command:raced_item"] }],
] as const satisfies ReadonlyArray<readonly [string, Partial<ControllerNativeEvidenceCandidate>]>;

function installAcceptedFinalization(
  db: ReturnType<typeof submittedControllerFixture>["db"],
  turnId: string,
  now: number,
): void {
  db.prepare(
    `INSERT INTO controller_finalizations (
       turn_id, revision, payload_json, rendered_message, evidence_high_water_id,
       state, rejection_code, created_at, validated_at
     ) VALUES (?, 1, '{}', 'sealed', 0, 'accepted', NULL, ?, ?)`,
  ).run(turnId, now, now);
  const inserted = db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number | bigint };
  db.prepare("UPDATE controller_turns SET accepted_finalization_id = ? WHERE id = ?")
    .run(Number(inserted.id), turnId);
}

it("records bounded current-turn evidence under the exact executor fence", () => {
  const { store, turn, fence } = submittedControllerFixture();

  const written = store.recordControllerEvidence({
    ...validEvidenceInput(turn),
    ...fence,
  });

  expect(written).toMatchObject({
    outcome: "recorded",
    evidence: {
      ref: "evidence:1",
      observedAt: fence.now,
    },
  });
});

it("denies a stale generation and inserts nothing", () => {
  const { store, turn, fence } = submittedControllerFixture();

  const written = store.recordControllerEvidence({
    ...validEvidenceInput(turn),
    ...fence,
    generation: fence.generation + 1,
  });

  expect(written).toEqual({ outcome: "stale" });
  expect(store.listControllerEvidence(turn.id, 128)).toEqual([]);
});

it("denies an expired global lease even when the turn fence still matches", () => {
  const { store, turn, fence } = submittedControllerFixture();

  expect(store.recordControllerEvidence({
    ...validEvidenceInput(turn),
    ...fence,
    now: 32_000,
  })).toEqual({ outcome: "stale" });
  expect(store.listControllerEvidence(turn.id, 128)).toEqual([]);
});

it("denies a controller-key mismatch under an otherwise current fence", () => {
  const { store, turn, fence } = submittedControllerFixture();

  expect(store.recordControllerEvidence({
    ...validEvidenceInput(turn),
    ...fence,
    controllerKey: "owner-7-other-controller",
  })).toEqual({ outcome: "stale" });
  expect(store.listControllerEvidence(turn.id, 128)).toEqual([]);
});

it("adopts a submitted turn only into the current successor fence", () => {
  const { store, turn, fence } = submittedControllerFixture();
  const successor = store.acquireExecutorLease("successor", 40_001, 30_000);
  if (!successor.acquired) throw new Error("successor lease was not acquired");
  const successorFence = {
    turnId: turn.id,
    ownerId: "successor",
    generation: successor.generation,
    now: 40_001,
  };

  expect(store.adoptSubmittedControllerTurnFence({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 40_001,
  })).toBe(false);
  expect(store.adoptSubmittedControllerTurnFence(successorFence)).toBe(true);
  expect(store.adoptSubmittedControllerTurnFence(successorFence)).toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    leaseOwner: "successor",
    leaseGeneration: successor.generation,
  });
});

it("deduplicates repeated native item ids within one batch", () => {
  const { store, turn, fence } = submittedControllerFixture();
  const candidate = {
    sourceName: "command",
    sourceItemId: "item_1",
    outcome: "succeeded" as const,
    argsSha256: "c".repeat(64),
    resultSha256: "d".repeat(64),
    proofKinds: ["command_result"] as const,
    subjectRefs: ["command:item_1"] as const,
  };

  expect(store.recordControllerNativeEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 2,
    items: [candidate, candidate],
  })).toBe("recorded");

  expect(store.listControllerEvidence(turn.id, 128)).toMatchObject([
    { sourceKind: "bb_item", sourceItemId: "item_1" },
  ]);
});

it("persists native rows and their cursor across store restart", () => {
  const { store, turn, fence, reopen } = submittedControllerFixture();
  expect(store.recordControllerNativeEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [{
      sourceName: "command",
      sourceItemId: "restart_item",
      outcome: "succeeded",
      argsSha256: "c".repeat(64),
      resultSha256: "d".repeat(64),
      proofKinds: ["command_result"],
      subjectRefs: ["command:restart_item"],
    }],
  })).toBe("recorded");

  const restarted = reopen();
  expect(restarted.listControllerEvidence(turn.id, 128)).toMatchObject([
    { sourceKind: "bb_item", sourceItemId: "restart_item" },
  ]);
  expect(restarted.getControllerTurn(turn.id)).toMatchObject({ evidenceEventSeq: 1 });
});

it("replays one native item across restart without duplicating its row", () => {
  const { store, turn, fence, reopen } = submittedControllerFixture();
  const candidate = nativeEvidenceCandidate("cross_batch_replay");
  expect(store.recordControllerNativeEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [candidate],
  })).toBe("recorded");

  const restarted = reopen();
  expect(restarted.recordControllerNativeEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 1,
    throughSeq: 2,
    items: [candidate],
  })).toBe("recorded");
  expect(restarted.listControllerEvidence(turn.id, 128)).toHaveLength(1);
  expect(restarted.getControllerTurn(turn.id)).toMatchObject({ evidenceEventSeq: 2 });
});

it.each(nativeIdentityConflicts)(
  "rejects a two-connection %s identity conflict without advancing the cursor",
  (_semanticField, conflictingFields) => {
    const { store, turn, fence, db } = submittedControllerFixture();
    const storedCandidate: ControllerNativeEvidenceCandidate = {
      ...nativeEvidenceCandidate("raced_item"),
      proofKinds: ["command_result", "tool_result"],
      subjectRefs: ["command:raced_item", "project:proj_1"],
    };
    const competing = openEvidenceConnection(db.name);
    try {
      expect(competing.repository.list(turn.id, 128)).toEqual([]);
      expect(store.recordControllerNativeEvidence({
        ...fence,
        turnId: turn.id,
        controllerKey: turn.controllerKey,
        fromSeq: 0,
        throughSeq: 0,
        items: [storedCandidate],
      })).toBe("recorded");

      expect(competing.repository.recordNativeBatch({
        ...fence,
        now: fence.now + 1,
        turnId: turn.id,
        controllerKey: turn.controllerKey,
        fromSeq: 0,
        throughSeq: 1,
        items: [{ ...storedCandidate, ...conflictingFields }],
      })).toBe("native_identity_conflict");
      expect(store.listControllerEvidence(turn.id, 128)).toMatchObject([storedCandidate]);
      expect(store.getControllerTurn(turn.id)).toMatchObject({ evidenceEventSeq: 0 });
    } finally {
      competing.db.close();
    }
  },
);

it("keeps an identical two-connection non-advancing duplicate idempotent", () => {
  const { store, turn, fence, db } = submittedControllerFixture();
  const candidate = nativeEvidenceCandidate("identical_non_advancing");
  const competing = openEvidenceConnection(db.name);
  try {
    expect(competing.repository.list(turn.id, 128)).toEqual([]);
    expect(store.recordControllerNativeEvidence({
      ...fence,
      turnId: turn.id,
      controllerKey: turn.controllerKey,
      fromSeq: 0,
      throughSeq: 0,
      items: [candidate],
    })).toBe("recorded");

    expect(competing.repository.recordNativeBatch({
      ...fence,
      now: fence.now + 1,
      turnId: turn.id,
      controllerKey: turn.controllerKey,
      fromSeq: 0,
      throughSeq: 0,
      items: [candidate],
    })).toBe("recorded");
    expect(store.listControllerEvidence(turn.id, 128)).toMatchObject([
      { ...candidate, observedAt: fence.now },
    ]);
    expect(store.getControllerTurn(turn.id)).toMatchObject({ evidenceEventSeq: 0 });
  } finally {
    competing.db.close();
  }
});

it("advances the native cursor for an empty batch without inserting evidence", () => {
  const { store, turn, fence } = submittedControllerFixture();

  expect(store.recordControllerNativeEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 7,
    items: [],
  })).toBe("recorded");
  expect(store.listControllerEvidence(turn.id, 128)).toEqual([]);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ evidenceEventSeq: 7 });
});

it("rejects a native batch whose expected cursor has changed", () => {
  const { store, turn, fence } = submittedControllerFixture({
    turnColumns: { evidenceEventSeq: 4 },
  });

  expect(store.recordControllerNativeEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 3,
    throughSeq: 5,
    items: [],
  })).toBe("cursor_changed");
  expect(store.getControllerTurn(turn.id)).toMatchObject({ evidenceEventSeq: 4 });
  expect(store.listControllerEvidence(turn.id, 128)).toEqual([]);
});

it("rolls back both native rows and cursor on a forced SQL exception", () => {
  const { store, turn, fence, db } = submittedControllerFixture();
  db.exec(`
    CREATE TRIGGER force_controller_evidence_failure
    BEFORE INSERT ON controller_evidence
    WHEN NEW.source_item_id = 'item_explode'
    BEGIN
      SELECT RAISE(ABORT, 'forced controller evidence failure');
    END;
  `);

  expect(() => store.recordControllerNativeEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 2,
    items: [
      {
        sourceName: "command",
        sourceItemId: "item_before_exception",
        outcome: "succeeded",
        argsSha256: "c".repeat(64),
        resultSha256: "d".repeat(64),
        proofKinds: ["command_result"],
        subjectRefs: ["command:item_before_exception"],
      },
      {
        sourceName: "command",
        sourceItemId: "item_explode",
        outcome: "failed",
        argsSha256: "e".repeat(64),
        resultSha256: "f".repeat(64),
        proofKinds: ["command_result"],
        subjectRefs: ["command:item_explode"],
      },
    ],
  })).toThrow(/forced controller evidence failure/);
  expect(store.listControllerEvidence(turn.id, 128)).toEqual([]);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ evidenceEventSeq: 0 });
});

it("marks the 129th direct item and preserves the first 128 without inserting it", () => {
  const { store, turn, fence } = submittedControllerFixture();

  for (let index = 0; index < 128; index += 1) {
    expect(store.recordControllerEvidence({
      ...validEvidenceInput(turn),
      ...fence,
      sourceName: `telegram_agent_read_${index}`,
      subjectRefs: [`project:proj_${index}`],
    }).outcome).toBe("recorded");
  }

  expect(store.recordControllerEvidence({
    ...validEvidenceInput(turn),
    ...fence,
    sourceName: "telegram_agent_read_128",
  })).toEqual({ outcome: "limit_exceeded" });
  expect(store.listControllerEvidence(turn.id, 128)).toHaveLength(128);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    evidenceLimitExceededAt: fence.now,
  });
});

it("marks a cap-crossing native batch without inserting rows or advancing its cursor", () => {
  const { store, turn, fence } = submittedControllerFixture();
  for (let index = 0; index < 127; index += 1) {
    store.recordControllerEvidence({
      ...validEvidenceInput(turn),
      ...fence,
      sourceName: `telegram_agent_read_${index}`,
    });
  }

  expect(store.recordControllerNativeEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 2,
    items: [0, 1].map((index) => ({
      sourceName: "command",
      sourceItemId: `native_${index}`,
      outcome: "succeeded" as const,
      argsSha256: "c".repeat(64),
      resultSha256: "d".repeat(64),
      proofKinds: ["command_result"] as const,
      subjectRefs: [`command:native_${index}`],
    })),
  })).toBe("limit_exceeded");
  expect(store.listControllerEvidence(turn.id, 128)).toHaveLength(127);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    evidenceEventSeq: 0,
    evidenceLimitExceededAt: fence.now,
  });
});

it("advances a duplicate-only replay at cap before rejecting a genuinely new native id", () => {
  const { store, turn, fence } = submittedControllerFixture();
  const storedNative = nativeEvidenceCandidate("stored_at_cap");
  expect(store.recordControllerNativeEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [storedNative],
  })).toBe("recorded");
  for (let index = 0; index < 127; index += 1) {
    expect(store.recordControllerEvidence({
      ...validEvidenceInput(turn),
      ...fence,
      sourceName: `telegram_agent_cap_fill_${index}`,
    }).outcome).toBe("recorded");
  }
  expect(store.listControllerEvidence(turn.id, 128)).toHaveLength(128);

  expect(store.recordControllerNativeEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 1,
    throughSeq: 2,
    items: [storedNative],
  })).toBe("recorded");
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    evidenceEventSeq: 2,
    evidenceLimitExceededAt: null,
  });

  expect(store.recordControllerNativeEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 2,
    throughSeq: 3,
    items: [nativeEvidenceCandidate("new_over_cap")],
  })).toBe("limit_exceeded");
  expect(store.listControllerEvidence(turn.id, 128)).toHaveLength(128);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    evidenceEventSeq: 2,
    evidenceLimitExceededAt: fence.now,
  });
});

it("scopes evidence reads to the requested turn", () => {
  const { store, turn, fence } = submittedControllerFixture();
  const first = store.recordControllerEvidence({ ...validEvidenceInput(turn), ...fence });
  if (first.outcome !== "recorded") throw new Error("first evidence was not recorded");
  const other = store.enqueueControllerTurn({
    controllerKey: "owner-7-other-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 20_001,
    inputText: "Inspect another project.",
    now: 2_001,
  });
  expect(store.claimNextControllerTurn({ ...fence, now: 2_001 })?.id).toBe(other.id);
  expect(store.reserveControllerSpawn({
    controllerKey: other.controllerKey,
    turnId: other.id,
    projectId: "proj_2",
    hostId: "host_1",
    now: 2_001,
  })).toBe(true);
  expect(store.markControllerSpawned({
    ...fence,
    now: 2_001,
    turnId: other.id,
    projectId: "proj_2",
    hostId: "host_1",
    threadId: "thr_other_controller",
    spawnToken: other.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, now: 2_001, turnId: other.id })).toBe(true);

  expect(store.listControllerEvidence(other.id, 128)).toEqual([]);
  expect(store.getControllerEvidence(other.id, first.evidence.id)).toBeNull();
});

it("reads subject and proof arrays back in caller order", () => {
  const { store, turn, fence } = submittedControllerFixture();

  const written = store.recordControllerEvidence({
    ...validEvidenceInput(turn),
    ...fence,
    proofKinds: ["retrieved_content", "project_state", "health_snapshot"],
    subjectRefs: ["project:proj_2", "project:proj_1", "health:prod"],
  });

  expect(written).toMatchObject({
    outcome: "recorded",
    evidence: {
      proofKinds: ["retrieved_content", "project_state", "health_snapshot"],
      subjectRefs: ["project:proj_2", "project:proj_1", "health:prod"],
    },
  });
});

it("lists multiple evidence rows in ascending evidence-id order", () => {
  const { store, turn, fence } = submittedControllerFixture();
  for (const sourceName of ["third_observation", "first_observation", "second_observation"]) {
    expect(store.recordControllerEvidence({
      ...validEvidenceInput(turn),
      ...fence,
      sourceName,
    }).outcome).toBe("recorded");
  }

  expect(store.listControllerEvidence(turn.id, 128).map((evidence) => evidence.ref)).toEqual([
    "evidence:1",
    "evidence:2",
    "evidence:3",
  ]);
});

it.each([
  ["uppercase hash", { argsSha256: "A".repeat(64) }],
  ["empty source name", { sourceName: "" }],
  ["oversized source name", { sourceName: "s".repeat(257) }],
  ["duplicate subjects", { subjectRefs: ["project:one", "project:one"] }],
  ["too many subjects", { subjectRefs: Array.from({ length: 17 }, (_, index) => `project:${index}`) }],
  ["unknown proof kind", { proofKinds: ["invented_proof"] }],
  ["duplicate proof kinds", { proofKinds: ["project_state", "project_state"] }],
  ["too many proof kinds", { proofKinds: Array.from({ length: 9 }, (_, index) => `proof_${index}`) }],
  ["negative plugin timestamp", { now: -1 }],
  ["mismatched source kind", { sourceKind: "bb_item" }],
  ["mismatched source item id", { sourceItemId: "native_item" }],
])("rejects %s before any evidence write", (_scenario, override) => {
  const { store, turn, fence } = submittedControllerFixture();

  expect(() => store.recordControllerEvidence({
    ...validEvidenceInput(turn),
    ...fence,
    ...override,
  } as never)).toThrow(TypeError);
  expect(store.listControllerEvidence(turn.id, 128)).toEqual([]);
});

it("validates every native candidate before starting the batch transaction", () => {
  const { store, turn, fence } = submittedControllerFixture();

  expect(() => store.recordControllerNativeEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 2,
    items: [
      {
        sourceName: "command",
        sourceItemId: "valid_item",
        outcome: "succeeded",
        argsSha256: "c".repeat(64),
        resultSha256: "d".repeat(64),
        proofKinds: ["command_result"],
        subjectRefs: ["command:valid_item"],
      },
      {
        sourceName: "command",
        sourceItemId: "invalid_item",
        outcome: "succeeded",
        argsSha256: "not-a-hash",
        resultSha256: "d".repeat(64),
        proofKinds: ["command_result"],
        subjectRefs: ["command:invalid_item"],
      },
    ],
  })).toThrow(TypeError);
  expect(store.listControllerEvidence(turn.id, 128)).toEqual([]);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ evidenceEventSeq: 0 });
});

it("rejects evidence after an accepted finalization", () => {
  const { store, turn, fence, db } = submittedControllerFixture();
  installAcceptedFinalization(db, turn.id, fence.now);

  expect(store.recordControllerEvidence({
    ...validEvidenceInput(turn),
    ...fence,
  })).toEqual({ outcome: "stale" });
  expect(store.listControllerEvidence(turn.id, 128)).toEqual([]);
});

it("records late native evidence after an accepted finalization and advances its cursor", () => {
  const { store, turn, fence, db } = submittedControllerFixture();
  installAcceptedFinalization(db, turn.id, fence.now);

  expect(store.recordControllerNativeEvidence({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [nativeEvidenceCandidate("sealed_native_item")],
  })).toBe("recorded");
  expect(store.listControllerEvidence(turn.id, 128)).toMatchObject([
    { sourceKind: "bb_item", sourceItemId: "sealed_native_item" },
  ]);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ evidenceEventSeq: 1 });
});

it("persists the accepted evidence seal and immutable BB event seal separately", () => {
  const { store, turn, fence, reopen } = submittedControllerFixture({
    turnColumns: { evidenceEventSeq: 4 },
  });
  const accepted = store.proposeControllerFinalization({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    bbEventHighWaterSeq: 4,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: "sealed answer" }],
      obligationRefs: [],
    },
  });

  expect(accepted.outcome).toBe("accepted");
  if (accepted.outcome !== "accepted") return;
  expect(accepted.finalization).toMatchObject({ evidenceHighWaterId: 0, bbEventHighWaterSeq: 4 });
  expect(reopen().getAcceptedControllerFinalization(turn.id)).toMatchObject({
    evidenceHighWaterId: 0,
    bbEventHighWaterSeq: 4,
  });
});

it("allows lifecycle-only BB event high-water advancement after acceptance", () => {
  const { store, turn, fence } = submittedControllerFixture({
    turnColumns: { evidenceEventSeq: 4 },
  });
  const accepted = store.proposeControllerFinalization({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    bbEventHighWaterSeq: 4,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: "must not escape" }],
      obligationRefs: [],
    },
  });
  expect(accepted.outcome).toBe("accepted");

  expect(store.completeControllerTurnFromFinalization({
    ...fence,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    bbHighWaterSeq: 5,
  })).toBe("completed");
  expect(store.getControllerTurn(turn.id)?.state).toBe("completed");
  expect(store.getAcceptedControllerFinalization(turn.id)?.consumedAt).toBe(fence.now);
});

it("exposes the fixed proof-kind vocabulary once from controller models", async () => {
  const models = await import("../src/controller/models");
  expect(models.CONTROLLER_PROOF_KINDS).toEqual([
    "project_state",
    "job_state",
    "thread_state",
    "monitor_state",
    "memory_state",
    "command_result",
    "tool_result",
    "workspace_change",
    "external_mutation",
    "pipeline_outcome",
    "obligation",
    "retrieved_content",
    "health_snapshot",
  ]);
});
