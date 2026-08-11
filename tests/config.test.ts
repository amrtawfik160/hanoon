import { expect, it } from "vitest";
import { parseGlobalConfig } from "../src/config";

function globalValues(overrides: Record<string, string | undefined> = {}) {
  return {
    botToken: "123:test-token",
    bbAppBaseUrl: "",
    pollTimeoutSeconds: "30",
    ...overrides,
  };
}

it("defaults controller execution to Opus 5 at xhigh with full permissions", () => {
  const parsed = parseGlobalConfig(globalValues({ maxConcurrentJobs: undefined }));

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  expect(parsed.value).toMatchObject({
    maxConcurrentJobs: 2,
    controllerModel: "claude-opus-5[1m]",
    controllerReasoningLevel: "xhigh",
    controllerServiceTier: "default",
    controllerPermissionMode: "full",
  });
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

it("rejects an unknown controller model instead of silently falling back", () => {
  expect(parseGlobalConfig({
    ...globalValues({ maxConcurrentJobs: undefined }),
    controllerModel: "made-up-model",
  })).toEqual({
    ok: false,
    message: "Fix the Telegram Agent URL, polling timeout, or controller execution settings.",
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
