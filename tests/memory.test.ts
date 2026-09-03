import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { openStore } from "../src/storage/store";

const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000;

let fixtureNumber = 0;
function fixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-agent-memory-${fixtureNumber++}` });
  return { bb, store: openStore(bb.storage, bb.storage.kv, () => NOW) };
}

function remember(
  store: ReturnType<typeof openStore>,
  overrides: Partial<Parameters<ReturnType<typeof openStore>["rememberMemory"]>[0]> = {},
) {
  return store.rememberMemory({
    scope: "owner",
    kind: "preference",
    subject: "deploy window",
    body: "Deploy parknwash only on weekday mornings.",
    source: "owner",
    now: NOW,
    ...overrides,
  });
}

it("recalls a memory by the words the owner actually used", () => {
  const { store } = fixture();
  remember(store);
  remember(store, { subject: "review depth", body: "Always run the full test suite before merging." });

  const hits = store.recallMemories({ scope: "owner", query: "when can I deploy?", limit: 5, now: NOW });

  expect(hits.map((memory) => memory.subject)).toEqual(["deploy window"]);
  expect(hits[0]).toMatchObject({ kind: "preference", source: "owner", body: expect.stringContaining("weekday") });
});

it("survives punctuation and FTS operators in the owner's question", () => {
  const { store } = fixture();
  remember(store);

  for (const query of ['deploy "OR" NEAR(', "-- drop", "*", "", "   ", "AND OR NOT"]) {
    expect(() => store.recallMemories({ scope: "owner", query, limit: 5, now: NOW })).not.toThrow();
  }
  expect(store.recallMemories({ scope: "owner", query: 'deploy"', limit: 5, now: NOW })).toHaveLength(1);
});

it("ranks a fresh important memory above a stale unimportant one", () => {
  const { store } = fixture();
  remember(store, {
    subject: "old deploy note",
    body: "Deploy notes from a long time ago.",
    importance: 0.2,
    now: NOW - 200 * DAY_MS,
  });
  const fresh = remember(store, {
    subject: "new deploy note",
    body: "Deploy notes from today.",
    importance: 0.9,
  });

  const hits = store.recallMemories({ scope: "owner", query: "deploy notes", limit: 5, now: NOW });

  expect(hits[0]?.id).toBe(fresh.id);
  expect(hits).toHaveLength(2);
});

it("keeps project memories out of unrelated projects but always keeps owner memories", () => {
  const { store } = fixture();
  remember(store, { subject: "global tone", body: "Keep answers short." });
  remember(store, { scope: "proj_a", subject: "a deploys", body: "Project A deploys with make ship." });
  remember(store, { scope: "proj_b", subject: "b deploys", body: "Project B deploys with npm run ship." });

  const inProjectA = store.recallMemories({ scope: "proj_a", query: "deploy short", limit: 10, now: NOW });

  expect(inProjectA.map((memory) => memory.subject).sort()).toEqual(["a deploys", "global tone"]);
});

it("supersedes an earlier memory on the same subject instead of stacking duplicates", () => {
  const { store } = fixture();
  const first = remember(store, { body: "Deploy parknwash only on weekday mornings." });
  const second = remember(store, { body: "Deploy parknwash any weekday, mornings or evenings.", now: NOW + 1_000 });

  const hits = store.recallMemories({ scope: "owner", query: "deploy parknwash", limit: 5, now: NOW + 1_000 });

  expect(hits).toHaveLength(1);
  expect(hits[0]?.id).toBe(second.id);
  expect(hits[0]?.body).toContain("evenings");
  expect(store.getMemory(first.id)).toMatchObject({ supersededBy: second.id });
});

it("forgets a memory on request and stops recalling it", () => {
  const { store } = fixture();
  const memory = remember(store);

  expect(store.forgetMemory({ id: memory.id, now: NOW + 5 })).toBe(true);

  expect(store.recallMemories({ scope: "owner", query: "deploy", limit: 5, now: NOW + 5 })).toEqual([]);
  expect(store.forgetMemory({ id: memory.id, now: NOW + 6 })).toBe(false);
});

it("returns the strongest memories when there is no question to match on", () => {
  const { store } = fixture();
  remember(store, { subject: "weak", body: "Barely worth keeping.", importance: 0.1 });
  remember(store, { subject: "strong", body: "Matters a lot.", importance: 1 });

  const briefing = store.recallMemories({ scope: "owner", limit: 1, now: NOW });

  expect(briefing.map((memory) => memory.subject)).toEqual(["strong"]);
});

it("bounds how much it keeps by dropping the weakest memory", () => {
  const { store } = fixture();
  for (let index = 0; index < 12; index += 1) {
    remember(store, {
      subject: `note ${index}`,
      body: `Body number ${index} about deploys.`,
      importance: index === 0 ? 0.05 : 0.8,
      now: NOW + index,
    });
  }

  expect(store.countMemories("owner")).toBeLessThanOrEqual(10);
  expect(store.recallMemories({ scope: "owner", query: "note 0", limit: 20, now: NOW })
    .some((memory) => memory.subject === "note 0")).toBe(false);
});

it("refuses to keep a secret the owner pasted", () => {
  const { store } = fixture();

  for (const body of [
    "my api_key = sk-abcdefghijklmnop",
    "use bearer eyJhbGciOiJIUzI1NiJ9.abc",
    "the bot token is 123456789:AAHkQwErTyUiOpAsDfGhJkLzXcVbNmQwErT",
    "password: hunter2hunter2",
  ]) {
    expect(() => remember(store, { subject: "credentials", body })).toThrow(/credential/i);
  }

  expect(store.countMemories("owner")).toBe(0);
});

it("records that a recalled memory was used so it decays more slowly", () => {
  const { store } = fixture();
  const memory = remember(store);

  store.recallMemories({ scope: "owner", query: "deploy", limit: 5, now: NOW + DAY_MS });

  expect(store.getMemory(memory.id)).toMatchObject({ useCount: 1, lastUsedAt: NOW + DAY_MS });
});

it.each([
  ["a spoken password", "the console password is hunter2swordfish"],
  ["a passphrase colon form", "passphrase: correct-horse-battery"],
  ["an env-var assignment", "run with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwx"],
  ["an OpenAI-style key", "use sk-abcdefghijklmnopqrstuvwxyz01"],
  ["a private key block", "-----BEGIN RSA PRIVATE KEY----- MIIEpAIB"],
])("refuses to remember %s", (_label, body) => {
  const { store } = fixture();

  expect(() => store.rememberMemory({
    scope: "owner", kind: "fact", subject: "a credential", body,
    source: "owner", now: 2_000,
  })).toThrow(/credential/);
});

it("still remembers ordinary text that merely mentions credentials", () => {
  const { store } = fixture();

  const stored = store.rememberMemory({
    scope: "owner", kind: "fact", subject: "where credentials live",
    body: "The console credentials live in the vault; never paste them into chat.",
    source: "owner", now: 2_000,
  });

  expect(stored.subject).toBe("where credentials live");
});

// The owner's own import is the one path allowed to carry secret-shaped text.
// It arrives from the protected host under the owner's CLI identity, never from
// provider output or a chat message, so the stored-secret screen that guards
// `rememberMemory` would only be refusing the owner their own file.

it("imports an owner entry the remember path would refuse", () => {
  const { store } = fixture();
  const body = "STRIPE_SECRET_KEY=sk-live-000111222333444555666";

  expect(() => store.rememberMemory({
    scope: "owner", kind: "fact", subject: "stripe key", body, source: "owner", now: 2_000,
  })).toThrow(/credential/);

  const imported = store.importOwnerMemory({
    scope: "owner", kind: "fact", subject: "stripe key", body, now: 2_000,
  });

  expect(imported.body).toBe(body);
  expect(imported.source).toBe("owner");
});

it("recalls an imported secret only when asked for it", () => {
  const { store } = fixture();
  store.importOwnerMemory({
    scope: "owner", kind: "fact", subject: "stripe key",
    body: "STRIPE_SECRET_KEY=sk-live-000111222333444555666", now: 2_000,
  });

  const recalled = store.recallMemories({ scope: "owner", query: "stripe", limit: 10, now: 3_000 });

  expect(recalled.map((memory) => memory.subject)).toContain("stripe key");
});

it("replaces an imported entry when the same subject is imported again", () => {
  const { store } = fixture();
  store.importOwnerMemory({
    scope: "owner", kind: "fact", subject: "stripe key", body: "old value", now: 2_000,
  });
  store.importOwnerMemory({
    scope: "owner", kind: "fact", subject: "stripe key", body: "new value", now: 3_000,
  });

  const live = store.recallMemories({ scope: "owner", query: "stripe", limit: 10, now: 4_000 })
    .filter((memory) => memory.subject === "stripe key");

  expect(live.map((memory) => memory.body)).toEqual(["new value"]);
});

it("still refuses an agent-written memory that carries a secret", () => {
  const { store } = fixture();

  expect(() => store.rememberMemory({
    scope: "owner", kind: "fact", subject: "stripe key",
    body: "STRIPE_SECRET_KEY=sk-live-000111222333444555666", source: "agent", now: 2_000,
  })).toThrow(/credential/);
});
