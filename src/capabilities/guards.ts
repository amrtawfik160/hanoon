import { createHash } from "node:crypto";
import { z } from "zod";
import { changedPathsFromGitDiff } from "./change-surface";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const BOUNDED_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_GUARDS = 16;
const MAX_FINDINGS = 100;

export function isBoundedPolicyKey(value: unknown): value is string {
  return typeof value === "string" && BOUNDED_KEY.test(value);
}

const guardFindingSchema = z.object({
  ruleId: z.string().regex(BOUNDED_KEY),
  severity: z.enum(["critical", "high", "medium", "low"]),
  subject: z.string().min(1).max(512),
  line: z.number().int().positive().nullable(),
  evidence: z.string().min(1).max(2_000),
  evidenceClass: z.string().regex(BOUNDED_KEY),
  requirementId: z.string().regex(BOUNDED_KEY).nullable(),
}).strict();

const guardTerminalResultSchema = z.object({
  capabilityId: z.string().regex(BOUNDED_KEY),
  descriptorDigest: z.string().regex(SHA256),
  outcome: z.enum(["passed", "findings", "blocked", "failed"]),
  findings: z.array(guardFindingSchema).max(MAX_FINDINGS),
}).strict().superRefine((result, context) => {
  if (result.outcome === "findings" && result.findings.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["findings"],
      message: "a findings outcome requires at least one finding",
    });
  }
  if (result.outcome !== "findings" && result.findings.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["findings"],
      message: "only a findings outcome may contain findings",
    });
  }
});

export const guardResultEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: z.string().min(1).max(256),
  profileRevision: z.number().int().positive().safe(),
  reviewedHeadSha: z.string().regex(FULL_SHA),
  diffDigest: z.string().regex(SHA256),
  guards: z.array(guardTerminalResultSchema).max(MAX_GUARDS),
}).strict();

export type GuardFinding = z.infer<typeof guardFindingSchema>;
export type GuardTerminalResult = z.infer<typeof guardTerminalResultSchema>;
export type GuardResultEnvelope = z.infer<typeof guardResultEnvelopeSchema>;

const selectedGuardPolicySchema = z.object({
  capabilityId: z.string().regex(BOUNDED_KEY),
  descriptorDigest: z.string().regex(SHA256),
  mandatory: z.boolean(),
  substitutes: z.array(z.string().regex(BOUNDED_KEY)).max(8),
}).strict();

export const guardAssessmentPolicySchema = z.object({
  profileId: z.string().min(1).max(256),
  profileRevision: z.number().int().positive().safe(),
  reviewedHeadSha: z.string().regex(FULL_SHA),
  diffDigest: z.string().regex(SHA256),
  selectedGuards: z.array(selectedGuardPolicySchema).max(MAX_GUARDS),
  requirementIds: z.array(z.string().regex(BOUNDED_KEY)).max(100),
  mustFixRuleIds: z.array(z.string().regex(BOUNDED_KEY)).max(100),
  advisoryRuleIds: z.array(z.string().regex(BOUNDED_KEY)).max(100),
}).strict();

export type SelectedGuardPolicy = Readonly<z.infer<typeof selectedGuardPolicySchema>>;
export type GuardAssessmentPolicy = Readonly<{
  profileId: string;
  profileRevision: number;
  reviewedHeadSha: string;
  diffDigest: string;
  selectedGuards: readonly SelectedGuardPolicy[];
  requirementIds: readonly string[];
  mustFixRuleIds: readonly string[];
  advisoryRuleIds: readonly string[];
}>;

export type AssessedGuardFinding = GuardFinding & Readonly<{
  capabilityId: string;
  descriptorDigest: string;
  disposition: "must_fix" | "advisory";
  fingerprint: string;
}>;

export type FindingDispositionPolicy = Readonly<{
  defaultDisposition: "must_fix" | "advisory";
  mustFixRuleIds: readonly string[];
  advisoryRuleIds: readonly string[];
  requirementIds: readonly string[];
}>;

export type FindingDispositionInput = Readonly<{
  ruleId: string;
  severity: "critical" | "high" | "medium" | "low";
  requirementId: string | null;
  evidenceClass: string;
}>;

/**
 * Evaluate one finding against an admitted, versioned policy snapshot.
 * A null result means the finding references policy context that was not
 * admitted for the assessment and must therefore fail closed.
 */
export function evaluateFindingDisposition(
  finding: FindingDispositionInput,
  policy: FindingDispositionPolicy,
): "must_fix" | "advisory" | null {
  if (finding.requirementId !== null && !policy.requirementIds.includes(finding.requirementId)) return null;
  if (finding.severity === "critical" || finding.severity === "high") return "must_fix";
  if (finding.requirementId !== null || finding.evidenceClass === "public-contract") return "must_fix";
  if (policy.mustFixRuleIds.includes(finding.ruleId)) return "must_fix";
  if (policy.advisoryRuleIds.includes(finding.ruleId)) return "advisory";
  return policy.defaultDisposition;
}

export type GuardEnvelopeAssessment = Readonly<{
  outcome: "pass" | "pass_with_advisories" | "changes_requested" | "blocked";
  reasons: readonly string[];
  findings: readonly AssessedGuardFinding[];
  substitutions: readonly Readonly<{
    capabilityId: string;
    substituteCapabilityId: string;
  }>[];
}>;

export type GuardFingerprintPersistenceInput = Readonly<{
  profileId: string;
  scopeId: string;
  fingerprint: string;
  capabilityId: string;
  ruleId: string;
  subjectIdentity: string;
  requirementClass: string;
  now: number;
}>;

export interface GuardFingerprintRepository {
  recordGuardFingerprint(input: GuardFingerprintPersistenceInput): number;
}

export type GuardSettlementPersistenceInput = Readonly<{
  profileId: string;
  profileRevision: number;
  scopeId: string;
  outcomes: readonly Readonly<{
    capabilityId: string;
    descriptorDigest: string;
    outcome: "passed" | "findings" | "blocked" | "failed";
    evidenceRefs: readonly string[];
  }>[];
  fingerprints: readonly GuardFingerprintPersistenceInput[];
  now: number;
}>;

export type GuardSettlementPersistenceResult = Readonly<{
  fingerprints: readonly Readonly<{ fingerprint: string; occurrence: number }>[];
}>;

export interface GuardSettlementRepository extends GuardFingerprintRepository {
  settleGuardOutcomes(input: GuardSettlementPersistenceInput): GuardSettlementPersistenceResult;
}

export type GuardRequirementBinding = Readonly<{
  id: string;
  label: string;
}>;

export function guardRequirementBindings(requiredChecks: readonly string[]): readonly GuardRequirementBinding[] {
  if (requiredChecks.length > 50) throw new TypeError("Guard requirements exceed their bounded limit");
  const labels = [...new Set(requiredChecks)].sort((left, right) => left.localeCompare(right));
  if (labels.some((label) => label.length < 1 || label.length > 512)) {
    throw new TypeError("Guard requirement labels must be bounded text");
  }
  return labels.map((label) => ({
    id: `required-check:${createHash("sha256").update(label, "utf8").digest("hex").slice(0, 32)}`,
    label,
  }));
}

function blocked(reason: string): GuardEnvelopeAssessment {
  return { outcome: "blocked", reasons: [reason], findings: [], substitutions: [] };
}

function hasUniqueBoundedKeys(values: readonly string[], maximum: number): boolean {
  return values.length <= maximum && new Set(values).size === values.length &&
    values.every(isBoundedPolicyKey);
}

function validPolicy(policy: GuardAssessmentPolicy): boolean {
  if (!policy || !guardAssessmentPolicySchema.safeParse(policy).success ||
    !hasUniqueBoundedKeys(policy.requirementIds, 100) ||
    !hasUniqueBoundedKeys(policy.mustFixRuleIds, 100) ||
    !hasUniqueBoundedKeys(policy.advisoryRuleIds, 100)) return false;
  const selectedIds = policy.selectedGuards.map((guard) => guard.capabilityId);
  if (!hasUniqueBoundedKeys(selectedIds, MAX_GUARDS)) return false;
  const selected = new Set(selectedIds);
  return policy.selectedGuards.every((guard) =>
    SHA256.test(guard.descriptorDigest) &&
    hasUniqueBoundedKeys(guard.substitutes, 8) &&
    guard.substitutes.every((substitute) => selected.has(substitute) && substitute !== guard.capabilityId));
}

export function normalizeGuardSubject(rawSubject: string): string {
  const normalized = rawSubject
    .replace(/\\/gu, "/")
    .replace(/^\.\//u, "")
    .replace(/\/{2,}/gu, "/")
    .replace(/\/$/u, "");
  if (normalized.length < 1 || normalized.length > 512 || normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) || normalized.includes("\0") ||
    normalized.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
    throw new TypeError("Guard finding subject must be a normalized project-relative identity");
  }
  return normalized;
}

function findingRequirementClass(finding: GuardFinding): string {
  return finding.requirementId === null
    ? `evidence:${finding.evidenceClass}`
    : `requirement:${finding.requirementId}`;
}

export function guardFindingFingerprint(input: Readonly<{
  descriptorDigest: string;
  finding: GuardFinding;
}>): string {
  if (!SHA256.test(input.descriptorDigest)) throw new TypeError("Guard fingerprint requires a descriptor digest");
  const parsed = guardFindingSchema.parse(input.finding);
  const identity = [
    input.descriptorDigest,
    parsed.ruleId,
    normalizeGuardSubject(parsed.subject),
    findingRequirementClass(parsed),
  ];
  return createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex");
}

function compareFindings(left: AssessedGuardFinding, right: AssessedGuardFinding): number {
  const disposition = left.disposition === right.disposition ? 0 : left.disposition === "must_fix" ? -1 : 1;
  if (disposition !== 0) return disposition;
  if (left.capabilityId !== right.capabilityId) return left.capabilityId.localeCompare(right.capabilityId);
  if (left.subject !== right.subject) return left.subject.localeCompare(right.subject);
  if (left.ruleId !== right.ruleId) return left.ruleId.localeCompare(right.ruleId);
  return (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER);
}

export function assessGuardEnvelope(
  rawEnvelope: GuardResultEnvelope,
  policy: GuardAssessmentPolicy,
): GuardEnvelopeAssessment {
  if (!validPolicy(policy)) return blocked("guard assessment policy is invalid");
  const parsed = guardResultEnvelopeSchema.safeParse(rawEnvelope);
  if (!parsed.success) return blocked("guard result envelope is invalid");
  const envelope = parsed.data;
  if (envelope.profileId !== policy.profileId || envelope.profileRevision !== policy.profileRevision) {
    return blocked("guard result targets a different capability profile");
  }
  if (envelope.reviewedHeadSha !== policy.reviewedHeadSha) {
    return blocked("guard result targets a different head");
  }
  if (envelope.diffDigest !== policy.diffDigest) {
    return blocked("guard result targets a different diff");
  }

  const resultById = new Map<string, GuardTerminalResult>();
  for (const result of envelope.guards) {
    if (resultById.has(result.capabilityId)) {
      return blocked(`guard result contains duplicate ${result.capabilityId}`);
    }
    resultById.set(result.capabilityId, result);
  }
  if (resultById.size !== policy.selectedGuards.length) {
    return blocked("guard result does not contain exactly the selected guards");
  }
  for (const selected of policy.selectedGuards) {
    const result = resultById.get(selected.capabilityId);
    if (!result) return blocked(`guard result is missing ${selected.capabilityId}`);
    if (result.descriptorDigest !== selected.descriptorDigest) {
      return blocked(`guard result descriptor changed for ${selected.capabilityId}`);
    }
  }
  for (const capabilityId of resultById.keys()) {
    if (!policy.selectedGuards.some((guard) => guard.capabilityId === capabilityId)) {
      return blocked(`guard result contains unselected ${capabilityId}`);
    }
  }

  const requirementIds = new Set(policy.requirementIds);
  const substitutions: Array<{ capabilityId: string; substituteCapabilityId: string }> = [];
  const reasons: string[] = [];
  const findings: AssessedGuardFinding[] = [];
  const dispositionPolicy: FindingDispositionPolicy = {
    defaultDisposition: "advisory",
    mustFixRuleIds: policy.mustFixRuleIds,
    advisoryRuleIds: policy.advisoryRuleIds,
    requirementIds: policy.requirementIds,
  };
  let mandatoryFailure = false;
  let hasAdvisoryCondition = false;

  for (const selected of policy.selectedGuards) {
    const result = resultById.get(selected.capabilityId);
    if (!result) continue;
    if (result.outcome === "blocked" || result.outcome === "failed") {
      if (!selected.mandatory) {
        hasAdvisoryCondition = true;
        reasons.push(`optional guard ${selected.capabilityId} ${result.outcome}`);
        continue;
      }
      const substituteCapabilityId = selected.substitutes.find((candidate) => {
        const substitute = resultById.get(candidate);
        return substitute?.outcome === "passed" || substitute?.outcome === "findings";
      });
      if (substituteCapabilityId) {
        substitutions.push({ capabilityId: selected.capabilityId, substituteCapabilityId });
        reasons.push(`guard ${selected.capabilityId} used admitted substitute ${substituteCapabilityId}`);
        hasAdvisoryCondition = true;
      } else {
        mandatoryFailure = true;
        reasons.push(`mandatory guard ${selected.capabilityId} ${result.outcome}`);
      }
    }
    for (const finding of result.findings) {
      if (finding.requirementId !== null && !requirementIds.has(finding.requirementId)) {
        return blocked(`guard finding references unknown requirement ${finding.requirementId}`);
      }
      let subject: string;
      try {
        subject = normalizeGuardSubject(finding.subject);
      } catch {
        return blocked("guard finding subject is not project-relative");
      }
      const normalizedFinding = { ...finding, subject };
      const disposition = evaluateFindingDisposition(normalizedFinding, dispositionPolicy);
      if (disposition === null) return blocked(`guard finding references unknown requirement ${finding.requirementId}`);
      findings.push({
        ...normalizedFinding,
        capabilityId: selected.capabilityId,
        descriptorDigest: selected.descriptorDigest,
        disposition,
        fingerprint: guardFindingFingerprint({
          descriptorDigest: selected.descriptorDigest,
          finding: normalizedFinding,
        }),
      });
    }
  }

  findings.sort(compareFindings);
  if (mandatoryFailure) return { outcome: "blocked", reasons, findings, substitutions };
  if (findings.some((finding) => finding.disposition === "must_fix")) {
    return { outcome: "changes_requested", reasons, findings, substitutions };
  }
  if (findings.length > 0 || hasAdvisoryCondition) {
    return { outcome: "pass_with_advisories", reasons, findings, substitutions };
  }
  return { outcome: "pass", reasons: [], findings: [], substitutions: [] };
}

export function recordGuardFingerprint(input: Readonly<{
  repository: GuardFingerprintRepository;
  profileId: string;
  scopeId: string;
  capabilityId: string;
  descriptorDigest: string;
  finding: GuardFinding;
  now: number;
}>): Readonly<{
  fingerprint: string;
  occurrence: number;
  outcome: "remediate" | "blocked";
}> {
  const finding = guardFindingSchema.parse(input.finding);
  const subjectIdentity = normalizeGuardSubject(finding.subject);
  const fingerprint = guardFindingFingerprint({ descriptorDigest: input.descriptorDigest, finding });
  const occurrence = input.repository.recordGuardFingerprint({
    profileId: input.profileId,
    scopeId: input.scopeId,
    fingerprint,
    capabilityId: input.capabilityId,
    ruleId: finding.ruleId,
    subjectIdentity,
    requirementClass: findingRequirementClass(finding),
    now: input.now,
  });
  if (!Number.isSafeInteger(occurrence) || occurrence < 1 || occurrence > 3) {
    throw new TypeError("Guard fingerprint repository returned an invalid occurrence");
  }
  return {
    fingerprint,
    occurrence,
    outcome: occurrence === 3 ? "blocked" : "remediate",
  };
}

export function persistGuardEnvelopeSettlement(input: Readonly<{
  repository: GuardSettlementRepository;
  scopeId: string;
  envelope: GuardResultEnvelope;
  policy: GuardAssessmentPolicy;
  now: number;
}>): GuardEnvelopeAssessment {
  const envelope = guardResultEnvelopeSchema.parse(input.envelope);
  const policy = guardAssessmentPolicySchema.parse(input.policy);
  const assessment = assessGuardEnvelope(envelope, policy);
  const selectedById = new Map(policy.selectedGuards.map((guard) => [guard.capabilityId, guard]));
  if (envelope.profileId !== policy.profileId || envelope.profileRevision !== policy.profileRevision ||
    envelope.reviewedHeadSha !== policy.reviewedHeadSha || envelope.diffDigest !== policy.diffDigest ||
    envelope.guards.length !== policy.selectedGuards.length ||
    envelope.guards.some((guard) => selectedById.get(guard.capabilityId)?.descriptorDigest !== guard.descriptorDigest) ||
    new Set(envelope.guards.map((guard) => guard.capabilityId)).size !== envelope.guards.length) {
    return assessment;
  }

  const assessedByIdentity = new Map(assessment.findings.map((finding) => [
    `${finding.capabilityId}:${finding.fingerprint}`,
    finding,
  ]));
  const outcomes = envelope.guards.map((guard) => {
    const fingerprints = guard.findings.map((finding) => guardFindingFingerprint({
      descriptorDigest: guard.descriptorDigest,
      finding,
    }));
    const outputDigest = createHash("sha256")
      .update(JSON.stringify(guard), "utf8")
      .digest("hex");
    return {
      capabilityId: guard.capabilityId,
      descriptorDigest: guard.descriptorDigest,
      outcome: guard.outcome,
      evidenceRefs: [
        `diff:${envelope.diffDigest}`,
        ...fingerprints.map((fingerprint) => `finding:${fingerprint}`),
        `guard-output:${outputDigest}`,
        `head:${envelope.reviewedHeadSha}`,
      ].sort((left, right) => left.localeCompare(right)),
    };
  });
  const fingerprints = envelope.guards.flatMap((guard) => {
    const selected = selectedById.get(guard.capabilityId);
    if (!selected?.mandatory) return [];
    return guard.findings.flatMap((finding): GuardFingerprintPersistenceInput[] => {
      const fingerprint = guardFindingFingerprint({ descriptorDigest: guard.descriptorDigest, finding });
      if (assessedByIdentity.get(`${guard.capabilityId}:${fingerprint}`)?.disposition !== "must_fix") return [];
      return [{
        profileId: envelope.profileId,
        scopeId: input.scopeId,
        fingerprint,
        capabilityId: guard.capabilityId,
        ruleId: finding.ruleId,
        subjectIdentity: normalizeGuardSubject(finding.subject),
        requirementClass: findingRequirementClass(finding),
        now: input.now,
      }];
    });
  });
  const persisted = input.repository.settleGuardOutcomes({
    profileId: envelope.profileId,
    profileRevision: envelope.profileRevision,
    scopeId: input.scopeId,
    outcomes,
    fingerprints,
    now: input.now,
  });
  if (persisted.fingerprints.some((entry) => entry.occurrence >= 3)) {
    return {
      ...assessment,
      outcome: "blocked",
      reasons: [...assessment.reasons, "mandatory guard finding recurred for the third time"],
    };
  }
  return assessment;
}

export function persistBlockedGuardSettlement(input: Readonly<{
  repository: GuardSettlementRepository;
  scopeId: string;
  policy: GuardAssessmentPolicy;
  reasonCode: string;
  now: number;
}>): void {
  const policy = guardAssessmentPolicySchema.parse(input.policy);
  if (!BOUNDED_KEY.test(input.reasonCode)) throw new TypeError("Blocked guard settlement requires a reason code");
  const reasonDigest = createHash("sha256").update(input.reasonCode, "utf8").digest("hex");
  input.repository.settleGuardOutcomes({
    profileId: policy.profileId,
    profileRevision: policy.profileRevision,
    scopeId: input.scopeId,
    outcomes: policy.selectedGuards.map((guard) => ({
      capabilityId: guard.capabilityId,
      descriptorDigest: guard.descriptorDigest,
      outcome: "blocked" as const,
      evidenceRefs: [
        `diff:${policy.diffDigest}`,
        `guard-block:${reasonDigest}`,
        `head:${policy.reviewedHeadSha}`,
      ],
    })),
    fingerprints: [],
    now: input.now,
  });
}

function isTestPath(path: string): boolean {
  return /(^|\/)(?:tests?|__tests__)(\/|$)|\.(?:test|spec)\.[^.]+$/u.test(path.toLowerCase());
}

function isDocumentationPath(path: string): boolean {
  return /(^|\/)(?:readme|changelog)(?:\.|$)|(^|\/)docs?\/|\.(?:md|mdx|rst)$/u.test(path.toLowerCase());
}

export function requiredGuardsForChangeSurface(diff: string): readonly string[] {
  if (typeof diff !== "string" || Buffer.byteLength(diff, "utf8") > 2_000_000) {
    throw new TypeError("Guard change surface must be bounded text");
  }
  const guards = new Set<string>();
  for (const path of changedPathsFromGitDiff(diff)) {
    if (isTestPath(path)) guards.add("test-guard");
    else if (isDocumentationPath(path)) guards.add("docs-guard");
    else guards.add("clean-code-guard");
  }
  return [...guards].sort((left, right) => left.localeCompare(right));
}
