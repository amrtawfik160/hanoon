import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { HISTORICAL_RECIPE_CAPABILITY_BY_ID } from "../src/capabilities/catalog";
import {
  nativeAdapterActivationForTransition,
  nativeAdapterEnvelopeWithOutcome,
  prepareNativeAdapterTransition,
} from "../src/capabilities/native-adapters";
import {
  deliveryMetadataPolicy,
  documentationRequirement,
  runRecipe,
} from "../src/domain/pipeline-graph";
import { transition } from "../src/domain/state-machine";
import type { JobEvent } from "../src/domain/models";
import type { TaskRecipe } from "../src/domain/recipes";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { jobFixture, policyFixture, sha, stateJob } from "./helpers";

describe("recipe execution graphs", () => {
  it.each([
    ["direct", ["implementation", "validation", "diff-guards", "delivery"]],
    ["bounded", ["approved-design", "implementation", "validation", "review", "delivery"]],
    ["bug", ["diagnosis", "regression", "implementation", "validation", "review", "delivery"]],
    ["architectural", ["plan", "critique", "implementation", "task-review", "validation", "integrated-review", "delivery"]],
    ["skill-authoring", ["baseline", "implementation", "validation", "review", "delivery"]],
    ["adopted-pr", ["resolve-head", "inspection", "validation", "review", "delivery"]],
  ] as const)("projects the complete %s graph", (recipe, stages) => {
    const projection = runRecipe(recipe);

    expect(projection.stages).toEqual(stages);
    expect(projection.implementationWritersPerWorktree).toBe(1);
    expect(projection.reviewLanes.every((lane) => lane.independent)).toBe(true);
  });

  it("inserts conditional documentation without changing recipe identity", () => {
    expect(runRecipe("bounded", { documentationRequired: true })).toMatchObject({
      recipe: "bounded",
      stages: ["approved-design", "implementation", "validation", "review", "documentation", "delivery"],
    });
    expect(runRecipe("architectural", { documentationRequired: true }).stages).toEqual([
      "plan", "critique", "implementation", "task-review", "documentation",
      "validation", "integrated-review", "delivery",
    ]);
  });

  it("uses deterministic direct delivery metadata and reserves pr-writer for nontrivial diffs", () => {
    expect(deliveryMetadataPolicy({
      recipe: "direct",
      diff: "diff --git a/docs/usage.md b/docs/usage.md\n+++ b/docs/usage.md\n@@ -1 +1 @@\n-old\n+new",
    })).toMatchObject({ mode: "deterministic", capabilityId: null });
    expect(deliveryMetadataPolicy({
      recipe: "bounded",
      diff: "diff --git a/src/api.ts b/src/api.ts\n+++ b/src/api.ts\n@@ -1 +1 @@\n-old\n+export const api = true;",
    })).toMatchObject({ mode: "pr-writer", capabilityId: "pr-writer" });
  });
});

describe("exact-diff documentation selection", () => {
  it.each([
    ["documentation", "diff --git a/docs/usage.md b/docs/usage.md\n+++ b/docs/usage.md", "docs_path"],
    ["CLI", "diff --git a/src/cli.ts b/src/cli.ts\n+++ b/src/cli.ts", "cli_behavior"],
    ["configuration", "diff --git a/src/config.ts b/src/config.ts\n+++ b/src/config.ts", "configuration_behavior"],
    ["public API", "diff --git a/src/index.ts b/src/index.ts\n+++ b/src/index.ts\n@@ -0,0 +1 @@\n+export { publicApi };", "public_contract"],
  ])("requires docs for an exact %s change", (_label, diff, reason) => {
    expect(documentationRequirement({ diff, traits: [], reasonCodes: [] })).toMatchObject({
      required: true,
      reasons: expect.arrayContaining([reason]),
    });
  });

  it("honors a durable work-order requirement and skips unrelated implementation diffs", () => {
    const ordinary = "diff --git a/src/private-helper.ts b/src/private-helper.ts\n+++ b/src/private-helper.ts\n@@ -1 +1 @@\n-old\n+new";
    expect(documentationRequirement({ diff: ordinary, traits: [], reasonCodes: [] })).toMatchObject({
      required: false,
      reasons: [],
    });
    expect(documentationRequirement({
      diff: ordinary,
      traits: ["public-contract"],
      reasonCodes: ["work_order:documentation_required"],
    })).toMatchObject({
      required: true,
      reasons: expect.arrayContaining(["work_order_required"]),
    });
  });

  it("fails closed when the exact diff is malformed", () => {
    expect(() => documentationRequirement({
      diff: "diff --git \"a/docs/broken.md b/docs/broken.md",
      traits: [],
      reasonCodes: [],
    })).toThrow(/quoted|diff/i);
  });
});

describe("active recipe state progression", () => {
  it.each([
    ["direct", "creating_implementation", "spawn_implementation"],
    ["bounded", "creating_implementation", "spawn_implementation"],
    ["bug", "creating_implementation", "spawn_implementation"],
    ["skill-authoring", "creating_implementation", "spawn_implementation"],
    ["architectural", "planning", "spawn_plan"],
  ] as const)("enters the %s recipe from its confirmed precondition", (taskRecipe, state, effect) => {
    const result = transition(stateJob("awaiting_confirmation", {
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture(),
      taskRecipe,
      routingMode: "active",
      deliveryMode: taskRecipe === "direct" ? "small_fix" : "full",
    }), { type: "CONFIRMED" }, 10_000);

    expect(result.job.state).toBe(state);
    expect(result.effects.map((candidate) => candidate.kind)).toContain(effect);
  });

  it("retains adopted PR immutable source setup", () => {
    const result = transition(jobFixture({
      state: "awaiting_confirmation",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture(),
      taskRecipe: "adopted-pr",
      routingMode: "active",
      origin: "adopted_pr",
      adoptedBranch: "telegram-agent/adopt-pr-7-aaaaaaaaaaaa",
      adoptedHeadSha: sha(),
      prNumber: 7,
      prUrl: "https://github.com/acme/cyndra/pull/7",
      prHeadSha: sha(),
    }), { type: "CONFIRMED" }, 10_000);

    expect(result.job.state).toBe("creating_implementation");
    expect(result.effects[0]?.payload).toMatchObject({ adoptedHeadSha: sha(), prNumber: 7 });
  });

  it.each([
    ["direct", false, "complete", "render_status"],
    ["bounded", true, "documenting", "spawn_docs"],
    ["architectural", false, "final_validating", "run_final_validation"],
  ] as const)("routes a passed %s review from deterministic docs evidence", (taskRecipe, required, state, effect) => {
    const policy = policyFixture();
    if (taskRecipe !== "architectural") delete (policy as Partial<typeof policy>).production;
    const event = {
      type: "REVIEW_PASSED",
      headSha: sha(),
      documentation: {
        required,
        diffDigest: "d".repeat(64),
        reasons: required ? ["docs_path"] : [],
      },
    } as JobEvent;
    const result = transition(stateJob("reviewing", {
      taskRecipe: taskRecipe as TaskRecipe,
      routingMode: "active",
      deliveryMode: taskRecipe === "direct" ? "small_fix" : "full",
      policy,
      prHeadSha: sha(),
    }), event, 10_000);

    expect(result.job.state).toBe(state);
    expect(result.effects.map((candidate) => candidate.kind)).toContain(effect);
  });

  it("fails closed when active review completion omits exact documentation evidence", () => {
    expect(() => transition(stateJob("reviewing", {
      taskRecipe: "bounded",
      routingMode: "active",
      prHeadSha: sha(),
    }), { type: "REVIEW_PASSED", headSha: sha() }, 10_000)).toThrow(/documentation|diff/i);
  });

  it("keeps shadow routing on the legacy delivery-mode path", () => {
    const result = transition(stateJob("awaiting_confirmation", {
      taskRecipe: "direct",
      routingMode: "shadow",
      deliveryMode: "full",
    }), { type: "CONFIRMED" }, 10_000);

    expect(result.job.state).toBe("planning");
    expect(result.effects.map((candidate) => candidate.kind)).toContain("spawn_plan");
  });
});

let nativeFixtureId = 0;

function nativeFixture(
  recipe: TaskRecipe = "architectural",
  routingMode: "active" | "shadow" | "legacy" = "active",
): Readonly<{
  bb: ReturnType<typeof createFakePluginHost>["bb"];
  db: Database.Database;
  store: TelegramAgentStore;
  fence: { ownerId: string; generation: number; now: number };
  jobId: string;
}> {
  const { bb } = createFakePluginHost({ pluginId: `recipe-native-${nativeFixtureId++}` });
  const db = bb.storage.database();
  const store = openStore(bb.storage);
  const jobId = `job_native_${nativeFixtureId}`;
  store.createJob({ id: jobId, sourceUpdateId: nativeFixtureId, requestText: "work", now: 1_000 });
  db.prepare(
    `UPDATE jobs SET state = 'creating_implementation', project_id = 'proj_1', policy_version = 1,
       policy_json = ?, task_recipe = ?, routing_mode = ?, version = 2, updated_at = 1001 WHERE id = ?`,
  ).run(JSON.stringify(policyFixture()), recipe, routingMode, jobId);
  const lease = store.acquireExecutorLease("native-executor", 1_002, 60_000);
  if (!lease.acquired) throw new Error("native fixture lease was not acquired");
  return {
    bb,
    db,
    store,
    fence: { ownerId: "native-executor", generation: lease.generation, now: 1_003 },
    jobId,
  };
}

describe("atomic native-adapter transitions", () => {
  const implementationCreated = {
    type: "IMPLEMENTATION_CREATED" as const,
    threadId: "thr_native_impl",
    environmentId: "env_native_impl",
  };

  it("blocks active advancement when its mandatory native outcomes are absent", () => {
    const { store, fence, jobId } = nativeFixture("architectural", "active");

    expect(store.applyExecutorJobEvent({
      jobId,
      expectedVersion: 2,
      event: implementationCreated,
      ...fence,
    })).toBeNull();
    expect(store.getJob(jobId)).toMatchObject({ state: "creating_implementation", version: 2 });
  });

  it("commits every mandatory adapter outcome with the authoritative transition", () => {
    const { store, fence, jobId } = nativeFixture("architectural", "active");
    const job = store.getJob(jobId);
    if (!job) throw new Error("native job missing");
    const nativeAdapter = prepareNativeAdapterTransition({
      store,
      job,
      transition: "implementation-worktree-created",
      effectIdempotencyKey: `${jobId}:2:spawn_implementation`,
      now: fence.now,
    });
    if (!nativeAdapter) throw new Error("active transition did not select native adapters");

    expect(store.applyExecutorJobEvent({
      jobId,
      expectedVersion: 2,
      event: implementationCreated,
      nativeAdapter,
      ...fence,
    })).toMatchObject({ state: "implementing", version: 3 });
    const outcomes = store.listCapabilityReceipts(nativeAdapter.profileId, 20)
      .filter((receipt) => receipt.eventType === "outcome");
    expect(outcomes).toHaveLength(3);
    expect(outcomes.map((receipt) => receipt.capabilityId).sort()).toEqual([
      "hanoon-native-executing-plans",
      "hanoon-native-using-git-worktrees",
      "hanoon-native-using-superpowers",
    ]);
    expect(outcomes.every((receipt) => receipt.outcome === "passed")).toBe(true);
    expect(store.listMissingMandatoryCapabilityOutcomes(nativeAdapter.profileId)).toEqual([]);
  });

  it("rolls back the first native receipt and transition when a later receipt conflicts", () => {
    const { store, fence, jobId } = nativeFixture("architectural", "active");
    const job = store.getJob(jobId);
    if (!job) throw new Error("native job missing");
    const prepared = prepareNativeAdapterTransition({
      store,
      job,
      transition: "implementation-worktree-created",
      effectIdempotencyKey: `${jobId}:2:spawn_implementation`,
      now: fence.now,
    });
    if (!prepared) throw new Error("active transition did not select native adapters");
    const laterOutcome = prepared.outcomes.at(-1);
    if (!laterOutcome) throw new Error("later native outcome missing");
    store.appendCapabilityTerminalOutcome({
      profileId: prepared.profileId,
      capabilityId: laterOutcome.capabilityId,
      descriptorDigest: laterOutcome.descriptorDigest,
      outcome: laterOutcome.outcome,
      evidenceRefs: [...laterOutcome.evidenceRefs],
      now: fence.now,
    });

    expect(() => store.applyExecutorJobEvent({
      jobId,
      expectedVersion: 2,
      event: implementationCreated,
      nativeAdapter: prepared,
      ...fence,
    })).toThrow(/terminal|outcome|conflict/i);
    expect(store.getJob(jobId)).toMatchObject({ state: "creating_implementation", version: 2 });
    expect(store.listCapabilityReceipts(prepared.profileId, 20)
      .filter((receipt) => receipt.eventType === "outcome")).toMatchObject([{
        capabilityId: laterOutcome.capabilityId,
      }]);
    expect(store.listMissingMandatoryCapabilityOutcomes(prepared.profileId)).toEqual(
      prepared.outcomes.slice(0, -1).map((outcome) => outcome.capabilityId).sort(),
    );
  });

  it("reconstructs one selected profile after restart and never duplicates a terminal outcome", () => {
    const { bb, store, fence, jobId } = nativeFixture("architectural", "active");
    const job = store.getJob(jobId);
    if (!job) throw new Error("native job missing");
    const beforeRestart = prepareNativeAdapterTransition({
      store,
      job,
      transition: "implementation-worktree-created",
      effectIdempotencyKey: `${jobId}:2:spawn_implementation`,
      now: fence.now,
    });
    if (!beforeRestart) throw new Error("active transition did not select native adapters");

    const restarted = openStore(bb.storage);
    const reconstructed = prepareNativeAdapterTransition({
      store: restarted,
      job: restarted.getJob(jobId)!,
      transition: "implementation-worktree-created",
      effectIdempotencyKey: `${jobId}:2:spawn_implementation`,
      now: fence.now + 1,
    });
    expect(reconstructed?.profileId).toBe(beforeRestart.profileId);
    expect(restarted.applyExecutorJobEvent({
      jobId,
      expectedVersion: 2,
      event: implementationCreated,
      nativeAdapter: reconstructed!,
      ...fence,
      now: fence.now + 2,
    })).toMatchObject({ state: "implementing" });

    const afterSecondRestart = openStore(bb.storage);
    expect(afterSecondRestart.listCapabilityReceipts(beforeRestart.profileId, 20)
      .filter((receipt) => receipt.eventType === "outcome")).toHaveLength(3);
    expect(afterSecondRestart.applyExecutorJobEvent({
      jobId,
      expectedVersion: 2,
      event: implementationCreated,
      nativeAdapter: beforeRestart,
      ...fence,
      now: fence.now + 3,
    })).toBeNull();
    expect(afterSecondRestart.listCapabilityReceipts(beforeRestart.profileId, 20)
      .filter((receipt) => receipt.eventType === "outcome")).toHaveLength(3);
  });

  it("gives every admitted native adapter a production activation or an explicit fail-closed boundary", () => {
    const activeJob = jobFixture({
      taskRecipe: "architectural",
      routingMode: "active",
    });
    const decisions = [
      nativeAdapterActivationForTransition(activeJob, "plan-worktree-created"),
      nativeAdapterActivationForTransition(activeJob, "implementation-worktree-created"),
      nativeAdapterActivationForTransition(activeJob, "review-created", 2),
      nativeAdapterActivationForTransition(activeJob, "branch-finished"),
    ];
    const selected = new Set(decisions.flatMap((decision) => decision.selectedCapabilityIds));
    const denied = new Map(decisions.flatMap((decision) =>
      decision.denied.map((entry) => [entry.capabilityId, entry.reasonCode] as const)));
    const catalogAdapters = [...HISTORICAL_RECIPE_CAPABILITY_BY_ID.values()]
      .filter((descriptor) => descriptor.kind === "native-adapter" && descriptor.route === "hanoon-native")
      .map((descriptor) => descriptor.id)
      .sort();

    expect([...new Set([...selected, ...denied.keys()])].sort()).toEqual(catalogAdapters);
    expect(selected).toContain("hanoon-native-using-superpowers");
    expect(denied).toEqual(new Map([
      ["hanoon-native-subagent-driven-development", "one_writer_worktree"],
    ]));
  });

  it("persists the subagent non-selection boundary in the immutable implementation profile", () => {
    const { store, fence, jobId } = nativeFixture("architectural", "active");
    const job = store.getJob(jobId);
    if (!job) throw new Error("native job missing");
    const prepared = prepareNativeAdapterTransition({
      store,
      job,
      transition: "implementation-worktree-created",
      effectIdempotencyKey: `${jobId}:2:spawn_implementation`,
      now: fence.now,
    });
    if (!prepared) throw new Error("active transition did not select native adapters");

    const profile = store.getCapabilityProfileById(prepared.profileId);
    expect(profile?.reasonCodes).toContain(
      "native_denial:hanoon-native-subagent-driven-development:one_writer_worktree",
    );
    expect(profile?.assignments.map((assignment) => assignment.capabilityId))
      .not.toContain("hanoon-native-subagent-driven-development");
    expect(store.listCapabilityReceipts(prepared.profileId, 20)
      .filter((receipt) => receipt.eventType === "denied")).toMatchObject([{
        capabilityId: "hanoon-native-subagent-driven-development",
        reasonCode: "one_writer_worktree",
        mandatory: false,
      }]);

    expect(prepareNativeAdapterTransition({
      store,
      job,
      transition: "implementation-worktree-created",
      effectIdempotencyKey: `${jobId}:2:spawn_implementation`,
      now: fence.now + 1,
    })?.profileId).toBe(prepared.profileId);
    expect(store.listCapabilityReceipts(prepared.profileId, 20)
      .filter((receipt) => receipt.eventType === "denied")).toHaveLength(1);
  });

  it("keeps workflow discipline passed when the fenced branch-finishing operation fails", () => {
    const { db, store, fence, jobId } = nativeFixture("bounded", "active");
    db.prepare("UPDATE jobs SET state = 'locating_pr' WHERE id = ?").run(jobId);
    const job = store.getJob(jobId);
    if (!job) throw new Error("native job missing");
    const prepared = prepareNativeAdapterTransition({
      store,
      job,
      transition: "branch-finished",
      effectIdempotencyKey: `${jobId}:2:inspect_implementation`,
      now: fence.now,
    });
    if (!prepared) throw new Error("active transition did not select native adapters");

    expect(store.applyExecutorJobEvent({
      jobId,
      expectedVersion: 2,
      event: { type: "PR_MISSING", reason: "No pull request was created" },
      nativeAdapter: nativeAdapterEnvelopeWithOutcome(prepared, "failed"),
      ...fence,
    })).toMatchObject({ state: "failed" });
    expect(store.listCapabilityReceipts(prepared.profileId, 20)
      .filter((receipt) => receipt.eventType === "outcome")
      .map((receipt) => [receipt.capabilityId, receipt.outcome]))
      .toEqual([
        ["hanoon-native-finishing-a-development-branch", "failed"],
        ["hanoon-native-using-superpowers", "passed"],
      ]);
  });

  it.each(["shadow", "legacy"] as const)("keeps %s transitions free of manufactured native success", (routingMode) => {
    const { db, store, fence, jobId } = nativeFixture("architectural", routingMode);
    const job = store.getJob(jobId);
    if (!job) throw new Error("native job missing");

    expect(prepareNativeAdapterTransition({
      store,
      job,
      transition: "implementation-worktree-created",
      effectIdempotencyKey: `${jobId}:2:spawn_implementation`,
      now: fence.now,
    })).toBeUndefined();
    expect(store.applyExecutorJobEvent({
      jobId,
      expectedVersion: 2,
      event: implementationCreated,
      ...fence,
    })).toMatchObject({ state: "implementing" });
    expect(db.prepare(
      `SELECT COUNT(*) AS count FROM capability_receipts
        WHERE capability_kind = 'native-adapter' AND event_type = 'outcome'`,
    ).get()).toEqual({ count: 0 });
    for (const id of ["hanoon-native-using-git-worktrees", "hanoon-native-executing-plans"]) {
      expect(HISTORICAL_RECIPE_CAPABILITY_BY_ID.get(id)?.route).toBe("hanoon-native");
    }
  });
});
