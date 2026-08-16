import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  canonicalControllerJson,
  ControllerCapabilityExecutionError,
  authorizeControllerCapability,
  executeControllerCapability,
  registerControllerCapabilityTool,
  sha256ControllerJson,
  type ControllerCapabilityDependencies,
} from "../src/controller/capability-executor";
import { CONTROLLER_CAPABILITIES } from "../src/controller/capability-policy";
import { registerControllerTools, verifiedPipelineOutcome } from "../src/controller/tools";
import {
  disposeControllerTrustFixtures,
  registeredControllerFixture,
  submittedControllerFixture,
  validEvidenceInput,
} from "./support/controller-trust-fixtures";

afterEach(async () => {
  await disposeControllerTrustFixtures();
});
import { policyFixture } from "./helpers";
import { EffectRunner } from "../src/services/effect-runner";
import { runProductionStage } from "../src/services/production-runner";
import { GIT_REMOTE_COMMAND, PR_CHECKS_COMMAND, PR_HEAD_COMMAND, PR_VIEW_COMMAND } from "../src/bb/validation";
import type { TelegramAgentStore } from "../src/storage/store";

type TelegramAgentStoreWithLegacyLease = TelegramAgentStore & {
  leaseEffects(
    ownerId: string,
    generation: number,
    now: number,
    limit: number,
    leaseMs: number,
  ): ReturnType<TelegramAgentStore["listEffectsForJob"]>;
};

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

it("reserves a mutating invocation before async scope resolution can finalize the turn", async () => {
  const fixture = executorFixture();
  let releaseResolution!: () => void;
  const resolutionReleased = new Promise<void>((resolve) => {
    releaseResolution = resolve;
  });
  let scopeResolved!: () => void;
  const resolutionStarted = new Promise<void>((resolve) => {
    scopeResolved = resolve;
  });
  const run = vi.fn(() => ({ remembered: { id: "memory_1" } }));

  const execution = executeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_remember,
    params: { subject: "style", body: "Use short answers.", kind: "fact" },
    context: fixture.context,
    resolveScope: async () => {
      scopeResolved();
      await resolutionReleased;
      return { scope: globalScope };
    },
    run,
    projectEvidence: () => ({
      outcome: "succeeded" as const,
      proofKinds: ["memory_state"] as const,
      subjectRefs: [] as const,
    }),
  });

  await resolutionStarted;
  expect(fixture.db.prepare(
    "SELECT state FROM tool_receipts WHERE turn_id = ?",
  ).get(fixture.turn.id)).toEqual({ state: "started" });
  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: "Here is the requested answer." }],
      obligationRefs: [],
    },
  })).toMatchObject({ outcome: "rejected", code: "invocation_in_flight" });
  expect(run).not.toHaveBeenCalled();

  releaseResolution();
  await expect(execution).resolves.toContain("evidence:1");
  expect(run).toHaveBeenCalledOnce();
  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: "Here is the requested answer." }],
      obligationRefs: [],
    },
  })).toMatchObject({ outcome: "accepted" });
});

it("rolls back receipt settlement when evidence persistence fails", async () => {
  const fixture = executorFixture();
  fixture.db.function("fail_controller_evidence_insert", () => {
    throw new Error("evidence insert failed");
  });
  fixture.db.exec(`
    CREATE TRIGGER fail_controller_evidence_insert
    BEFORE INSERT ON controller_evidence
    BEGIN
      SELECT fail_controller_evidence_insert();
    END
  `);

  await expect(executeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_remember,
    params: { subject: "style", body: "Use short answers.", kind: "fact" },
    context: fixture.context,
    scope: globalScope,
    run: () => ({ remembered: { id: "memory_1" } }),
    projectEvidence: () => ({ outcome: "succeeded", proofKinds: ["memory_state"], subjectRefs: [] }),
  })).rejects.toThrow();

  expect(fixture.store.listToolReceipts(fixture.turn.id)).toMatchObject([
    { toolName: "telegram_agent_remember", state: "started", result: null },
  ]);
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 10)).toEqual([]);
});

it("denies every normal capability after durable acceptance before receipts or evidence", () => {
  const fixture = executorFixture();
  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: "Here is the requested answer." }],
      obligationRefs: [],
    },
  })).toMatchObject({ outcome: "accepted" });

  for (const descriptor of Object.values(CONTROLLER_CAPABILITIES)) {
    if (descriptor.capability_id === "telegram_agent_respond") continue;
    expect(() => authorizeControllerCapability(fixture.dependencies, {
      descriptor,
      context: fixture.context,
      scope: {
        kind: descriptor.project_scope === "controller_global" ? "controller_global" : "exact_entity",
        entityRefs: [],
        matches: true,
      },
      approval: "current",
      credentialAudienceMatches: true,
    }), descriptor.capability_id).toThrow(/turn_finalized/);
  }
  expect(fixture.db.prepare(
    "SELECT COUNT(*) AS count FROM tool_receipts WHERE turn_id = ?",
  ).get(fixture.turn.id)).toEqual({ count: 0 });
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 128)).toEqual([]);
});

it("reports a stale fence before durable finalization", () => {
  const fixture = executorFixture();
  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: "Here is the requested answer." }],
      obligationRefs: [],
    },
  })).toMatchObject({ outcome: "accepted" });
  expect(fixture.store.releaseExecutorLease(
    fixture.fence.ownerId,
    fixture.fence.generation,
    fixture.fence.now,
  )).toBe(true);

  expect(() => authorizeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
    context: fixture.context,
    scope: globalScope,
  })).toThrow(/fence_lost/);
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

it("suppresses success against a real stale evidence fence", async () => {
  const fixture = executorFixture();
  expect(fixture.store.releaseExecutorLease(
    fixture.fence.ownerId,
    fixture.fence.generation,
    fixture.fence.now,
  )).toBe(true);
  expect(fixture.store.recordControllerEvidence({
    ...validEvidenceInput(fixture.turn),
    ...fixture.fence,
  })).toEqual({ outcome: "stale" });

  await expect(executeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
    params: {},
    context: fixture.context,
    scope: globalScope,
    run: () => ({ projects: [] }),
    projectEvidence: () => ({ outcome: "observed", proofKinds: ["project_state"], subjectRefs: [] }),
  })).rejects.toMatchObject({ code: "fence_lost" });
});

it("suppresses success when real SQLite evidence state reaches its durable cap", async () => {
  const fixture = executorFixture();
  for (let index = 0; index < 128; index += 1) {
    expect(fixture.store.recordControllerEvidence({
      ...validEvidenceInput(fixture.turn),
      ...fixture.fence,
      argsSha256: index.toString(16).padStart(64, "0"),
    }).outcome).toBe("recorded");
  }

  await expect(executeControllerCapability(fixture.dependencies, {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
    params: {},
    context: fixture.context,
    scope: globalScope,
    run: () => ({ projects: [] }),
    projectEvidence: () => ({ outcome: "observed", proofKinds: ["project_state"], subjectRefs: [] }),
  })).rejects.toMatchObject({ code: "evidence_write_failed" });
});

it("absorbs a real duplicate native source item without creating duplicate evidence", () => {
  const fixture = executorFixture();
  const candidate = {
    sourceName: "tool",
    sourceItemId: "item_1",
    outcome: "observed" as const,
    argsSha256: "a".repeat(64),
    resultSha256: "b".repeat(64),
    proofKinds: ["tool_result"] as const,
    subjectRefs: [] as const,
  };
  expect(fixture.store.recordControllerNativeEvidence({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [candidate],
  })).toBe("recorded");
  expect(fixture.store.recordControllerNativeEvidence({
    ...fixture.fence,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    fromSeq: 1,
    throughSeq: 2,
    items: [candidate],
  })).toBe("recorded");
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 10)).toHaveLength(1);
});

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

  const input = {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_remember,
    params,
    context: fixture.context,
    scope: globalScope,
    run,
    projectEvidence: () => ({
      outcome: "succeeded" as const,
      proofKinds: ["memory_state"] as const,
      subjectRefs: [] as const,
    }),
  } as const;
  const output = JSON.parse(await executeControllerCapability(fixture.dependencies, input));
  const repeated = JSON.parse(await executeControllerCapability(fixture.dependencies, input));

  expect(run).not.toHaveBeenCalled();
  expect(output).toMatchObject({
    outcome: "uncertain",
    _hanoonEvidence: { outcome: "interrupted", proofKinds: [] },
  });
  expect(repeated).toMatchObject({
    outcome: "uncertain",
    _hanoonEvidence: { outcome: "interrupted", proofKinds: [] },
  });
  expect(fixture.store.listToolReceipts(fixture.turn.id)).toMatchObject([
    { toolName: "telegram_agent_remember", state: "failed", result: null },
  ]);
});

it("does not repeat a mutation whose domain operation threw after reservation", async () => {
  const fixture = executorFixture();
  const params = { subject: "style", body: "Use short answers.", kind: "fact" };
  const run = vi.fn(() => {
    throw new Error("write result became ambiguous");
  });
  const input = {
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_remember,
    params,
    context: fixture.context,
    scope: globalScope,
    run,
    projectEvidence: () => ({
      outcome: "succeeded" as const,
      proofKinds: ["memory_state"] as const,
      subjectRefs: [] as const,
    }),
  } as const;

  await expect(executeControllerCapability(fixture.dependencies, input)).rejects.toThrow("ambiguous");
  const replay = JSON.parse(await executeControllerCapability(fixture.dependencies, input));

  expect(run).toHaveBeenCalledOnce();
  expect(replay).toMatchObject({
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

it("returns a structured tool error and makes zero BB calls when durable controller authorization fails", async () => {
  const fixture = registeredControllerFixture();

  const result = await fixture.harness.behavior.callAgentTool(
    "telegram_agent_thread_status",
    { threadId: "thr_visible" },
    { ...fixture.toolContext, threadId: "thr_forged" },
  );

  expect(result).toEqual({
    content: [{ type: "text", text: '{"error":{"code":"identity_mismatch"}}' }],
    isError: true,
  });

  expect(fixture.harness.inspection.sdk.callsTo("threads.get")).toEqual([]);
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 10)).toEqual([]);
});

it("returns a structured tool error when a registered capability exceeds its result limit", async () => {
  const fixture = executorFixture();
  registerControllerCapabilityTool(fixture.bb, fixture.dependencies, {
    name: "telegram_agent_list_projects",
    descriptor: CONTROLLER_CAPABILITIES.telegram_agent_list_projects,
    description: "List projects",
    parameters: z.object({}),
    resolveScope: () => ({ scope: globalScope }),
    execute: () => ({ text: "é".repeat(4_000) }),
    projectEvidence: () => ({
      outcome: "observed",
      proofKinds: ["project_state"],
      subjectRefs: [],
    }),
  });

  const result = await fixture.harness.behavior.callAgentTool(
    "telegram_agent_list_projects",
    {},
    fixture.context,
  );

  expect(result).toEqual({
    content: [{ type: "text", text: '{"error":{"code":"result_limit_exceeded"}}' }],
    isError: true,
  });
  expect(fixture.store.listControllerEvidence(fixture.turn.id, 10)).toEqual([]);
});

it("continues throwing genuine storage faults from registered tools", async () => {
  const fixture = registeredControllerFixture();
  fixture.db.exec("DROP TABLE controller_evidence");

  await expect(fixture.harness.behavior.callAgentTool(
    "telegram_agent_list_projects",
    {},
    fixture.toolContext,
  )).rejects.toMatchObject({ code: "evidence_write_failed" });
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
  )).resolves.toEqual({
    content: [{ type: "text", text: '{"error":{"code":"scope_denied"}}' }],
    isError: true,
  });

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
  )).resolves.toEqual({
    content: [{ type: "text", text: '{"error":{"code":"scope_denied"}}' }],
    isError: true,
  });
  expect(fixture.store.listSystemMonitors()[0]).toMatchObject({ id: systemMonitor.id, state: "armed" });

  const cancelled = JSON.parse(await fixture.harness.behavior.callAgentTool(
    "telegram_agent_cancel_watch",
    { id: ownerMonitor.id },
    fixture.toolContext,
  ) as string);
  expect(cancelled).toMatchObject({
    cancelled: true,
    _hanoonEvidence: {
      outcome: "succeeded",
      proofKinds: ["monitor_state"],
      subjectRefs: [`monitor:${ownerMonitor.id}`],
    },
  });

  const inactive = JSON.parse(await fixture.harness.behavior.callAgentTool(
    "telegram_agent_cancel_watch",
    { id: inactiveMonitor.id },
    fixture.toolContext,
  ) as string);
  expect(inactive).toMatchObject({
    cancelled: false,
    _hanoonEvidence: {
      outcome: "observed",
      proofKinds: ["monitor_state"],
      subjectRefs: [`monitor:${inactiveMonitor.id}`],
    },
  });
});

it("promotes pipeline outcome only from the real validation writer's fully bound terminal chain", async () => {
  const headSha = "a".repeat(40);
  const mergeSha = "b".repeat(40);
  const nonceHash = "c".repeat(64);
  const mergedAt = "2026-08-12T12:00:00.000Z";
  const expiresAt = "2026-08-12T13:00:00.000Z";
  const effectIdempotencyKey = "job_verified:8:merge_pr";
  const reviewAttemptId = "review_verified";
  const longValidationCommand = `node -e "${"x".repeat(600)}"`;
  const policy = policyFixture({
    production: undefined,
    validationCommands: [{ name: "long", command: longValidationCommand, timeoutMs: 600_000 }],
  });
  const fixture = submittedControllerFixture();
  fixture.store.upsertProjectPolicy(policy, 1);
  fixture.store.createJob({ id: "job_verified", sourceUpdateId: 30_000, requestText: "verified chain", now: 1 });
  fixture.db.prepare(
    `UPDATE jobs SET state = 'final_validating', project_id = ?, policy_version = 1, policy_json = ?,
       environment_id = 'env_1', pr_number = 17, pr_url = ?, pr_head_sha = ?,
       version = 2
     WHERE id = 'job_verified'`,
  ).run(policy.projectId, JSON.stringify(policy), "https://github.com/acme/cyndra/pull/17", headSha);
  const validationEffectKey = "job_verified:2:run_final_validation";
  fixture.db.prepare(
    `INSERT INTO effects (
       idempotency_key, job_id, kind, payload_json, status, attempts,
       next_attempt_at, created_at, updated_at
     ) VALUES (?, 'job_verified', 'run_final_validation', ?, 'pending', 0, 1, 1, 1)`,
  ).run(validationEffectKey, JSON.stringify({ headSha }));
  const claimed = (fixture.store as TelegramAgentStoreWithLegacyLease).leaseEffects(
    fixture.fence.ownerId,
    fixture.fence.generation,
    2_000,
    10,
    30_000,
  ).find((effect) => effect.idempotencyKey === validationEffectKey);
  if (!claimed) throw new Error("final validation effect was not leased");
  const validationCommands = [
    GIT_REMOTE_COMMAND,
    PR_HEAD_COMMAND(17),
    longValidationCommand,
    PR_VIEW_COMMAND(17),
    PR_CHECKS_COMMAND(17),
    PR_HEAD_COMMAND(17),
  ];
  await new EffectRunner({
    store: fixture.store,
    fence: {
      ownerId: fixture.fence.ownerId,
      generation: fixture.fence.generation,
      signal: new AbortController().signal,
    },
    now: () => 2_001,
    runValidation: async () => ({
      headSha,
      originRepository: policy.githubRepository,
      commandReceipts: validationCommands.map((command) => ({
        command,
        outcome: "pass" as const,
        exitCode: 0,
        output: "verified",
      })),
      requiredChecks: [{ name: "test", bucket: "pass", state: "SUCCESS", link: null }],
      githubPr: {
        number: 17,
        url: "https://github.com/acme/cyndra/pull/17",
        state: "OPEN",
        isDraft: false,
        baseRefName: policy.baseBranch,
        headRefName: "feature/verified-chain",
        mergeStateStatus: "CLEAN",
        mergeable: "MERGEABLE",
        reviewDecision: null,
        changedFiles: 1,
        additions: 1,
        deletions: 0,
        mergeCommit: null,
        mergedAt: null,
      },
      validationOutcome: "pass" as const,
      completedAt: mergedAt,
      terminalIds: ["terminal_validation", "terminal_checks"],
    }),
  }).run(claimed);
  const writtenFinalTest = fixture.store.getLatestPipelineStageAttempt("job_verified", "FINAL_TEST");
  expect(writtenFinalTest).toMatchObject({
    state: "completed",
    resourceKind: "bb_terminal",
    resourceId: "terminal_checks",
    outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  fixture.db.prepare(
    `UPDATE jobs SET state = 'merged', merge_message = 'merged', merge_commit_sha = ?,
       merged_at = ?, version = 9 WHERE id = 'job_verified'`,
  ).run(mergeSha, mergedAt);
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
  registerControllerTools(fixture.bb, {
    store: fixture.store,
    sdk: fixture.bb.sdk,
    threadOperations: { request: vi.fn() },
    health: () => ({ ok: true }),
    notify: vi.fn(),
    now: () => 2_002,
  });
  const controller = fixture.store.getControllerForOwner("7", "7");
  if (!controller?.threadId || !controller.projectId) throw new Error("controller fixture is incomplete");
  const mergedStatus = JSON.parse(await fixture.harness.behavior.callAgentTool(
    "telegram_agent_job_status",
    { jobId: job.id },
    { threadId: controller.threadId, projectId: controller.projectId },
  ) as string) as { _hanoonEvidence: { outcome: string; proofKinds: string[] } };
  expect(mergedStatus._hanoonEvidence).toMatchObject({ outcome: "succeeded" });
  expect(mergedStatus._hanoonEvidence.proofKinds).toContain("pipeline_outcome");
  const finalTest = fixture.store.getLatestPipelineStageAttempt(job.id, "FINAL_TEST");
  if (!finalTest?.outcome) throw new Error("real final validation outcome disappeared");
  const originalOutcome = finalTest.outcome;
  const writeOutcome = (outcome: Record<string, unknown>) => {
    const outputText = JSON.stringify(outcome);
    const outputSha256 = createHash("sha256").update(outputText, "utf8").digest("hex");
    fixture.db.prepare(
      "UPDATE pipeline_stage_attempts SET output_text = ?, output_sha256 = ?, outcome_json = ? WHERE id = ?",
    ).run(outputText, outputSha256, outputText, finalTest.id);
  };
  writeOutcome({ ...originalOutcome, commandReceipts: [{ command: "npm test", outcome: "pass", exitCode: 0, output: "partial" }] });
  expect(verifiedPipelineOutcome(fixture.store, job)).toBe(false);
  writeOutcome(originalOutcome);
  fixture.db.prepare("UPDATE pipeline_stage_attempts SET resource_id = 'terminal_stale' WHERE id = ?").run(finalTest.id);
  expect(verifiedPipelineOutcome(fixture.store, job)).toBe(false);
  fixture.db.prepare("UPDATE pipeline_stage_attempts SET resource_id = 'terminal_checks' WHERE id = ?").run(finalTest.id);
  writeOutcome({ ...originalOutcome, requiredChecks: [{ name: "test", bucket: "pass" }] });
  expect(verifiedPipelineOutcome(fixture.store, job)).toBe(false);
  writeOutcome({ ...originalOutcome, completedAt: "not-a-date" });
  const status = JSON.parse(await fixture.harness.behavior.callAgentTool(
    "telegram_agent_job_status",
    { jobId: job.id },
    { threadId: controller.threadId, projectId: controller.projectId },
  ) as string) as { _hanoonEvidence: { proofKinds: string[] } };
  expect(status._hanoonEvidence.proofKinds).toContain("job_state");
  expect(status._hanoonEvidence.proofKinds).not.toContain("pipeline_outcome");
  writeOutcome({ ...originalOutcome, completedAt: "2026-08-12T11:00:00.000Z" });
  expect(verifiedPipelineOutcome(fixture.store, job)).toBe(false);
  const mismatchedTimestampStatus = JSON.parse(await fixture.harness.behavior.callAgentTool(
    "telegram_agent_job_status",
    { jobId: job.id },
    { threadId: controller.threadId, projectId: controller.projectId },
  ) as string) as { _hanoonEvidence: { proofKinds: string[] } };
  expect(mismatchedTimestampStatus._hanoonEvidence.proofKinds).toContain("job_state");
  expect(mismatchedTimestampStatus._hanoonEvidence.proofKinds).not.toContain("pipeline_outcome");
  const postMergeValidationAt = "2026-08-12T12:01:00.000Z";
  writeOutcome({ ...originalOutcome, completedAt: postMergeValidationAt });
  fixture.db.prepare("UPDATE effects SET payload_json = ? WHERE idempotency_key = ?").run(JSON.stringify({
    headSha,
    receipt: { ...receipt, validationCompletedAt: postMergeValidationAt },
    mergeCallStartedAt: 1,
    mergeCallOutcome: "unknown",
    mergeResult,
  }), effectIdempotencyKey);
  expect(verifiedPipelineOutcome(fixture.store, job)).toBe(false);
  fixture.db.prepare("UPDATE effects SET payload_json = ? WHERE idempotency_key = ?").run(JSON.stringify({
    headSha,
    receipt,
    mergeCallStartedAt: 1,
    mergeCallOutcome: "unknown",
    mergeResult,
  }), effectIdempotencyKey);
  writeOutcome(originalOutcome);
  expect(verifiedPipelineOutcome(fixture.store, job)).toBe(true);

  const productionPolicy = policyFixture({
    validationCommands: policy.validationCommands,
    outputRedactionPatterns: ["TOPSECRET"],
    production: {
      deployCommands: [{
        name: `deploy-TOPSECRET-${"n".repeat(23)}`,
        command: `./scripts/deploy-TOPSECRET-${"d".repeat(600)}`,
        timeoutMs: 1_800_000,
      }],
      canaryCommands: [{
        name: `canary-TOPSECRET-${"n".repeat(23)}`,
        command: `./scripts/canary-TOPSECRET-${"c".repeat(600)}`,
        timeoutMs: 300_000,
      }],
      convexDeployRequired: false,
    },
  });
  fixture.db.prepare(
    "UPDATE jobs SET state = 'complete', policy_json = ? WHERE id = ?",
  ).run(JSON.stringify(productionPolicy), job.id);
  const writeProductionStage = (
    id: string,
    role: "DEPLOY" | "CANARY",
    snapshot: Record<string, unknown>,
    resourceId: string,
  ) => {
    const outputText = JSON.stringify(snapshot);
    const outputSha256 = createHash("sha256").update(outputText, "utf8").digest("hex");
    fixture.db.prepare(
      `INSERT INTO pipeline_stage_attempts (
         id, job_id, role, ordinal, state, environment_id, resource_kind, resource_id,
         input_sha256, output_text, output_sha256, outcome_json, start_sha, end_sha,
         created_at, completed_at, updated_at
       ) VALUES (?, ?, ?, 1, 'completed', 'env_1', 'bb_terminal', ?, ?, ?, ?, ?, ?, ?, 3, 4, 4)`,
    ).run(id, job.id, role, resourceId, "d".repeat(64), outputText, outputSha256, outputText, mergeSha, mergeSha);
  };
  let productionTerminal = 0;
  const productionRunner = {
    run: async (input: { onObservation?: (observation: { id: string; status: string; updatedAt: number }) => void }) => {
      const id = `terminal_${String(++productionTerminal)}`;
      input.onObservation?.({ id, status: "exited", updatedAt: Date.parse(mergedAt) });
      return { outcome: "exited" as const, exitCode: 0, output: "verified" };
    },
  };
  const deploySnapshot = await runProductionStage({
    runner: productionRunner,
    environmentId: "env_1",
    expectedHeadSha: mergeSha,
    policy: productionPolicy,
    phase: "deploy",
    now: () => Date.parse(mergedAt),
  });
  const canarySnapshot = await runProductionStage({
    runner: productionRunner,
    environmentId: "env_1",
    expectedHeadSha: mergeSha,
    policy: productionPolicy,
    phase: "canary",
    now: () => Date.parse(mergedAt),
  });
  expect(deploySnapshot.commandReceipts[1]).toMatchObject({
    name: "deploy-[REDACTED]-nnnnnnnnnnnnnnnnnnnnn…",
    outcome: "pass",
  });
  expect(deploySnapshot.commandReceipts[1]?.command).toHaveLength(500);
  expect(JSON.stringify([deploySnapshot, canarySnapshot])).not.toContain("TOPSECRET");
  writeProductionStage("deploy_verified", "DEPLOY", deploySnapshot, deploySnapshot.terminalIds.at(-1)!);
  writeProductionStage("canary_verified", "CANARY", canarySnapshot, canarySnapshot.terminalIds.at(-1)!);
  const completeJob = fixture.store.getJob(job.id);
  if (!completeJob) throw new Error("complete pipeline job disappeared");
  expect(verifiedPipelineOutcome(fixture.store, completeJob)).toBe(true);
  const completeStatus = JSON.parse(await fixture.harness.behavior.callAgentTool(
    "telegram_agent_job_status",
    { jobId: job.id },
    { threadId: controller.threadId, projectId: controller.projectId },
  ) as string) as { _hanoonEvidence: { proofKinds: string[] } };
  expect(completeStatus._hanoonEvidence.proofKinds).toContain("production_outcome");

  const mutateProduction = (id: string, snapshot: Record<string, unknown>) => {
    const outputText = JSON.stringify(snapshot);
    const outputSha256 = createHash("sha256").update(outputText, "utf8").digest("hex");
    fixture.db.prepare(
      "UPDATE pipeline_stage_attempts SET output_text = ?, output_sha256 = ?, outcome_json = ? WHERE id = ?",
    ).run(outputText, outputSha256, outputText, id);
  };
  mutateProduction("deploy_verified", {
    ...deploySnapshot,
    commandReceipts: [deploySnapshot.commandReceipts[0], { ...deploySnapshot.commandReceipts[1], command: "./wrong-deploy.sh" }],
  });
  expect(verifiedPipelineOutcome(fixture.store, completeJob)).toBe(false);
  mutateProduction("deploy_verified", deploySnapshot);
  mutateProduction("canary_verified", {
    ...canarySnapshot,
    terminalIds: ["terminal_other"],
  });
  expect(verifiedPipelineOutcome(fixture.store, completeJob)).toBe(false);
  mutateProduction("canary_verified", canarySnapshot);
  expect(verifiedPipelineOutcome(fixture.store, completeJob)).toBe(true);
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
  expect(health._hanoonEvidence).toMatchObject({
    outcome: "succeeded",
    proofKinds: ["health_snapshot"],
    subjectRefs: [`controller:${fixture.turn.controllerKey}`],
  });
  const scorecard = await call("telegram_agent_scorecard", {});
  expect(scorecard._hanoonEvidence).toMatchObject({
    outcome: "observed",
    proofKinds: ["health_snapshot"],
    subjectRefs: [`controller:${fixture.turn.controllerKey}`],
  });

  const style = await call("telegram_agent_set_working_style", { text: "Lead with the result." });
  expect(style._hanoonEvidence).toMatchObject({ outcome: "succeeded", proofKinds: ["memory_state"] });
  const sameStyle = await call("telegram_agent_set_working_style", { text: "Lead with the result." });
  expect(sameStyle._hanoonEvidence).toMatchObject({ outcome: "observed", proofKinds: ["memory_state"] });
});
