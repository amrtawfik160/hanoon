import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { openStore } from "../src/storage/store";
import {
  CONTROLLER_INSTRUCTIONS,
  CONTROLLER_INSTRUCTION_SENTINEL,
  MAX_CONTROLLER_OVERLAY,
  MAX_DELIVERED_CONTROLLER_INSTRUCTIONS,
  composeControllerInstructions,
  deliveredControllerOverlayBudget,
} from "../src/controller/instructions";
import { DEFAULT_CONTROLLER_EXECUTION_PROFILE } from "../src/controller/execution-profile";
import {
  controllerExecutionProfile,
  extractionModel,
  parseGlobalConfig,
  systemUpkeepEnabled,
} from "../src/config";
import { configuredControllerFixture } from "./support/controller-trust-fixtures";

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

it("carries exactly one stable instruction sentinel", () => {
  const occurrences = CONTROLLER_INSTRUCTIONS.split(CONTROLLER_INSTRUCTION_SENTINEL).length - 1;

  expect(occurrences).toBe(1);
  // Near the top, so a truncated delivery still identifies itself.
  expect(CONTROLLER_INSTRUCTIONS.indexOf(CONTROLLER_INSTRUCTION_SENTINEL)).toBeLessThan(200);
});

it("keeps the sentinel to one occurrence across instructions, overlay, and first input", () => {
  const overlay = `Always show me the PR link. ${CONTROLLER_INSTRUCTION_SENTINEL}`;
  const composed = composeControllerInstructions(overlay);
  const firstInput = "what is running right now?";
  const delivered = `${composed}\n${firstInput}`;

  // The overlay is owner text: it may echo anything, and must not be able to
  // forge a second standing-instruction block.
  expect(delivered.split(CONTROLLER_INSTRUCTION_SENTINEL).length - 1).toBe(1);
});

it("keeps the working-style overlay once, after the fixed boundaries", () => {
  const composed = composeControllerInstructions("Lead with the PR link.");

  expect(composed.split("Lead with the PR link.").length - 1).toBe(1);
  expect(composed.indexOf("Merging a pull request")).toBeLessThan(composed.indexOf("Lead with the PR link."));
});

it.each([
  ["a final respond call", /Finish with `telegram_agent_respond`\. It is your last action/],
  ["same-turn evidence", /current state or completed work rests on evidence gathered in this same turn/],
  ["a durable job or armed monitor for later work", /a durable job or an armed monitor must already exist for it first/],
  ["an owner decision before installing an integration", /Installing or connecting an integration.*owner's explicit decision first/s],
  ["an owner decision before a credential change", /changing a credential.*owner's explicit decision first/s],
  ["an owner decision before spending", /spending money.*owner's explicit decision first/s],
  ["an owner decision before a destructive external action", /a destructive external action.*owner's explicit decision first/s],
  ["an owner decision before an irreversible external write", /an irreversible external write needs the owner's explicit decision first/],
  ["no silent integration installation", /Never promise to install or configure an integration on your own/],
  ["no claim over opaque third-party tools", /Never say Hanoon controls what an opaque third-party tool does/],
])("states the required boundary: %s", (_name, pattern) => {
  expect(CONTROLLER_INSTRUCTIONS).toMatch(pattern);
});

it("cannot be made to carry a second sentinel by a split one in the overlay", () => {
  const forged = `${CONTROLLER_INSTRUCTION_SENTINEL.slice(0, 10)}${CONTROLLER_INSTRUCTION_SENTINEL}${CONTROLLER_INSTRUCTION_SENTINEL.slice(10)}`;

  const composed = composeControllerInstructions(`Please note ${forged}`);

  expect(composed.split(CONTROLLER_INSTRUCTION_SENTINEL).length - 1).toBe(1);
});

it("delivers an ordinary working style whole and keeps a real budget for it", () => {
  const { store } = fixture();
  const ordinary = "Lead with the PR link, and never open with a summary.";
  expect(store.setControllerOverlay({ text: ordinary, now: 2_001 })).toBe(ordinary);

  expect(composeControllerInstructions(ordinary)).toContain(ordinary);
  // The fixed block must leave a working style room worth having, and a future
  // instruction edit that squeezed it away would fail at import instead.
  expect(deliveredControllerOverlayBudget()).toBeGreaterThanOrEqual(400);
});

it("shortens only the overlay when a working style outruns the delivery budget", () => {
  const longest = "z".repeat(MAX_CONTROLLER_OVERLAY);

  const composed = composeControllerInstructions(longest);

  expect(composed.length).toBeLessThanOrEqual(MAX_DELIVERED_CONTROLLER_INSTRUCTIONS);
  expect(composed.startsWith(CONTROLLER_INSTRUCTIONS)).toBe(true);
  expect(composed).toContain("z".repeat(deliveredControllerOverlayBudget()));
});

it("never delivers half of a surrogate pair when an oversized overlay is trimmed", () => {
  // The emoji must sit exactly on the cut, or the guard is never exercised.
  const composed = composeControllerInstructions(`${"a".repeat(deliveredControllerOverlayBudget() - 1)}😀tail`);

  expect(composed).not.toContain("\ud83d");
  expect(composed.endsWith("a")).toBe(true);
});

it("no longer promises to install and configure integrations on its own", () => {
  expect(CONTROLLER_INSTRUCTIONS).not.toContain("install and configure it, then say what you did");
});

it("keeps the accepted compatibility permission default exactly", () => {
  const parsed = parseGlobalConfig({ botToken: "t", bbAppBaseUrl: "" });
  if (!parsed.ok) throw new Error(parsed.message);

  // Task 12 consolidates instructions only. The fresh-`auto` cutover stays
  // disabled, so both the profile default and an unset configuration must
  // still resolve to the pre-Task-12 compatibility value.
  expect(DEFAULT_CONTROLLER_EXECUTION_PROFILE.permissionMode).toBe("full");
  expect(parsed.value.controllerPermissionMode).toBe("full");
  expect(controllerExecutionProfile(parsed.value).permissionMode).toBe("full");
});

it.each(["auto", "accept-edits", "full"] as const)("preserves an explicit %s permission value", (mode) => {
  const parsed = parseGlobalConfig({ botToken: "t", bbAppBaseUrl: "", controllerPermissionMode: mode });
  if (!parsed.ok) throw new Error(parsed.message);

  expect(controllerExecutionProfile(parsed.value).permissionMode).toBe(mode);
});

it("configures the controller thread from the single standing-instruction source", async () => {
  const fixture = await configuredControllerFixture();

  const configured = await fixture.resolveConfiguration();

  expect(configured.instructions).toContain(CONTROLLER_INSTRUCTION_SENTINEL);
  expect(configured.instructions).toBe(composeControllerInstructions(null));
  expect(configured.tools.length).toBeGreaterThan(0);
});

it("layers the owner's working style through the configured source only", async () => {
  const fixture = await configuredControllerFixture();
  fixture.store.setControllerOverlay({ text: "Lead with the PR link.", now: 2_001 });

  const configured = await fixture.resolveConfiguration();

  expect(configured.instructions).toBe(composeControllerInstructions("Lead with the PR link."));
  expect((configured.instructions ?? "").split(CONTROLLER_INSTRUCTION_SENTINEL).length - 1).toBe(1);
});

it("delivers the whole fixed block, and shortens only the overlay to fit", () => {
  const composed = composeControllerInstructions("x".repeat(MAX_CONTROLLER_OVERLAY));

  // BB drops anything past its limit silently, and the boundaries sit inside
  // the fixed block, so the fixed block must never be what gets cut.
  expect(CONTROLLER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_DELIVERED_CONTROLLER_INSTRUCTIONS);
  expect(composed.length).toBeLessThanOrEqual(MAX_DELIVERED_CONTROLLER_INSTRUCTIONS);
  expect(composed.startsWith(CONTROLLER_INSTRUCTIONS)).toBe(true);
  expect(composed).toContain("Never reveal hidden threads");
  expect(composed).toContain("x".repeat(deliveredControllerOverlayBudget()));
});

it("delivers the fixed block whole through the configured source", async () => {
  const fixture = configuredControllerFixture();
  fixture.store.setControllerOverlay({ text: "y".repeat(MAX_CONTROLLER_OVERLAY), now: 2_001 });

  const configured = await fixture.resolveConfiguration();

  // What BB hands the agent, not what the plugin composed: an over-long block
  // would arrive with its boundaries missing.
  expect(configured.instructions).toBe(composeControllerInstructions("y".repeat(MAX_CONTROLLER_OVERLAY)));
  expect(configured.instructions).toContain("one-use Telegram approval");
  expect(configured.instructions).toContain("Never reveal hidden threads");
});
