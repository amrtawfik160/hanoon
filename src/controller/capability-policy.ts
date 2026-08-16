import type { ControllerProofKind } from "./models";
// The shared runtime vocabulary, imported statically from the plain-JavaScript
// module both this file and `models` re-export, so one specifier resolves for
// native Node ESM and for the bundle alike.
import { CONTROLLER_PROOF_KINDS } from "./proof-kinds.js";

export const CONTROLLER_TOOL_NAMES = Object.freeze([
  "telegram_agent_list_projects",
  "telegram_agent_start_job",
  "telegram_agent_job_status",
  "telegram_agent_retry_job",
  "telegram_agent_cancel_job",
  "telegram_agent_list_threads",
  "telegram_agent_thread_status",
  "telegram_agent_read_thread",
  "telegram_agent_create_thread",
  "telegram_agent_send_to_thread",
  "telegram_agent_request_thread_operation",
  "telegram_agent_remember",
  "telegram_agent_recall",
  "telegram_agent_forget",
  "telegram_agent_watch",
  "telegram_agent_list_watches",
  "telegram_agent_cancel_watch",
  "telegram_agent_health",
  "telegram_agent_delegate",
  "telegram_agent_scorecard",
  "telegram_agent_set_working_style",
  "telegram_agent_turn_evidence",
  "telegram_agent_respond",
  "telegram_agent_steer_job",
  "telegram_agent_adopt_pr",
  "telegram_agent_access_list",
  "telegram_agent_access_status",
  "telegram_agent_access_verify",
  "telegram_agent_answer_thread",
] as const);

export const CONTROLLER_DATA_CLASSES = Object.freeze([
  "project_metadata",
  "job_control",
  "thread_metadata",
  "owner_memory",
  "monitor_schedule",
  "health_metrics",
  "controller_evidence",
  "controller_finalization",
  "credential_metadata",
  "credential_health",
] as const);

export type ControllerToolName = (typeof CONTROLLER_TOOL_NAMES)[number];
export type ControllerDataClass = (typeof CONTROLLER_DATA_CLASSES)[number];

export type ControllerCapabilityDescriptor = Readonly<{
  capability_id: ControllerToolName;
  schema_version: 1;
  effect_class:
    | "read"
    | "durable_local_write"
    | "reversible_external_write"
    | "irreversible_external_write";
  risk_class: "low" | "medium" | "high" | "critical";
  data_class: readonly ControllerDataClass[];
  reversibility: "not_applicable" | "reconcilable" | "compensating_action" | "irreversible";
  idempotency: "read" | "tool_receipt" | "domain_effect" | "exact_entity_reconciliation";
  approval: "none" | "bb_interaction" | "hanoon_confirmation" | "pipeline_approval";
  allowed_roles: readonly ["controller"];
  project_scope: "controller_global" | "current_project" | "exact_entity";
  credential_scope: Readonly<{
    credential: "none" | "bb" | "telegram" | "github" | "credential_broker";
    audience: string;
  }>;
  egress: readonly ("none" | "bb" | "telegram" | "github" | "credential_broker")[];
  proof_kinds: readonly ControllerProofKind[];
  receipt_kind: "observation" | "tool_receipt" | "domain_effect" | "finalization" | "none";
  result_limit: number;
}>;

function capability(
  descriptor: ControllerCapabilityDescriptor,
): ControllerCapabilityDescriptor {
  return Object.freeze({
    ...descriptor,
    data_class: Object.freeze([...descriptor.data_class]),
    allowed_roles: Object.freeze([...descriptor.allowed_roles]) as readonly ["controller"],
    credential_scope: Object.freeze({ ...descriptor.credential_scope }),
    egress: Object.freeze([...descriptor.egress]),
    proof_kinds: Object.freeze([...descriptor.proof_kinds]),
  });
}

export const CONTROLLER_CAPABILITIES: Readonly<
  Record<ControllerToolName, ControllerCapabilityDescriptor>
> = Object.freeze({
  telegram_agent_list_projects: capability({
    capability_id: "telegram_agent_list_projects",
    schema_version: 1,
    effect_class: "read",
    risk_class: "low",
    data_class: ["project_metadata"],
    reversibility: "not_applicable",
    idempotency: "read",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "controller_global",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: ["project_state"],
    receipt_kind: "observation",
    result_limit: 8_000,
  }),
  telegram_agent_start_job: capability({
    capability_id: "telegram_agent_start_job",
    schema_version: 1,
    effect_class: "durable_local_write",
    risk_class: "high",
    data_class: ["job_control"],
    reversibility: "reconcilable",
    idempotency: "tool_receipt",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: ["job_state", "external_mutation", "obligation"],
    receipt_kind: "tool_receipt",
    result_limit: 8_000,
  }),
  telegram_agent_job_status: capability({
    capability_id: "telegram_agent_job_status",
    schema_version: 1,
    effect_class: "read",
    risk_class: "low",
    data_class: ["job_control"],
    reversibility: "not_applicable",
    idempotency: "read",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: ["job_state", "pipeline_outcome", "production_outcome", "obligation"],
    receipt_kind: "observation",
    result_limit: 8_000,
  }),
  telegram_agent_retry_job: capability({
    capability_id: "telegram_agent_retry_job",
    schema_version: 1,
    effect_class: "durable_local_write",
    risk_class: "high",
    data_class: ["job_control"],
    reversibility: "reconcilable",
    idempotency: "tool_receipt",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: ["job_state", "external_mutation", "obligation"],
    receipt_kind: "tool_receipt",
    result_limit: 8_000,
  }),
  telegram_agent_cancel_job: capability({
    capability_id: "telegram_agent_cancel_job",
    schema_version: 1,
    effect_class: "durable_local_write",
    risk_class: "high",
    data_class: ["job_control"],
    reversibility: "reconcilable",
    idempotency: "tool_receipt",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: ["job_state", "external_mutation"],
    receipt_kind: "tool_receipt",
    result_limit: 8_000,
  }),
  telegram_agent_list_threads: capability({
    capability_id: "telegram_agent_list_threads",
    schema_version: 1,
    effect_class: "read",
    risk_class: "low",
    data_class: ["thread_metadata"],
    reversibility: "not_applicable",
    idempotency: "read",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "controller_global",
    credential_scope: { credential: "bb", audience: "bb-plugin-sdk" },
    egress: ["bb"],
    proof_kinds: ["thread_state"],
    receipt_kind: "observation",
    result_limit: 8_000,
  }),
  telegram_agent_thread_status: capability({
    capability_id: "telegram_agent_thread_status",
    schema_version: 1,
    effect_class: "read",
    risk_class: "low",
    data_class: ["thread_metadata"],
    reversibility: "not_applicable",
    idempotency: "read",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "bb", audience: "bb-plugin-sdk" },
    egress: ["bb"],
    proof_kinds: ["thread_state"],
    receipt_kind: "observation",
    result_limit: 8_000,
  }),
  telegram_agent_read_thread: capability({
    capability_id: "telegram_agent_read_thread",
    schema_version: 1,
    effect_class: "read",
    risk_class: "low",
    data_class: ["thread_metadata"],
    reversibility: "not_applicable",
    idempotency: "read",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "bb", audience: "bb-plugin-sdk" },
    egress: ["bb"],
    proof_kinds: ["thread_state"],
    receipt_kind: "observation",
    result_limit: 8_000,
  }),
  telegram_agent_create_thread: capability({
    capability_id: "telegram_agent_create_thread",
    schema_version: 1,
    effect_class: "reversible_external_write",
    risk_class: "medium",
    data_class: ["thread_metadata"],
    reversibility: "compensating_action",
    idempotency: "tool_receipt",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "bb", audience: "bb-plugin-sdk" },
    egress: ["bb"],
    proof_kinds: ["thread_state", "external_mutation"],
    receipt_kind: "tool_receipt",
    result_limit: 8_000,
  }),
  telegram_agent_send_to_thread: capability({
    capability_id: "telegram_agent_send_to_thread",
    schema_version: 1,
    effect_class: "reversible_external_write",
    risk_class: "medium",
    data_class: ["thread_metadata"],
    reversibility: "compensating_action",
    idempotency: "tool_receipt",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "bb", audience: "bb-plugin-sdk" },
    egress: ["bb"],
    proof_kinds: ["external_mutation", "thread_state"],
    receipt_kind: "tool_receipt",
    result_limit: 8_000,
  }),
  telegram_agent_request_thread_operation: capability({
    capability_id: "telegram_agent_request_thread_operation",
    schema_version: 1,
    effect_class: "durable_local_write",
    risk_class: "high",
    data_class: ["thread_metadata"],
    reversibility: "reconcilable",
    idempotency: "tool_receipt",
    approval: "hanoon_confirmation",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "bb", audience: "bb-plugin-sdk" },
    egress: ["bb", "telegram"],
    proof_kinds: ["obligation"],
    receipt_kind: "tool_receipt",
    result_limit: 8_000,
  }),
  telegram_agent_remember: capability({
    capability_id: "telegram_agent_remember",
    schema_version: 1,
    effect_class: "durable_local_write",
    risk_class: "medium",
    data_class: ["owner_memory"],
    reversibility: "reconcilable",
    idempotency: "tool_receipt",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "controller_global",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: ["memory_state"],
    receipt_kind: "tool_receipt",
    result_limit: 8_000,
  }),
  telegram_agent_recall: capability({
    capability_id: "telegram_agent_recall",
    schema_version: 1,
    effect_class: "read",
    risk_class: "low",
    data_class: ["owner_memory"],
    reversibility: "not_applicable",
    idempotency: "read",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "controller_global",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: ["memory_state"],
    receipt_kind: "observation",
    result_limit: 8_000,
  }),
  telegram_agent_forget: capability({
    capability_id: "telegram_agent_forget",
    schema_version: 1,
    effect_class: "durable_local_write",
    risk_class: "medium",
    data_class: ["owner_memory"],
    reversibility: "reconcilable",
    idempotency: "exact_entity_reconciliation",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: ["memory_state"],
    receipt_kind: "domain_effect",
    result_limit: 8_000,
  }),
  telegram_agent_watch: capability({
    capability_id: "telegram_agent_watch",
    schema_version: 1,
    effect_class: "durable_local_write",
    risk_class: "medium",
    data_class: ["monitor_schedule"],
    reversibility: "reconcilable",
    idempotency: "tool_receipt",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: ["monitor_state", "obligation"],
    receipt_kind: "tool_receipt",
    result_limit: 8_000,
  }),
  telegram_agent_list_watches: capability({
    capability_id: "telegram_agent_list_watches",
    schema_version: 1,
    effect_class: "read",
    risk_class: "low",
    data_class: ["monitor_schedule"],
    reversibility: "not_applicable",
    idempotency: "read",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "controller_global",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: ["monitor_state", "obligation"],
    receipt_kind: "observation",
    result_limit: 8_000,
  }),
  telegram_agent_cancel_watch: capability({
    capability_id: "telegram_agent_cancel_watch",
    schema_version: 1,
    effect_class: "durable_local_write",
    risk_class: "medium",
    data_class: ["monitor_schedule"],
    reversibility: "reconcilable",
    idempotency: "exact_entity_reconciliation",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: ["monitor_state"],
    receipt_kind: "domain_effect",
    result_limit: 8_000,
  }),
  telegram_agent_health: capability({
    capability_id: "telegram_agent_health",
    schema_version: 1,
    effect_class: "read",
    risk_class: "low",
    data_class: ["health_metrics"],
    reversibility: "not_applicable",
    idempotency: "read",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "controller_global",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: ["health_snapshot"],
    receipt_kind: "observation",
    result_limit: 8_000,
  }),
  telegram_agent_delegate: capability({
    capability_id: "telegram_agent_delegate",
    schema_version: 1,
    effect_class: "reversible_external_write",
    risk_class: "high",
    data_class: ["thread_metadata"],
    reversibility: "compensating_action",
    idempotency: "tool_receipt",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "bb", audience: "bb-plugin-sdk" },
    egress: ["bb"],
    proof_kinds: ["thread_state", "external_mutation", "obligation"],
    receipt_kind: "tool_receipt",
    result_limit: 8_000,
  }),
  telegram_agent_scorecard: capability({
    capability_id: "telegram_agent_scorecard",
    schema_version: 1,
    effect_class: "read",
    risk_class: "low",
    data_class: ["health_metrics"],
    reversibility: "not_applicable",
    idempotency: "read",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "controller_global",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: ["health_snapshot"],
    receipt_kind: "observation",
    result_limit: 8_000,
  }),
  telegram_agent_set_working_style: capability({
    capability_id: "telegram_agent_set_working_style",
    schema_version: 1,
    effect_class: "durable_local_write",
    risk_class: "medium",
    data_class: ["owner_memory"],
    reversibility: "reconcilable",
    idempotency: "tool_receipt",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "controller_global",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: ["memory_state"],
    receipt_kind: "tool_receipt",
    result_limit: 8_000,
  }),
  telegram_agent_turn_evidence: capability({
    capability_id: "telegram_agent_turn_evidence",
    schema_version: 1,
    effect_class: "read",
    risk_class: "low",
    data_class: ["controller_evidence"],
    reversibility: "not_applicable",
    idempotency: "read",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: [],
    receipt_kind: "none",
    result_limit: 8_000,
  }),
  telegram_agent_respond: capability({
    capability_id: "telegram_agent_respond",
    schema_version: 1,
    effect_class: "durable_local_write",
    risk_class: "medium",
    data_class: ["controller_finalization"],
    reversibility: "reconcilable",
    idempotency: "exact_entity_reconciliation",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: [],
    receipt_kind: "finalization",
    result_limit: 1_000,
  }),
  // Steering redirects a job's live implementation thread, so it reaches BB and
  // is undone by steering again rather than by a rollback.
  telegram_agent_steer_job: capability({
    capability_id: "telegram_agent_steer_job",
    schema_version: 1,
    effect_class: "reversible_external_write",
    risk_class: "high",
    data_class: ["job_control"],
    reversibility: "compensating_action",
    idempotency: "tool_receipt",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "bb", audience: "bb-plugin-sdk" },
    egress: ["bb"],
    proof_kinds: ["external_mutation", "job_state", "thread_state"],
    receipt_kind: "tool_receipt",
    result_limit: 8_000,
  }),
  // Adoption reads an existing pull request over GitHub and opens a durable job
  // against it; the branch it adopts already exists, so nothing is published.
  telegram_agent_adopt_pr: capability({
    capability_id: "telegram_agent_adopt_pr",
    schema_version: 1,
    effect_class: "durable_local_write",
    risk_class: "high",
    data_class: ["job_control"],
    reversibility: "reconcilable",
    idempotency: "exact_entity_reconciliation",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "bb", audience: "bb-plugin-sdk" },
    egress: ["bb"],
    proof_kinds: ["job_state", "external_mutation", "obligation"],
    receipt_kind: "tool_receipt",
    result_limit: 8_000,
  }),
  // The three foundation credential-broker capabilities. All are reads that
  // never resolve or reveal a credential value: list is local-only, status
  // dispatches only the broker's diagnostic health check, and verify proves
  // vault resolution only — it can never move a binding to `active`.
  telegram_agent_access_list: capability({
    capability_id: "telegram_agent_access_list",
    schema_version: 1,
    effect_class: "read",
    risk_class: "low",
    data_class: ["credential_metadata"],
    reversibility: "not_applicable",
    idempotency: "read",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "controller_global",
    credential_scope: { credential: "none", audience: "none" },
    egress: ["none"],
    proof_kinds: ["health_snapshot"],
    receipt_kind: "observation",
    result_limit: 8_000,
  }),
  telegram_agent_access_status: capability({
    capability_id: "telegram_agent_access_status",
    schema_version: 1,
    effect_class: "read",
    risk_class: "low",
    data_class: ["credential_health"],
    reversibility: "not_applicable",
    idempotency: "read",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "controller_global",
    credential_scope: { credential: "credential_broker", audience: "hanoon-credential-broker:v1" },
    egress: ["credential_broker"],
    proof_kinds: ["health_snapshot"],
    receipt_kind: "observation",
    result_limit: 4_000,
  }),
  telegram_agent_access_verify: capability({
    capability_id: "telegram_agent_access_verify",
    schema_version: 1,
    effect_class: "read",
    risk_class: "medium",
    data_class: ["credential_metadata"],
    reversibility: "not_applicable",
    idempotency: "read",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "credential_broker", audience: "hanoon-credential-broker:v1" },
    egress: ["credential_broker"],
    proof_kinds: ["health_snapshot"],
    receipt_kind: "observation",
    result_limit: 2_000,
  }),
  // Unblocking a thread the controller started. The effect lands in BB rather
  // than the outside world, and the thread itself is what acts afterwards, so
  // this is the same class of write as sending the thread a message. It is
  // deliberately not `approval: "bb_interaction"`: routing here already means
  // the decision was found to be the controller's, and requiring the owner
  // again would restore the 1:50am menu this exists to remove.
  telegram_agent_answer_thread: capability({
    capability_id: "telegram_agent_answer_thread",
    schema_version: 1,
    effect_class: "reversible_external_write",
    risk_class: "high",
    data_class: ["thread_metadata"],
    reversibility: "compensating_action",
    idempotency: "tool_receipt",
    approval: "none",
    allowed_roles: ["controller"],
    project_scope: "exact_entity",
    credential_scope: { credential: "bb", audience: "bb-plugin-sdk" },
    egress: ["bb"],
    proof_kinds: ["external_mutation", "thread_state"],
    receipt_kind: "tool_receipt",
    result_limit: 8_000,
  }),
});

const EFFECT_CLASSES = new Set([
  "read",
  "durable_local_write",
  "reversible_external_write",
  "irreversible_external_write",
]);
const RISK_CLASSES = new Set(["low", "medium", "high", "critical"]);
const REVERSIBILITIES = new Set([
  "not_applicable",
  "reconcilable",
  "compensating_action",
  "irreversible",
]);
const IDEMPOTENCY_KINDS = new Set([
  "read",
  "tool_receipt",
  "domain_effect",
  "exact_entity_reconciliation",
]);
const APPROVAL_KINDS = new Set([
  "none",
  "bb_interaction",
  "hanoon_confirmation",
  "pipeline_approval",
]);
const PROJECT_SCOPES = new Set(["controller_global", "current_project", "exact_entity"]);
const CREDENTIAL_KINDS = new Set(["none", "bb", "telegram", "github", "credential_broker"]);
const EGRESS_KINDS = new Set(["none", "bb", "telegram", "github", "credential_broker"]);
const DATA_CLASSES: ReadonlySet<string> = new Set(CONTROLLER_DATA_CLASSES);
const PROOF_KINDS: ReadonlySet<string> = new Set(CONTROLLER_PROOF_KINDS);
const RECEIPT_KINDS = new Set([
  "observation",
  "tool_receipt",
  "domain_effect",
  "finalization",
  "none",
]);

function throwInvalidCapability(capabilityId: string, field: string): never {
  throw new TypeError(`controller capability ${capabilityId.slice(0, 64)} has invalid ${field}`);
}

function assertKnown(
  capabilityId: string,
  field: string,
  enumValue: string,
  knownValues: ReadonlySet<string>,
): void {
  if (!knownValues.has(enumValue)) throwInvalidCapability(capabilityId, field);
}

function assertUnique(
  capabilityId: string,
  field: string,
  enumValues: readonly string[],
): void {
  if (new Set(enumValues).size !== enumValues.length) throwInvalidCapability(capabilityId, field);
}

function validateVocabulary(
  capabilityId: string,
  descriptor: ControllerCapabilityDescriptor,
): void {
  assertKnown(capabilityId, "effect_class", descriptor.effect_class, EFFECT_CLASSES);
  assertKnown(capabilityId, "risk_class", descriptor.risk_class, RISK_CLASSES);
  assertKnown(capabilityId, "reversibility", descriptor.reversibility, REVERSIBILITIES);
  assertKnown(capabilityId, "idempotency", descriptor.idempotency, IDEMPOTENCY_KINDS);
  assertKnown(capabilityId, "approval", descriptor.approval, APPROVAL_KINDS);
  assertKnown(capabilityId, "project_scope", descriptor.project_scope, PROJECT_SCOPES);
  assertKnown(capabilityId, "receipt_kind", descriptor.receipt_kind, RECEIPT_KINDS);
}

function validateArrays(
  capabilityId: string,
  descriptor: ControllerCapabilityDescriptor,
): void {
  const allowedRoles: readonly string[] = descriptor.allowed_roles;
  if (descriptor.data_class.length !== 1) throwInvalidCapability(capabilityId, "data_class");
  if (allowedRoles.length !== 1 || allowedRoles[0] !== "controller") throwInvalidCapability(capabilityId, "allowed_roles");
  if (descriptor.egress.length === 0) throwInvalidCapability(capabilityId, "egress");
  for (const dataClass of descriptor.data_class) assertKnown(capabilityId, "data_class", dataClass, DATA_CLASSES);
  for (const proofKind of descriptor.proof_kinds) assertKnown(capabilityId, "proof_kinds", proofKind, PROOF_KINDS);
  for (const egress of descriptor.egress) assertKnown(capabilityId, "egress", egress, EGRESS_KINDS);
  assertUnique(capabilityId, "data_class", descriptor.data_class);
  assertUnique(capabilityId, "allowed_roles", allowedRoles);
  assertUnique(capabilityId, "egress", descriptor.egress);
  assertUnique(capabilityId, "proof_kinds", descriptor.proof_kinds);
}

function validateCredential(
  capabilityId: string,
  descriptor: ControllerCapabilityDescriptor,
): void {
  const { credential, audience } = descriptor.credential_scope;
  assertKnown(capabilityId, "credential_scope", credential, CREDENTIAL_KINDS);
  if (audience.trim().length === 0) throwInvalidCapability(capabilityId, "credential_scope");
  if ((credential === "none") !== (audience === "none")) throwInvalidCapability(capabilityId, "credential_scope");
  const hasNoneEgress = descriptor.egress.includes("none");
  if (hasNoneEgress && descriptor.egress.length !== 1) throwInvalidCapability(capabilityId, "egress");
}

function validateEffectConsistency(
  capabilityId: string,
  descriptor: ControllerCapabilityDescriptor,
): void {
  if (descriptor.effect_class === "irreversible_external_write") throwInvalidCapability(capabilityId, "effect_class");
  if (descriptor.effect_class === "read") {
    if (descriptor.idempotency !== "read") throwInvalidCapability(capabilityId, "idempotency");
    if (descriptor.reversibility !== "not_applicable") throwInvalidCapability(capabilityId, "reversibility");
    return;
  }
  if (descriptor.idempotency === "read") throwInvalidCapability(capabilityId, "idempotency");
  const expectedReversibility = descriptor.effect_class === "durable_local_write"
    ? "reconcilable"
    : "compensating_action";
  if (descriptor.reversibility !== expectedReversibility) throwInvalidCapability(capabilityId, "reversibility");
}

function validateDescriptor(
  capabilityId: ControllerToolName,
  descriptor: ControllerCapabilityDescriptor,
): void {
  if (descriptor.capability_id !== capabilityId) throwInvalidCapability(capabilityId, "capability_id");
  if (descriptor.schema_version !== 1) throwInvalidCapability(capabilityId, "schema_version");
  if (!Number.isSafeInteger(descriptor.result_limit)
    || descriptor.result_limit < 1
    || descriptor.result_limit > 8_000) throwInvalidCapability(capabilityId, "result_limit");
  validateVocabulary(capabilityId, descriptor);
  validateArrays(capabilityId, descriptor);
  validateCredential(capabilityId, descriptor);
  validateEffectConsistency(capabilityId, descriptor);
}

function validateManifest(): void {
  const manifestKeys = Object.keys(CONTROLLER_CAPABILITIES);
  if (manifestKeys.length !== CONTROLLER_TOOL_NAMES.length) {
    throwInvalidCapability("manifest", "keys");
  }
  for (const capabilityId of CONTROLLER_TOOL_NAMES) {
    if (!Object.hasOwn(CONTROLLER_CAPABILITIES, capabilityId)) throwInvalidCapability(capabilityId, "key");
    validateDescriptor(capabilityId, CONTROLLER_CAPABILITIES[capabilityId]);
  }
}

validateManifest();

export function controllerCapability(name: ControllerToolName): ControllerCapabilityDescriptor {
  if (!Object.hasOwn(CONTROLLER_CAPABILITIES, name)) {
    throw new TypeError("unknown controller capability");
  }
  return CONTROLLER_CAPABILITIES[name];
}

export const CONTROLLER_CAPABILITY_DENIAL_CODES = Object.freeze([
  "policy_unreadable",
  "identity_mismatch",
  "turn_missing",
  "role_denied",
  "scope_denied",
  "approval_invalid",
  "credential_scope_denied",
  "fence_lost",
  "turn_finalized",
] as const);

export type ControllerCapabilityDenialCode = (typeof CONTROLLER_CAPABILITY_DENIAL_CODES)[number];

export type ControllerCapabilityAuthority = Readonly<{
  policyReadable: boolean;
  durableController: boolean;
  currentTurn: boolean;
  turnFinalized: boolean;
  role: "controller" | "worker" | "unknown";
  contextMatches: boolean;
  scopeMatches: boolean;
  approval: "not_required" | "current" | "missing" | "stale";
  credentialAudienceMatches: boolean;
  fenceCurrent: boolean;
  untrustedContent?: string;
}>;

export function decideControllerCapability(
  authority: ControllerCapabilityAuthority,
  descriptor: ControllerCapabilityDescriptor,
): { outcome: "allowed" } | { outcome: "denied"; code: ControllerCapabilityDenialCode } {
  if (!authority.policyReadable) return { outcome: "denied", code: "policy_unreadable" };
  if (!authority.durableController || !authority.contextMatches) return { outcome: "denied", code: "identity_mismatch" };
  if (!authority.currentTurn) return { outcome: "denied", code: "turn_missing" };
  if (!descriptor.allowed_roles.includes(authority.role as "controller")) return { outcome: "denied", code: "role_denied" };
  if (!authority.scopeMatches) return { outcome: "denied", code: "scope_denied" };
  if (authority.approval === "missing" || authority.approval === "stale") return { outcome: "denied", code: "approval_invalid" };
  if (!authority.credentialAudienceMatches) return { outcome: "denied", code: "credential_scope_denied" };
  if (!authority.fenceCurrent) return { outcome: "denied", code: "fence_lost" };
  if (authority.turnFinalized && descriptor.capability_id !== "telegram_agent_respond") {
    return { outcome: "denied", code: "turn_finalized" };
  }
  return { outcome: "allowed" };
}
