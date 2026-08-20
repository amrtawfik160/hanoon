import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { openStore } from "../src/storage/store";
import {
  buildListSelfDiagnosisPullRequestsCommand,
  buildSelfDiagnosisPullRequestCommand,
  parseDraftSelfDiagnosisPullRequest,
  parseOpenSelfDiagnosisPullRequests,
} from "../src/bb/pr-publish";
import {
  SELF_DIAGNOSIS_COOLDOWN_MS,
  SelfDiagnosisService,
  buildSelfDiagnosisPullRequestBody,
  buildSelfDiagnosisPrompt,
  buildSelfDiagnosisWorkOrder,
  findSelfDiagnosisCandidates,
  parseSelfDiagnosisOutput,
  type SelfDiagnosisCandidate,
  type SelfDiagnosisLedgerState,
} from "../src/services/self-diagnosis-service";

const NOW = 10_000;
const MODEL_ROUTE = {
  pool: "fast" as const,
  providerId: "codex",
  modelId: "test-model",
  reasoning: "low" as const,
  serviceTier: "default" as const,
};

function candidate(overrides: Partial<SelfDiagnosisCandidate> = {}): SelfDiagnosisCandidate {
  return {
    sourceId: "turn_failed",
    turnId: "turn_failed",
    kind: "failed_turn",
    state: "failed",
    threadState: "failed",
    updatedAt: NOW - 1_000,
    ageMs: 1_000,
    lastError: "Controller turn failed safely",
    streamPhase: "failed",
    acceptedFinalization: false,
    completionContinuations: 0,
    eventSeq: 2,
    evidenceSeq: 1,
    toolCalls: 0,
    commandFailures: 0,
    ...overrides,
  };
}

function memoryLedger(initial?: SelfDiagnosisLedgerState) {
  let state = initial;
  return {
    async get() {
      return state;
    },
    async set(next: SelfDiagnosisLedgerState) {
      state = next;
    },
    state() {
      return state;
    },
  };
}

describe("self-diagnosis persistence scan", () => {
  it("detects persisted failed turns without reading chat text", () => {
    const { bb } = createFakePluginHost({ pluginId: "self-diagnosis-test" });
    const store = openStore(bb.storage, bb.storage.kv, () => NOW);
    const db = bb.storage.database();

    db.prepare(
      `INSERT INTO controller_threads (
         controller_key, telegram_user_id, telegram_chat_id, project_id, host_id,
         bb_thread_id, state, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "controller:test",
      "owner-id",
      "chat-id",
      "project-1",
      "host-1",
      "bb-thread-1",
      "failed",
      "Controller thread failed safely",
      1,
      NOW - 2_000,
    );
    db.prepare(
      `INSERT INTO controller_turns (
         id, telegram_update_id, controller_key, ordinal, input_text, state,
         last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "turn_failed",
      1,
      "controller:test",
      1,
      "private chat contents must never reach diagnosis output",
      "failed",
      "Controller turn failed safely",
      1,
      NOW - 1_000,
    );

    const insertThread = db.prepare(
      `INSERT INTO controller_threads (
         controller_key, telegram_user_id, telegram_chat_id, project_id, host_id,
         bb_thread_id, state, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertTurn = db.prepare(
      `INSERT INTO controller_turns (
         id, telegram_update_id, controller_key, ordinal, input_text, state,
         last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertThread.run("controller:last-error", "owner-id", "chat-id", "project-1", "host-1", "bb-thread-2", "active", null, 1, NOW - 4_000);
    insertTurn.run("turn_last_error", 2, "controller:last-error", 1, "unread user text", "submitted", "Persisted failure summary", 1, NOW - 3_000);
    insertThread.run("controller:missing", "owner-id", "chat-id", "project-1", "host-1", "bb-thread-3", "active", null, 1, NOW - 5_000);
    insertTurn.run("turn_missing", 3, "controller:missing", 1, "unread user text", "completed", null, 1, NOW - 5_000);
    insertThread.run("controller:stalled", "owner-id", "chat-id", "project-1", "host-1", "bb-thread-4", "active", null, 1, NOW - 500_000);
    insertTurn.run("turn_stalled", 4, "controller:stalled", 1, "unread user text", "submitted", null, 1, NOW - 500_000);
    insertThread.run("controller:thread-error", "owner-id", "chat-id", "project-1", "host-1", "bb-thread-5", "failed", "Thread failure summary", 1, NOW - 6_000);

    const candidates = findSelfDiagnosisCandidates(db, NOW, 10);

    expect(candidates).toHaveLength(5);
    expect(candidates.find((candidate) => candidate.sourceId === "turn_failed")).toMatchObject({
      sourceId: "turn_failed",
      turnId: "turn_failed",
      kind: "failed_turn",
      state: "failed",
      lastError: "Controller turn failed safely",
    });
    expect(new Set(candidates.map((candidate) => candidate.kind))).toEqual(new Set([
      "failed_turn",
      "missing_finalization",
      "stalled_turn",
      "failed_thread",
    ]));
    expect(buildSelfDiagnosisPrompt(candidates.find((candidate) => candidate.sourceId === "turn_failed")!))
      .not.toContain("private chat contents");
    expect(buildSelfDiagnosisPrompt(candidates.find((candidate) => candidate.sourceId === "turn_failed")!))
      .toContain("failed_turn");
    void store;
  });
});

describe("self-diagnosis analysis and safety gates", () => {
  it("parses a structured diagnosis and rejects unsafe model output", () => {
    expect(parseSelfDiagnosisOutput(JSON.stringify({
      whatFailed: "A submitted controller turn stopped before finalization",
      evidence: ["state=submitted", "accepted_finalization=false"],
      hypothesis: "The reconciliation boundary did not observe a terminal event",
      candidateFix: "Add a bounded reconciliation fallback and regression test",
    }))).toEqual({
      whatFailed: "A submitted controller turn stopped before finalization",
      evidence: ["state=submitted", "accepted_finalization=false"],
      hypothesis: "The reconciliation boundary did not observe a terminal event",
      candidateFix: "Add a bounded reconciliation fallback and regression test",
    });

    expect(parseSelfDiagnosisOutput(JSON.stringify({
      whatFailed: "A turn failed",
      evidence: ["Bearer secret-token-value"],
      hypothesis: "The boundary failed",
      candidateFix: "Add a test",
    }))).toBeNull();
  });

  it("runs once out of band, stores the structured diagnosis, and publishes at most one draft", async () => {
    const ledger = memoryLedger();
    const analyze = vi.fn(async () => ({
      diagnosis: {
        whatFailed: "A submitted controller turn stopped before finalization",
        evidence: ["state=submitted", "accepted_finalization=false"],
        hypothesis: "The reconciliation boundary did not observe a terminal event",
        candidateFix: "Add a bounded reconciliation fallback and regression test",
      },
      environmentId: "env-1",
      environmentStatus: { checkout: { branchName: "bb/self-diagnosis-abc" } },
    }));
    const publish = vi.fn(async () => ({
      outcome: "published" as const,
      number: 42,
      url: "https://github.com/example/repo/pull/42",
    }));
    const service = new SelfDiagnosisService({
      enabled: () => true,
      readCandidates: () => [candidate()],
      resolveTarget: async () => ({
        projectId: "project-1",
        baseBranch: "main",
        hostId: "host-1",
        cwd: "/workspace/repo",
      }),
      ledger,
      github: { listOpen: async () => [] },
      analyze,
      publish,
      modelRoute: () => MODEL_ROUTE,
      clock: { now: () => NOW },
      idFactory: () => "diag_abc123",
    });

    await expect(service.runOnce()).resolves.toMatchObject({ outcome: "published" });
    expect(analyze).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(ledger.state()?.records[0]).toMatchObject({
      sourceId: "turn_failed",
      diagnosisId: "diag_abc123",
      outcome: "published",
      prUrl: "https://github.com/example/repo/pull/42",
    });
    expect(ledger.state()?.records[0]?.diagnosis).toEqual({
      whatFailed: "A submitted controller turn stopped before finalization",
      evidence: ["state=submitted", "accepted_finalization=false"],
      hypothesis: "The reconciliation boundary did not observe a terminal event",
      candidateFix: "Add a bounded reconciliation fallback and regression test",
    });
  });

  it("serializes concurrent passes so one persisted failure cannot create two attempts", async () => {
    const ledger = memoryLedger();
    const service = new SelfDiagnosisService({
      enabled: () => true,
      readCandidates: () => [candidate()],
      resolveTarget: async () => ({ projectId: "project-1", baseBranch: "main", hostId: "host-1", cwd: "/repo" }),
      ledger,
      github: { listOpen: async () => [] },
      analyze: async () => ({
        diagnosis: {
          whatFailed: "A turn failed",
          evidence: ["state=failed"],
          hypothesis: "A boundary failed",
          candidateFix: "Add a regression test",
        },
        environmentId: "env-1",
        environmentStatus: { checkout: { branchName: "bb/self-diagnosis" } },
      }),
      publish: async () => ({ outcome: "published" as const, number: 9, url: "https://github.com/example/repo/pull/9" }),
      modelRoute: () => MODEL_ROUTE,
      clock: { now: () => NOW },
    });

    const outcomes = await Promise.all([service.runOnce(), service.runOnce()]);

    expect(outcomes.map((result) => result.outcome)).toEqual(["published", "already-attempted"]);
    expect(ledger.state()?.records).toHaveLength(1);
  });

  it("holds the open-PR gate and the cooldown without retrying the same failure", async () => {
    const ledger = memoryLedger();
    const analyze = vi.fn();
    const publish = vi.fn();
    const service = new SelfDiagnosisService({
      enabled: () => true,
      readCandidates: () => [candidate()],
      resolveTarget: async () => ({ projectId: "project-1", baseBranch: "main", hostId: "host-1", cwd: "/repo" }),
      ledger,
      github: { listOpen: async () => [{ number: 7, url: "https://github.com/example/repo/pull/7" }] },
      analyze,
      publish,
      modelRoute: () => MODEL_ROUTE,
      clock: { now: () => NOW },
    });

    await expect(service.runOnce()).resolves.toMatchObject({ outcome: "open-pr" });
    expect(analyze).not.toHaveBeenCalled();

    const afterOpen = memoryLedger({
      version: 1,
      lastAttemptAt: NOW - SELF_DIAGNOSIS_COOLDOWN_MS - 1,
      records: [{
        sourceId: "turn_failed",
        diagnosisId: "diag_old",
        kind: "failed_turn",
        attemptedAt: NOW - SELF_DIAGNOSIS_COOLDOWN_MS - 1,
        outcome: "failed",
        diagnosis: null,
        prUrl: null,
      }],
    });
    const afterFailedAttempt = new SelfDiagnosisService({
      enabled: () => true,
      readCandidates: () => [candidate()],
      resolveTarget: async () => ({ projectId: "project-1", baseBranch: "main", hostId: "host-1", cwd: "/repo" }),
      ledger: afterOpen,
      github: { listOpen: async () => [] },
      analyze,
      publish,
      modelRoute: () => MODEL_ROUTE,
      clock: { now: () => NOW },
    });

    await expect(afterFailedAttempt.runOnce()).resolves.toMatchObject({ outcome: "already-attempted" });
    expect(analyze).not.toHaveBeenCalled();

    const cooldown = memoryLedger({
      version: 1,
      lastAttemptAt: NOW,
      records: [],
    });
    const duringCooldown = new SelfDiagnosisService({
      enabled: () => true,
      readCandidates: () => [candidate({ sourceId: "turn_new" })],
      resolveTarget: async () => ({ projectId: "project-1", baseBranch: "main", hostId: "host-1", cwd: "/repo" }),
      ledger: cooldown,
      github: { listOpen: async () => [] },
      analyze,
      publish,
      modelRoute: () => MODEL_ROUTE,
      clock: { now: () => NOW + 1 },
    });

    await expect(duringCooldown.runOnce()).resolves.toMatchObject({ outcome: "cooldown" });
    expect(publish).not.toHaveBeenCalled();
  });

  it("fails open on scanner, GitHub, analysis, and publish errors", async () => {
    const outcomes = await Promise.all([
      new SelfDiagnosisService({
        enabled: () => true,
        readCandidates: () => { throw new Error("database unavailable"); },
        resolveTarget: async () => null,
        ledger: memoryLedger(),
        github: { listOpen: async () => [] },
      analyze: async () => { throw new Error("not reached"); },
      publish: async () => ({ outcome: "missing" as const, reason: "not reached" }),
        modelRoute: () => MODEL_ROUTE,
        clock: { now: () => NOW },
      }).runOnce(),
      new SelfDiagnosisService({
        enabled: () => true,
        readCandidates: () => [candidate({ sourceId: "turn_github" })],
        resolveTarget: async () => ({ projectId: "project-1", baseBranch: "main", hostId: "host-1", cwd: "/repo" }),
        ledger: memoryLedger(),
        github: { listOpen: async () => { throw new Error("GitHub unavailable"); } },
        analyze: async () => { throw new Error("not reached"); },
        publish: async () => ({ outcome: "missing" as const, reason: "not reached" }),
        modelRoute: () => MODEL_ROUTE,
        clock: { now: () => NOW },
      }).runOnce(),
      new SelfDiagnosisService({
        enabled: () => true,
        readCandidates: () => [candidate({ sourceId: "turn_analyze" })],
        resolveTarget: async () => ({ projectId: "project-1", baseBranch: "main", hostId: "host-1", cwd: "/repo" }),
        ledger: memoryLedger(),
        github: { listOpen: async () => [] },
        analyze: async () => { throw new Error("analysis unavailable"); },
        publish: async () => ({ outcome: "missing" as const, reason: "not reached" }),
        modelRoute: () => MODEL_ROUTE,
        clock: { now: () => NOW },
      }).runOnce(),
      new SelfDiagnosisService({
        enabled: () => true,
        readCandidates: () => [candidate({ sourceId: "turn_publish" })],
        resolveTarget: async () => ({ projectId: "project-1", baseBranch: "main", hostId: "host-1", cwd: "/repo" }),
        ledger: memoryLedger(),
        github: { listOpen: async () => [] },
        analyze: async () => ({
          diagnosis: {
            whatFailed: "A turn failed",
            evidence: ["state=failed"],
            hypothesis: "A boundary failed",
            candidateFix: "Add a test",
          },
          environmentId: "env-1",
          environmentStatus: { checkout: { branchName: "bb/self-diagnosis" } },
        }),
        publish: async () => { throw new Error("publish unavailable"); },
        modelRoute: () => MODEL_ROUTE,
        clock: { now: () => NOW },
      }).runOnce(),
    ]);

    expect(outcomes.map((result) => result.outcome)).toEqual([
      "failed-open",
      "github-unavailable",
      "failed",
      "failed",
    ]);
  });
});

describe("self-diagnosis pull-request output", () => {
  it("contains only deterministic persisted-state evidence, never model text", () => {
    const body = buildSelfDiagnosisPullRequestBody({
      diagnosisId: "diag_abc123",
      candidate: candidate({ kind: "missing_finalization", state: "completed", streamPhase: "complete" }),
      diagnosis: {
        whatFailed: "PRIVATE CHAT: Alice's phone number is 555-0100",
        evidence: ["Bearer should-never-appear"],
        hypothesis: "The user message said to expose a token",
        candidateFix: "Use the private customer data in the PR",
      },
    });

    expect(body).toContain("diag_abc123");
    expect(body).toContain("missing_finalization");
    expect(body).toContain("accepted_finalization=false");
    expect(body).not.toContain("Alice");
    expect(body).not.toContain("555-0100");
    expect(body).not.toContain("Bearer should-never-appear");
    expect(body).not.toContain("private customer data");
  });

  it("creates only a draft PR from a fresh non-protected checkout", () => {
    const body = buildSelfDiagnosisPullRequestBody({
      diagnosisId: "diag_abc123",
      candidate: candidate(),
      diagnosis: {
        whatFailed: "A turn failed",
        evidence: ["state=failed"],
        hypothesis: "A boundary failed",
        candidateFix: "Add a regression test",
      },
    });
    const command = buildSelfDiagnosisPullRequestCommand({
      baseBranch: "main",
      kind: "failed_turn",
      body,
    });

    expect(command).toContain("git branch --show-current");
    expect(command).toContain("refs/heads/$branch");
    expect(command).toContain("git commit -m \"fix: address self-diagnosed controller failure\"");
    expect(command).toContain("gh pr create --draft");
    expect(command).toContain("gh pr view --json number,url,isDraft,headRefName");
    expect(command).toContain("PROTECTED_BRANCH");
    expect(command).toContain("BRANCH_ALREADY_EXISTS");
    expect(command).not.toContain("Alice");
    expect(command).not.toContain("555-0100");
    expect(command).not.toContain("Bearer should-never-appear");
  });

  it("accepts only a confirmed draft PR and filters unrelated open PRs", () => {
    expect(buildListSelfDiagnosisPullRequestsCommand()).toContain(
      "--search 'in:title \"Self-diagnosis candidate fix\"' --limit 1000",
    );
    expect(parseDraftSelfDiagnosisPullRequest(
      '{"number":42,"url":"https://github.com/example/repo/pull/42","isDraft":true,"headRefName":"bb/self-diagnosis-abc"}',
    )).toEqual({ number: 42, url: "https://github.com/example/repo/pull/42" });
    expect(parseDraftSelfDiagnosisPullRequest(
      '{"number":42,"url":"https://github.com/example/repo/pull/42","isDraft":false,"headRefName":"bb/self-diagnosis-abc"}',
    )).toBeNull();
    expect(parseOpenSelfDiagnosisPullRequests(JSON.stringify([
      { number: 1, url: "https://github.com/example/repo/pull/1", title: "unrelated change" },
      { number: 2, url: "https://github.com/example/repo/pull/2", title: "Self-diagnosis candidate fix: stalled_turn" },
    ]))).toEqual([{ number: 2, url: "https://github.com/example/repo/pull/2" }]);
    expect(parseOpenSelfDiagnosisPullRequests("not json")).toBeNull();
  });
});

describe("filing a diagnosis as pipeline work", () => {
  const DIAGNOSIS = {
    whatFailed: "A submitted controller turn stopped before finalization",
    evidence: ["state=submitted"],
    hypothesis: "The reconciliation boundary did not observe a terminal event",
    candidateFix: "Add a bounded reconciliation fallback and regression test",
  };

  function pipelineService(overrides: {
    mode?: () => "draft-pr" | "pipeline";
    filePipelineJob?: ReturnType<typeof vi.fn>;
    publish?: ReturnType<typeof vi.fn>;
    warn?: (message: string) => void;
  }) {
    const publish = overrides.publish ?? vi.fn(async () => ({
      outcome: "published" as const,
      number: 42,
      url: "https://github.com/example/repo/pull/42",
    }));
    const ledger = memoryLedger();
    const service = new SelfDiagnosisService({
      enabled: () => true,
      readCandidates: () => [candidate()],
      resolveTarget: async () => ({
        projectId: "proj_self",
        baseBranch: "main",
        hostId: "host-1",
        cwd: "/workspace/repo",
      }),
      ledger,
      github: { listOpen: async () => [] },
      analyze: async () => ({
        diagnosis: DIAGNOSIS,
        environmentId: "env-1",
        environmentStatus: { checkout: { branchName: "bb/self-diagnosis" } },
      }),
      publish,
      ...(overrides.mode === undefined ? {} : { mode: overrides.mode }),
      ...(overrides.filePipelineJob === undefined ? {} : { filePipelineJob: overrides.filePipelineJob }),
      modelRoute: () => MODEL_ROUTE,
      clock: { now: () => NOW },
      idFactory: () => "diag_abc123",
      ...(overrides.warn === undefined ? {} : { warn: overrides.warn }),
    });
    return { service, publish, ledger };
  }

  it("writes the diagnosis as a work order that says it is only a guess", () => {
    const order = buildSelfDiagnosisWorkOrder({ candidate: candidate(), diagnosis: DIAGNOSIS });

    expect(order).toContain(DIAGNOSIS.whatFailed);
    expect(order).toContain(DIAGNOSIS.candidateFix);
    // A diagnosis that turns out to be wrong must stop, not be implemented.
    expect(order).toMatch(/if it is wrong/i);
    expect(order).not.toContain("\n");
  });

  it("still pushes a draft pull request when nothing asked for pipeline mode", async () => {
    const filePipelineJob = vi.fn();
    const { service, publish } = pipelineService({ filePipelineJob });

    await expect(service.runOnce()).resolves.toMatchObject({ outcome: "published" });
    expect(filePipelineJob).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
  });

  it("files a pipeline job instead of a draft pull request in pipeline mode", async () => {
    const filePipelineJob = vi.fn(() => ({ outcome: "filed" as const, jobId: "job_from_diagnosis" }));
    const { service, publish, ledger } = pipelineService({
      mode: () => "pipeline",
      filePipelineJob,
    });

    await expect(service.runOnce()).resolves.toEqual({ outcome: "filed", jobId: "job_from_diagnosis" });
    expect(publish).not.toHaveBeenCalled();
    expect(filePipelineJob).toHaveBeenCalledOnce();
    expect(filePipelineJob.mock.calls[0]?.[0]).toMatchObject({
      diagnosisId: "diag_abc123",
      target: { projectId: "proj_self" },
    });
    // The attempt is spent either way: this failure has had its one look.
    expect(ledger.state()?.records[0]).toMatchObject({ outcome: "published", prUrl: null });
  });

  it("falls back to the draft pull request, saying why, when the project cannot take the work", async () => {
    const warn = vi.fn();
    const { service, publish } = pipelineService({
      mode: () => "pipeline",
      filePipelineJob: vi.fn(() => ({
        outcome: "fallback" as const,
        reason: "the project has no audit intake allowance",
      })),
      warn,
    });

    await expect(service.runOnce()).resolves.toMatchObject({ outcome: "published" });
    expect(publish).toHaveBeenCalledOnce();
    expect(warn.mock.calls.flat().join(" ")).toContain("no audit intake allowance");
  });

  it("falls back to the draft pull request when filing throws", async () => {
    const { service, publish } = pipelineService({
      mode: () => "pipeline",
      filePipelineJob: vi.fn(() => {
        throw new Error("database is locked");
      }),
    });

    await expect(service.runOnce()).resolves.toMatchObject({ outcome: "published" });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("falls back to the draft pull request when this installation cannot file at all", async () => {
    const { service, publish } = pipelineService({ mode: () => "pipeline" });

    await expect(service.runOnce()).resolves.toMatchObject({ outcome: "published" });
    expect(publish).toHaveBeenCalledOnce();
  });
});
