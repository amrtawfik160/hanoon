import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import { expect, it } from "vitest";
import { hashSecret } from "../src/crypto";
import { referenceBriefingFor } from "../src/reference/briefing";
import { readIngestionSource } from "../src/reference/ingestion";
import { ALL_MIGRATIONS, INGESTION_SOURCE_MIGRATIONS } from "../src/storage/migrations";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { TelegramIngress } from "../src/telegram/ingress";
import type { SendMessagePayload, TelegramUpdate } from "../src/telegram/types";
import { policyFixture } from "./helpers";

let fixtureNumber = 0;

const EXCERPT = `# Billing

Refunds are always a new document.`;

function fixture(pluginId = `ingestion-source-${fixtureNumber++}`): {
  store: TelegramAgentStore;
  db: Database.Database;
} {
  const { bb } = createFakePluginHost({ pluginId });
  return { db: bb.storage.database(), store: openStore(bb.storage) };
}

function groupUpdate(chatType: "group" | "supergroup" | "channel"): TelegramUpdate {
  return {
    update_id: 3,
    message: {
      message_id: 4,
      from: { id: 7, is_bot: false },
      chat: { id: -100, type: chatType },
      text: EXCERPT,
    },
  } as TelegramUpdate;
}

it("appends the ingestion_source table after the durable-core drop", () => {
  expect(ALL_MIGRATIONS.at(-1)).toBe(INGESTION_SOURCE_MIGRATIONS[0]);
  expect(INGESTION_SOURCE_MIGRATIONS[0]).toContain("CREATE TABLE ingestion_source");
  expect(INGESTION_SOURCE_MIGRATIONS[0]).toMatch(/status TEXT NOT NULL DEFAULT 'disabled'/);
});

it("creates the table disabled by default on a fresh store", () => {
  const { db } = fixture();
  const columns = db.prepare("PRAGMA table_info(ingestion_source)").all() as {
    name: string;
    dflt_value: string | null;
  }[];
  expect(columns.map((column) => column.name)).toEqual([
    "id",
    "chat_ref",
    "project_id",
    "captured_at",
    "excerpt",
    "status",
  ]);
  expect(columns.find((column) => column.name === "status")?.dflt_value).toBe("'disabled'");
});

it("records a source as disabled and keeps the read-only route empty", () => {
  const { store } = fixture();
  store.upsertProjectPolicy(policyFixture(), 1_000);

  const recorded = store.recordIngestionSource({
    chatRef: "telegram:-100",
    projectId: policyFixture().projectId,
    excerpt: EXCERPT,
    now: 2_000,
  });

  expect(recorded).toMatchObject({
    chatRef: "telegram:-100",
    projectId: policyFixture().projectId,
    capturedAt: 2_000,
    excerpt: EXCERPT,
    status: "disabled",
  });
  expect(store.listIngestionSources(policyFixture().projectId)).toEqual([recorded]);
  expect(store.readIngestionRoute(policyFixture().projectId)).toEqual([]);
  expect(readIngestionSource(recorded)).toBeNull();
});

it("does not file a disabled source as a reference document or outside reading", () => {
  const { store } = fixture();
  store.upsertProjectPolicy(policyFixture(), 1_000);
  store.saveReferenceDocument({
    scope: "project",
    projectId: policyFixture().projectId,
    title: "Product spec",
    source: "telegram:doc_1",
    markdown: "# Access\n\nOnly an owner may delete an account.",
    now: 1_500,
  });
  store.recordIngestionSource({
    chatRef: "telegram:-100",
    projectId: policyFixture().projectId,
    excerpt: EXCERPT,
    now: 2_000,
  });

  expect(store.listReferenceDocuments(policyFixture().projectId).map((document) => document.title))
    .toEqual(["Product spec"]);
  expect(store.searchReferencePassages({ query: "Refunds", projectId: policyFixture().projectId }))
    .toEqual([]);
  expect(referenceBriefingFor(store, policyFixture().projectId)).toContain("Product spec");
  expect(referenceBriefingFor(store, policyFixture().projectId)).not.toContain("Billing");
  expect(store.readIngestionRoute(policyFixture().projectId)).toEqual([]);
});

it("projects an enabled source through the outside-reading and reference-document model without writing it", () => {
  const { store } = fixture();
  const reading = readIngestionSource({
    id: "src_enabled",
    chatRef: "telegram:-100",
    projectId: policyFixture().projectId,
    capturedAt: 2_000,
    excerpt: EXCERPT,
    status: "enabled",
  });

  expect(reading).toEqual({
    source: "telegram:-100",
    capturedAt: 2_000,
    excerpt: EXCERPT,
    map: [{ path: ["Billing"], level: 1, characters: 34 }],
    passages: [{
      ordinal: "1",
      path: ["Billing"],
      body: "Refunds are always a new document.",
    }],
  });
  expect(store.listReferenceDocuments(policyFixture().projectId)).toEqual([]);
  expect(store.searchReferencePassages({ query: "Refunds", projectId: policyFixture().projectId }))
    .toEqual([]);
});

it("leaves group and channel messages untouched: no source, no reference, no job", async () => {
  const { store } = fixture("ingestion-source-ingress");
  store.upsertProjectPolicy(policyFixture(), 1_000);
  store.createPairingCode(hashSecret("pair-ingestion"), 1_000, 20_000);
  expect(store.pairOwnerWithCode(hashSecret("pair-ingestion"), "7", "7", 1_001)).toEqual({ ok: true });

  const telegram = {
    sent: [] as Array<{ chatId: string; payload: SendMessagePayload }>,
    async sendMessage(chatId: string, payload: SendMessagePayload) {
      this.sent.push({ chatId, payload });
      return { message_id: this.sent.length };
    },
    async editMessage() {},
    async answerCallback() {},
  };
  const ingress = new TelegramIngress({ store, telegram });

  for (const chatType of ["group", "supergroup", "channel"] as const) {
    await ingress.handleClaimed(groupUpdate(chatType), 2_000);
  }

  expect(store.listIngestionSources(policyFixture().projectId)).toEqual([]);
  expect(store.readIngestionRoute(policyFixture().projectId)).toEqual([]);
  expect(store.listReferenceDocuments(policyFixture().projectId)).toEqual([]);
  expect(store.listJobs(10)).toEqual([]);
  expect(telegram.sent).toEqual([]);
});
