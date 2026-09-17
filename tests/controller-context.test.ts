import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import { completeTurnThroughFinalization } from "./support/controller-trust-fixtures";
import {
  buildTurnContext,
  composeTurnInput,
  detectStandingInstruction,
} from "../src/controller/context";

const NOW = 1_800_000_000_000;

let fixtureNumber = 0;
function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-agent-context-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  store.createPairingCode(hashSecret("pair-context"), NOW - 1_000, NOW + 10_000);
  expect(store.pairOwnerWithPrivateChatCode(hashSecret("pair-context"), "7", "70", NOW - 500)).toEqual({ ok: true });
  return { store };
}

describe("standing instruction capture", () => {
  it("captures the instructions an owner actually gives", () => {
    expect(detectStandingInstruction("always deploy parknwash on weekday mornings")).toMatchObject({
      kind: "preference",
      body: "always deploy parknwash on weekday mornings",
    });
    expect(detectStandingInstruction("Remember that my staging db is called cyndra_stage")).toMatchObject({
      kind: "fact",
      body: "my staging db is called cyndra_stage",
    });
    expect(detectStandingInstruction("never merge without my approval")).toMatchObject({
      kind: "correction",
      body: "never merge without my approval",
    });
  });

  it("ignores ordinary conversation", () => {
    expect(detectStandingInstruction("why is this thread taking so long?")).toBeNull();
    expect(detectStandingInstruction("it always takes ages to deploy")).toBeNull();
    expect(detectStandingInstruction("hi")).toBeNull();
    expect(detectStandingInstruction("remember")).toBeNull();
  });
});

describe("turn context", () => {
  it("gives the agent the memories that match the question and nothing else", () => {
    const { store } = fixture();
    store.rememberMemory({
      scope: "owner",
      kind: "preference",
      subject: "deploy window",
      body: "Deploy parknwash only on weekday mornings.",
      source: "owner",
      now: NOW,
    });
    store.rememberMemory({
      scope: "owner",
      kind: "fact",
      subject: "coffee",
      body: "The owner drinks flat whites.",
      source: "agent",
      now: NOW,
    });

    const context = buildTurnContext({
      store,
      controllerKey: "owner-7-controller",
      inputText: "can I deploy parknwash now?",
      includeDigest: false,
      now: NOW,
    });

    expect(context).toContain("deploy window");
    expect(context).toContain("weekday mornings");
    expect(context).not.toContain("flat whites");
  });

  it("returns nothing when there is nothing worth telling the agent", () => {
    const { store } = fixture();

    expect(buildTurnContext({
      store,
      controllerKey: "owner-7-controller",
      inputText: "hi",
      includeDigest: true,
      now: NOW,
    })).toBeNull();
    expect(composeTurnInput(null, "hi")).toBe("hi");
  });


  it("keeps the owner's message clearly separated from injected context", () => {
    expect(composeTurnInput("What you already know", "deploy it")).toBe(
      "What you already know\n\n---\n\nOwner message:\ndeploy it",
    );
  });
});
