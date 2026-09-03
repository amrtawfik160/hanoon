import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  assessModelRouteShadowEvidence,
  defineModelPoolRegistry,
  modelFailureSignature,
  recordModelFailure,
  selectModelRoute,
  type ModelPoolRegistry,
  type ModelRoute,
} from "../src/capabilities/models";
import { CapabilityRepository } from "../src/storage/capability-repository";
import { CAPABILITY_MIGRATIONS, PROMOTION_EVIDENCE_MIGRATIONS } from "../src/storage/migrations";
import { BbRunner } from "../src/bb/runner";
import { capabilityProfileDigest } from "../src/capabilities/profiles";
import { jobFixture, policyFixture } from "./helpers";

const registryInput = {
  controller: {
    fast: { providerId: "codex", modelId: "gpt-5.6-luna", reasoning: "low", serviceTier: "fast" },
    standard: { providerId: "codex", modelId: "gpt-5.6-terra", reasoning: "high", serviceTier: "fast" },
    strong: { providerId: "codex", modelId: "gpt-5.6-sol", reasoning: "xhigh", serviceTier: "fast" },
  },
  pipeline: {
    fast: { providerId: "codex", modelId: "gpt-5.6-luna", reasoning: "high", serviceTier: "fast" },
    standard: { providerId: "codex", modelId: "gpt-5.6-terra", reasoning: "high", serviceTier: "fast" },
    strong: { providerId: "codex", modelId: "gpt-5.6-sol", reasoning: "xhigh", serviceTier: "fast" },
  },
  worker: {
    fast: { providerId: "codex", modelId: "gpt-5.6-luna", reasoning: "high", serviceTier: "fast" },
    standard: { providerId: "codex", modelId: "gpt-5.6-terra", reasoning: "high", serviceTier: "fast" },
    strong: { providerId: "codex", modelId: "gpt-5.6-sol", reasoning: "xhigh", serviceTier: "fast" },
  },
  background: {
    fast: { providerId: "codex", modelId: "gpt-5.6-luna", reasoning: "low", serviceTier: "fast" },
    standard: { providerId: "codex", modelId: "gpt-5.6-terra", reasoning: "medium", serviceTier: "fast" },
    strong: { providerId: "codex", modelId: "gpt-5.6-sol", reasoning: "high", serviceTier: "fast" },
  },
} as const;

const pools = defineModelPoolRegistry(registryInput);

function route(pool: ModelRoute["pool"] = "fast"): ModelRoute {
  return { pool, ...registryInput.worker[pool] };
}

describe("explicit model routing", () => {
  it("selects a pool from recipe, stage, risk, and execution class", () => {
    expect(selectModelRoute({
      executionClass: "pipeline",
      recipe: "architectural",
      stage: "planning",
      risk: "high",
    }, pools)).toEqual({ pool: "strong", ...registryInput.pipeline.strong });
    expect(selectModelRoute({
      executionClass: "worker",
      recipe: "direct",
      stage: "delivery-metadata",
      risk: "low",
    }, pools)).toEqual({ pool: "fast", ...registryInput.worker.fast });
    expect(selectModelRoute({
      executionClass: "worker",
      recipe: "bounded",
      stage: "implementation",
      risk: "medium",
    }, pools)).toEqual({ pool: "standard", ...registryInput.worker.standard });
  });

  it("requires every class and pool to contain a real exact tuple", () => {
    const incomplete = structuredClone(registryInput) as unknown as Record<string, unknown>;
    delete (incomplete.worker as Record<string, unknown>).strong;
    expect(() => defineModelPoolRegistry(incomplete as unknown as ModelPoolRegistry)).toThrow(/worker.*strong|strong.*worker/i);

    const placeholder = structuredClone(registryInput) as unknown as Record<string, Record<string, Record<string, unknown>>>;
    placeholder.worker!.fast!.providerId = "configured-default";
    expect(() => defineModelPoolRegistry(placeholder as unknown as ModelPoolRegistry)).toThrow(/placeholder|provider/i);

    const permissionLeak = structuredClone(registryInput) as unknown as Record<string, Record<string, Record<string, unknown>>>;
    permissionLeak.worker!.fast!.permissionMode = "full";
    expect(() => defineModelPoolRegistry(permissionLeak as unknown as ModelPoolRegistry)).toThrow(/unrecognized|permission/i);
  });

  it("keeps the tuple fixed in-attempt and escalates only a new attempt after the second equivalent failure", () => {
    const selected = route("fast");
    const failure = {
      route: selected,
      stage: "implementation",
      operation: "spawn-worker",
      error: new Error("HTTP 503: provider temporarily unavailable for request abc"),
    } as const;
    const signature = modelFailureSignature(failure);
    const first = recordModelFailure({ ...failure, priorFailureSignatures: [] });
    expect(first).toMatchObject({ action: "retry", equivalentFailures: 1, nextPool: "fast" });
    expect(first.route).toEqual(selected);
    expect(Object.isFrozen(first.route)).toBe(true);

    const second = recordModelFailure({ ...failure, priorFailureSignatures: [signature] });
    expect(second).toMatchObject({ action: "escalate", equivalentFailures: 2, nextPool: "standard" });
    expect(second.route).toEqual(selected);
    if (second.nextPool === null) throw new Error("escalation did not select a next pool");
    expect(selectModelRoute({
      executionClass: "worker",
      recipe: "direct",
      stage: "delivery-metadata",
      risk: "low",
      minimumPool: second.nextPool,
    }, pools).pool).toBe("standard");
  });

  it("never downgrades and blocks after the second equivalent strong-tier failure", () => {
    expect(selectModelRoute({
      executionClass: "worker",
      recipe: "direct",
      stage: "delivery-metadata",
      risk: "low",
      minimumPool: "strong",
    }, pools).pool).toBe("strong");
    const strong = route("strong");
    const failure = { route: strong, stage: "review", operation: "spawn-review", error: "timeout after 30000ms" };
    expect(recordModelFailure({
      ...failure,
      priorFailureSignatures: [modelFailureSignature(failure)],
    })).toMatchObject({ action: "block", nextPool: null, equivalentFailures: 2 });
  });

  it("requires five independent successful candidate trials against the same baseline", () => {
    const candidate = Array.from({ length: 5 }, (_, index) => ({
      trialId: `candidate-${index}`,
      harnessDigest: "a".repeat(64),
      budgetDigest: "b".repeat(64),
      outcome: "passed" as const,
    }));
    const baseline = Array.from({ length: 5 }, (_, index) => ({
      trialId: `baseline-${index}`,
      harnessDigest: "a".repeat(64),
      budgetDigest: "b".repeat(64),
      outcome: "passed" as const,
    }));
    expect(assessModelRouteShadowEvidence({ candidate, baseline })).toEqual({
      ready: true,
      candidateSuccesses: 5,
      baselineSuccesses: 5,
      reasonCodes: [],
    });
    expect(assessModelRouteShadowEvidence({ candidate: candidate.slice(0, 4), baseline })).toMatchObject({
      ready: false,
      reasonCodes: expect.arrayContaining(["insufficient_candidate_trials"]),
    });
  });
});

describe("model route persistence", () => {
  it("stores the exact tuple before spawn and reconstructs it without permission policy", () => {
    const db = new Database(":memory:");
    for (const migration of [...CAPABILITY_MIGRATIONS, ...PROMOTION_EVIDENCE_MIGRATIONS]) db.exec(migration);
    const first = new CapabilityRepository(db);
    const selected = route("standard");
    const stored = first.recordModelRouteSelection({
      subjectKind: "worker_attempt",
      subjectId: "attempt-model-1",
      attempt: 1,
      stage: "implementation",
      operation: "spawn-worker",
      route: selected,
      now: 1_000,
    });
    expect(stored).toMatchObject({ outcome: "selected", route: selected });
    expect(stored).not.toHaveProperty("permissionMode");

    const restarted = new CapabilityRepository(db);
    expect(restarted.listModelRouteTrials("worker_attempt", "attempt-model-1", 10)).toEqual([stored]);
    expect(restarted.recordModelRouteSelection({
      subjectKind: "worker_attempt",
      subjectId: "attempt-model-1",
      attempt: 1,
      stage: "implementation",
      operation: "spawn-worker",
      route: selected,
      now: 1_000,
    })).toEqual(stored);
    expect(() => restarted.recordModelRouteSelection({
      subjectKind: "worker_attempt",
      subjectId: "attempt-model-1",
      attempt: 1,
      stage: "implementation",
      operation: "spawn-worker",
      route: route("strong"),
      now: 1_000,
    })).toThrow(/immutable|conflict/i);
    db.close();
  });

  it("settles a selected model trial exactly once with durable failure evidence", () => {
    const db = new Database(":memory:");
    for (const migration of [...CAPABILITY_MIGRATIONS, ...PROMOTION_EVIDENCE_MIGRATIONS]) db.exec(migration);
    const repository = new CapabilityRepository(db);
    const selected = route("fast");
    repository.recordModelRouteSelection({
      subjectKind: "worker_attempt",
      subjectId: "attempt-model-failure",
      attempt: 1,
      stage: "implementation",
      operation: "spawn-implementation",
      route: selected,
      now: 1_000,
    });
    const signature = "c".repeat(64);

    expect(repository.settleModelRouteTrial({
      subjectKind: "worker_attempt",
      subjectId: "attempt-model-failure",
      attempt: 1,
      outcome: "failed",
      failureSignature: signature,
      now: 1_100,
    })).toMatchObject({ outcome: "failed", failureSignature: signature, route: selected });
    expect(repository.settleModelRouteTrial({
      subjectKind: "worker_attempt",
      subjectId: "attempt-model-failure",
      attempt: 1,
      outcome: "failed",
      failureSignature: signature,
      now: 1_200,
    })).toMatchObject({ outcome: "failed", failureSignature: signature });
    expect(() => repository.settleModelRouteTrial({
      subjectKind: "worker_attempt",
      subjectId: "attempt-model-failure",
      attempt: 1,
      outcome: "passed",
      failureSignature: null,
      now: 1_300,
    })).toThrow(/terminal|conflict/i);

    const restarted = new CapabilityRepository(db);
    expect(restarted.listModelRouteTrials("worker_attempt", "attempt-model-failure", 10))
      .toMatchObject([{ outcome: "failed", failureSignature: signature }]);
    db.close();
  });

  it("uses the persisted active tuple in threads.spawn while permission stays role-owned", async () => {
    const { bb } = createFakePluginHost({ pluginId: "model-route-spawn-profile" });
    const repository = new CapabilityRepository(bb.storage.database());
    for (const migration of [...CAPABILITY_MIGRATIONS, ...PROMOTION_EVIDENCE_MIGRATIONS]) {
      bb.storage.database().exec(migration);
    }
    const selected = route("strong");
    const profile = repository.createProfile({
      subjectKind: "worker_attempt",
      subjectId: "attempt-spawn-1",
      threadId: null,
      recipeId: "architectural",
      recipeVersion: 1,
      registryDigest: "a".repeat(64),
      graphDigest: "b".repeat(64),
      mode: "active",
      model: selected,
      assignments: [],
      reasonCodes: [],
      traits: [],
      now: 1_000,
    });
    repository.recordModelRouteSelection({
      subjectKind: "worker_attempt",
      subjectId: profile.subjectId,
      attempt: 1,
      stage: "implementation",
      operation: "spawn-worker",
      route: profile.model,
      now: 1_000,
    });
    const spawns: Record<string, unknown>[] = [];
    const sdk = {
      projects: {
        list: async () => [{
          id: "proj_1",
          kind: "standard",
          sources: [{ id: "source_1", isDefault: true, hostId: "host_1", path: "/workspace" }],
        }],
        attachments: {
          upload: async (input: { filename: string }) => ({
            type: "localFile",
            path: `attachments/${input.filename}`,
            name: input.filename,
          }),
        },
      },
      threads: {
        spawn: async (input: Record<string, unknown>) => {
          spawns.push(input);
          return { id: "thr_spawned", environmentId: "env_spawned" };
        },
      },
    } as unknown as BbPluginApi["sdk"];
    const policy = policyFixture({
      implementation: {
        providerId: "legacy-provider",
        model: "legacy-model",
        reasoningLevel: "low",
        serviceTier: "default",
        permissionMode: "accept-edits",
      },
      production: undefined,
    });
    const job = jobFixture({
      state: "implementing",
      projectId: policy.projectId,
      policyVersion: 1,
      policy,
      routingMode: "active",
      taskRecipe: "architectural",
    });
    await new BbRunner(sdk).spawnImplementation(job, {
      id: profile.subjectId,
      capabilityProfile: {
        profileId: profile.id,
        profileRevision: profile.revision,
        profileDigest: capabilityProfileDigest(profile.assignments),
        recipeId: "architectural",
        recipeVersion: 1,
        mode: "active",
        model: profile.model,
        assignments: [],
      },
    });

    expect(spawns[0]).toMatchObject({
      providerId: selected.providerId,
      model: selected.modelId,
      reasoningLevel: selected.reasoning,
      serviceTier: selected.serviceTier,
      permissionMode: "accept-edits",
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        serviceTier: "explicit",
        permissionMode: "explicit",
      },
    });
    expect(spawns[0]).not.toMatchObject({ model: "legacy-model" });
  });
});
