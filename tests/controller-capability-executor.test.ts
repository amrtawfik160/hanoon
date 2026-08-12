import { expect, it, vi } from "vitest";
import {
  canonicalControllerJson,
  ControllerCapabilityExecutionError,
  executeControllerCapability,
  sha256ControllerJson,
  type ControllerCapabilityDependencies,
} from "../src/controller/capability-executor";
import { CONTROLLER_CAPABILITIES } from "../src/controller/capability-policy";
import { verifiedPipelineOutcome } from "../src/controller/tools";
import { registeredControllerFixture, submittedControllerFixture } from "./support/controller-trust-fixtures";
import { policyFixture } from "./helpers";

function executorFixture() {
  const fixture = submittedControllerFixture();
  const controller = fixture.store.getControllerForOwner("7", "7");
  if (!controller?.threadId || !controller.projectId) throw new Error("controller fixture is incomplete");
  const context = {
    threadId: controller.threadId,
    projectId: controller.projectId,
    signal: new AbortController().signal,
  };
  const dependencies: ControllerCapabilityDependencies = {
    store: fixture.store,
    now: () => 2_000,
    credential: { credential: "none", audience: "none" },
  };
  return { ...fixture, context, dependencies };
}

const globalScope = { kind: "controller_global", entityRefs: [] as string[], matches: true } as const;

it("does not invoke a domain call when the adopted executor fence is stale", async () => {
  const fixture = executorFixture();
  expect(fixture.store.releaseExecutorLease(
    fixture.fence.ownerId,
    fixture.fence.generation,
    fixture.fence.now,
  )).toBe(true);
  const run = vi.fn(() => ({ projects: [] }));

  await expect(executeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
    params: {},
    context: fixture.context,
    scope: globalScope,
    run,
    projectEvidence: () => ({ outcome: "observed", proofKinds: ["project_state"], subjectRefs: [] }),
  })).rejects.toThrow(/fence/i);

  expect(run).not.toHaveBeenCalled();
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 10)).toEqual([]);
});

it.each([
  ["dispatching turn", "UPDATE controller_turns SET state = 'dispatching' WHERE id = ?", "turn"],
  ["forged thread", null, "identity"],
  ["forged project", null, "identity"],
] as const)("fails closed before execution for a %s", async (scenario, sql, errorCode) => {
  const fixture = executorFixture();
  if (sql) fixture.db.prepare(sql).run(fixture.turn.id);
  const context = scenario === "forged thread"
    ? { ...fixture.context, threadId: "thr_forged" }
    : scenario === "forged project"
      ? { ...fixture.context, projectId: "proj_forged" }
      : fixture.context;
  const run = vi.fn(() => ({ projects: [] }));

  await expect(executeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
    params: {},
    context,
    scope: globalScope,
    run,
    projectEvidence: () => ({ outcome: "observed", proofKinds: ["project_state"], subjectRefs: [] }),
  })).rejects.toThrow(new RegExp(errorCode, "i"));
  expect(run).not.toHaveBeenCalled();
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 10)).toEqual([]);
});

it.each([
  ["unreadable policy", { policyReadable: false }],
  ["wrong entity scope", { scope: { kind: "exact_entity", entityRefs: ["project:proj_other"], matches: false } }],
  ["credential audience mismatch", { credentialAudienceMatches: false }],
] as const)("denies %s without exposing input or writing evidence", async (_scenario, override) => {
  const fixture = executorFixture();
  const run = vi.fn(() => ({ secretResult: "must-not-escape" }));
  const execution = executeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_start_job,
    params: { projectId: "proj_secret", task: "raw-secret-task" },
    context: fixture.context,
    scope: "scope" in override
      ? override.scope
      : { kind: "exact_entity", entityRefs: ["project:proj_secret"], matches: true },
    policyReadable: "policyReadable" in override ? override.policyReadable : undefined,
    credentialAudienceMatches: "credentialAudienceMatches" in override
      ? override.credentialAudienceMatches
      : undefined,
    run,
    projectEvidence: () => ({ outcome: "succeeded", proofKinds: ["job_state"], subjectRefs: ["job:job_secret"] }),
  });

  const error = await execution.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain("raw-secret-task");
  expect(String(error)).not.toContain("must-not-escape");
  expect(run).not.toHaveBeenCalled();
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 10)).toEqual([]);
});

it("commits evidence before returning the exact bounded envelope", async () => {
  const fixture = executorFixture();
  const output = await executeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
    params: {},
    context: fixture.context,
    scope: globalScope,
    run: () => ({ projects: [{ id: "proj_1" }] }),
    projectEvidence: () => ({
      outcome: "observed",
      proofKinds: ["project_state"],
      subjectRefs: ["project:proj_1"],
    }),
  });

  expect(JSON.parse(output)).toEqual({
    _hanoonEvidence: {
      observedAt: 2_000,
      outcome: "observed",
      proofKinds: ["project_state"],
      ref: "evidence:1",
      subjectRefs: ["project:proj_1"],
    },
    projects: [{ id: "proj_1" }],
  });
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 10)).toHaveLength(1);
});

it("rechecks the executor fence after the domain call and before evidence", async () => {
  const fixture = executorFixture();
  const run = vi.fn(() => {
    expect(fixture.store.releaseExecutorLease(
      fixture.fence.ownerId,
      fixture.fence.generation,
      fixture.fence.now,
    )).toBe(true);
    return { projects: [] };
  });

  await expect(executeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
    params: {},
    context: fixture.context,
    scope: globalScope,
    run,
    projectEvidence: () => ({ outcome: "observed", proofKinds: ["project_state"], subjectRefs: [] }),
  })).rejects.toThrow(/fence/i);
  expect(run).toHaveBeenCalledOnce();
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 10)).toEqual([]);
});

it.each([
  ["null", null],
  ["array", []],
  ["class instance", new (class UnsafeResult { public ok = true; })()],
  ["non-finite number", { count: Number.NaN }],
  ["reserved envelope", { _hanoonEvidence: {} }],
  ["sparse array", { values: new Array(1) }],
] as const)("rejects a %s domain result", async (_scenario, domainResult) => {
  const fixture = executorFixture();
  await expect(executeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
    params: {},
    context: fixture.context,
    scope: globalScope,
    run: () => domainResult,
    projectEvidence: () => ({ outcome: "observed", proofKinds: [], subjectRefs: [] }),
  })).rejects.toThrow(/result|json|object/i);
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 10)).toEqual([]);
});

it("rejects accessors without invoking them and rejects cycles", async () => {
  const fixture = executorFixture();
  const getter = vi.fn(() => "unsafe");
  const accessor = Object.defineProperty({}, "unsafe", { enumerable: true, get: getter });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  for (const domainResult of [accessor, cyclic]) {
    await expect(executeControllerCapability(fixture.dependencies, {
      descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
      params: {},
      context: fixture.context,
      scope: globalScope,
      run: () => domainResult,
      projectEvidence: () => ({ outcome: "observed", proofKinds: [], subjectRefs: [] }),
    })).rejects.toThrow(/result|json|accessor|cycle/i);
  }
  expect(getter).not.toHaveBeenCalled();
});

it("uses JavaScript code-unit ordering for canonical JSON and SHA-256", () => {
  const value = { "😀": 4, "ä": 3, a: 2, Z: 1 };
  const canonical = '{"Z":1,"a":2,"ä":3,"😀":4}';
  expect(canonicalControllerJson(value)).toBe(canonical);
  expect(sha256ControllerJson(value)).toBe("ff33e069bbe182b79d1be937adbd97aeae0521b66ea8b20f642298cace347b43");
});

it("preserves an own __proto__ JSON key without prototype mutation or pollution", () => {
  const parsed = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;

  expect(canonicalControllerJson(parsed)).toBe('{"__proto__":{"polluted":true}}');
  expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
  expect((Object.prototype as { polluted?: boolean }).polluted).toBeUndefined();
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
});

it("enforces result limits in UTF-8 bytes without truncation", async () => {
  const fixture = executorFixture();
  await expect(executeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
    params: {},
    context: fixture.context,
    scope: globalScope,
    run: () => ({ text: "é".repeat(4_000) }),
    projectEvidence: () => ({ outcome: "observed", proofKinds: [], subjectRefs: [] }),
  })).rejects.toThrow(/bound|limit|byte/i);
});

it("suppresses success when the evidence insert throws", async () => {
  const fixture = executorFixture();
  fixture.db.exec("DROP TABLE controller_evidence");
  await expect(executeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
    params: {},
    context: fixture.context,
    scope: globalScope,
    run: () => ({ projects: [] }),
    projectEvidence: () => ({ outcome: "observed", proofKinds: ["project_state"], subjectRefs: [] }),
  })).rejects.toThrow();
});

it.each(["stale", "limit_exceeded", "duplicate"] as const)(
  "suppresses success for a non-recorded %s evidence result",
  async (outcome) => {
    const fixture = executorFixture();
    vi.spyOn(fixture.store, "recordControllerEvidence").mockReturnValue(outcome === "duplicate"
      ? { outcome, evidence: {} as never }
      : { outcome });

    const error = await executeControllerCapability(fixture.dependencies, {
      descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
      params: {},
      context: fixture.context,
      scope: globalScope,
      run: () => ({ projects: [] }),
      projectEvidence: () => ({ outcome: "observed", proofKinds: ["project_state"], subjectRefs: [] }),
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "evidence_write_failed" });
  },
);

it("preserves 16 trusted subjects in order and rejects a seventeenth", async () => {
  const accepted = executorFixture();
  const refs = Array.from({ length: 16 }, (_, index) => `project:proj_${index}`);
  const output = JSON.parse(await executeControllerCapability(accepted.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
    params: {},
    context: accepted.context,
    scope: globalScope,
    run: () => ({ projects: [] }),
    projectEvidence: () => ({ outcome: "observed", proofKinds: ["project_state"], subjectRefs: refs }),
  }));
  expect(output._hanoonEvidence.subjectRefs).toEqual(refs);

  const rejected = executorFixture();
  await expect(executeControllerCapability(rejected.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
    params: {},
    context: rejected.context,
    scope: globalScope,
    run: () => ({ projects: [] }),
    projectEvidence: () => ({
      outcome: "observed",
      proofKinds: ["project_state"],
      subjectRefs: [...refs, "project:proj_16"],
    }),
  })).rejects.toMatchObject({ code: "evidence_projection_invalid" });
});

it("uses a coded safe execution error for permanent normalization failures", async () => {
  const fixture = executorFixture();
  const error = await executeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
    params: { secret: "raw-param-secret" },
    context: fixture.context,
    scope: globalScope,
    run: () => ({ value: Number.NaN, secret: "raw-result-secret" }),
    projectEvidence: () => ({ outcome: "observed", proofKinds: [], subjectRefs: [] }),
  }).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ControllerCapabilityExecutionError);
  expect(error).toMatchObject({ code: "domain_result_invalid" });
  expect(String(error)).not.toContain("raw-param-secret");
  expect(String(error)).not.toContain("raw-result-secret");
});

it("replays only the canonical domain object and records a fresh observation", async () => {
  const fixture = executorFixture();
  const run = vi.fn(() => ({ remembered: { id: "mem-1", subject: "style", scope: "owner" } }));
  const input = {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_remember,
    params: { subject: "style", body: "Use short answers.", kind: "fact" },
    context: fixture.context,
    scope: globalScope,
    run,
    projectEvidence: () => ({
      outcome: "succeeded" as const,
      proofKinds: ["memory_state"] as const,
      subjectRefs: ["memory:mem-1"],
    }),
  };

  const first = JSON.parse(await executeControllerCapability(fixture.dependencies, input));
  const replay = JSON.parse(await executeControllerCapability(fixture.dependencies, input));

  expect(run).toHaveBeenCalledOnce();
  expect(first.remembered).toEqual(replay.remembered);
  expect(first._hanoonEvidence).toMatchObject({ ref: "evidence:1", outcome: "succeeded" });
  expect(replay._hanoonEvidence).toMatchObject({ ref: "evidence:2", outcome: "observed" });
  expect(fixture.store.listToolReceipts(fixture.turn.id)).toEqual([
    expect.objectContaining({
      state: "completed",
      result: '{"remembered":{"id":"mem-1","scope":"owner","subject":"style"}}',
    }),
  ]);
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 10)).toHaveLength(2);
});

it("records interrupted receipt uncertainty without invoking the domain call", async () => {
  const fixture = executorFixture();
  const params = { subject: "style", body: "Use short answers.", kind: "fact" };
  const key = {
    turnId: fixture.turn.id,
    toolName: "telegram_agent_remember",
    argsSha256: sha256ControllerJson(params),
  };
  expect(fixture.store.claimToolReceipt({
    ...key,
    controllerKey: fixture.turn.controllerKey,
    now: 1_999,
  })).toEqual({ outcome: "fresh" });
  const run = vi.fn(() => ({ unreachable: true }));

  const output = JSON.parse(await executeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_remember,
    params,
    context: fixture.context,
    scope: globalScope,
    run,
    projectEvidence: () => ({ outcome: "succeeded", proofKinds: ["memory_state"], subjectRefs: [] }),
  }));

  expect(run).not.toHaveBeenCalled();
  expect(output).toMatchObject({
    outcome: "uncertain",
    _hanoonEvidence: { outcome: "interrupted", proofKinds: [] },
  });
});

it("rejects corrupt receipt JSON and receipt completion overflow", async () => {
  const fixture = executorFixture();
  const params = { subject: "style", body: "Use short answers.", kind: "fact" };
  const key = {
    turnId: fixture.turn.id,
    toolName: "telegram_agent_remember",
    argsSha256: sha256ControllerJson(params),
  };
  fixture.store.claimToolReceipt({ ...key, controllerKey: fixture.turn.controllerKey, now: 1_998 });
  fixture.store.completeToolReceipt({ ...key, result: "not-json", now: 1_999 });

  await expect(executeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_remember,
    params,
    context: fixture.context,
    scope: globalScope,
    run: vi.fn(() => ({ unreachable: true })),
    projectEvidence: () => ({ outcome: "succeeded", proofKinds: ["memory_state"], subjectRefs: [] }),
  })).rejects.toThrow(/receipt|json|result/i);

  expect(() => fixture.store.completeToolReceipt({
    turnId: fixture.turn.id,
    toolName: "telegram_agent_set_working_style",
    argsSha256: "a".repeat(64),
    result: `{"text":"${"é".repeat(4_000)}"}`,
    now: 2_000,
  })).toThrow(/receipt|started|byte|bound/i);
});

it("routes a registered tool through durable evidence before returning", async () => {
  const fixture = registeredControllerFixture();
  const output = JSON.parse(await fixture.harness.behavior.callAgentTool(
    "telegram_agent_list_projects",
    {},
    fixture.toolContext,
  ) as string);

  expect(output).toMatchObject({
    projects: [{ id: "proj_1" }],
    _hanoonEvidence: {
      ref: "evidence:1",
      outcome: "observed",
      proofKinds: ["project_state"],
      subjectRefs: ["project:proj_1"],
    },
  });
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 10)).toHaveLength(1);
});

it("makes zero BB calls when durable controller authorization fails", async () => {
  const fixture = registeredControllerFixture();

  await expect(fixture.harness.behavior.callAgentTool(
    "telegram_agent_thread_status",
    { threadId: "thr_visible" },
    { ...fixture.toolContext, threadId: "thr_forged" },
  )).rejects.toThrow(/identity|controller|authorized/i);

  expect(fixture.harness.inspection.sdk.callsTo("threads.get")).toEqual([]);
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 10)).toEqual([]);
});

it("keeps credentials and token audiences out of every provider parameter schema", async () => {
  const fixture = registeredControllerFixture();

  await expect(fixture.harness.behavior.callAgentTool(
    "telegram_agent_list_threads",
    { credential: "bb", token: "secret", audience: "bb-plugin-sdk" },
    fixture.toolContext,
  )).rejects.toThrow();
  expect(fixture.harness.inspection.sdk.callsTo("threads.list")).toEqual([]);
});

it("denies a disabled exact project before creating a job or evidence", async () => {
  const fixture = registeredControllerFixture();
  fixture.store.upsertProjectPolicy(policyFixture({ enabled: false }), 1_900);
  const before = fixture.store.listJobs(100).length;

  await expect(fixture.harness.behavior.callAgentTool(
    "telegram_agent_start_job",
    { projectId: "proj_1", task: "must not run" },
    fixture.toolContext,
  )).rejects.toThrow(/scope/i);

  expect(fixture.store.listJobs(100)).toHaveLength(before);
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 10)).toEqual([]);
});

it("isolates owner monitors from system and foreign cancellation", async () => {
  const fixture = registeredControllerFixture();
  const ownerMonitor = fixture.store.createMonitor({
    controllerKey: fixture.turn.controllerKey,
    kind: "schedule",
    cron: "0 9 * * 1-5",
    instruction: "Review the queue.",
    dueAt: 10_000,
    now: 1_800,
  });
  const inactiveMonitor = fixture.store.createMonitor({
    controllerKey: fixture.turn.controllerKey,
    kind: "schedule",
    cron: "0 10 * * 1-5",
    instruction: "Review completed work.",
    dueAt: 11_000,
    now: 1_801,
  });
  expect(fixture.store.cancelControllerMonitor(fixture.turn.controllerKey, inactiveMonitor.id, 1_802)).toBe(true);
  const systemMonitor = fixture.store.ensureSystemMonitor({
    systemKey: "production-health:proj_1",
    controllerKey: fixture.turn.controllerKey,
    cron: "0 11 * * 1-5",
    instruction: "Check production health.",
    dueAt: 12_000,
    now: 1_803,
  });

  await expect(fixture.harness.behavior.callAgentTool(
    "telegram_agent_cancel_watch",
    { id: systemMonitor.id },
    fixture.toolContext,
  )).rejects.toThrow(/scope/i);
  expect(fixture.store.listSystemMonitors()[0]).toMatchObject({ id: systemMonitor.id, state: "armed" });

  const cancelled = JSON.parse(await fixture.harness.behavior.callAgentTool(
    "telegram_agent_cancel_watch",
    { id: ownerMonitor.id },
    fixture.toolContext,
  ) as string);
  expect(cancelled).toMatchObject({ cancelled: true, _hanoonEvidence: { outcome: "succeeded" } });

  const inactive = JSON.parse(await fixture.harness.behavior.callAgentTool(
    "telegram_agent_cancel_watch",
    { id: inactiveMonitor.id },
    fixture.toolContext,
  ) as string);
  expect(inactive).toMatchObject({ cancelled: false, _hanoonEvidence: { outcome: "observed" } });
});

it("promotes pipeline outcome only from a fully bound durable terminal chain", () => {
  const headSha = "a".repeat(40);
  const mergeSha = "b".repeat(40);
  const nonceHash = "c".repeat(64);
  const mergedAt = "2026-08-12T12:00:00.000Z";
  const expiresAt = "2026-08-12T13:00:00.000Z";
  const effectIdempotencyKey = "job_verified:8:merge_pr";
  const reviewAttemptId = "review_verified";
  const policy = policyFixture({ production: undefined });
  const fixture = submittedControllerFixture();
  fixture.store.upsertProjectPolicy(policy, 1);
  fixture.store.createJob({ id: "job_verified", sourceUpdateId: 30_000, requestText: "verified chain", now: 1 });
  fixture.db.prepare(
    `UPDATE jobs SET state = 'merged', project_id = ?, policy_version = 1, policy_json = ?,
       environment_id = 'env_1', pr_number = 17, pr_url = ?, pr_head_sha = ?,
       merge_message = 'merged', merge_commit_sha = ?, merged_at = ?, version = 9
     WHERE id = 'job_verified'`,
  ).run(policy.projectId, JSON.stringify(policy), "https://github.com/acme/cyndra/pull/17", headSha, mergeSha, mergedAt);
  const job = fixture.store.getJob("job_verified");
  if (!job) throw new Error("verified pipeline fixture job disappeared");
  const receipt = {
    jobId: job.id,
    effectIdempotencyKey,
    approvalNonceHash: nonceHash,
    approvalOwnerUserId: "7",
    approvalOwnerChatId: "7",
    jobVersion: 8,
    approvalJobVersion: 7,
    projectId: policy.projectId,
    environmentId: "env_1",
    prNumber: 17,
    baseBranch: policy.baseBranch,
    headSha,
    reviewAttemptId,
    validationCompletedAt: mergedAt,
    requiredCheckNames: [...policy.requiredChecks].sort(),
    mergeMethod: policy.mergeMethod,
    expiresAt,
  };
  const mergeResult = {
    jobId: job.id,
    effectIdempotencyKey,
    approvalNonceHash: nonceHash,
    environmentId: "env_1",
    prNumber: 17,
    authoritativeHeadSha: headSha,
    baseContentVerified: true,
    mergedAt,
    mergeCommit: { oid: mergeSha },
    pullRequest: { number: 17, url: "https://github.com/acme/cyndra/pull/17", state: "MERGED" },
    confirmedAt: mergedAt,
  };
  const validationOutcome = {
    validationOutcome: "pass",
    headSha,
    commandReceipts: [{ outcome: "pass" }],
    requiredChecks: [{ name: "test", bucket: "pass", state: "SUCCESS" }],
  };
  fixture.db.prepare(
    `INSERT INTO pipeline_stage_attempts (
       id, job_id, role, ordinal, state, environment_id, resource_kind, resource_id,
       input_sha256, output_text, output_sha256, outcome_json, start_sha, end_sha,
       created_at, completed_at, updated_at
     ) VALUES ('final_test_1', ?, 'FINAL_TEST', 1, 'completed', 'env_1', 'bb_terminal',
       'terminal_1', ?, 'passed', ?, ?, ?, ?, 1, 2, 2)`,
  ).run(job.id, "d".repeat(64), "e".repeat(64), JSON.stringify(validationOutcome), headSha, headSha);
  fixture.db.prepare(
    `INSERT INTO attempts (
       id, job_id, kind, ordinal, thread_id, head_sha, result_json, created_at, completed_at
     ) VALUES (?, ?, 'review', 1, 'thr_review', ?, ?, 1, 2)`,
  ).run(reviewAttemptId, job.id, headSha, JSON.stringify(mergeResult));
  fixture.db.prepare(
    `INSERT INTO approvals (
       nonce_hash, job_id, head_sha, expires_at, consumed_at, outcome,
       owner_user_id, owner_chat_id, job_version
     ) VALUES (?, ?, ?, ?, 1, 'accepted', '7', '7', 7)`,
  ).run(nonceHash, job.id, headSha, Date.parse(expiresAt));
  fixture.db.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, ?, 'merge_pr', ?, 'done', 1, 0, 1, 2)`,
  ).run(effectIdempotencyKey, job.id, JSON.stringify({
    headSha,
    receipt,
    mergeCallStartedAt: 1,
    mergeCallOutcome: "unknown",
    mergeResult,
  }));

  expect(verifiedPipelineOutcome(fixture.store, job)).toBe(true);
  fixture.db.prepare("DELETE FROM pipeline_stage_attempts WHERE id = 'final_test_1'").run();
  expect(verifiedPipelineOutcome(fixture.store, job)).toBe(false);
});

it("projects the remaining memory, monitor, health, scorecard, and style rows from trusted state", async () => {
  const fixture = registeredControllerFixture();
  const call = async (name: string, params: unknown) => JSON.parse(await fixture.harness.behavior.callAgentTool(
    name,
    params,
    fixture.toolContext,
  ) as string);

  const remembered = await call("telegram_agent_remember", {
    subject: "review depth",
    body: "Run the full suite.",
    kind: "preference",
  });
  expect(remembered._hanoonEvidence).toMatchObject({ outcome: "succeeded", proofKinds: ["memory_state"] });

  const recalled = await call("telegram_agent_recall", { query: "review depth" });
  expect(recalled._hanoonEvidence).toMatchObject({
    outcome: "observed",
    proofKinds: ["memory_state"],
    subjectRefs: [`memory:${remembered.remembered.id}`],
  });

  const forgotten = await call("telegram_agent_forget", { id: remembered.remembered.id });
  expect(forgotten._hanoonEvidence).toMatchObject({ outcome: "succeeded", proofKinds: ["memory_state"] });

  const watching = await call("telegram_agent_watch", {
    kind: "schedule",
    cron: "0 9 * * 1-5",
    instruction: "Review the queue.",
  });
  expect(watching._hanoonEvidence).toMatchObject({
    outcome: "succeeded",
    proofKinds: ["monitor_state", "obligation"],
    subjectRefs: [`monitor:${watching.watching.id}`],
  });

  const watches = await call("telegram_agent_list_watches", {});
  expect(watches._hanoonEvidence).toMatchObject({
    outcome: "observed",
    proofKinds: ["monitor_state", "obligation"],
    subjectRefs: [`monitor:${watching.watching.id}`],
  });

  const health = await call("telegram_agent_health", {});
  expect(health._hanoonEvidence).toMatchObject({ outcome: "observed", proofKinds: ["health_snapshot"] });
  const scorecard = await call("telegram_agent_scorecard", {});
  expect(scorecard._hanoonEvidence).toMatchObject({ outcome: "observed", proofKinds: ["health_snapshot"] });

  const style = await call("telegram_agent_set_working_style", { text: "Lead with the result." });
  expect(style._hanoonEvidence).toMatchObject({ outcome: "succeeded", proofKinds: ["memory_state"] });
  const sameStyle = await call("telegram_agent_set_working_style", { text: "Lead with the result." });
  expect(sameStyle._hanoonEvidence).toMatchObject({ outcome: "observed", proofKinds: ["memory_state"] });
});
