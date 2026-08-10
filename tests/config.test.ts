import { expect, it } from "vitest";
import { parseGlobalConfig } from "../src/config";

const telegramSettings = {
  botToken: "123:test-token",
  bbAppBaseUrl: "",
  pollTimeoutSeconds: "30",
};

it("defaults controller execution to Opus 5 at xhigh with full permissions", () => {
  const parsed = parseGlobalConfig(telegramSettings);

  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error(parsed.message);
  expect(parsed.value).toMatchObject({
    controllerModel: "claude-opus-5[1m]",
    controllerReasoningLevel: "xhigh",
    controllerServiceTier: "default",
    controllerPermissionMode: "full",
  });
});

it("preserves a non-default controller execution profile", () => {
  const parsed = parseGlobalConfig({
    ...telegramSettings,
    controllerModel: "gpt-5.6-terra",
    controllerReasoningLevel: "high",
    controllerServiceTier: "default",
    controllerPermissionMode: "accept-edits",
  });

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
    ...telegramSettings,
    controllerModel: "made-up-model",
  })).toEqual({
    ok: false,
    message: "Fix the Telegram Agent URL, polling timeout, or controller execution settings.",
  });
});
