import { describe, expect, it } from "vitest";
import { projectPolicySchema } from "../src/domain/models";
import {
  DEFAULT_STAGE_PROFILES,
  PIPELINE_MODEL_CATALOG,
  PIPELINE_STAGES,
  costMicroUsd,
  escalatedTier,
  resolveStageExecution,
  stageCostMicroUsd,
  stageEscalationSteps,
  stageExecutionSpawnArgs,
  type PipelineStage,
} from "../src/domain/stage-execution";
import { policyFixture } from "./helpers";

function resolve(stage: PipelineStage, input: Parameters<typeof resolveStageExecution>[0] | null = null) {
  return resolveStageExecution({ stage, ...(input ?? {}) });
}

describe("tiered stage defaults", () => {
  it("gives every worker kind its own profile", () => {
    expect(Object.keys(DEFAULT_STAGE_PROFILES).sort()).toEqual([...PIPELINE_STAGES].sort());
  });

  it("spends heavy reasoning only where judgement is the work", () => {
    for (const stage of ["plan", "critique", "review"] as const) {
      expect(resolve(stage)).toMatchObject({
        tier: "strong",
        providerId: "codex",
        model: "gpt-5.6-sol",
        reasoningLevel: "xhigh",
        source: "default",
      });
    }
    expect(resolve("implementation")).toMatchObject({ tier: "standard", model: "gpt-5.6-terra" });
  });

  it("runs the mechanical stages on the cheap tier", () => {
    for (const stage of ["docs", "validation", "merge", "deploy", "canary"] as const) {
      expect(resolve(stage)).toMatchObject({
        tier: "fast",
        model: "gpt-5.6-luna",
        reasoningLevel: "low",
      });
    }
  });

  it("leaves fast service mode off unless a stage opts in", () => {
    for (const stage of PIPELINE_STAGES) {
      expect(resolve(stage).serviceTier).toBe("default");
    }
    const opted = resolve("docs", { stage: "docs", stageExecution: { docs: { serviceTier: "fast" } } });
    expect(opted.serviceTier).toBe("fast");
    expect(resolve("plan").serviceTier).toBe("default");
  });

  it("drops a service tier the provider cannot honour", () => {
    const resolved = resolve("plan", {
      stage: "plan",
      stageExecution: { plan: { model: "claude-opus-5[1m]", serviceTier: "fast" } },
    });
    expect(resolved.serviceTier).toBe("default");
    expect(stageExecutionSpawnArgs(resolved)).not.toHaveProperty("serviceTier");
  });

  it("names no model outside the catalog", () => {
    for (const stage of PIPELINE_STAGES) {
      expect(PIPELINE_MODEL_CATALOG[resolve(stage).model]).toBeDefined();
    }
  });

  it("keeps the cheap short-thread model out of every pipeline default", () => {
    const shortThreadModel = "openrouter/~deepseek/deepseek-v4-flash-latest";
    expect(PIPELINE_MODEL_CATALOG[shortThreadModel]).toBeDefined();
    for (const stage of PIPELINE_STAGES) {
      expect(resolve(stage).model).not.toBe(shortThreadModel);
    }
  });
});

describe("escalation on retry", () => {
  it("climbs one tier per repeat and stops at the strongest", () => {
    expect(escalatedTier("fast", 0)).toBe("fast");
    expect(escalatedTier("fast", 1)).toBe("standard");
    expect(escalatedTier("fast", 2)).toBe("strong");
    expect(escalatedTier("fast", 9)).toBe("strong");
    expect(escalatedTier("strong", 3)).toBe("strong");
  });

  it("treats a repeated attempt and a repeated cycle as one signal, not two", () => {
    expect(stageEscalationSteps({ attemptOrdinal: 2, repeatedCycles: 1 })).toBe(1);
    expect(stageEscalationSteps({ attemptOrdinal: 1, repeatedCycles: 2 })).toBe(2);
    expect(stageEscalationSteps({ attemptOrdinal: 3, repeatedCycles: 0 })).toBe(2);
    expect(stageEscalationSteps({})).toBe(0);
  });

  it("escalates a cheap stage to a stronger model on its second attempt", () => {
    const first = resolve("docs", { stage: "docs", escalationSteps: 0 });
    const second = resolve("docs", { stage: "docs", escalationSteps: 1 });
    expect(first.model).toBe("gpt-5.6-luna");
    expect(second).toMatchObject({ baseTier: "fast", tier: "standard", escalationSteps: 1, model: "gpt-5.6-terra" });
  });

  it("cannot climb forever", () => {
    const resolved = resolve("docs", { stage: "docs", escalationSteps: 25 });
    expect(resolved.tier).toBe("strong");
    expect(resolved.escalationSteps).toBe(DEFAULT_STAGE_PROFILES.docs.maxEscalations);
  });

  it("honours a per-stage escalation bound of zero", () => {
    const resolved = resolve("docs", {
      stage: "docs",
      stageExecution: { docs: { maxEscalations: 0 } },
      escalationSteps: 2,
    });
    expect(resolved).toMatchObject({ tier: "fast", escalationSteps: 0 });
  });

  it("never substitutes a model the project pinned exactly", () => {
    const resolved = resolve("implementation", {
      stage: "implementation",
      stageExecution: { implementation: { model: "claude-sonnet-5" } },
      escalationSteps: 2,
    });
    expect(resolved).toMatchObject({
      model: "claude-sonnet-5",
      providerId: "claude-code",
      modelPinned: true,
      escalationSteps: 0,
    });
  });
});

describe("stored policies keep working", () => {
  it("parses a policy saved before the stage table existed", () => {
    const stored = policyFixture();
    delete (stored as { stageExecution?: unknown }).stageExecution;
    const parsed = projectPolicySchema.safeParse(stored);
    expect(parsed.success).toBe(true);
  });

  it("maps the stored implementation and review profiles onto their stages", () => {
    const legacy = {
      implementation: { model: "implementation-model", reasoningLevel: "medium" as const, permissionMode: "full" as const },
      review: { providerId: "codex", model: "review-model", serviceTier: "fast" as const },
    };
    expect(resolve("implementation", { stage: "implementation", legacy })).toMatchObject({
      model: "implementation-model",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      source: "legacy-policy",
    });
    expect(resolve("review", { stage: "review", legacy })).toMatchObject({
      providerId: "codex",
      model: "review-model",
      serviceTier: "fast",
      source: "legacy-policy",
    });
  });

  it("leaves the other seven stages on their defaults when only the old fields are set", () => {
    const legacy = { implementation: { model: "implementation-model" }, review: { model: "review-model" } };
    expect(resolve("plan", { stage: "plan", legacy })).toMatchObject({ model: "gpt-5.6-sol", source: "default" });
    expect(resolve("docs", { stage: "docs", legacy })).toMatchObject({ model: "gpt-5.6-luna", source: "default" });
  });

  it("lets the stage table override the old fields", () => {
    const resolved = resolve("review", {
      stage: "review",
      legacy: { review: { model: "review-model" } },
      stageExecution: { review: { tier: "standard" } },
    });
    expect(resolved).toMatchObject({ model: "gpt-5.6-terra", tier: "standard", source: "stage-policy" });
  });
});

describe("model ids are validated when a policy is parsed", () => {
  function policyWith(stageExecution: Record<string, unknown>) {
    return projectPolicySchema.safeParse(policyFixture({ stageExecution } as never));
  }

  it("rejects a model no provider offers", () => {
    const parsed = policyWith({ plan: { model: "gpt-9-imaginary" } });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && JSON.stringify(parsed.error.issues))
      .toContain("No configured provider offers the model");
  });

  it("rejects a provider that does not own the named model", () => {
    const parsed = policyWith({ plan: { providerId: "claude-code", model: "gpt-5.6-sol" } });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && JSON.stringify(parsed.error.issues)).toContain("does not offer");
  });

  it("rejects an unknown provider", () => {
    expect(policyWith({ plan: { providerId: "acme-llm", model: "gpt-5.6-sol" } }).success).toBe(false);
  });

  it("rejects a provider named without a model, which would pair it with another provider's", () => {
    const parsed = policyWith({ plan: { providerId: "claude-code", serviceTier: "fast" } });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && JSON.stringify(parsed.error.issues)).toContain("requires an explicit model");
  });

  it("rejects a fast service tier the provider cannot honour", () => {
    const parsed = policyWith({ review: { model: "claude-opus-5[1m]", serviceTier: "fast" } });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && JSON.stringify(parsed.error.issues)).toContain("fast service tier");
  });

  it("accepts a real model on the provider that offers it", () => {
    expect(policyWith({ canary: { providerId: "codex", model: "gpt-5.6-luna", tier: "fast" } }).success).toBe(true);
  });
});

describe("spawn arguments", () => {
  it("declares every execution input explicit so nothing is inherited", () => {
    const args = stageExecutionSpawnArgs(resolve("plan"));
    expect(args).toMatchObject({
      providerId: "codex",
      model: "gpt-5.6-sol",
      reasoningLevel: "xhigh",
      serviceTier: "default",
      permissionMode: "auto",
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        serviceTier: "explicit",
        permissionMode: "explicit",
      },
    });
  });

  it("omits permission mode when the project leaves it unset", () => {
    const args = stageExecutionSpawnArgs(resolve("implementation"));
    expect(args).not.toHaveProperty("permissionMode");
    expect(args.executionInputSources).not.toHaveProperty("permissionMode");
  });
});

describe("measured cost", () => {
  const usage = {
    inputTokens: 1_000_000,
    cachedInputTokens: 400_000,
    outputTokens: 100_000,
    reasoningOutputTokens: 50_000,
    totalTokens: 1_100_000,
  };

  it("bills uncached input, cached input, and output at their own rates", () => {
    expect(costMicroUsd(
      { inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 10 },
      usage,
    )).toBe(600_000 * 2 + 400_000 * 0.5 + 100_000 * 10);
  });

  it("reports no cost rather than a guessed one when a model has no published rate", () => {
    expect(PIPELINE_MODEL_CATALOG["gpt-5.6-sol"]?.rate).toBeNull();
    expect(stageCostMicroUsd("gpt-5.6-sol", usage)).toBeNull();
    expect(stageCostMicroUsd("not-a-model", usage)).toBeNull();
  });
});
