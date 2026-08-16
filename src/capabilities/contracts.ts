import { createHash } from "node:crypto";
import { z } from "zod";

const MAX_CAPABILITY_ITEMS = 64;
const capabilityIdSchema = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u);
const boundedTextSchema = z.string().min(1).max(512);
const boundedKeySchema = z.string().regex(/^[a-z][a-z0-9._:-]{0,127}$/u);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const boundedKeys = z.array(boundedKeySchema).max(MAX_CAPABILITY_ITEMS);

export const CAPABILITY_ROUTES = [
  "worker",
  "hanoon-native",
  "manual-only",
  "inventory-only",
] as const;
export const CAPABILITY_KINDS = [
  "skill",
  "tool",
  "bundle",
  "native-adapter",
  "model",
  "connector",
  "recipe",
] as const;
export const CAPABILITY_TERMINAL_OUTCOMES = [
  "passed",
  "findings",
  "blocked",
  "failed",
] as const;

export type CapabilityRoute = typeof CAPABILITY_ROUTES[number];
export type CapabilityKind = typeof CAPABILITY_KINDS[number];
export type CapabilityTerminalOutcome = typeof CAPABILITY_TERMINAL_OUTCOMES[number];

const routingSchema = z.object({
  roles: boundedKeys,
  recipes: boundedKeys,
  stages: boundedKeys,
  requiredTraits: boundedKeys,
  forbiddenTraits: boundedKeys,
}).strict();

const compositionSchema = z.object({
  prerequisites: z.array(capabilityIdSchema).max(MAX_CAPABILITY_ITEMS),
  conflicts: z.array(capabilityIdSchema).max(MAX_CAPABILITY_ITEMS),
  orderAfter: z.array(capabilityIdSchema).max(MAX_CAPABILITY_ITEMS),
  substitutes: z.array(capabilityIdSchema).max(8),
}).strict();

const effectsSchema = z.object({
  class: z.enum(["none", "read", "write", "orchestrate", "irreversible"]),
  risk: z.enum(["low", "medium", "high", "critical"]),
  dataClasses: z.array(z.enum([
    "none",
    "owner-message",
    "repository",
    "operational-state",
    "external-content",
    "credentials",
  ])).min(1).max(8),
  reversible: z.boolean(),
  idempotent: z.boolean(),
}).strict();

const authoritySchema = z.object({
  ownerApproval: z.enum(["never", "conditional", "required"]),
  credentials: z.boolean(),
  egress: z.boolean(),
  hosts: z.array(z.enum(["controller", "project", "primary", "any-readonly"])).max(4),
  workspaces: z.array(z.enum(["personal", "managed-worktree", "host-path"])).max(3),
  permissionModes: z.array(z.enum(["none", "auto", "accept-edits", "full"])).max(4),
}).strict();

const ioContractSchema = z.object({
  inputSchema: boundedTextSchema,
  outputSchema: boundedTextSchema,
  timeoutMs: z.number().int().min(0).max(3_600_000),
  maxResultBytes: z.number().int().min(1).max(1_048_576),
}).strict();

const economicsSchema = z.object({
  costClass: z.enum(["none", "low", "medium", "high"]),
  modelPools: z.array(z.enum(["fast", "standard", "strong"])).max(3),
}).strict();

const evidenceSchema = z.object({
  requirement: z.enum(["mandatory", "optional"]),
  outcomes: z.array(z.enum(CAPABILITY_TERMINAL_OUTCOMES)).min(1).max(4),
  proofSchema: boundedTextSchema,
  receiptType: z.enum(["selection", "worker", "guard", "tool", "native", "model", "recipe"]),
  strength: z.enum(["low", "standard", "high", "critical"]),
}).strict();

export const capabilityDescriptorSchema = z.object({
  id: capabilityIdSchema,
  kind: z.enum(CAPABILITY_KINDS),
  source: boundedTextSchema,
  sourceDigest: sha256Schema,
  version: boundedTextSchema,
  digest: sha256Schema,
  status: z.enum(["admitted", "disabled", "retired"]),
  route: z.enum(CAPABILITY_ROUTES),
  routing: routingSchema,
  composition: compositionSchema,
  effects: effectsSchema,
  authority: authoritySchema,
  contract: ioContractSchema,
  economics: economicsSchema,
  evidence: evidenceSchema,
}).strict().superRefine((descriptor, context) => {
  const overlap = descriptor.routing.requiredTraits.find((trait) =>
    descriptor.routing.forbiddenTraits.includes(trait));
  if (overlap) {
    context.addIssue({
      code: "custom",
      path: ["routing", "forbiddenTraits"],
      message: `trait ${overlap} cannot be both required and forbidden`,
    });
  }
  for (const [field, values] of Object.entries(descriptor.composition)) {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        path: ["composition", field],
        message: `${field} contains a duplicate capability id`,
      });
    }
    if (values.includes(descriptor.id)) {
      context.addIssue({
        code: "custom",
        path: ["composition", field],
        message: `${field} cannot reference the capability itself`,
      });
    }
  }
});

export type CapabilityDescriptor = z.infer<typeof capabilityDescriptorSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function descriptorDigest(descriptor: CapabilityDescriptor): string {
  const validated = capabilityDescriptorSchema.parse(descriptor);
  const { digest: _digest, ...content } = validated;
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(content)), "utf8")
    .digest("hex");
}

const EVIDENCE_STRENGTH = {
  low: 0,
  standard: 1,
  high: 2,
  critical: 3,
} as const;

function assertAcyclic(
  descriptors: readonly CapabilityDescriptor[],
  descriptorById: ReadonlyMap<string, CapabilityDescriptor>,
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new TypeError(`Capability ordering contains a cycle at ${id}`);
    visiting.add(id);
    const descriptor = descriptorById.get(id);
    if (!descriptor) throw new TypeError(`Unknown capability in ordering graph: ${id}`);
    for (const dependency of [
      ...descriptor.composition.prerequisites,
      ...descriptor.composition.orderAfter,
    ]) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const descriptor of descriptors) visit(descriptor.id);
}

export function validateCapabilityCatalog(
  input: readonly CapabilityDescriptor[],
): readonly CapabilityDescriptor[] {
  if (input.length === 0 || input.length > 256) {
    throw new TypeError("Capability catalog must contain between 1 and 256 descriptors");
  }
  const descriptors = input.map((descriptor) => capabilityDescriptorSchema.parse(descriptor));
  const descriptorById = new Map<string, CapabilityDescriptor>();
  for (const descriptor of descriptors) {
    if (descriptor.digest !== descriptorDigest(descriptor)) {
      throw new TypeError(`Capability descriptor ${descriptor.id} has a digest mismatch`);
    }
    if (descriptorById.has(descriptor.id)) {
      throw new TypeError(`Capability catalog contains duplicate id ${descriptor.id}`);
    }
    descriptorById.set(descriptor.id, descriptor);
  }

  for (const descriptor of descriptors) {
    for (const prerequisite of descriptor.composition.prerequisites) {
      if (!descriptorById.has(prerequisite)) {
        throw new TypeError(`${descriptor.id} references unknown prerequisite ${prerequisite}`);
      }
    }
    for (const ordered of descriptor.composition.orderAfter) {
      if (!descriptorById.has(ordered)) {
        throw new TypeError(`${descriptor.id} references unknown ordering capability ${ordered}`);
      }
    }
    for (const conflict of descriptor.composition.conflicts) {
      const peer = descriptorById.get(conflict);
      if (!peer) throw new TypeError(`${descriptor.id} references unknown conflict ${conflict}`);
      if (!peer.composition.conflicts.includes(descriptor.id)) {
        throw new TypeError(`Capability conflict ${descriptor.id}/${conflict} must be symmetric`);
      }
    }
    for (const substituteId of descriptor.composition.substitutes) {
      const substitute = descriptorById.get(substituteId);
      if (!substitute || substitute.status !== "admitted" || substitute.route === "inventory-only") {
        throw new TypeError(`${descriptor.id} substitute ${substituteId} is not admitted`);
      }
      if (EVIDENCE_STRENGTH[substitute.evidence.strength] < EVIDENCE_STRENGTH[descriptor.evidence.strength]) {
        throw new TypeError(`${descriptor.id} substitute ${substituteId} has weaker evidence protection`);
      }
    }
  }

  assertAcyclic(descriptors, descriptorById);
  return descriptors;
}
