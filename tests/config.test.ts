import { expect, it } from "vitest";
import { controllerExecutionProfiles, parseGlobalConfig } from "../src/config";

function globalValues(overrides: Record<string, string | undefined> = {}) {
  return {
    botToken: "123:test-token",
    bbAppBaseUrl: "",
    ...overrides,
  };
}

it("defaults controller execution when only public connection settings are present", () => {
  const parsed = parseGlobalConfig(globalValues({ maxConcurrentJobs: undefined }));

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  expect(parsed.value).toMatchObject({
    maxConcurrentJobs: 5,
    controllerModel: "claude-opus-5[1m]",
    controllerFallbackModel1: "gpt-5.6-sol",
    controllerFallbackModel2: "disabled",
    controllerReasoningLevel: "xhigh",
    controllerServiceTier: "default",
    controllerPermissionMode: "full",
  });
});

it("builds the ordered controller fallback chain with one shared execution policy", () => {
  const parsed = parseGlobalConfig(globalValues({
    controllerModel: "claude-opus-5[1m]",
    controllerFallbackModel1: "gpt-5.6-terra",
    controllerFallbackModel2: "claude-sonnet-5",
    controllerReasoningLevel: "high",
    controllerServiceTier: "fast",
    controllerPermissionMode: "accept-edits",
  }));

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  expect(controllerExecutionProfiles(parsed.value)).toEqual([
    {
      model: "claude-opus-5[1m]",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "accept-edits",
    },
    {
      model: "gpt-5.6-terra",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "accept-edits",
    },
    {
      model: "claude-sonnet-5",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "accept-edits",
    },
  ]);
});

it("does not retry a disabled or duplicate fallback model", () => {
  const parsed = parseGlobalConfig(globalValues({
    controllerModel: "gpt-5.6-sol",
    controllerFallbackModel1: "gpt-5.6-sol",
    controllerFallbackModel2: "disabled",
  }));

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  expect(controllerExecutionProfiles(parsed.value).map((profile) => profile.model)).toEqual([
    "gpt-5.6-sol",
  ]);
});

it("does not let fallback settings weaken the strong-only routing kill switch", () => {
  const parsed = parseGlobalConfig(globalValues({
    capabilityModelRouting: "strong-only",
    controllerFallbackModel1: "gpt-5.6-terra",
    controllerFallbackModel2: "claude-sonnet-5",
  }));

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  expect(controllerExecutionProfiles(parsed.value).map((profile) => profile.model)).toEqual([
    "gpt-5.6-sol",
  ]);
});

it("preserves a non-default controller execution profile", () => {
  const parsed = parseGlobalConfig(globalValues({
    controllerModel: "gpt-5.6-terra",
    controllerReasoningLevel: "high",
    controllerServiceTier: "default",
    controllerPermissionMode: "accept-edits",
    maxConcurrentJobs: undefined,
  }));

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  expect(parsed.value).toMatchObject({
    controllerModel: "gpt-5.6-terra",
    controllerReasoningLevel: "high",
    controllerServiceTier: "default",
    controllerPermissionMode: "accept-edits",
  });
});

it.each([
  ["primary", { controllerModel: "made-up-model" }],
  ["fallback", { controllerFallbackModel1: "made-up-model" }],
] as const)("rejects an unknown %s controller model", (_label, invalidModel) => {
  expect(parseGlobalConfig({
    ...globalValues({ maxConcurrentJobs: undefined }),
    ...invalidModel,
  })).toEqual({
    ok: false,
    message: "Fix the Telegram Agent URL or controller execution settings.",
  });
});

it.each(["1", "2", "3", "4", "5", "6", "7", "8"]) (
  "accepts maxConcurrentJobs=%s",
  (maxConcurrentJobs) => {
    const parsed = parseGlobalConfig(globalValues({ maxConcurrentJobs }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.value.maxConcurrentJobs).toBe(Number(maxConcurrentJobs));
  },
);

it.each(["0", "9", "1.5", "not-a-number", ""]) (
  "rejects invalid maxConcurrentJobs=%s",
  (maxConcurrentJobs) => {
    expect(parseGlobalConfig(globalValues({ maxConcurrentJobs })).ok).toBe(false);
  },
);
