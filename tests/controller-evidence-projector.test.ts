import { expect, it, vi } from "vitest";
import { CONTROLLER_TOOL_NAMES } from "../src/controller/capability-policy";
import { sha256ControllerJson } from "../src/controller/capability-executor";
import {
  ControllerEvidenceProjector,
  ControllerEvidenceProjectorError,
  projectCompletedControllerItem,
  type ControllerCompletedNativeItem,
} from "../src/controller/evidence-projector";
import type { ControllerThreadRecord, ControllerTurnRecord } from "../src/controller/models";
import {
  submittedControllerFixture,
  validEvidenceInput,
} from "./support/controller-trust-fixtures";

type CommandItem = Extract<ControllerCompletedNativeItem, { type: "commandExecution" }>;
type FileItem = Extract<ControllerCompletedNativeItem, { type: "fileChange" }>;
type ToolItem = Extract<ControllerCompletedNativeItem, { type: "toolCall" }>;

const PROJECT_ROOT = "/workspace/project";

function commandItem(overrides: Partial<CommandItem> = {}): CommandItem {
  return {
    type: "commandExecution",
    id: "cmd_1",
    command: "printf secret-command",
    cwd: PROJECT_ROOT,
    status: "completed",
    approvalStatus: null,
    ...overrides,
  };
}

function fileItem(path: string, overrides: Partial<FileItem> = {}): FileItem {
  return {
    type: "fileChange",
    id: "file_1",
    changes: [{ path, kind: "update", diff: "secret-diff" }],
    status: "completed",
    approvalStatus: null,
    ...overrides,
  };
}

function toolItem(tool: string, overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    type: "toolCall",
    id: "tool_1",
    server: "plugin",
    tool,
    arguments: { token: "secret-argument" },
    status: "completed",
    result: { text: "secret-result" },
    ...overrides,
  };
}

function completedEvent(seq: number, item: ControllerCompletedNativeItem) {
  return {
    id: `event_${seq}`,
    scope: { kind: "thread" as const },
    threadId: "thr_controller_trust_1",
    seq,
    createdAt: 1_000 + seq,
    type: "item/completed" as const,
    data: { providerThreadId: "provider_thread", item },
  };
}

function nonCandidateEvent(seq: number) {
  return {
    id: `event_${seq}`,
    scope: { kind: "thread" as const },
    threadId: "thr_controller_trust_1",
    seq,
    createdAt: 1_000 + seq,
    type: "turn/input/accepted" as const,
    data: {
      providerThreadId: "provider_thread",
      clientRequestId: `request_${seq}`,
      scope: { kind: "thread" as const },
    },
  };
}

type ProjectorFixtureOptions = Readonly<{
  rows?: readonly (ReturnType<typeof completedEvent> | ReturnType<typeof nonCandidateEvent>)[];
  maxSeq?: number;
  clock?: () => number;
  listEvents?: (afterSeq: number, limit: number) => readonly unknown[];
  thread?: Record<string, unknown> | null;
  environment?: Record<string, unknown> | null;
}>;

function readyProjectorFixture(options: ProjectorFixtureOptions = {}) {
  const fixture = submittedControllerFixture();
  const controller = fixture.store.getControllerForOwner("7", "7");
  if (!controller?.threadId || !controller.projectId || !controller.hostId) {
    throw new Error("controller projector fixture is incomplete");
  }
  const rows = (options.rows ?? []).map((row) => ({ ...row, threadId: controller.threadId }));
  const target = options.maxSeq ?? rows.reduce((maximum, row) => Math.max(maximum, row.seq), 0);
  const defaultThread = {
    id: controller.threadId,
    projectId: controller.projectId,
    environmentId: "env_controller",
  };
  const thread = options.thread === null
    ? null
    : { ...defaultThread, ...(options.thread ?? {}) };
  const defaultEnvironment = {
    id: "env_controller",
    projectId: controller.projectId,
    hostId: controller.hostId,
    path: PROJECT_ROOT,
    status: "ready",
    workspaceProvisionType: "personal",
  };
  const environment = options.environment === null
    ? null
    : { ...defaultEnvironment, ...(options.environment ?? {}) };
  fixture.harness.sdk.stub("threads.get", async () => thread);
  fixture.harness.sdk.stub("environments.get", async () => environment);
  fixture.harness.sdk.stub("threads.timeline", async () => ({ maxSeq: target }));
  fixture.harness.sdk.stub("threads.events.list", async ({ afterSeq = "0", limit = "100" }) => {
    const after = Number(afterSeq);
    const pageLimit = Number(limit);
    const sourceRows = options.listEvents
      ? options.listEvents(after, pageLimit)
      : rows.filter((row) => row.seq > after).slice(0, pageLimit);
    return sourceRows.map((row) => ({
      ...(row as Record<string, unknown>),
      threadId: controller.threadId,
    }));
  });
  const projector = new ControllerEvidenceProjector({
    sdk: fixture.bb.sdk,
    store: fixture.store,
    clock: { now: options.clock ?? (() => 2_100) },
    hanoonToolNames: CONTROLLER_TOOL_NAMES,
  });
  return { ...fixture, controller, projector, rows };
}

function currentTurn(store: ReturnType<typeof readyProjectorFixture>["store"], turnId: string): ControllerTurnRecord {
  const turn = store.getControllerTurn(turnId);
  if (!turn) throw new Error("controller turn disappeared");
  return turn;
}

function installAcceptedFinalization(
  db: ReturnType<typeof readyProjectorFixture>["db"],
  turnId: string,
): void {
  db.prepare(
    `INSERT INTO controller_finalizations (
       turn_id, revision, payload_json, rendered_message, evidence_high_water_id,
       state, rejection_code, created_at, validated_at
     ) VALUES (?, 1, '{}', 'sealed', 0, 'accepted', NULL, 2_000, 2_000)`,
  ).run(turnId);
  const inserted = db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number | bigint };
  db.prepare("UPDATE controller_turns SET accepted_finalization_id = ? WHERE id = ?")
    .run(Number(inserted.id), turnId);
}

const commandApprovalRows = [
  ...(["pending", "completed", "failed", "interrupted"] as const).map((status) =>
    [status, "denied", "denied"] as const),
  ...(["pending", "completed", "failed", "interrupted"] as const).map((status) =>
    [status, "waiting_for_approval", "observed"] as const),
  ["pending", null, "observed"],
  ["completed", null, "succeeded"],
  ["failed", null, "failed"],
  ["interrupted", null, "interrupted"],
] as const;

it.each(commandApprovalRows)(
  "maps command status %s with approval %s to %s",
  (status, approvalStatus, outcome) => {
    expect(projectCompletedControllerItem(
      commandItem({ status, approvalStatus }),
      { projectRoot: PROJECT_ROOT },
    )).toMatchObject({
      sourceName: "commandExecution",
      outcome,
      proofKinds: ["command_result"],
      subjectRefs: ["bb-item:cmd_1"],
    });
  },
);

it("treats an absent or zero command exit as success and a nonzero exit as failure", () => {
  expect(projectCompletedControllerItem(commandItem(), { projectRoot: PROJECT_ROOT })?.outcome)
    .toBe("succeeded");
  expect(projectCompletedControllerItem(commandItem({ exitCode: 0 }), { projectRoot: PROJECT_ROOT })?.outcome)
    .toBe("succeeded");
  expect(projectCompletedControllerItem(commandItem({ exitCode: 9 }), { projectRoot: PROJECT_ROOT })?.outcome)
    .toBe("failed");
});

it("hashes command payload fields without returning raw command material", () => {
  const projected = projectCompletedControllerItem(commandItem({
    aggregatedOutput: "secret-output",
    exitCode: 0,
    durationMs: 12,
  }), { projectRoot: PROJECT_ROOT });

  expect(projected).toMatchObject({
    argsSha256: sha256ControllerJson({
      type: "commandExecution",
      command: "printf secret-command",
      cwd: PROJECT_ROOT,
    }),
    resultSha256: sha256ControllerJson({
      status: "completed",
      approvalStatus: null,
      aggregatedOutput: "secret-output",
      exitCode: 0,
      durationMs: 12,
    }),
  });
  expect(JSON.stringify(projected)).not.toContain("secret-command");
  expect(JSON.stringify(projected)).not.toContain("secret-output");
  expect(JSON.stringify(projected)).not.toContain(PROJECT_ROOT);
});

it.each(commandApprovalRows)(
  "maps file status %s with approval %s to %s",
  (status, approvalStatus, outcome) => {
    expect(projectCompletedControllerItem(
      fileItem("src/index.ts", { status, approvalStatus }),
      { projectRoot: PROJECT_ROOT },
    )).toMatchObject({
      sourceName: "fileChange",
      outcome,
      proofKinds: ["workspace_change"],
      subjectRefs: ["bb-item:file_1", "path:src/index.ts"],
    });
  },
);

it("projects web, image, and generic tool completions with their exact proof kinds", () => {
  const roots = { projectRoot: PROJECT_ROOT };
  expect(projectCompletedControllerItem({
    type: "webSearch",
    id: "search_1",
    queries: ["secret query"],
    resultText: null,
  }, roots)).toMatchObject({ outcome: "succeeded", proofKinds: ["retrieved_content"] });
  expect(projectCompletedControllerItem({
    type: "webFetch",
    id: "fetch_1",
    url: "https://secret.invalid/path",
    prompt: null,
    pattern: null,
    resultText: "secret fetched result",
  }, roots)).toMatchObject({ outcome: "succeeded", proofKinds: ["retrieved_content"] });
  expect(projectCompletedControllerItem({
    type: "imageView",
    id: "image_1",
    path: "/secret/image.png",
  }, roots)).toMatchObject({
    outcome: "succeeded",
    proofKinds: ["retrieved_content"],
    subjectRefs: ["bb-item:image_1"],
  });
  expect(projectCompletedControllerItem(toolItem("external_lookup"), roots)).toMatchObject({
    outcome: "succeeded",
    proofKinds: ["tool_result"],
    subjectRefs: ["bb-item:tool_1"],
  });
});

it("hashes exact web, image, file, and tool projections without exposing them", () => {
  const roots = { projectRoot: PROJECT_ROOT };
  const changes = [{
    path: "src/index.ts",
    movePath: "src/main.ts",
    kind: "update" as const,
    diff: "secret exact diff",
  }];
  expect(projectCompletedControllerItem(fileItem("ignored", { changes }), roots)).toMatchObject({
    argsSha256: sha256ControllerJson({ type: "fileChange", changes }),
    resultSha256: sha256ControllerJson({ status: "completed", approvalStatus: null }),
  });
  expect(projectCompletedControllerItem({
    type: "webFetch",
    id: "fetch_hash",
    url: "https://secret.invalid/hash",
    prompt: null,
    pattern: "needle",
    resultText: null,
  }, roots)).toMatchObject({
    argsSha256: sha256ControllerJson({
      type: "webFetch",
      url: "https://secret.invalid/hash",
      prompt: null,
      pattern: "needle",
    }),
    resultSha256: sha256ControllerJson({ resultText: null }),
  });
  expect(projectCompletedControllerItem({
    type: "imageView",
    id: "image_hash",
    path: "/secret/image.png",
  }, roots)).toMatchObject({
    argsSha256: sha256ControllerJson({ type: "imageView", path: "/secret/image.png" }),
    resultSha256: sha256ControllerJson({ completed: true }),
  });
  expect(projectCompletedControllerItem(toolItem("external_hash", {
    durationMs: 12,
    error: "stale",
  }), roots)).toMatchObject({
    argsSha256: sha256ControllerJson({
      type: "toolCall",
      server: "plugin",
      tool: "external_hash",
      arguments: { token: "secret-argument" },
    }),
    resultSha256: sha256ControllerJson({
      status: "completed",
      result: { text: "secret-result" },
      error: "stale",
      durationMs: 12,
    }),
  });
});

it("uses generic tool status even when its error field is inconsistent", () => {
  const roots = { projectRoot: PROJECT_ROOT };
  expect(projectCompletedControllerItem(toolItem("external", {
    status: "completed",
    error: "stale error text",
  }), roots)?.outcome).toBe("succeeded");
  expect(projectCompletedControllerItem(toolItem("external", {
    status: "failed",
    result: { stale: "success" },
  }), roots)?.outcome).toBe("failed");
  expect(projectCompletedControllerItem(toolItem("external", { status: "pending" }), roots)?.outcome)
    .toBe("observed");
  expect(projectCompletedControllerItem(toolItem("external", { status: "interrupted" }), roots)?.outcome)
    .toBe("interrupted");
});

it.each(CONTROLLER_TOOL_NAMES)("does not project Hanoon tool call %s a second time", (name) => {
  expect(projectCompletedControllerItem(toolItem(name), { projectRoot: PROJECT_ROOT })).toBeNull();
});

it("ignores completed BB item types outside the native projection allowlist", async () => {
  const fixture = readyProjectorFixture({
    maxSeq: 1,
    listEvents: () => [{
      id: "event_1",
      scope: { kind: "thread" },
      threadId: "thr_controller_trust_1",
      seq: 1,
      createdAt: 1_001,
      type: "item/completed",
      data: {
        providerThreadId: "provider_thread",
        item: { type: "agentMessage", id: "message_1", text: "not native evidence" },
      },
    }],
  });

  await expect(fixture.projector.reconcile(
    fixture.controller,
    fixture.turn,
    fixture.fence,
    new AbortController().signal,
  )).resolves.toMatchObject({ outcome: "reconciled", throughSeq: 1 });
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 128)).toEqual([]);
});

it("preserves omitted fields separately from explicit null in canonical hashes", () => {
  const omitted = projectCompletedControllerItem(toolItem("external", {
    server: undefined,
    arguments: undefined,
    result: undefined,
  }), { projectRoot: PROJECT_ROOT });
  const explicitNull = projectCompletedControllerItem({
    type: "webSearch",
    id: "search_null",
    queries: [],
    resultText: null,
  }, { projectRoot: PROJECT_ROOT });

  expect(omitted?.argsSha256).toBe(sha256ControllerJson({ type: "toolCall", tool: "external" }));
  expect(explicitNull?.resultSha256).toBe(sha256ControllerJson({ resultText: null }));
});

const rejectedPaths = [
  "../project-sibling/secret",
  "src/../secret",
  "/workspace/project/inside.ts",
  "/etc/shadow",
  ".",
  "src/./index.ts",
  "src//index.ts",
  "src/\u0000index.ts",
  "src/\u001findex.ts",
  "src\\index.ts",
  "C:relative.txt",
  "C:/absolute.txt",
  "C:\\absolute.txt",
  "//server/share/file.txt",
  "\\\\server\\share\\file.txt",
  "\\\\.\\device\\file.txt",
  "\\\\?\\C:\\verbatim.txt",
] as const;

it.each(rejectedPaths)("omits non-lexically-local file path %s", (candidate) => {
  const projected = projectCompletedControllerItem(fileItem(candidate), { projectRoot: PROJECT_ROOT });
  expect(projected?.subjectRefs).toEqual(["bb-item:file_1"]);
});

it.each(["", "relative/root", "/workspace/\u0000project"])(
  "omits path subjects when root %j cannot be trusted",
  (projectRoot) => {
    expect(projectCompletedControllerItem(fileItem("src/index.ts"), { projectRoot })?.subjectRefs)
      .toEqual(["bb-item:file_1"]);
  },
);

it.each([PROJECT_ROOT, "C:\\workspace\\project", "C:/workspace/project"])(
  "accepts slash-separated relative labels under trusted root %s",
  (projectRoot) => {
    expect(projectCompletedControllerItem(fileItem("src/index.ts"), { projectRoot })?.subjectRefs)
      .toEqual(["bb-item:file_1", "path:src/index.ts"]);
  },
);

it("orders and stably deduplicates paths and move paths under the 16-subject cap", () => {
  const changes = Array.from({ length: 20 }, (_, index) => ({
    path: index === 1 ? "src/0.ts" : `src/${index}.ts`,
    movePath: `moved/${index}.ts`,
    kind: "update" as const,
    diff: `diff-${index}`,
  }));
  const projected = projectCompletedControllerItem(fileItem("ignored", { changes }), {
    projectRoot: PROJECT_ROOT,
  });

  expect(projected?.subjectRefs).toEqual([
    "bb-item:file_1",
    "path:src/0.ts",
    "path:moved/0.ts",
    "path:moved/1.ts",
    "path:src/2.ts",
    "path:moved/2.ts",
    "path:src/3.ts",
    "path:moved/3.ts",
    "path:src/4.ts",
    "path:moved/4.ts",
    "path:src/5.ts",
    "path:moved/5.ts",
    "path:src/6.ts",
    "path:moved/6.ts",
    "path:src/7.ts",
    "path:moved/7.ts",
  ]);
});

it("rejects an item id that cannot satisfy both native and subject byte bounds", () => {
  expect(projectCompletedControllerItem(commandItem({ id: "x".repeat(249) }), {
    projectRoot: PROJECT_ROOT,
  })).toBeNull();
  expect(projectCompletedControllerItem(commandItem({ id: "😀".repeat(63) }), {
    projectRoot: PROJECT_ROOT,
  })).toBeNull();
});

it.each([
  [99, 1],
  [100, 1],
  [101, 2],
] as const)("advances across the %i-row page boundary in %i page calls", async (rowCount, pageCalls) => {
  const rows = Array.from({ length: rowCount }, (_, index) => nonCandidateEvent(index + 1));
  const fixture = readyProjectorFixture({ rows });

  const reconciled = await fixture.projector.reconcile(
    fixture.controller,
    fixture.turn,
    fixture.fence,
    new AbortController().signal,
  );

  expect(reconciled).toMatchObject({
    outcome: "reconciled",
    reconciliationIncomplete: null,
    throughSeq: rowCount,
  });
  expect(fixture.harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(pageCalls);
  expect(currentTurn(fixture.store, fixture.turn.id).evidenceEventSeq).toBe(rowCount);
});

it("uses evidenceEventSeq independently from the streaming bbEventSeq", async () => {
  const fixture = readyProjectorFixture({ rows: [completedEvent(1, commandItem())] });
  fixture.db.prepare("UPDATE controller_turns SET bb_event_seq = 1, evidence_event_seq = 0 WHERE id = ?")
    .run(fixture.turn.id);

  await fixture.projector.reconcile(
    fixture.controller,
    currentTurn(fixture.store, fixture.turn.id),
    fixture.fence,
    new AbortController().signal,
  );

  expect(fixture.store.listControllerEvidence(fixture.turn.id, 128)).toMatchObject([
    { sourceItemId: "cmd_1" },
  ]);
  expect(currentTurn(fixture.store, fixture.turn.id)).toMatchObject({
    bbEventSeq: 1,
    evidenceEventSeq: 1,
  });
});

it("reconciles exactly 5,000 rows and caps 5,001 rows at the fixed bounded prefix", async () => {
  const completeRows = Array.from({ length: 5_000 }, (_, index) => nonCandidateEvent(index + 1));
  const complete = readyProjectorFixture({ rows: completeRows });
  expect(await complete.projector.reconcile(
    complete.controller,
    complete.turn,
    complete.fence,
    new AbortController().signal,
  )).toMatchObject({
    outcome: "reconciled",
    reconciliationIncomplete: null,
    throughSeq: 5_000,
  });
  expect(complete.harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(50);

  const cappedRows = Array.from({ length: 5_001 }, (_, index) => nonCandidateEvent(index + 1));
  const capped = readyProjectorFixture({ rows: cappedRows });
  expect(await capped.projector.reconcile(
    capped.controller,
    capped.turn,
    capped.fence,
    new AbortController().signal,
  )).toMatchObject({
    outcome: "reconciled",
    reconciliationIncomplete: "page_cap",
    throughSeq: 5_000,
  });
  expect(currentTurn(capped.store, capped.turn.id).evidenceEventSeq).toBe(5_000);
  expect(capped.harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(50);
});

it("keeps one fixed snapshot and ignores rows above its high-water", async () => {
  const rows = [
    completedEvent(1, commandItem({ id: "cmd_1" })),
    completedEvent(2, commandItem({ id: "cmd_2" })),
    completedEvent(3, commandItem({ id: "cmd_after_snapshot" })),
  ];
  const fixture = readyProjectorFixture({ rows, maxSeq: 2 });

  const reconciled = await fixture.projector.reconcile(
    fixture.controller,
    fixture.turn,
    fixture.fence,
    new AbortController().signal,
  );

  expect(reconciled).toMatchObject({ outcome: "reconciled", throughSeq: 2, targetSeq: 2 });
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 128).map((row) => row.sourceItemId))
    .toEqual(["cmd_1", "cmd_2"]);
  expect(fixture.harness.inspection.sdk.callsTo("threads.timeline")).toHaveLength(1);
});

it.each([
  ["empty", () => []],
  ["short", () => [nonCandidateEvent(1)]],
] as const)("commits only the fully scanned %s prefix on a source gap", async (_label, listEvents) => {
  const fixture = readyProjectorFixture({ maxSeq: 3, listEvents });
  const write = vi.spyOn(fixture.store, "recordControllerNativeEvidence");

  const reconciled = await fixture.projector.reconcile(
    fixture.controller,
    fixture.turn,
    fixture.fence,
    new AbortController().signal,
  );

  expect(reconciled).toMatchObject({
    outcome: "reconciled",
    reconciliationIncomplete: "source_gap",
    throughSeq: _label === "empty" ? 0 : 1,
  });
  expect(write).toHaveBeenCalledTimes(1);
  expect(currentTurn(fixture.store, fixture.turn.id).evidenceEventSeq).toBe(_label === "empty" ? 0 : 1);
});

it("retries cursor conflicts twice and succeeds on the third attempt with one target", async () => {
  const rows = [nonCandidateEvent(1), nonCandidateEvent(2), nonCandidateEvent(3)];
  const fixture = readyProjectorFixture({ rows });
  const original = fixture.store.recordControllerNativeEvidence.bind(fixture.store);
  let attempts = 0;
  vi.spyOn(fixture.store, "recordControllerNativeEvidence").mockImplementation((input) => {
    attempts += 1;
    if (attempts < 3) {
      fixture.db.prepare("UPDATE controller_turns SET evidence_event_seq = ? WHERE id = ?")
        .run(attempts, fixture.turn.id);
      return "cursor_changed";
    }
    return original(input);
  });

  const reconciled = await fixture.projector.reconcile(
    fixture.controller,
    fixture.turn,
    fixture.fence,
    new AbortController().signal,
  );

  expect(reconciled).toMatchObject({ outcome: "reconciled", throughSeq: 3, targetSeq: 3 });
  expect(attempts).toBe(3);
  expect(fixture.harness.inspection.sdk.callsTo("threads.timeline")).toHaveLength(1);
  expect(fixture.harness.inspection.sdk.callsTo("threads.events.list").map((args) =>
    (args[0] as { afterSeq: string }).afterSeq)).toEqual(["0", "1", "2"]);
});

it("fails closed after a third cursor conflict while retaining the original target", async () => {
  const fixture = readyProjectorFixture({
    rows: [nonCandidateEvent(1), nonCandidateEvent(2), nonCandidateEvent(3)],
  });
  let attempts = 0;
  vi.spyOn(fixture.store, "recordControllerNativeEvidence").mockImplementation(() => {
    attempts += 1;
    if (attempts < 3) {
      fixture.db.prepare("UPDATE controller_turns SET evidence_event_seq = ? WHERE id = ?")
        .run(attempts, fixture.turn.id);
    }
    return "cursor_changed";
  });

  await expect(fixture.projector.reconcile(
    fixture.controller,
    fixture.turn,
    fixture.fence,
    new AbortController().signal,
  )).rejects.toMatchObject({ code: "cursor_conflict" });
  expect(attempts).toBe(3);
  expect(fixture.harness.inspection.sdk.callsTo("threads.timeline")).toHaveLength(1);
  expect(currentTurn(fixture.store, fixture.turn.id).evidenceEventSeq).toBe(2);
});

it("deduplicates identical ids and rejects conflicting ids within one scanned batch", async () => {
  const duplicate = commandItem({ id: "duplicate_item", aggregatedOutput: "same" });
  const identical = readyProjectorFixture({
    rows: [completedEvent(1, duplicate), completedEvent(2, duplicate)],
  });
  await identical.projector.reconcile(
    identical.controller,
    identical.turn,
    identical.fence,
    new AbortController().signal,
  );
  expect(identical.store.listControllerEvidence(identical.turn.id, 128)).toHaveLength(1);
  expect(currentTurn(identical.store, identical.turn.id).evidenceEventSeq).toBe(2);

  const conflicting = readyProjectorFixture({
    rows: [
      completedEvent(1, commandItem({ id: "conflict_item", aggregatedOutput: "first" })),
      completedEvent(2, commandItem({ id: "conflict_item", aggregatedOutput: "second" })),
    ],
  });
  await expect(conflicting.projector.reconcile(
    conflicting.controller,
    conflicting.turn,
    conflicting.fence,
    new AbortController().signal,
  )).rejects.toMatchObject({ code: "native_identity_conflict" });
  expect(conflicting.store.listControllerEvidence(conflicting.turn.id, 128)).toEqual([]);
  expect(currentTurn(conflicting.store, conflicting.turn.id).evidenceEventSeq).toBe(0);
});

it("rejects a conflicting duplicate split across two event pages", async () => {
  const rows = [
    ...Array.from({ length: 99 }, (_, index) => nonCandidateEvent(index + 1)),
    completedEvent(100, commandItem({ id: "page_conflict", aggregatedOutput: "first" })),
    completedEvent(101, commandItem({ id: "page_conflict", aggregatedOutput: "second" })),
  ];
  const fixture = readyProjectorFixture({ rows });

  await expect(fixture.projector.reconcile(
    fixture.controller,
    fixture.turn,
    fixture.fence,
    new AbortController().signal,
  )).rejects.toMatchObject({ code: "native_identity_conflict" });
  expect(fixture.harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(2);
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 128)).toEqual([]);
  expect(currentTurn(fixture.store, fixture.turn.id).evidenceEventSeq).toBe(0);
});

it("surfaces repository identity decisions across replay and restart", async () => {
  const firstEvent = completedEvent(1, commandItem({ id: "restart_item", aggregatedOutput: "same" }));
  const fixture = readyProjectorFixture({ rows: [firstEvent], maxSeq: 1 });
  await fixture.projector.reconcile(
    fixture.controller,
    fixture.turn,
    fixture.fence,
    new AbortController().signal,
  );

  fixture.harness.sdk.stub("threads.timeline", async () => ({ maxSeq: 2 }));
  fixture.harness.sdk.stub("threads.events.list", async ({ afterSeq = "0" }) => Number(afterSeq) < 2
    ? [{
        ...completedEvent(2, commandItem({ id: "restart_item", aggregatedOutput: "same" })),
        threadId: fixture.controller.threadId,
      }]
    : []);
  const restarted = new ControllerEvidenceProjector({
    sdk: fixture.bb.sdk,
    store: fixture.reopen(),
    clock: { now: () => 2_200 },
    hanoonToolNames: CONTROLLER_TOOL_NAMES,
  });
  expect(await restarted.reconcile(
    fixture.controller,
    currentTurn(fixture.store, fixture.turn.id),
    fixture.fence,
    new AbortController().signal,
  )).toMatchObject({ outcome: "reconciled", throughSeq: 2 });
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 128)).toHaveLength(1);

  fixture.harness.sdk.stub("threads.timeline", async () => ({ maxSeq: 3 }));
  fixture.harness.sdk.stub("threads.events.list", async () => [
    {
      ...completedEvent(3, commandItem({ id: "restart_item", aggregatedOutput: "changed" })),
      threadId: fixture.controller.threadId,
    },
  ]);
  await expect(restarted.reconcile(
    fixture.controller,
    currentTurn(fixture.store, fixture.turn.id),
    fixture.fence,
    new AbortController().signal,
  )).rejects.toMatchObject({ code: "native_identity_conflict" });
  expect(currentTurn(fixture.store, fixture.turn.id).evidenceEventSeq).toBe(2);
});

it("leaves both evidence and cursor unchanged when the atomic repository call crashes", async () => {
  const fixture = readyProjectorFixture({ rows: [completedEvent(1, commandItem())] });
  vi.spyOn(fixture.store, "recordControllerNativeEvidence").mockImplementation(() => {
    throw new Error("simulated crash before commit");
  });

  await expect(fixture.projector.reconcile(
    fixture.controller,
    fixture.turn,
    fixture.fence,
    new AbortController().signal,
  )).rejects.toThrow(/simulated crash/);
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 128)).toEqual([]);
  expect(currentTurn(fixture.store, fixture.turn.id).evidenceEventSeq).toBe(0);
});

it("honors abort before paging and before the repository commit", async () => {
  const beforePage = readyProjectorFixture({ rows: [nonCandidateEvent(1)] });
  const aborted = new AbortController();
  aborted.abort();
  await expect(beforePage.projector.reconcile(
    beforePage.controller,
    beforePage.turn,
    beforePage.fence,
    aborted.signal,
  )).rejects.toMatchObject({ name: "AbortError" });
  expect(beforePage.store.listControllerEvidence(beforePage.turn.id, 128)).toEqual([]);

  const beforeCommit = readyProjectorFixture({ rows: [nonCandidateEvent(1)] });
  const commitAbort = new AbortController();
  beforeCommit.harness.sdk.stub("threads.events.list", async () => {
    commitAbort.abort();
    return [{ ...nonCandidateEvent(1), threadId: beforeCommit.controller.threadId }];
  });
  await expect(beforeCommit.projector.reconcile(
    beforeCommit.controller,
    beforeCommit.turn,
    beforeCommit.fence,
    commitAbort.signal,
  )).rejects.toMatchObject({ name: "AbortError" });
  expect(currentTurn(beforeCommit.store, beforeCommit.turn.id).evidenceEventSeq).toBe(0);
});

it("surfaces stale turns without a BB read and continues after finalization", async () => {
  const stale = readyProjectorFixture({ rows: [nonCandidateEvent(1)] });
  expect(stale.store.releaseExecutorLease(
    stale.fence.ownerId,
    stale.fence.generation,
    stale.fence.now,
  )).toBe(true);
  expect(await stale.projector.reconcile(
    stale.controller,
    stale.turn,
    stale.fence,
    new AbortController().signal,
  )).toMatchObject({ outcome: "stale" });
  expect(stale.harness.inspection.sdk.calls).toEqual([]);

  const finalized = readyProjectorFixture({ rows: [nonCandidateEvent(1)] });
  installAcceptedFinalization(finalized.db, finalized.turn.id);
  expect(await finalized.projector.reconcile(
    finalized.controller,
    currentTurn(finalized.store, finalized.turn.id),
    finalized.fence,
    new AbortController().signal,
  )).toMatchObject({ outcome: "reconciled", throughSeq: 1 });
  expect(finalized.harness.inspection.sdk.calls.length).toBeGreaterThan(0);
  expect(currentTurn(finalized.store, finalized.turn.id).evidenceEventSeq).toBe(1);
});

it("marks a cap crossing without advancing, advances an identical replay at cap, and rolls back conflict", async () => {
  const crossing = readyProjectorFixture({
    rows: [completedEvent(1, commandItem({ id: "new_at_cap" }))],
  });
  for (let index = 0; index < 128; index += 1) {
    crossing.store.recordControllerEvidence({
      ...validEvidenceInput(crossing.turn),
      ...crossing.fence,
      sourceName: `direct_${index}`,
    });
  }
  expect(await crossing.projector.reconcile(
    crossing.controller,
    crossing.turn,
    crossing.fence,
    new AbortController().signal,
  )).toMatchObject({ outcome: "limit_exceeded" });
  expect(currentTurn(crossing.store, crossing.turn.id)).toMatchObject({
    evidenceEventSeq: 0,
    evidenceLimitExceededAt: 2_100,
  });

  const replay = readyProjectorFixture({
    rows: [completedEvent(1, commandItem({ id: "stored_at_cap", aggregatedOutput: "same" }))],
  });
  await replay.projector.reconcile(replay.controller, replay.turn, replay.fence, new AbortController().signal);
  for (let index = 0; index < 127; index += 1) {
    replay.store.recordControllerEvidence({
      ...validEvidenceInput(replay.turn),
      ...replay.fence,
      sourceName: `fill_${index}`,
    });
  }
  replay.harness.sdk.stub("threads.timeline", async () => ({ maxSeq: 2 }));
  replay.harness.sdk.stub("threads.events.list", async () => [
    {
      ...completedEvent(2, commandItem({ id: "stored_at_cap", aggregatedOutput: "same" })),
      threadId: replay.controller.threadId,
    },
  ]);
  expect(await replay.projector.reconcile(
    replay.controller,
    currentTurn(replay.store, replay.turn.id),
    replay.fence,
    new AbortController().signal,
  )).toMatchObject({ outcome: "reconciled", throughSeq: 2 });
  expect(currentTurn(replay.store, replay.turn.id).evidenceEventSeq).toBe(2);

  replay.harness.sdk.stub("threads.timeline", async () => ({ maxSeq: 3 }));
  replay.harness.sdk.stub("threads.events.list", async () => [
    {
      ...completedEvent(3, commandItem({ id: "stored_at_cap", aggregatedOutput: "conflict" })),
      threadId: replay.controller.threadId,
    },
  ]);
  await expect(replay.projector.reconcile(
    replay.controller,
    currentTurn(replay.store, replay.turn.id),
    replay.fence,
    new AbortController().signal,
  )).rejects.toMatchObject({ code: "native_identity_conflict" });
  expect(currentTurn(replay.store, replay.turn.id)).toMatchObject({
    evidenceEventSeq: 2,
    evidenceLimitExceededAt: null,
  });
});

const identityFailures: ReadonlyArray<readonly [string, ProjectorFixtureOptions]> = [
  ["thread id", { thread: { id: "other" } }],
  ["thread project", { thread: { projectId: "other" } }],
  ["missing environment", { thread: { environmentId: null } }],
  ["environment project", { environment: { projectId: "other" } }],
  ["environment host", { environment: { hostId: "other" } }],
  ["environment readiness", { environment: { status: "provisioning" } }],
  ["workspace provision", { environment: { workspaceProvisionType: "managed-worktree" } }],
  ["relative root", { environment: { path: "relative/root" } }],
  ["empty root", { environment: { path: "" } }],
  ["NUL root", { environment: { path: "/workspace/\u0000root" } }],
];

it.each(identityFailures)("fails closed on %s mismatch before timeline paging", async (_label, options) => {
  const fixture = readyProjectorFixture({ ...options, rows: [nonCandidateEvent(1)] });
  await expect(fixture.projector.reconcile(
    fixture.controller,
    fixture.turn,
    fixture.fence,
    new AbortController().signal,
  )).rejects.toBeInstanceOf(ControllerEvidenceProjectorError);
  expect(fixture.harness.inspection.sdk.callsTo("threads.timeline")).toEqual([]);
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 128)).toEqual([]);
});

it("uses only the attached personal environment root and never project sources", async () => {
  const fixture = readyProjectorFixture({
    rows: [completedEvent(1, fileItem("src/index.ts"))],
    environment: {
      id: "env_controller",
      projectId: "proj_1",
      hostId: "host_1",
      path: "C:\\active-environment",
      status: "ready",
      workspaceProvisionType: "personal",
    },
  });
  await fixture.projector.reconcile(
    fixture.controller,
    fixture.turn,
    fixture.fence,
    new AbortController().signal,
  );

  expect(fixture.harness.inspection.sdk.callsTo("projects.list")).toEqual([]);
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 128)[0]?.subjectRefs)
    .toEqual(["bb-item:file_1", "path:src/index.ts"]);
});

it("stores hashes and bounded descriptors but no secret-shaped native payload or absolute root", async () => {
  const rows = [
    completedEvent(1, commandItem({ aggregatedOutput: "secret-command-output" })),
    completedEvent(2, fileItem("/workspace/project/secret-file", {
      changes: [{
        path: "/workspace/project/secret-file",
        movePath: "/workspace/project/secret-move",
        kind: "update",
        diff: "secret-file-diff",
      }],
    })),
    completedEvent(3, {
      type: "webSearch",
      id: "search_1",
      queries: ["secret-search-query"],
      resultText: "secret-search-result",
    }),
    completedEvent(4, {
      type: "webFetch",
      id: "fetch_1",
      url: "https://secret.invalid/private-url",
      prompt: "secret-fetch-prompt",
      pattern: "secret-fetch-pattern",
      resultText: "secret-fetch-result",
    }),
    completedEvent(5, {
      type: "imageView",
      id: "image_1",
      path: "/workspace/project/secret-image.png",
    }),
    completedEvent(6, toolItem("external_secret_tool")),
  ];
  const fixture = readyProjectorFixture({ rows });
  await fixture.projector.reconcile(
    fixture.controller,
    fixture.turn,
    fixture.fence,
    new AbortController().signal,
  );

  const persisted = fixture.db.prepare("SELECT * FROM controller_evidence ORDER BY id").all();
  const durableText = JSON.stringify(persisted);
  for (const secret of [
    "secret-command",
    "secret-command-output",
    "secret-file-diff",
    "secret-search-query",
    "secret-search-result",
    "https://secret.invalid/private-url",
    "secret-fetch-prompt",
    "secret-fetch-pattern",
    "secret-fetch-result",
    "secret-image.png",
    "secret-argument",
    "secret-result",
    PROJECT_ROOT,
  ]) expect(durableText).not.toContain(secret);
  expect(persisted).toHaveLength(6);
  expect(new Set((persisted as Array<{ observed_at: number }>).map((row) => row.observed_at)))
    .toEqual(new Set([2_100]));
});

it("does not spin or read BB again after the evidence cap is already marked", async () => {
  const fixture = readyProjectorFixture({ rows: [nonCandidateEvent(1)] });
  fixture.db.prepare("UPDATE controller_turns SET evidence_limit_exceeded_at = 2_000 WHERE id = ?")
    .run(fixture.turn.id);

  expect(await fixture.projector.reconcile(
    fixture.controller,
    currentTurn(fixture.store, fixture.turn.id),
    fixture.fence,
    new AbortController().signal,
  )).toMatchObject({ outcome: "limit_exceeded" });
  expect(fixture.harness.inspection.sdk.calls).toEqual([]);
});

it("requires the exact active controller record passed to reconciliation", async () => {
  const fixture = readyProjectorFixture({ rows: [nonCandidateEvent(1)] });
  const forged: ControllerThreadRecord = { ...fixture.controller, hostId: "forged-host" };

  expect(await fixture.projector.reconcile(
    forged,
    fixture.turn,
    fixture.fence,
    new AbortController().signal,
  )).toMatchObject({ outcome: "stale" });
  expect(fixture.harness.inspection.sdk.calls).toEqual([]);
});
