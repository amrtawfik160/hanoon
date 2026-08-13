import { createHash } from "node:crypto";
import { z } from "zod";
import {
  capabilityDescriptorSchema,
  descriptorDigest,
  type CapabilityDescriptor,
  type CapabilityKind,
} from "./contracts";

const MAX_INVENTORY_ITEMS = 512;
const MAX_METADATA_JSON = 2_048;
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const boundedText = z.string().min(1).max(512);
const capabilityIdSchema = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u);

export type CapabilityInventoryItem = Readonly<{
  inventoryKey: string;
  capabilityId: string;
  capabilityKind: CapabilityKind;
  source: string;
  version: string | null;
  digest: string | null;
  hostScope: string;
  status: "inventory-only";
  metadata: Readonly<Record<string, string | number | boolean | null>>;
  discoveredAt: number;
}>;

export type InventoryHealth = Readonly<{
  status: "ok" | "degraded";
  errorClass: string | null;
  refreshedAt: number;
}>;

export type ExternalInventoryReadClient = Readonly<{
  providers: Readonly<{
    list(args?: { signal?: AbortSignal }): Promise<unknown>;
    models(args?: { signal?: AbortSignal }): Promise<unknown>;
  }>;
  plugins: Readonly<{ list(args?: { signal?: AbortSignal }): Promise<unknown> }>;
  skills: Readonly<{ list(args: {
    projectId: string;
    environmentId: string | null;
    signal?: AbortSignal;
  }): Promise<unknown> }>;
}>;

type RawRecord = Record<string, unknown>;

function record(value: unknown): RawRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RawRecord : null;
}

function rows(value: unknown, key?: string): RawRecord[] {
  const source = key === undefined ? value : record(value)?.[key];
  return Array.isArray(source) ? source.map(record).filter((entry): entry is RawRecord => entry !== null) : [];
}

function text(value: unknown, maximum = 256): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/gu, " ").trim().slice(0, maximum);
  return normalized.length === 0 ? null : normalized;
}

function safeId(prefix: string, value: unknown): string {
  const normalized = (text(value, 96) ?? "unknown").toLowerCase()
    .replace(/[^a-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  const candidate = `${prefix}-${normalized || "unknown"}`.slice(0, 128);
  return capabilityIdSchema.parse(candidate);
}

function inventoryKey(kind: string, source: string, hostScope: string): string {
  return `inventory:${createHash("sha256").update(`${kind}\0${source}\0${hostScope}`, "utf8").digest("hex")}`;
}

function digest(value: unknown): string | null {
  return typeof value === "string" && sha256Schema.safeParse(value).success ? value : null;
}

function boundedMetadata(input: Record<string, string | number | boolean | null>): Readonly<Record<string, string | number | boolean | null>> {
  const sorted = Object.fromEntries(Object.entries(input)
    .filter(([, value]) => value !== null && (typeof value !== "string" || value.length <= 256))
    .sort(([left], [right]) => left.localeCompare(right)));
  if (JSON.stringify(sorted).length > MAX_METADATA_JSON) throw new TypeError("inventory metadata exceeds its bound");
  return Object.freeze(sorted);
}

function item(input: Omit<CapabilityInventoryItem, "inventoryKey" | "status" | "metadata"> & {
  metadata: Record<string, string | number | boolean | null>;
}): CapabilityInventoryItem {
  const source = boundedText.parse(input.source);
  const hostScope = boundedText.max(256).parse(input.hostScope);
  return Object.freeze({
    ...input,
    source,
    hostScope,
    inventoryKey: inventoryKey(input.capabilityKind, source, hostScope),
    status: "inventory-only" as const,
    metadata: boundedMetadata(input.metadata),
  });
}

function normalizeProviders(value: unknown, hostScope: string, discoveredAt: number): CapabilityInventoryItem[] {
  return rows(value).map((provider) => {
    const id = text(provider.id, 128) ?? "unknown";
    const capabilities = record(provider.capabilities);
    return item({
      capabilityId: safeId("inventory-provider", id),
      capabilityKind: "connector",
      source: `provider:${id}`.slice(0, 512),
      version: null,
      digest: null,
      hostScope,
      metadata: {
        providerId: id,
        displayName: text(provider.displayName, 128),
        available: provider.available === true,
        supportsServiceTier: capabilities?.supportsServiceTier === true,
      },
      discoveredAt,
    });
  });
}

function normalizeModels(value: unknown, hostScope: string, discoveredAt: number): CapabilityInventoryItem[] {
  return rows(value, "models").map((model) => {
    const modelId = text(model.model ?? model.id, 256) ?? "unknown";
    const providerId = text(model.routeProviderId, 128) ?? "unknown";
    return item({
      capabilityId: safeId("inventory-model", `${providerId}-${modelId}`),
      capabilityKind: "model",
      source: `model:${providerId}:${modelId}`.slice(0, 512),
      version: null,
      digest: null,
      hostScope,
      metadata: {
        providerId,
        modelId,
        displayName: text(model.displayName, 128),
        defaultReasoning: text(model.defaultReasoningEffort, 64),
        isDefault: model.isDefault === true,
      },
      discoveredAt,
    });
  });
}

function normalizePlugins(value: unknown, hostScope: string, discoveredAt: number): CapabilityInventoryItem[] {
  return rows(value, "plugins").map((plugin) => {
    const id = text(plugin.id, 128) ?? "unknown";
    const bundle = record(record(plugin.app)?.bundle);
    return item({
      capabilityId: safeId("inventory-plugin", id),
      capabilityKind: "connector",
      // The SDK's source and rootDir may contain private paths or source
      // credentials. Stable plugin identity is enough for inventory.
      source: `plugin:${id}`,
      version: text(plugin.version, 128),
      digest: digest(bundle?.hash),
      hostScope,
      metadata: {
        pluginId: id,
        name: text(plugin.name, 128),
        provenance: text(plugin.provenance, 64),
        enabled: plugin.enabled === true,
        status: text(plugin.status, 64),
      },
      discoveredAt,
    });
  });
}

function normalizeSkills(value: unknown, hostScope: string, discoveredAt: number): CapabilityInventoryItem[] {
  return rows(value, "skills").map((skill) => {
    const id = text(skill.id, 128) ?? "unknown";
    const pluginId = text(skill.pluginId, 128);
    return item({
      capabilityId: safeId("inventory-skill", id),
      capabilityKind: "skill",
      source: `skill:${pluginId ? `${pluginId}:` : ""}${id}`.slice(0, 512),
      version: null,
      digest: null,
      hostScope,
      metadata: {
        skillId: id,
        name: text(skill.name, 128),
        provider: text(skill.provider, 64),
        scope: text(skill.scope, 64),
        pluginId,
        manageable: skill.manageable === true,
      },
      discoveredAt,
    });
  });
}

function discoveryErrorClass(reason: unknown): string {
  const message = reason instanceof Error ? messageFor(reason) : String(reason).toLowerCase();
  if (/auth|credential|401|403/u.test(message)) return "authentication";
  if (/timeout|timed out|deadline/u.test(message)) return "timeout";
  if (/rate|429/u.test(message)) return "rate_limited";
  if (/network|connection|unavailable|50[234]/u.test(message)) return "unavailable";
  if (/abort|cancel/u.test(message)) return "cancelled";
  return "read_failed";
}

function messageFor(error: Error): string {
  return `${error.name} ${error.message}`.toLowerCase();
}

function abortableRead<T>(read: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return read;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("inventory discovery cancelled"));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error("inventory discovery cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    read.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
  });
}

export async function discoverExternalInventory(input: Readonly<{
  client: ExternalInventoryReadClient;
  workspace: Readonly<{ projectId: string; environmentId: string | null }>;
  hostScope: string;
  previousSnapshot: readonly CapabilityInventoryItem[];
  now: number;
  signal?: AbortSignal;
}>): Promise<Readonly<{ items: readonly CapabilityInventoryItem[]; health: InventoryHealth }>> {
  const hostScope = boundedText.max(256).parse(input.hostScope);
  const now = z.number().int().nonnegative().safe().parse(input.now);
  const workspace = z.object({
    projectId: z.string().startsWith("proj_").max(256),
    environmentId: z.string().min(1).max(256).nullable(),
  }).strict().parse(input.workspace);
  // Invoke all four reads before awaiting any of them. Each is raced against
  // the shared signal so a non-cooperative SDK promise cannot hang plugin load.
  const calls = await Promise.allSettled([
    abortableRead(input.client.providers.list({ signal: input.signal }), input.signal),
    abortableRead(input.client.providers.models({ signal: input.signal }), input.signal),
    abortableRead(input.client.plugins.list({ signal: input.signal }), input.signal),
    abortableRead(input.client.skills.list({ ...workspace, signal: input.signal }), input.signal),
  ]);
  const failure = calls.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) {
    return {
      items: [...input.previousSnapshot],
      health: { status: "degraded", errorClass: discoveryErrorClass(failure.reason), refreshedAt: now },
    };
  }
  const [providers, models, plugins, skills] = calls as [
    PromiseFulfilledResult<unknown>, PromiseFulfilledResult<unknown>,
    PromiseFulfilledResult<unknown>, PromiseFulfilledResult<unknown>,
  ];
  const normalized = [
    ...normalizeProviders(providers.value, hostScope, now),
    ...normalizeModels(models.value, hostScope, now),
    ...normalizePlugins(plugins.value, hostScope, now),
    ...normalizeSkills(skills.value, hostScope, now),
  ].sort((left, right) => left.inventoryKey.localeCompare(right.inventoryKey));
  const unique = [...new Map(normalized.map((entry) => [entry.inventoryKey, entry])).values()];
  if (unique.length > MAX_INVENTORY_ITEMS) throw new TypeError("external inventory exceeds its bounded item count");
  return { items: unique, health: { status: "ok", errorClass: null, refreshedAt: now } };
}

export type InventoryAdmissionEvidence = Readonly<{
  descriptor: CapabilityDescriptor;
  shadowTrials: number;
  mapping: Readonly<{ roles: readonly string[]; recipes: readonly string[]; stages: readonly string[] }>;
}>;

export function admitInventoryItem(
  discovered: CapabilityInventoryItem,
  evidence?: InventoryAdmissionEvidence,
): Readonly<{ status: "admitted"; inventoryKey: string; admittedCapabilityId: string }> {
  if (discovered.status !== "inventory-only" || evidence === undefined) {
    throw new TypeError("Inventory admission requires a complete descriptor, shadow evidence, and explicit mapping");
  }
  const descriptor = capabilityDescriptorSchema.parse(evidence.descriptor);
  if (descriptor.status !== "admitted" || descriptor.route === "inventory-only" ||
    descriptor.digest !== descriptorDigest(descriptor)) {
    throw new TypeError("Inventory admission requires a valid executable admitted descriptor");
  }
  if (!Number.isSafeInteger(evidence.shadowTrials) || evidence.shadowTrials < 5) {
    throw new TypeError("Inventory admission requires at least five shadow trials");
  }
  const mapping = z.object({
    roles: z.array(z.string().min(1).max(128)).min(1).max(64),
    recipes: z.array(z.string().min(1).max(128)).min(1).max(64),
    stages: z.array(z.string().min(1).max(128)).min(1).max(64),
  }).strict().parse(evidence.mapping);
  if (mapping.roles.some((role) => !descriptor.routing.roles.includes(role)) ||
    mapping.recipes.some((recipe) => !descriptor.routing.recipes.includes(recipe)) ||
    mapping.stages.some((stage) => !descriptor.routing.stages.includes(stage))) {
    throw new TypeError("Inventory admission mapping is not declared by the descriptor");
  }
  return Object.freeze({
    status: "admitted",
    inventoryKey: discovered.inventoryKey,
    admittedCapabilityId: descriptor.id,
  });
}
