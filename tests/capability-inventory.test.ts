import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import {
  admitInventoryItem,
  discoverExternalInventory,
  type CapabilityInventoryItem,
  type ExternalInventoryReadClient,
} from "../src/capabilities/inventory";
import { CAPABILITY_BY_ID } from "../src/capabilities/catalog";
import { CapabilityRepository } from "../src/storage/capability-repository";
import { CAPABILITY_MIGRATIONS } from "../src/storage/migrations";
import { CapabilityInventoryService } from "../src/services/capability-inventory-service";
import { openStore } from "../src/storage/store";
import { policyFixture } from "./helpers";

const now = 8_000;

function client(overrides: Partial<ExternalInventoryReadClient> = {}): ExternalInventoryReadClient {
  return {
    providers: {
      list: vi.fn(async () => [{
        id: "codex",
        displayName: "Codex",
        available: true,
        capabilities: { supportsServiceTier: true },
      }]),
      models: vi.fn(async () => ({
        providers: [],
        permissionCeiling: "full",
        models: [{
          id: "gpt-5.6-sol",
          model: "gpt-5.6-sol",
          displayName: "Sol",
          routeProviderId: "codex",
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [{ reasoningEffort: "high", description: "secret detail" }],
          description: "do not persist this unbounded provider prose",
          isDefault: false,
        }],
        selectedOnlyModels: [],
        modelLoadError: null,
      })),
    },
    plugins: {
      list: vi.fn(async () => ({ plugins: [{
        id: "docs-plugin",
        source: "path:/private/root?token=secret",
        rootDir: "/private/root",
        version: "1.2.3",
        provenance: "direct",
        enabled: true,
        status: "running",
        capabilities: [{ kind: "skill", id: "docs", label: "Docs", detail: "private" }],
        app: { hasApp: true, bundle: { hash: "c".repeat(64) } },
      }] })),
    },
    skills: {
      list: vi.fn(async () => ({ skills: [{
        id: "docs-guard",
        name: "Docs Guard",
        description: "private instructions",
        provider: "codex",
        scope: "plugin",
        pluginId: "docs-plugin",
        filePath: "/private/root/SKILL.md",
        manageable: false,
        registrySkillId: null,
      }] })),
    },
    ...overrides,
  };
}

describe("read-only external inventory", () => {
  it("calls only the four approved reads and produces bounded inventory-only rows", async () => {
    const reads = client();
    const result = await discoverExternalInventory({
      client: reads,
      workspace: { projectId: "proj_1", environmentId: null },
      hostScope: "primary",
      previousSnapshot: [],
      now,
    });

    expect(reads.providers.list).toHaveBeenCalledOnce();
    expect(reads.providers.models).toHaveBeenCalledOnce();
    expect(reads.plugins.list).toHaveBeenCalledOnce();
    expect(reads.skills.list).toHaveBeenCalledOnce();
    expect(result.health).toEqual({ status: "ok", errorClass: null, refreshedAt: now });
    expect(result.items.map((item) => item.capabilityKind).sort()).toEqual([
      "connector", "connector", "model", "skill",
    ]);
    expect(result.items.every((item) => item.status === "inventory-only" && item.hostScope === "primary")).toBe(true);
    expect(JSON.stringify(result.items)).not.toMatch(/private\/root|token=|secret detail|private instructions/i);
    expect(result.items.every((item) => JSON.stringify(item.metadata).length <= 2_048)).toBe(true);
  });

  it("keeps the previous snapshot and reports bounded degraded health when a read fails", async () => {
    const previous: CapabilityInventoryItem[] = [{
      inventoryKey: "inventory:prior",
      capabilityId: "inventory-prior",
      capabilityKind: "skill",
      source: "skill:prior",
      version: null,
      digest: null,
      hostScope: "primary",
      status: "inventory-only",
      metadata: { scope: "plugin" },
      discoveredAt: 1_000,
    }];
    const reads = client({
      plugins: { list: vi.fn(async () => { throw new Error(`token=super-secret ${"x".repeat(2_000)}`); }) },
    });
    const result = await discoverExternalInventory({
      client: reads,
      workspace: { projectId: "proj_1", environmentId: null },
      hostScope: "primary",
      previousSnapshot: previous,
      now,
    });
    expect(result.items).toEqual(previous);
    expect(result.health).toMatchObject({ status: "degraded", refreshedAt: now });
    expect(result.health.errorClass).not.toMatch(/secret|token|x{100}/i);
    expect(reads.providers.list).toHaveBeenCalledOnce();
    expect(reads.providers.models).toHaveBeenCalledOnce();
    expect(reads.plugins.list).toHaveBeenCalledOnce();
    expect(reads.skills.list).toHaveBeenCalledOnce();
  });

  it("does not turn discovery into execution authority", () => {
    const discovered: CapabilityInventoryItem = {
      inventoryKey: "inventory:docs",
      capabilityId: "inventory-docs-guard",
      capabilityKind: "skill",
      source: "skill:docs-guard",
      version: null,
      digest: null,
      hostScope: "primary",
      status: "inventory-only",
      metadata: {},
      discoveredAt: now,
    };
    expect(() => admitInventoryItem(discovered)).toThrow(/descriptor|shadow|mapping/i);
    expect(() => admitInventoryItem(discovered, {
      descriptor: CAPABILITY_BY_ID.get("docs-guard")!,
      shadowTrials: 4,
      mapping: { roles: ["documentation"], recipes: ["bounded"], stages: ["documentation"] },
    })).toThrow(/shadow/i);
    expect(admitInventoryItem(discovered, {
      descriptor: CAPABILITY_BY_ID.get("docs-guard")!,
      shadowTrials: 5,
      mapping: { roles: ["documentation"], recipes: ["bounded"], stages: ["documentation"] },
    })).toMatchObject({ status: "admitted", admittedCapabilityId: "docs-guard" });
  });

  it("atomically replaces a successful snapshot and preserves it on health failure", () => {
    const db = new Database(":memory:");
    for (const migration of CAPABILITY_MIGRATIONS) db.exec(migration);
    const repository = new CapabilityRepository(db);
    const item: CapabilityInventoryItem = {
      inventoryKey: "inventory:one",
      capabilityId: "inventory-one",
      capabilityKind: "model",
      source: "model:codex:one",
      version: "1",
      digest: "d".repeat(64),
      hostScope: "primary",
      status: "inventory-only",
      metadata: { providerId: "codex" },
      discoveredAt: now,
    };
    repository.replaceInventorySnapshot({ hostScope: "primary", items: [item], now });
    repository.recordInventoryDiscoveryFailure({
      hostScope: "primary",
      errorClass: "unavailable",
      now: now + 1,
    });
    expect(repository.listInventory("primary", 10)).toEqual([item]);
    expect(repository.getInventoryHealth("primary")).toEqual({
      hostScope: "primary",
      status: "degraded",
      errorClass: "unavailable",
      refreshedAt: now + 1,
    });
    db.close();
  });

  it("refreshes on a bounded service path and preserves the last good durable snapshot", async () => {
    const { bb } = createFakePluginHost({ pluginId: "inventory-refresh-service" });
    const store = openStore(bb.storage);
    store.upsertProjectPolicy(policyFixture({ production: undefined }), now);
    const pluginList = vi.fn()
      .mockResolvedValueOnce({ plugins: [{ id: "one", version: "1", enabled: true, status: "running" }] })
      .mockRejectedValueOnce(new Error("provider unavailable token=must-not-persist"));
    const reads = client({ plugins: { list: pluginList } });
    let current = now;
    const service = new CapabilityInventoryService({
      store,
      client: reads,
      clock: { now: () => current },
      refreshIntervalMs: 60_000,
    });

    expect(await service.refresh()).toBe(true);
    const scope = "project:proj_1";
    const snapshot = store.listExternalCapabilityInventory(scope, 512);
    expect(snapshot.length).toBeGreaterThan(0);
    current += 60_000;
    expect(await service.refresh()).toBe(false);
    expect(store.listExternalCapabilityInventory(scope, 512)).toEqual(snapshot);
    expect(store.getExternalCapabilityInventoryHealth(scope)).toMatchObject({
      status: "degraded",
      errorClass: "unavailable",
      refreshedAt: current,
    });
    expect(reads.providers.list).toHaveBeenCalledTimes(2);
    expect(reads.providers.models).toHaveBeenCalledTimes(2);
    expect(reads.skills.list).toHaveBeenCalledTimes(2);
    expect(pluginList).toHaveBeenCalledTimes(2);
  });

  it("aborts a hung read at the refresh deadline and keeps the previous snapshot", async () => {
    const { bb } = createFakePluginHost({ pluginId: "inventory-refresh-timeout" });
    const store = openStore(bb.storage);
    store.upsertProjectPolicy(policyFixture({ production: undefined }), now);
    const scope = "project:proj_1";
    const prior: CapabilityInventoryItem = {
      inventoryKey: "inventory:prior-live",
      capabilityId: "inventory-prior-live",
      capabilityKind: "skill",
      source: "skill:prior-live",
      version: null,
      digest: null,
      hostScope: scope,
      status: "inventory-only",
      metadata: {},
      discoveredAt: now - 1,
    };
    store.replaceExternalCapabilityInventory({ hostScope: scope, items: [prior], now: now - 1 });
    let receivedSignal: AbortSignal | undefined;
    const reads = client({
      providers: {
        list: vi.fn(async (args?: { signal?: AbortSignal }) => {
          receivedSignal = args?.signal;
          return new Promise<never>(() => undefined);
        }),
        models: vi.fn(async () => ({ models: [] })),
      },
    });
    const service = new CapabilityInventoryService({
      store,
      client: reads,
      clock: { now: () => now },
      readTimeoutMs: 5,
    });

    await expect(service.refresh()).resolves.toBe(false);
    expect(receivedSignal?.aborted).toBe(true);
    expect(store.listExternalCapabilityInventory(scope, 10)).toEqual([prior]);
    expect(store.getExternalCapabilityInventoryHealth(scope)).toMatchObject({
      status: "degraded",
      errorClass: "timeout",
    });
  });
});
