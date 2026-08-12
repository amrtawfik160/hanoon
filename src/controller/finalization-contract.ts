import { z } from "zod";
import { containsCredentialLikeText } from "../domain/state-machine";
import { assertNoRawMergeCallback } from "../storage/job-persistence";
import { CONTROLLER_PROOF_KINDS, type ControllerProofKind } from "./models";

export const CONTROLLER_CLAIM_KINDS = [
  "observed_state",
  "execution_result",
  "workspace_change",
  "external_mutation",
  "pipeline_outcome",
  "health_assessment",
  "uncertainty",
] as const;

export const FINALIZATION_REJECTION_CODES = [
  "invalid_contract",
  "accepted_already",
  "revision_limit",
  "evidence_limit_exceeded",
  "duplicate_evidence_reference",
  "evidence_missing",
  "subject_mismatch",
  "proof_incompatible",
  "owner_boundary_missing",
  "obligation_forbidden",
  "obligation_missing",
  "obligation_not_live",
  "process_only",
  "high_impact_text_unclaimed",
] as const;

export type ControllerClaimKind = (typeof CONTROLLER_CLAIM_KINDS)[number];
export type FinalizationRejectionCode = (typeof FINALIZATION_REJECTION_CODES)[number];
type EvidenceRef = `evidence:${number}`;

const boundedSegmentText = z.string().max(4_000).refine(
  (text) => text.trim().length > 0,
  "segment text must be nonempty",
);
const boundedSubjectRef = z.string().min(1).max(256);
const evidenceRefSchema = z.string().regex(/^evidence:[1-9][0-9]*$/).transform((ref) => ref as EvidenceRef);
const boundedObligationRef = z.string().min(1).max(256);

export const controllerFinalizationSchema = z.object({
  disposition: z.enum(["answered", "needs_owner", "deferred"]),
  segments: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: boundedSegmentText }).strict(),
    z.object({
      type: z.literal("claim"),
      text: boundedSegmentText,
      kind: z.enum(CONTROLLER_CLAIM_KINDS),
      outcome: z.enum(["observed", "succeeded", "failed", "uncertain"]),
      subjectRef: boundedSubjectRef,
      evidenceRefs: z.array(evidenceRefSchema).min(1).max(8),
    }).strict(),
  ])).min(1).max(24),
  obligationRefs: z.array(boundedObligationRef).max(8),
}).strict().refine(
  (candidate) => candidate.segments.filter((segment) => segment.type === "claim").length <= 12,
  "finalization must contain at most 12 claim segments",
);

export type ControllerFinalization = z.infer<typeof controllerFinalizationSchema>;
type ControllerClaim = Extract<ControllerFinalization["segments"][number], { type: "claim" }>;

export type ControllerFinalizationValidationContext = Readonly<{
  acceptedAlready: boolean;
  revisionCount: number;
  evidenceLimitExceeded: boolean;
  evidenceByRef: ReadonlyMap<EvidenceRef, Readonly<{
    ref: EvidenceRef;
    outcome: "observed" | "succeeded" | "failed" | "interrupted" | "denied";
    proofKinds: readonly ControllerProofKind[];
    subjectRefs: readonly string[];
  }>>;
  ownerBoundaryPresent: boolean;
  liveObligationRefs: ReadonlySet<string>;
}>;

export type ControllerFinalizationValidation =
  | {
      outcome: "accepted";
      candidate: ControllerFinalization;
      renderedMessage: string;
    }
  | {
      outcome: "rejected";
      code: FinalizationRejectionCode;
      correction: string;
      storedCandidate: ControllerFinalization;
    };

type EvidenceRow = ControllerFinalizationValidationContext["evidenceByRef"] extends ReadonlyMap<unknown, infer Row>
  ? Row
  : never;

const CLAIM_PROOFS: Record<ControllerClaimKind, ReadonlySet<ControllerProofKind>> = {
  observed_state: new Set(["project_state", "job_state", "thread_state", "monitor_state", "memory_state"]),
  execution_result: new Set(["command_result", "tool_result"]),
  workspace_change: new Set(["workspace_change"]),
  external_mutation: new Set(["external_mutation"]),
  pipeline_outcome: new Set(["pipeline_outcome"]),
  health_assessment: new Set(["health_snapshot"]),
  uncertainty: new Set(CONTROLLER_PROOF_KINDS),
};

const CURRENT_OBSERVATION_SUCCESS_KINDS: ReadonlySet<ControllerClaimKind> = new Set([
  "observed_state",
  "pipeline_outcome",
  "health_assessment",
]);
const NEGATIVE_EVIDENCE_OUTCOMES: ReadonlySet<EvidenceRow["outcome"]> = new Set([
  "failed",
  "interrupted",
  "denied",
]);
const CORRECTIONS: Record<FinalizationRejectionCode, string> = {
  invalid_contract: "Return one valid bounded finalization without unsafe material.",
  accepted_already: "This turn already has an accepted finalization.",
  revision_limit: "The finalization revision limit has been reached.",
  evidence_limit_exceeded: "The evidence limit was exceeded; do not finalize this turn.",
  duplicate_evidence_reference: "Remove duplicate evidence references within each claim.",
  evidence_missing: "Reference only evidence available to this turn.",
  subject_mismatch: "Use evidence whose subject exactly matches the claim subject.",
  proof_incompatible: "Use proof and outcomes compatible with every claim.",
  owner_boundary_missing: "Use needs_owner only for an active owner boundary.",
  obligation_forbidden: "Remove obligations from answered or needs_owner finalizations.",
  obligation_missing: "A deferred finalization requires a durable obligation.",
  obligation_not_live: "Reference only live obligations for a deferred finalization.",
  process_only: "Replace process intent with a direct answer or durable deferred obligation.",
  high_impact_text_unclaimed: "Move high-impact success assertions into evidence-backed claim segments.",
};

const PROCESS_OBJECT_WORD = "(?!(?:and|then|if)\\b)[a-z0-9_'/:-]+";
const PROCESS_ACTION = `(?:check|look(?:\\s+into)?|investigate|work\\s+on|try|get\\s+back(?:\\s+to\\s+you)?|follow\\s+up)(?:\\s+${PROCESS_OBJECT_WORD}){0,12}`;
const PROCESS_ONLY = new RegExp(
  `^(?:i(?:'ll| will)|let me)\\s+${PROCESS_ACTION}(?:\\s+(?:and|then)\\s+${PROCESS_ACTION})*[.!]?$`,
  "i",
);
const NON_SUCCESS_TEXT = [
  /\?\s*$/,
  /\b(?:not|never|no longer|didn't|did not|hasn't|has not|haven't|have not|wasn't|was not)\b/i,
  /\b(?:failed|failure|unsuccessful|denied|interrupted)\b/i,
  /\b(?:will|would|could|should|plan to|intend to|propose|after approval|later)\b/i,
  /\b(?:may|might|maybe|uncertain|unsure|possibly|probably|appears|seems)\b/i,
];
const HIGH_IMPACT_SUCCESS = [
  /\b(?:i|we)\s+(?:have\s+)?(?:implemented|fixed|shipped)\b/i,
  /\btests?\s+(?:passed|succeeded|completed)\b/i,
  /\breview\s+(?:is|was|has been)?\s*(?:complete|completed|passed|approved)\b/i,
  /\b(?:merged|merge\s+(?:is|was)?\s*(?:complete|completed|succeeded))\b/i,
  /\b(?:deployed|deployment\s+(?:succeeded|completed)|production\s+(?:is|was)?\s*(?:live|healthy|verified))\b/i,
  /\b(?:deleted|removed|purged)\b/i,
  /\binstalled\b/i,
  /\b(?:rotated|updated|created|issued|changed)\s+(?:the\s+)?(?:credentials?|passwords?|secrets?|tokens?|api[_ -]?keys?)\b/i,
  /\b(?:i|we)\s+(?:have\s+)?(?:spent|paid|purchased)\b/i,
];

export function renderControllerFinalization(candidate: ControllerFinalization): string {
  const renderedMessage = candidate.segments.map((segment) => segment.text).join("");
  if (Array.from(renderedMessage).length > 4_000) {
    throw new TypeError("final message exceeds 4000 characters");
  }
  return renderedMessage;
}

function rejected(
  code: FinalizationRejectionCode,
  storedCandidate: ControllerFinalization,
): ControllerFinalizationValidation {
  return { outcome: "rejected", code, correction: CORRECTIONS[code], storedCandidate };
}

function fixedStorageProjection(): ControllerFinalization {
  return {
    disposition: "answered",
    segments: [{ type: "text", text: "[redacted]" }],
    obligationRefs: [],
  };
}

function hasUnsafeCallbackMaterial(candidateString: string): boolean {
  try {
    assertNoRawMergeCallback(candidateString, "controller finalization");
    return false;
  } catch (error) {
    if (error instanceof TypeError) return true;
    throw error;
  }
}

function isUnsafeCandidateString(candidateString: string): boolean {
  return containsCredentialLikeText(candidateString) || hasUnsafeCallbackMaterial(candidateString);
}

function nonTextCandidateStrings(candidate: ControllerFinalization): string[] {
  return [
    candidate.disposition,
    ...candidate.segments.flatMap((segment) => segment.type === "claim"
      ? [segment.type, segment.kind, segment.outcome, segment.subjectRef, ...segment.evidenceRefs]
      : [segment.type]),
    ...candidate.obligationRefs,
  ];
}

function redactedCandidate(candidate: ControllerFinalization): ControllerFinalization {
  return {
    ...candidate,
    segments: candidate.segments.map((segment) => ({ ...segment, text: "[redacted]" })),
  };
}

function unsafeStorageProjection(candidate: ControllerFinalization): ControllerFinalization | null {
  if (nonTextCandidateStrings(candidate).some(isUnsafeCandidateString)) return fixedStorageProjection();
  if (candidate.segments.some((segment) => isUnsafeCandidateString(segment.text))) return redactedCandidate(candidate);
  return null;
}

function claims(candidate: ControllerFinalization): ControllerClaim[] {
  return candidate.segments.filter((segment): segment is ControllerClaim => segment.type === "claim");
}

function hasDuplicateEvidenceReference(candidateClaims: readonly ControllerClaim[]): boolean {
  return candidateClaims.some((claim) => new Set(claim.evidenceRefs).size !== claim.evidenceRefs.length);
}

function hasMissingEvidence(
  candidateClaims: readonly ControllerClaim[],
  context: ControllerFinalizationValidationContext,
): boolean {
  return candidateClaims.some((claim) => claim.evidenceRefs.some((ref) => !context.evidenceByRef.has(ref)));
}

function evidenceRows(
  claim: ControllerClaim,
  context: ControllerFinalizationValidationContext,
): EvidenceRow[] {
  return claim.evidenceRefs.map((ref) => context.evidenceByRef.get(ref) as EvidenceRow);
}

function hasSubjectMismatch(
  candidateClaims: readonly ControllerClaim[],
  context: ControllerFinalizationValidationContext,
): boolean {
  return candidateClaims.some((claim) => (
    evidenceRows(claim, context).some((row) => !row.subjectRefs.includes(claim.subjectRef))
  ));
}

function evidenceOutcomesSupportClaim(claim: ControllerClaim, rows: readonly EvidenceRow[]): boolean {
  if (claim.outcome === "uncertain") return true;
  if (claim.outcome === "observed") {
    return rows.every((row) => row.outcome === "observed" || row.outcome === "succeeded");
  }
  if (claim.outcome === "failed") return rows.every((row) => NEGATIVE_EVIDENCE_OUTCOMES.has(row.outcome));

  const hasSucceeded = rows.some((row) => row.outcome === "succeeded");
  const hasOnlyCurrentOrSucceeded = rows.every((row) => row.outcome === "observed" || row.outcome === "succeeded");
  return hasOnlyCurrentOrSucceeded && (hasSucceeded || CURRENT_OBSERVATION_SUCCESS_KINDS.has(claim.kind));
}

function evidenceSupportsClaim(claim: ControllerClaim, rows: readonly EvidenceRow[]): boolean {
  const compatibleProofs = CLAIM_PROOFS[claim.kind];
  if (rows.some((row) => !row.proofKinds.some((proofKind) => compatibleProofs.has(proofKind)))) return false;
  if (!evidenceOutcomesSupportClaim(claim, rows)) return false;
  if (claim.kind !== "uncertainty") return true;
  return claim.outcome === "uncertain" || rows.some((row) => NEGATIVE_EVIDENCE_OUTCOMES.has(row.outcome));
}

function hasProofIncompatibility(
  candidateClaims: readonly ControllerClaim[],
  context: ControllerFinalizationValidationContext,
): boolean {
  return candidateClaims.some((claim) => !evidenceSupportsClaim(claim, evidenceRows(claim, context)));
}

function isProcessOnly(candidate: ControllerFinalization, renderedMessage: string): boolean {
  if (candidate.disposition === "deferred" && candidate.obligationRefs.length > 0) return false;
  return PROCESS_ONLY.test(renderedMessage.trim());
}

function textClauses(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]?/g) ?? [text];
  return sentences
    .flatMap((sentence) => sentence.split(/\s*(?:,\s*)?\b(?:and|but|however)\b\s+|;\s*/i))
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function clauseHasHighImpactSuccess(clause: string): boolean {
  if (NON_SUCCESS_TEXT.some((pattern) => pattern.test(clause))) return false;
  return HIGH_IMPACT_SUCCESS.some((pattern) => pattern.test(clause));
}

function hasUnclaimedHighImpactText(candidate: ControllerFinalization): boolean {
  return candidate.segments.some((segment) => (
    segment.type === "text" && textClauses(segment.text).some(clauseHasHighImpactSuccess)
  ));
}

function renderCandidate(candidate: ControllerFinalization): string | null {
  try {
    return renderControllerFinalization(candidate);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function contextRejectionCode(
  context: ControllerFinalizationValidationContext,
): FinalizationRejectionCode | null {
  if (context.acceptedAlready) return "accepted_already";
  if (context.revisionCount >= 8) return "revision_limit";
  if (context.evidenceLimitExceeded) return "evidence_limit_exceeded";
  return null;
}

function claimRejectionCode(
  candidateClaims: readonly ControllerClaim[],
  context: ControllerFinalizationValidationContext,
): FinalizationRejectionCode | null {
  if (hasDuplicateEvidenceReference(candidateClaims)) return "duplicate_evidence_reference";
  if (hasMissingEvidence(candidateClaims, context)) return "evidence_missing";
  if (hasSubjectMismatch(candidateClaims, context)) return "subject_mismatch";
  if (hasProofIncompatibility(candidateClaims, context)) return "proof_incompatible";
  return null;
}

function dispositionRejectionCode(
  candidate: ControllerFinalization,
  context: ControllerFinalizationValidationContext,
): FinalizationRejectionCode | null {
  if (candidate.disposition === "needs_owner" && !context.ownerBoundaryPresent) return "owner_boundary_missing";
  if (candidate.disposition !== "deferred" && candidate.obligationRefs.length > 0) return "obligation_forbidden";
  if (candidate.disposition === "deferred" && candidate.obligationRefs.length === 0) return "obligation_missing";
  if (candidate.disposition === "deferred"
    && candidate.obligationRefs.some((ref) => !context.liveObligationRefs.has(ref))) return "obligation_not_live";
  return null;
}

function semanticRejectionCode(
  candidate: ControllerFinalization,
  renderedMessage: string,
  context: ControllerFinalizationValidationContext,
): FinalizationRejectionCode | null {
  return contextRejectionCode(context)
    ?? claimRejectionCode(claims(candidate), context)
    ?? dispositionRejectionCode(candidate, context)
    ?? (isProcessOnly(candidate, renderedMessage) ? "process_only" : null)
    ?? (hasUnclaimedHighImpactText(candidate) ? "high_impact_text_unclaimed" : null);
}

export function validateControllerFinalization(
  candidateInput: unknown,
  context: ControllerFinalizationValidationContext,
): ControllerFinalizationValidation {
  const parsed = controllerFinalizationSchema.safeParse(candidateInput);
  if (!parsed.success) return rejected("invalid_contract", fixedStorageProjection());

  const candidate = parsed.data;
  const renderedMessage = renderCandidate(candidate);
  if (renderedMessage === null) return rejected("invalid_contract", fixedStorageProjection());
  const unsafeProjection = unsafeStorageProjection(candidate);
  if (unsafeProjection) return rejected("invalid_contract", unsafeProjection);
  const rejectionCode = semanticRejectionCode(candidate, renderedMessage, context);
  if (rejectionCode) return rejected(rejectionCode, candidate);
  return { outcome: "accepted", candidate, renderedMessage };
}
