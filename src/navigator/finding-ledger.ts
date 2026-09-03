import { createHash } from "node:crypto";
import { admittedCapabilityFindingPolicy, type CapabilityFindingPolicy } from "../capabilities/catalog";
import { evaluateFindingDisposition, normalizeGuardSubject } from "../capabilities/guards";
import {
  navigatorReviewFindingSchema,
  type NavigatorReviewFinding,
} from "./implementation-contracts";

export type NavigatorFindingLedgerState = "open" | "resolved" | "disputed" | "stale";
export type NavigatorFindingDisposition = "must_fix" | "advisory";

export type NavigatorFindingLedgerEntry = Readonly<{
  rootCauseId: string;
  sliceId: string;
  sourceReviewAttemptId: string;
  verificationAttemptId: string;
  disposition: NavigatorFindingDisposition;
  state: NavigatorFindingLedgerState;
  occurrence: number;
  blockingBurden: number;
  headSha: string;
  fingerprint: string;
  normalizedSubject: string;
  requirementClass: string;
  descriptorDigest: string;
  descriptorVersion: string;
  policyRevision: number;
  policyDigest: string;
  artifactSnapshotId: string | null;
  artifactSnapshotDigest: string | null;
  specificationSnapshotId: string | null;
  specificationSnapshotDigest: string | null;
  sourceAttemptDigest: string;
  verificationAttemptDigest: string;
  supersedesRootCauseId: string | null;
  finding: NavigatorReviewFinding;
}>;

export type NavigatorFindingLedgerDecision = Readonly<{
  outcome: "accepted" | "blocked";
  allowedNextAction: "repair" | "accept" | "recheck" | "stop";
  reasonCode: string | null;
  entries: readonly NavigatorFindingLedgerEntry[];
  currentRoots: readonly NavigatorFindingLedgerEntry[];
  blockingBurden: number;
  burdenDelta: number;
  staleEvidence: readonly Readonly<{
    fingerprint: string;
    assessedHeadSha: string;
    currentHeadSha: string;
  }>[];
  reasons: readonly string[];
}>;

export type NavigatorFindingAssessmentInput = Readonly<{
  jobId: string;
  sliceId: string;
  sourceReviewAttemptId: string;
  verificationAttemptId: string;
  sourceAttemptDigest: string;
  verificationAttemptDigest: string;
  exactHeadSha: string;
  artifactSnapshotId: string | null;
  artifactSnapshotDigest: string | null;
  specificationSnapshotId: string | null;
  specificationSnapshotDigest: string | null;
  selectedGuards: readonly Readonly<{ capabilityId: string; descriptorDigest: string }>[];
  requirementIds: readonly string[];
  proposedFindings: readonly NavigatorReviewFinding[];
  confirmedFindings: readonly NavigatorReviewFinding[];
  evidenceRefs: readonly string[];
  now: number;
  maxReviewCycles: number;
}>;

export type NavigatorFindingPassingReviewInput = Readonly<{
  jobId: string;
  sliceId: string;
  verificationAttemptId: string;
  verificationAttemptDigest: string;
  exactHeadSha: string;
  artifactSnapshotId: string | null;
  artifactSnapshotDigest: string | null;
  specificationSnapshotId: string | null;
  specificationSnapshotDigest: string | null;
  evidenceRefs: readonly string[];
  now: number;
  maxReviewCycles: number;
}>;

export type NavigatorFindingCurrentDecisionInput = Readonly<{
  jobId: string;
  sliceId?: string;
  expectedHeadSha?: string;
}>;

export type NavigatorFindingAssessmentFacts = Readonly<{
  input: NavigatorFindingAssessmentInput;
  findings: readonly NavigatorFindingAssessmentFact[];
}>;

export type NavigatorFindingAssessmentFact = Readonly<{
  proposed: NavigatorReviewFinding;
  observed: NavigatorReviewFinding;
  confirmed: boolean;
  fingerprint: string;
  normalizedSubject: string;
  requirementClass: string;
  disposition: NavigatorFindingDisposition;
  policy: CapabilityFindingPolicy;
}>;

type NormalizedFindingRecord = Readonly<{
  finding: NavigatorReviewFinding;
  policy: CapabilityFindingPolicy;
  fingerprint: string;
}>;

export interface NavigatorFindingLedgerPersistence {
  assess(input: NavigatorFindingAssessmentFacts): NavigatorFindingLedgerDecision;
  resolvePassingReview(input: NavigatorFindingPassingReviewInput): NavigatorFindingLedgerDecision;
  currentDecision(input: NavigatorFindingCurrentDecisionInput): NavigatorFindingLedgerDecision;
}

const SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9_.:/-]{1,256}$/u;

function rejected(reasonCode: string): NavigatorFindingLedgerDecision {
  return {
    outcome: "blocked",
    allowedNextAction: "stop",
    reasonCode,
    entries: [],
    currentRoots: [],
    blockingBurden: 0,
    burdenDelta: 0,
    staleEvidence: [],
    reasons: [reasonCode],
  };
}

function assertBoundedIdentifier(value: string, field: string): void {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new TypeError(`${field} is invalid`);
}

function assertSha(value: string, field: string): void {
  if (!SHA.test(value)) throw new TypeError(`${field} is invalid`);
}

function assertDigest(value: string | null, field: string): void {
  if (value !== null && !SHA256.test(value)) throw new TypeError(`${field} is invalid`);
}

function assertSnapshotBinding(
  snapshotId: string | null,
  snapshotDigest: string | null,
  field: string,
): void {
  if ((snapshotId === null) !== (snapshotDigest === null)) throw new TypeError(`${field} snapshot identity is incomplete`);
  if (snapshotId !== null) assertBoundedIdentifier(snapshotId, `${field} snapshot id`);
  assertDigest(snapshotDigest, `${field} snapshot digest`);
}

function assertTiming(now: number, maxReviewCycles: number, field: string): void {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxReviewCycles) || maxReviewCycles < 1) {
    throw new TypeError(`${field} timing is invalid`);
  }
}

function assertAssessmentIdentity(input: NavigatorFindingAssessmentInput): void {
  for (const [value, field] of [
    [input.jobId, "jobId"], [input.sliceId, "sliceId"],
    [input.sourceReviewAttemptId, "sourceReviewAttemptId"], [input.verificationAttemptId, "verificationAttemptId"],
  ] as const) assertBoundedIdentifier(value, field);
  if (input.sourceReviewAttemptId === input.verificationAttemptId) throw new TypeError("finding attempts must be independent");
  assertDigest(input.sourceAttemptDigest, "sourceAttemptDigest");
  assertDigest(input.verificationAttemptDigest, "verificationAttemptDigest");
  assertSha(input.exactHeadSha, "exactHeadSha");
  assertSnapshotBinding(input.artifactSnapshotId, input.artifactSnapshotDigest, "artifact");
  assertSnapshotBinding(input.specificationSnapshotId, input.specificationSnapshotDigest, "specification");
  assertTiming(input.now, input.maxReviewCycles, "assessment");
}

function validateSelectedGuards(input: NavigatorFindingAssessmentInput): string | null {
  if (input.selectedGuards.length === 0 || input.selectedGuards.length > 16) return "no_selected_guard_policy";
  for (const selected of input.selectedGuards) {
    assertBoundedIdentifier(selected.capabilityId, "selected capability");
    assertDigest(selected.descriptorDigest, "selected descriptor digest");
  }
  return new Set(input.selectedGuards.map(({ capabilityId }) => capabilityId)).size === input.selectedGuards.length
    ? null
    : "duplicate_selected_guard";
}

function validateRequirementIds(input: NavigatorFindingAssessmentInput): string | null {
  if (input.requirementIds.length > 100 || new Set(input.requirementIds).size !== input.requirementIds.length) {
    return "invalid_requirement_policy";
  }
  input.requirementIds.forEach((requirementId) => assertBoundedIdentifier(requirementId, "requirement"));
  return null;
}

function evidenceRefsError(evidenceRefs: readonly string[]): string | null {
  const invalid = evidenceRefs.length === 0 || evidenceRefs.length > 128 ||
    new Set(evidenceRefs).size !== evidenceRefs.length ||
    evidenceRefs.some((ref) => typeof ref !== "string" || ref.trim().length === 0 || ref.length > 1_024);
  return invalid ? "invalid_evidence_refs" : null;
}

function validateEvidenceRefs(input: NavigatorFindingAssessmentInput): string | null {
  return evidenceRefsError(input.evidenceRefs);
}

function findingRequirementIsAdmitted(
  finding: NavigatorReviewFinding,
  policy: CapabilityFindingPolicy,
): boolean {
  return finding.requirementId === null || policy.requirementIds.includes(finding.requirementId);
}

function normalizedFinding(finding: NavigatorReviewFinding): NavigatorReviewFinding {
  const parsed = navigatorReviewFindingSchema.safeParse({
    ...finding,
    subject: normalizeGuardSubject(finding.subject),
  });
  if (!parsed.success) throw new TypeError("finding is invalid");
  return parsed.data;
}

function requirementClass(finding: NavigatorReviewFinding): string {
  return finding.requirementId === null ? `evidence:${finding.evidenceClass}` : `requirement:${finding.requirementId}`;
}

export function navigatorFindingFingerprint(
  descriptorDigestOrInput: string | Readonly<{ descriptorDigest: string; finding: NavigatorReviewFinding }>,
  suppliedFinding?: NavigatorReviewFinding,
): string {
  const descriptorDigest = typeof descriptorDigestOrInput === "string"
    ? descriptorDigestOrInput
    : descriptorDigestOrInput.descriptorDigest;
  const finding = typeof descriptorDigestOrInput === "string"
    ? suppliedFinding
    : descriptorDigestOrInput.finding;
  if (!finding || !SHA256.test(descriptorDigest)) throw new TypeError("finding fingerprint inputs are invalid");
  const normalized = normalizedFinding(finding);
  const identity = [descriptorDigest, normalized.ruleId, normalized.subject, requirementClass(normalized)];
  return createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex");
}

function validateAssessmentInput(input: NavigatorFindingAssessmentInput): string | null {
  assertAssessmentIdentity(input);
  return validateSelectedGuards(input) ?? validateRequirementIds(input) ?? validateEvidenceRefs(input);
}

function validatePassingReviewInput(input: NavigatorFindingPassingReviewInput): void {
  for (const [value, field] of [
    [input.jobId, "jobId"], [input.sliceId, "sliceId"], [input.verificationAttemptId, "verificationAttemptId"],
  ] as const) assertBoundedIdentifier(value, field);
  assertDigest(input.verificationAttemptDigest, "verificationAttemptDigest");
  assertSha(input.exactHeadSha, "exactHeadSha");
  assertSnapshotBinding(input.artifactSnapshotId, input.artifactSnapshotDigest, "artifact");
  assertSnapshotBinding(input.specificationSnapshotId, input.specificationSnapshotDigest, "specification");
  if (evidenceRefsError(input.evidenceRefs) !== null) throw new TypeError("passing review evidence is invalid");
  assertTiming(input.now, input.maxReviewCycles, "passing review");
}

function policiesFor(
  input: NavigatorFindingAssessmentInput,
): Map<string, CapabilityFindingPolicy> | NavigatorFindingLedgerDecision {
  const policies = new Map<string, CapabilityFindingPolicy>();
  for (const selected of input.selectedGuards) {
    const policy = admittedCapabilityFindingPolicy({
      capabilityId: selected.capabilityId,
      descriptorDigest: selected.descriptorDigest,
      requirementIds: input.requirementIds,
    });
    if (!policy) return rejected("finding_policy_unregistered");
    policies.set(selected.capabilityId, policy);
  }
  return policies;
}

function collectProposedFindings(
  input: NavigatorFindingAssessmentInput,
  policies: ReadonlyMap<string, CapabilityFindingPolicy>,
): Map<string, NormalizedFindingRecord> | NavigatorFindingLedgerDecision {
  const proposed = new Map<string, NormalizedFindingRecord>();
  const rootCauses = new Set<string>();
  for (const finding of input.proposedFindings.map(normalizedFinding)) {
    const policy = policies.get(finding.capabilityId);
    if (!policy) return rejected("finding_capability_unselected");
    if (!findingRequirementIsAdmitted(finding, policy)) return rejected("finding_requirement_unregistered");
    if (rootCauses.has(finding.rootCauseId)) return rejected("duplicate_root_cause");
    const fingerprint = navigatorFindingFingerprint(policy.descriptorDigest, finding);
    if (proposed.has(fingerprint)) return rejected("duplicate_finding_identity");
    rootCauses.add(finding.rootCauseId);
    proposed.set(fingerprint, { finding, policy, fingerprint });
  }
  return proposed;
}

function collectConfirmedFindings(
  input: NavigatorFindingAssessmentInput,
  policies: ReadonlyMap<string, CapabilityFindingPolicy>,
  proposed: ReadonlyMap<string, NormalizedFindingRecord>,
): Map<string, NavigatorReviewFinding> | NavigatorFindingLedgerDecision {
  const confirmed = new Map<string, NavigatorReviewFinding>();
  for (const finding of input.confirmedFindings.map(normalizedFinding)) {
    const policy = policies.get(finding.capabilityId);
    if (!policy) return rejected("finding_capability_unselected");
    if (!findingRequirementIsAdmitted(finding, policy)) return rejected("finding_requirement_unregistered");
    const fingerprint = navigatorFindingFingerprint(policy.descriptorDigest, finding);
    const source = proposed.get(fingerprint);
    if (!source || confirmed.has(fingerprint) || source.finding.rootCauseId !== finding.rootCauseId) {
      return rejected("finding_verification_mismatch");
    }
    confirmed.set(fingerprint, finding);
  }
  return confirmed;
}

function findingFacts(
  proposed: ReadonlyMap<string, NormalizedFindingRecord>,
  confirmed: ReadonlyMap<string, NavigatorReviewFinding>,
): NavigatorFindingAssessmentFact[] {
  return [...proposed.values()].map(({ finding, policy, fingerprint }) => {
    const observed = confirmed.get(fingerprint) ?? finding;
    const disposition = evaluateFindingDisposition(observed, policy);
    if (disposition === null) throw new TypeError("finding disposition policy rejected observation");
    return {
      proposed: finding,
      observed,
      confirmed: confirmed.has(fingerprint),
      fingerprint,
      normalizedSubject: observed.subject,
      requirementClass: requirementClass(observed),
      disposition,
      policy,
    };
  });
}

function validateFindingSet(
  input: NavigatorFindingAssessmentInput,
  policies: ReadonlyMap<string, CapabilityFindingPolicy>,
): NavigatorFindingAssessmentFact[] | NavigatorFindingLedgerDecision {
  const proposed = collectProposedFindings(input, policies);
  if (!(proposed instanceof Map)) return proposed;
  const confirmed = collectConfirmedFindings(input, policies, proposed);
  if (!(confirmed instanceof Map)) return confirmed;
  return findingFacts(proposed, confirmed);
}

export class NavigatorFindingLedger {
  public constructor(private readonly persistence: NavigatorFindingLedgerPersistence) {}

  public assess(input: NavigatorFindingAssessmentInput): NavigatorFindingLedgerDecision {
    let facts: NavigatorFindingAssessmentFact[] | NavigatorFindingLedgerDecision;
    try {
      const invalid = validateAssessmentInput(input);
      if (invalid) return rejected(invalid);
      const policies = policiesFor(input);
      if (!(policies instanceof Map)) return policies;
      facts = validateFindingSet(input, policies);
    } catch (error) {
      if (error instanceof TypeError) return rejected("finding_assessment_invalid");
      throw error;
    }
    if (!Array.isArray(facts)) return facts;
    return this.persistence.assess({ input, findings: facts });
  }

  public resolvePassingReview(input: NavigatorFindingPassingReviewInput): NavigatorFindingLedgerDecision {
    try {
      validatePassingReviewInput(input);
    } catch (error) {
      if (error instanceof TypeError) return rejected("finding_resolution_invalid");
      throw error;
    }
    return this.persistence.resolvePassingReview(input);
  }

  public currentDecision(input: NavigatorFindingCurrentDecisionInput): NavigatorFindingLedgerDecision {
    return this.persistence.currentDecision(input);
  }
}
