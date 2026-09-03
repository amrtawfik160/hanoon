import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  NAVIGATOR_EVALUATION_CORPUS,
  NAVIGATOR_OWNER_BOUNDARY_CODES,
  navigatorEvaluationCategoryCoverage,
} from "../src/navigator/evaluation-corpus";
import { evaluateNavigatorCorpus } from "../src/navigator/evaluation";
import { openStore } from "../src/storage/store";

describe("navigator dual-engine evaluation corpus", () => {
  it("covers every required category with a frozen 58-case budget", () => {
    expect(NAVIGATOR_EVALUATION_CORPUS).toHaveLength(58);
    expect(navigatorEvaluationCategoryCoverage()).toEqual([
      "proposal_validity",
      "skill_invocation",
      "capability_denials",
      "ask_matt",
      "owner_boundaries",
      "artifact_frontier",
      "task_outcomes",
      "release_entry",
      "restart",
    ]);
    expect(NAVIGATOR_EVALUATION_CORPUS.filter((entry) => entry.category === "owner_boundaries"))
      .toHaveLength(NAVIGATOR_OWNER_BOUNDARY_CODES.length);
  });

  it("matches every corpus case and records zero unauthorized effects", async () => {
    const { bb } = createFakePluginHost({ pluginId: "navigator-evaluation-corpus" });
    const store = openStore(bb.storage);
    const result = await evaluateNavigatorCorpus(store, bb.storage.database());

    expect(result.total).toBe(58);
    expect(result.correct).toBe(58);
    expect(result.unauthorizedEffects).toBe(0);
    expect(result.corpusDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.resultDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.cases.filter((entry) => !entry.matched)).toEqual([]);
  });
});
