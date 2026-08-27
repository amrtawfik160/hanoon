import { createHash } from "node:crypto";
import { containsCredentialLikeText } from "./state-machine";

export const OWNER_BOUNDARY_CODES = [
  "product_decision_required",
  "scope_expansion_required",
  "credential_or_access_required",
  "spend_authority_required",
  "irreversible_effect_required",
  "policy_change_required",
  "technical_tradeoff_required",
  "production_recovery_required",
] as const;

export type OwnerBoundaryCode = (typeof OWNER_BOUNDARY_CODES)[number];

export type OwnerBoundaryOption = Readonly<{
  label: string;
  consequence: string;
}>;

export type OwnerBoundaryDraft = Readonly<{
  code: OwnerBoundaryCode;
  goal: string;
  blocker: string;
  priorChecks: readonly string[];
  options: readonly OwnerBoundaryOption[];
  recommendation: string;
  pausedEffect: string;
  evidenceFacts: readonly string[];
  affectedArtifactId?: string | null;
  affectedEffectIdempotencyKey?: string | null;
}>;

export const OWNER_BOUNDARY_REQUIRED_FACTS: Readonly<Record<OwnerBoundaryCode, readonly string[]>> = {
  product_decision_required: ["decision:product-options-unresolved"],
  scope_expansion_required: ["scope:outside-task-authority"],
  credential_or_access_required: ["access:required-and-unavailable"],
  spend_authority_required: ["spend:not-granted"],
  irreversible_effect_required: ["effect:irreversible"],
  policy_change_required: ["policy:change-required"],
  technical_tradeoff_required: ["tradeoff:material", "retry:exhausted"],
  production_recovery_required: ["production:failed", "recovery:exhausted"],
};

export function ownerBoundaryFactsSupport(
  code: OwnerBoundaryCode,
  evidenceFacts: readonly string[],
): boolean {
  const facts = new Set(evidenceFacts);
  return OWNER_BOUNDARY_REQUIRED_FACTS[code].every((required) => facts.has(required));
}

const MAX_BOUNDARY_TEXT = 2_000;
const MAX_PRIOR_CHECKS = 8;
const MAX_OPTIONS = 3;
const IDENTIFIER = /^[A-Za-z0-9_.:/-]{1,256}$/u;
const SLOP_PATTERNS = [
  /^(?:not sure|unclear|what should i do|please advise|i need help|something went wrong)$/iu,
  /\b(?:which|what)\s+(?:model|skill|workflow|tool|ticket)\b/iu,
];
const LOG_PATTERNS = [
  /\b(?:stack trace|traceback|npm err!|panic:|exception in thread)\b/iu,
  /^\s*at\s+[^\n]+$/imu,
  /(?:^|\n)\s*(?:debug|info|warn|error)\s*[:|]/imu,
];

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} must be text`);
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length === 0 || normalized.length > MAX_BOUNDARY_TEXT) {
    throw new TypeError(`${field} must be a bounded non-empty text`);
  }
  if (containsCredentialLikeText(normalized)) throw new TypeError(`${field} must not contain credential-like text`);
  if (LOG_PATTERNS.some((pattern) => pattern.test(normalized))) throw new TypeError(`${field} must not contain raw logs`);
  if (SLOP_PATTERNS.some((pattern) => pattern.test(normalized))) throw new TypeError(`${field} must contain a concrete decision`);
  return normalized;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new TypeError(`${field} is not a safe identifier`);
  return value;
}

export function assertOwnerBoundaryCode(value: unknown): asserts value is OwnerBoundaryCode {
  if (typeof value !== "string" || !OWNER_BOUNDARY_CODES.includes(value as OwnerBoundaryCode)) {
    throw new TypeError("owner boundary code is not an accepted boundary class");
  }
}

export function normalizeOwnerBoundary(input: OwnerBoundaryDraft): OwnerBoundaryDraft {
  assertOwnerBoundaryCode(input.code);
  const goal = text(input.goal, "boundary goal");
  const blocker = text(input.blocker, "boundary blocker");
  if (!Array.isArray(input.priorChecks) || input.priorChecks.length === 0 || input.priorChecks.length > MAX_PRIOR_CHECKS) {
    throw new TypeError("owner boundary prior checks must contain one to eight checks");
  }
  const priorChecks = input.priorChecks.map((check, index) => text(check, `prior check ${index + 1}`));
  if (new Set(priorChecks).size !== priorChecks.length) throw new TypeError("owner boundary prior checks are duplicated");
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > MAX_OPTIONS) {
    throw new TypeError("owner boundary must contain two or three options");
  }
  const options = input.options.map((option, index) => {
    if (option === null || typeof option !== "object") throw new TypeError(`boundary option ${index + 1} is invalid`);
    return {
      label: text(option.label, `boundary option ${index + 1} label`),
      consequence: text(option.consequence, `boundary option ${index + 1} consequence`),
    };
  });
  const optionLabels = options.map((option) => option.label.toLowerCase());
  if (new Set(optionLabels).size !== optionLabels.length) throw new TypeError("owner boundary options are duplicated");
  const recommendation = text(input.recommendation, "boundary recommendation");
  const pausedEffect = text(input.pausedEffect, "boundary paused effect");
  if (!Array.isArray(input.evidenceFacts) || input.evidenceFacts.length === 0 || input.evidenceFacts.length > 16) {
    throw new TypeError("owner boundary evidence facts must contain one to sixteen facts");
  }
  const evidenceFacts = input.evidenceFacts.map((fact, index) => identifier(fact, `boundary evidence fact ${index + 1}`));
  if (new Set(evidenceFacts).size !== evidenceFacts.length) throw new TypeError("owner boundary evidence facts are duplicated");
  const affectedArtifactId = input.affectedArtifactId === undefined || input.affectedArtifactId === null
    ? null
    : identifier(input.affectedArtifactId, "affected artifact id");
  const affectedEffectIdempotencyKey = input.affectedEffectIdempotencyKey === undefined || input.affectedEffectIdempotencyKey === null
    ? null
    : identifier(input.affectedEffectIdempotencyKey, "affected effect idempotency key");
  if (affectedArtifactId === null && affectedEffectIdempotencyKey === null) {
    throw new TypeError("owner boundary must identify an affected artifact or effect");
  }
  return {
    code: input.code,
    goal,
    blocker,
    priorChecks,
    options,
    recommendation,
    pausedEffect,
    evidenceFacts,
    affectedArtifactId,
    affectedEffectIdempotencyKey,
  };
}

export function ownerBoundaryDigest(input: OwnerBoundaryDraft): string {
  const normalized = normalizeOwnerBoundary(input);
  return digest(JSON.stringify(normalized));
}

export function renderOwnerBoundary(input: OwnerBoundaryDraft): string {
  const boundary = normalizeOwnerBoundary(input);
  const checks = boundary.priorChecks.map((check) => `• ${check}`).join("\n");
  const options = boundary.options
    .map((option, index) => `${index + 1}. ${option.label}: ${option.consequence}`)
    .join("\n");
  return [
    "Owner decision required",
    `Goal: ${boundary.goal}`,
    `Blocker: ${boundary.blocker}`,
    `Already checked:\n${checks}`,
    `Options:\n${options}`,
    `Recommendation: ${boundary.recommendation}`,
    `Paused safely: ${boundary.pausedEffect}`,
    "Reply to this message with your decision. No reply is not approval; the paused effect remains blocked.",
  ].join("\n\n");
}

export type OwnerBoundaryAnswer = Readonly<{
  answerText: string;
  answerDigest: string;
}>;

export function normalizeOwnerBoundaryAnswer(answerText: string): OwnerBoundaryAnswer {
  const answer = text(answerText, "owner boundary answer");
  return { answerText: answer, answerDigest: digest(answer) };
}
