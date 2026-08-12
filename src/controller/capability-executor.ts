import type {
  BbPluginApi,
  PluginAgentToolContext,
  PluginAgentToolExperimentalStatusLabels,
} from "@bb/plugin-sdk";
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { ControllerProofKind } from "./models";
import {
  CONTROLLER_CAPABILITIES,
  decideControllerCapability,
  type ControllerCapabilityDenialCode,
  type ControllerCapabilityDescriptor,
  type ControllerToolName,
} from "./capability-policy";
import type { ControllerThreadRecord, ControllerTurnRecord } from "./models";
import type {
  ControllerEvidenceRecord,
  ControllerEvidenceOutcome,
} from "../storage/controller-evidence-repository";
import type { TelegramAgentStore } from "../storage/store";

const MAX_SAFE_SUBJECTS = 16;
const SAFE_SUBJECT_REF = /^(?:project|job|thread|monitor|memory|delegation|controller):[^\s:]{1,248}$/;
const INTERRUPTED_DOMAIN_RESULT = Object.freeze({
  outcome: "uncertain",
  detail: "An identical call was already started and its outcome is unknown. Check current state before acting again.",
});

type JsonPrimitive = null | boolean | number | string;
export type ControllerJsonObject = { [key: string]: ControllerJsonValue };
export type ControllerJsonValue = JsonPrimitive | ControllerJsonValue[] | ControllerJsonObject;

export type ControllerCapabilityScope = Readonly<{
  kind: "controller_global" | "exact_entity";
  entityRefs: readonly string[];
  matches: boolean;
}>;

export type ControllerCapabilityDependencies = Readonly<{
  store: TelegramAgentStore;
  now(): number;
  credential: Readonly<{
    credential: "none" | "bb";
    audience: "none" | "bb-plugin-sdk";
  }>;
  sdk?: BbPluginApi["sdk"];
}>;

export type AuthorizedControllerCapability = Readonly<{
  controller: ControllerThreadRecord;
  turn: ControllerTurnRecord;
  fence: Readonly<{ ownerId: string; generation: number; now: number }>;
}>;

export type ControllerCapabilityAuthorizationInput = Readonly<{
  descriptor: ControllerCapabilityDescriptor;
  context: Pick<PluginAgentToolContext, "threadId" | "projectId">;
  scope: ControllerCapabilityScope;
  policyReadable?: boolean;
  approval?: "not_required" | "current" | "missing" | "stale";
  credentialAudienceMatches?: boolean;
}>;

export type ControllerCapabilityEvidenceProjection = Readonly<{
  outcome: Extract<ControllerEvidenceOutcome, "observed" | "succeeded" | "interrupted">;
  proofKinds: readonly ControllerProofKind[];
  subjectRefs: readonly string[];
}>;

export type ControllerCapabilityScopeResolution = Readonly<{
  scope: ControllerCapabilityScope;
  policyReadable?: boolean;
  state?: unknown;
}>;

export type HanoonEvidenceEnvelope = Readonly<{
  ref: `evidence:${number}`;
  outcome: ControllerEvidenceRecord["outcome"];
  proofKinds: readonly ControllerProofKind[];
  subjectRefs: readonly string[];
  observedAt: number;
}>;

export type ExecuteControllerCapabilityInput = Omit<ControllerCapabilityAuthorizationInput, "scope"> & Readonly<{
  params: unknown;
  scope?: ControllerCapabilityScope;
  resolveScope?(authorized: AuthorizedControllerCapability):
    ControllerCapabilityScopeResolution | Promise<ControllerCapabilityScopeResolution>;
  run(resolution: ControllerCapabilityScopeResolution): unknown | Promise<unknown>;
  projectEvidence(
    domainResult: Readonly<ControllerJsonObject>,
    resolution: ControllerCapabilityScopeResolution,
  ): ControllerCapabilityEvidenceProjection | Promise<ControllerCapabilityEvidenceProjection>;
}>;

export class ControllerCapabilityAuthorizationError extends Error {
  public readonly code: ControllerCapabilityDenialCode;

  public constructor(code: ControllerCapabilityDenialCode) {
    super(`Controller capability authorization denied: ${code}`);
    this.name = "ControllerCapabilityAuthorizationError";
    this.code = code;
  }
}

export type ControllerCapabilityExecutionErrorCode =
  | "params_invalid"
  | "domain_result_invalid"
  | "receipt_invalid"
  | "result_limit_exceeded"
  | "evidence_projection_invalid"
  | "receipt_persistence_failed"
  | "evidence_write_failed"
  | "final_result_invalid";

export class ControllerCapabilityExecutionError extends Error {
  public readonly code: ControllerCapabilityExecutionErrorCode;

  public constructor(code: ControllerCapabilityExecutionErrorCode) {
    super(`Controller capability execution failed: ${code}`);
    this.name = "ControllerCapabilityExecutionError";
    this.code = code;
  }
}

function assertSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} is invalid`);
}

function canonicalString(value: ControllerJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalString(value[key])}`).join(",")}}`;
}

function normalizedArray(value: unknown[], ancestors: Set<object>, field: string): ControllerJsonValue[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError(`${field} contains an invalid array`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) throw new TypeError(`${field} contains a symbol key`);
  if (ownKeys.length !== value.length + 1) throw new TypeError(`${field} contains a sparse or extended array`);
  const normalized: ControllerJsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${field} contains a sparse or accessor array`);
    }
    normalized.push(normalizedJsonValue(descriptor.value, ancestors, field));
  }
  return normalized;
}

function normalizedObject(
  value: object,
  ancestors: Set<object>,
  field: string,
): ControllerJsonObject {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${field} must contain plain objects`);
  const normalized = Object.create(null) as ControllerJsonObject;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${field} contains a symbol key`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${field} contains an accessor or hidden property`);
    }
    normalized[key] = normalizedJsonValue(descriptor.value, ancestors, field);
  }
  return normalized;
}

function normalizedJsonValue(value: unknown, ancestors: Set<object>, field: string): ControllerJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${field} contains a non-finite number`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`${field} contains a non-JSON value`);
  if (ancestors.has(value)) throw new TypeError(`${field} contains a cycle`);
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? normalizedArray(value, ancestors, field)
      : normalizedObject(value, ancestors, field);
  } finally {
    ancestors.delete(value);
  }
}

function normalizedDomainObject(value: unknown, field = "domain result"): ControllerJsonObject {
  const normalized = normalizedJsonValue(value, new Set(), field);
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new TypeError(`${field} must be a plain JSON object`);
  }
  if (Object.hasOwn(normalized, "_hanoonEvidence")) {
    throw new TypeError(`${field} contains the reserved evidence envelope`);
  }
  return normalized;
}

export function canonicalControllerJson(value: unknown): string {
  return canonicalString(normalizedJsonValue(value, new Set(), "JSON value"));
}

export function sha256ControllerJson(value: unknown): string {
  return createHash("sha256").update(canonicalControllerJson(value), "utf8").digest("hex");
}

function credentialMatches(
  dependencies: ControllerCapabilityDependencies,
  descriptor: ControllerCapabilityDescriptor,
): boolean {
  return dependencies.credential.credential === descriptor.credential_scope.credential &&
    dependencies.credential.audience === descriptor.credential_scope.audience;
}

export function authorizeControllerCapability(
  dependencies: ControllerCapabilityDependencies,
  input: ControllerCapabilityAuthorizationInput,
): AuthorizedControllerCapability {
  const controller = dependencies.store.getControllerByThreadId(input.context.threadId);
  const turn = controller
    ? dependencies.store.getPendingControllerTurn(controller.controllerKey)
    : null;
  const now = dependencies.now();
  assertSafeInteger(now, "controller capability clock");
  const submittedTurn = turn?.state === "submitted" && turn.controllerKey === controller?.controllerKey;
  const fenceCurrent = submittedTurn && turn.leaseOwner !== null && turn.leaseGeneration !== null
    ? dependencies.store.isExecutorLeaseCurrent(turn.leaseOwner, turn.leaseGeneration, now)
    : false;
  const authority = {
    policyReadable: input.policyReadable ?? true,
    durableController: controller !== null && controller.state === "active",
    currentTurn: submittedTurn,
    turnFinalized: false,
    role: "controller",
    contextMatches: controller !== null && controller.threadId === input.context.threadId &&
      controller.projectId === input.context.projectId,
    scopeMatches: input.scope.matches,
    approval: input.approval ?? "not_required",
    credentialAudienceMatches: input.credentialAudienceMatches ?? credentialMatches(dependencies, input.descriptor),
    fenceCurrent,
  } as const;
  const preliminaryDecision = decideControllerCapability(authority, input.descriptor);
  if (preliminaryDecision.outcome === "denied") {
    throw new ControllerCapabilityAuthorizationError(preliminaryDecision.code);
  }
  const turnFinalized = turn !== null &&
    dependencies.store.getAcceptedControllerFinalization(turn.id) !== null;
  const finalDecision = decideControllerCapability({ ...authority, turnFinalized }, input.descriptor);
  if (finalDecision.outcome === "denied") throw new ControllerCapabilityAuthorizationError(finalDecision.code);
  if (!controller || !turn || !turn.leaseOwner || turn.leaseGeneration === null) {
    throw new ControllerCapabilityAuthorizationError("turn_missing");
  }
  return {
    controller,
    turn,
    fence: { ownerId: turn.leaseOwner, generation: turn.leaseGeneration, now },
  };
}

function currentFence(
  dependencies: ControllerCapabilityDependencies,
  authorized: AuthorizedControllerCapability,
): AuthorizedControllerCapability["fence"] {
  const now = dependencies.now();
  assertSafeInteger(now, "controller capability clock");
  if (!dependencies.store.isExecutorLeaseCurrent(
    authorized.fence.ownerId,
    authorized.fence.generation,
    now,
  )) throw new ControllerCapabilityAuthorizationError("fence_lost");
  const turn = dependencies.store.getPendingControllerTurn(authorized.controller.controllerKey);
  if (
    turn?.id !== authorized.turn.id || turn.state !== "submitted" ||
    turn.leaseOwner !== authorized.fence.ownerId || turn.leaseGeneration !== authorized.fence.generation
  ) throw new ControllerCapabilityAuthorizationError("fence_lost");
  return { ...authorized.fence, now };
}

function safeProjection(
  descriptor: ControllerCapabilityDescriptor,
  projection: ControllerCapabilityEvidenceProjection,
): ControllerCapabilityEvidenceProjection {
  if (!projection.proofKinds.every((proofKind) => descriptor.proof_kinds.includes(proofKind))) {
    throw new TypeError("controller evidence projection contains an unauthorized proof kind");
  }
  const subjectRefs = [...new Set(projection.subjectRefs)];
  if (
    subjectRefs.length !== projection.subjectRefs.length || subjectRefs.length > MAX_SAFE_SUBJECTS ||
    subjectRefs.some((subjectRef) => typeof subjectRef !== "string" ||
      Buffer.byteLength(subjectRef, "utf8") > 256 || !SAFE_SUBJECT_REF.test(subjectRef))
  ) throw new TypeError("controller evidence projection contains an invalid subject reference");
  return { ...projection, proofKinds: [...projection.proofKinds], subjectRefs };
}

function interruptedSubjectRefs(resolution: ControllerCapabilityScopeResolution): readonly string[] {
  return resolution.scope.entityRefs.filter((subjectRef) =>
    typeof subjectRef === "string" &&
    Buffer.byteLength(subjectRef, "utf8") <= 256 &&
    SAFE_SUBJECT_REF.test(subjectRef));
}

function maximumEnvelope(projection: ControllerCapabilityEvidenceProjection): HanoonEvidenceEnvelope {
  return {
    ref: "evidence:9007199254740991",
    outcome: "interrupted",
    proofKinds: projection.proofKinds,
    subjectRefs: projection.subjectRefs,
    observedAt: Number.MAX_SAFE_INTEGER,
  };
}

function assertFinalResultBound(
  descriptor: ControllerCapabilityDescriptor,
  domainResult: ControllerJsonObject,
  envelope: HanoonEvidenceEnvelope,
): string {
  const output = canonicalControllerJson({ ...domainResult, _hanoonEvidence: envelope });
  if (Buffer.byteLength(output, "utf8") > descriptor.result_limit) {
    throw new TypeError("controller capability result exceeded its UTF-8 byte limit");
  }
  return output;
}

function parseReceiptDomainObject(receipt: string): ControllerJsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(receipt);
  } catch {
    throw new ControllerCapabilityExecutionError("receipt_invalid");
  }
  let normalized: ControllerJsonObject;
  try {
    normalized = normalizedDomainObject(parsed, "stored controller tool receipt");
  } catch {
    throw new ControllerCapabilityExecutionError("receipt_invalid");
  }
  if (canonicalString(normalized) !== receipt) {
    throw new ControllerCapabilityExecutionError("receipt_invalid");
  }
  return normalized;
}

function receiptKey(
  authorized: AuthorizedControllerCapability,
  descriptor: ControllerCapabilityDescriptor,
  params: unknown,
) {
  let argsSha256: string;
  try {
    argsSha256 = sha256ControllerJson(params);
  } catch {
    throw new ControllerCapabilityExecutionError("params_invalid");
  }
  return {
    turnId: authorized.turn.id,
    toolName: descriptor.capability_id,
    argsSha256,
  };
}

async function domainResultForExecution(
  dependencies: ControllerCapabilityDependencies,
  authorized: AuthorizedControllerCapability,
  input: ExecuteControllerCapabilityInput,
  resolution: ControllerCapabilityScopeResolution,
): Promise<{ domainResult: ControllerJsonObject; replay: boolean; interrupted: boolean; key: ReturnType<typeof receiptKey> | null }> {
  const key = input.descriptor.receipt_kind === "tool_receipt"
    ? receiptKey(authorized, input.descriptor, input.params)
    : null;
  if (key === null) {
    const rawDomainValue = await input.run(resolution);
    try {
      return { domainResult: normalizedDomainObject(rawDomainValue), replay: false, interrupted: false, key };
    } catch {
      throw new ControllerCapabilityExecutionError("domain_result_invalid");
    }
  }
  const claim = dependencies.store.claimToolReceipt({
    ...key,
    controllerKey: authorized.controller.controllerKey,
    now: currentFence(dependencies, authorized).now,
  });
  if (claim.outcome === "completed") {
    return { domainResult: parseReceiptDomainObject(claim.result), replay: true, interrupted: false, key };
  }
  if (claim.outcome === "interrupted") {
    return { domainResult: { ...INTERRUPTED_DOMAIN_RESULT }, replay: false, interrupted: true, key };
  }
  let rawDomainValue: unknown;
  try {
    rawDomainValue = await input.run(resolution);
  } catch (error) {
    if (input.descriptor.effect_class === "durable_local_write") {
      dependencies.store.failToolReceipt({ ...key, error: "domain_operation_failed", now: dependencies.now() });
    }
    throw error;
  }
  try {
    return {
      domainResult: normalizedDomainObject(rawDomainValue),
      replay: false,
      interrupted: false,
      key,
    };
  } catch {
    throw new ControllerCapabilityExecutionError("domain_result_invalid");
  }
}

export async function executeControllerCapability(
  dependencies: ControllerCapabilityDependencies,
  input: ExecuteControllerCapabilityInput,
): Promise<string> {
  const preliminary = authorizeControllerCapability(dependencies, {
    ...input,
    policyReadable: true,
    scope: { kind: input.descriptor.project_scope === "controller_global" ? "controller_global" : "exact_entity", entityRefs: [], matches: true },
  });
  let resolution: ControllerCapabilityScopeResolution;
  try {
    resolution = input.resolveScope
      ? await input.resolveScope(preliminary)
      : { scope: input.scope ?? { kind: "exact_entity", entityRefs: [], matches: false } };
  } catch (error) {
    if (error instanceof ControllerCapabilityAuthorizationError) throw error;
    throw new ControllerCapabilityAuthorizationError("policy_unreadable");
  }
  const authorized = authorizeControllerCapability(dependencies, {
    ...input,
    policyReadable: resolution.policyReadable ?? input.policyReadable ?? true,
    scope: resolution.scope,
  });
  if (preliminary.turn.id !== authorized.turn.id) throw new ControllerCapabilityAuthorizationError("turn_missing");
  currentFence(dependencies, authorized);
  const execution = await domainResultForExecution(dependencies, authorized, input, resolution);
  let projection: ControllerCapabilityEvidenceProjection;
  try {
    const rawProjection = execution.interrupted
      ? { outcome: "interrupted" as const, proofKinds: [] as const, subjectRefs: interruptedSubjectRefs(resolution) }
      : await input.projectEvidence(execution.domainResult, resolution);
    projection = safeProjection(input.descriptor, execution.replay
      ? { ...rawProjection, outcome: "observed" }
      : rawProjection);
  } catch {
    throw new ControllerCapabilityExecutionError("evidence_projection_invalid");
  }
  try {
    assertFinalResultBound(input.descriptor, execution.domainResult, maximumEnvelope(projection));
  } catch {
    throw new ControllerCapabilityExecutionError("result_limit_exceeded");
  }
  if (execution.key !== null && !execution.replay && !execution.interrupted) {
    try {
      dependencies.store.completeToolReceipt({
        ...execution.key,
        result: canonicalString(execution.domainResult),
        now: dependencies.now(),
      });
    } catch {
      throw new ControllerCapabilityExecutionError("receipt_persistence_failed");
    }
  }
  const fence = currentFence(dependencies, authorized);
  let evidenceWrite: ReturnType<TelegramAgentStore["recordControllerEvidence"]>;
  try {
    evidenceWrite = dependencies.store.recordControllerEvidence({
      ...fence,
      turnId: authorized.turn.id,
      controllerKey: authorized.controller.controllerKey,
      sourceKind: "hanoon_tool",
      sourceName: input.descriptor.capability_id,
      sourceItemId: null,
      outcome: projection.outcome,
      argsSha256: sha256ControllerJson(input.params),
      resultSha256: sha256ControllerJson(execution.domainResult),
      proofKinds: projection.proofKinds,
      subjectRefs: projection.subjectRefs,
    });
  } catch {
    throw new ControllerCapabilityExecutionError("evidence_write_failed");
  }
  if (evidenceWrite.outcome !== "recorded") {
    throw new ControllerCapabilityExecutionError("evidence_write_failed");
  }
  const envelope: HanoonEvidenceEnvelope = {
    ref: evidenceWrite.evidence.ref,
    outcome: evidenceWrite.evidence.outcome,
    proofKinds: evidenceWrite.evidence.proofKinds,
    subjectRefs: evidenceWrite.evidence.subjectRefs,
    observedAt: evidenceWrite.evidence.observedAt,
  };
  try {
    return assertFinalResultBound(input.descriptor, execution.domainResult, envelope);
  } catch {
    throw new ControllerCapabilityExecutionError("final_result_invalid");
  }
}

export type ControllerCapabilityToolRegistration<Schema extends z.ZodType> = Readonly<{
  name: ControllerToolName;
  descriptor: ControllerCapabilityDescriptor;
  description: string;
  parameters: Schema;
  experimental_statusLabels?: PluginAgentToolExperimentalStatusLabels;
  resolveScope(
    params: z.output<Schema>,
    context: PluginAgentToolContext,
    authorized: AuthorizedControllerCapability,
  ): ControllerCapabilityScopeResolution | Promise<ControllerCapabilityScopeResolution>;
  execute(
    params: z.output<Schema>,
    context: PluginAgentToolContext,
    resolution: ControllerCapabilityScopeResolution,
  ): unknown | Promise<unknown>;
  projectEvidence(
    params: z.output<Schema>,
    context: PluginAgentToolContext,
    domainResult: Readonly<ControllerJsonObject>,
    resolution: ControllerCapabilityScopeResolution,
  ): ControllerCapabilityEvidenceProjection | Promise<ControllerCapabilityEvidenceProjection>;
}>;

export function registerControllerCapabilityTool<Schema extends z.ZodType>(
  bb: Pick<BbPluginApi, "agents">,
  dependencies: ControllerCapabilityDependencies,
  registration: ControllerCapabilityToolRegistration<Schema>,
): void {
  if (
    !(CONTROLLER_CAPABILITIES[registration.name] === registration.descriptor) ||
    !Object.keys(CONTROLLER_CAPABILITIES).slice(0, 21).includes(registration.name)
  ) throw new ControllerCapabilityAuthorizationError("role_denied");
  bb.agents.registerTool({
    name: registration.name,
    description: registration.description,
    parameters: registration.parameters,
    ...(registration.experimental_statusLabels
      ? { experimental_statusLabels: registration.experimental_statusLabels }
      : {}),
    execute: (params, context) => executeControllerCapability(dependencies, {
      descriptor: registration.descriptor,
      params,
      context,
      approval: "not_required",
      resolveScope: (authorized) => registration.resolveScope(params, context, authorized),
      run: (resolution) => registration.execute(params, context, resolution),
      projectEvidence: (domainResult, resolution) =>
        registration.projectEvidence(params, context, domainResult, resolution),
    }),
  });
}
