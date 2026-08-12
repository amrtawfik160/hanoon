import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { openStore } from "../src/storage/store";
import {
  CONTROLLER_INSTRUCTIONS,
  MAX_CONTROLLER_OVERLAY,
  composeControllerInstructions,
} from "../src/controller/instructions";
import { extractionModel, parseGlobalConfig, systemUpkeepEnabled } from "../src/config";

let fixtureNumber = 0;

function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-overlay-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001)).toEqual({ ok: true });
  return { bb, store };
}

it("appends the overlay migration after every shipped one", () => {
  expect(ALL_MIGRATIONS[23]).toContain("CREATE TABLE controller_overlay");
});

it("returns the fixed instructions unchanged when nothing is set", () => {
  expect(composeControllerInstructions(null)).toBe(CONTROLLER_INSTRUCTIONS);
  expect(composeControllerInstructions("   ")).toBe(CONTROLLER_INSTRUCTIONS);
});

it("layers the owner's wording after the fixed instructions, never before", () => {
  const composed = composeControllerInstructions("Always show me the PR link.");

  expect(composed.startsWith(CONTROLLER_INSTRUCTIONS)).toBe(true);
  expect(composed).toContain("Always show me the PR link.");
  // A boundary stated above must not be reorderable by anything the overlay says.
  expect(composed.indexOf("Merging a pull request")).toBeLessThan(composed.indexOf("Always show me"));
});

it("stores, replaces, and clears the working style", () => {
  const { store } = fixture();

  expect(store.setControllerOverlay({ text: "Be terser.", now: 2_001 })).toBe("Be terser.");
  expect(store.getControllerOverlay()).toBe("Be terser.");

  expect(store.setControllerOverlay({ text: "Lead with the PR link.", now: 2_002 }))
    .toBe("Lead with the PR link.");
  expect(store.getControllerOverlay()).toBe("Lead with the PR link.");

  expect(store.setControllerOverlay({ text: "   ", now: 2_003 })).toBeNull();
  expect(store.getControllerOverlay()).toBeNull();
});

it("refuses an overlay that is too long or carries a credential", () => {
  const { store } = fixture();

  expect(() => store.setControllerOverlay({ text: "x".repeat(MAX_CONTROLLER_OVERLAY + 1), now: 2_001 }))
    .toThrow(/at most/);
  expect(() => store.setControllerOverlay({ text: "always use token=ghp_abcdefghijklmnopqrst", now: 2_001 }))
    .toThrow(/credential/);
  expect(store.getControllerOverlay()).toBeNull();
});

it("leaves background learning on the project default until it is configured", () => {
  const parsed = parseGlobalConfig({ botToken: "t", bbAppBaseUrl: "" });
  if (!parsed.ok) throw new Error(parsed.message);

  expect(parsed.value.extractionModel).toBe("inherit");
  expect(extractionModel(parsed.value)).toBeNull();
});

it("uses a chosen background model when one is configured", () => {
  const parsed = parseGlobalConfig({ botToken: "t", bbAppBaseUrl: "", extractionModel: "claude-sonnet-5" });
  if (!parsed.ok) throw new Error(parsed.message);

  expect(extractionModel(parsed.value)).toBe("claude-sonnet-5");
});

it("rejects a background model this plugin does not know", () => {
  expect(parseGlobalConfig({ botToken: "t", bbAppBaseUrl: "", extractionModel: "gpt-nonsense" }).ok).toBe(false);
});

it("keeps self-maintenance on unless the owner turns it off", () => {
  const parsed = parseGlobalConfig({ botToken: "t", bbAppBaseUrl: "" });
  if (!parsed.ok) throw new Error(parsed.message);

  expect(systemUpkeepEnabled(parsed.value)).toBe(true);
});

it("lets the owner turn self-maintenance off", () => {
  const parsed = parseGlobalConfig({ botToken: "t", bbAppBaseUrl: "", systemUpkeep: "disabled" });
  if (!parsed.ok) throw new Error(parsed.message);

  expect(systemUpkeepEnabled(parsed.value)).toBe(false);
});

it("rejects a self-maintenance value that is neither on nor off", () => {
  expect(parseGlobalConfig({ botToken: "t", bbAppBaseUrl: "", systemUpkeep: "sometimes" }).ok).toBe(false);
});
