import { createHash } from "node:crypto";
import { capabilityDescriptorById } from "./catalog";
import type { CapabilityTerminalOutcome } from "./contracts";
import type { CapabilityProfile } from "../storage/capability-repository";
import type { TelegramAgentStore } from "../storage/store";
import { changedPathsFromGitDiff } from "./change-surface";

const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_TERMINAL_ID = /^[A-Za-z0-9_.:-]{1,256}$/u;

export type CapabilityCommandEvidence = Readonly<{
  commandSha256: string;
  outcome: "pass" | "fail" | "timed_out" | "aborted";
  terminalId?: string;
}>;

export type MandatoryCapabilitySettlement = Readonly<{
  satisfied: boolean;
  blockingCapabilities: readonly string[];
}>;

type CapabilityProof = Readonly<{
  capabilityId: string;
  outcome: CapabilityTerminalOutcome;
  reasonCode: string;
  evidenceRefs: readonly string[];
}>;

function changedPaths(diff: string | null): string[] {
  return diff === null ? [] : changedPathsFromGitDiff(diff);
}

function isTestPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return /(^|\/)(?:tests?|__tests__)(\/|$)|\.(?:test|spec)\.[^.]+$/u.test(normalized);
}

function isSkillPath(path: string): boolean {
  return /(^|\/)skills?\/|(^|\/)skill\.md$/iu.test(path);
}

function boundedEvidenceRefs(input: Readonly<{
  handoffSha256: string;
  diff: string | null;
  commands: readonly CapabilityCommandEvidence[];
  validationPolicy: Readonly<{ commandSha256s: readonly string[] }>;
}>): string[] {
  const refs = new Set<string>([
    `handoff:${input.handoffSha256}`,
    input.diff === null
      ? "diff:unavailable"
      : `diff:${createHash("sha256").update(input.diff, "utf8").digest("hex")}`,
  ]);
  for (const command of input.commands) {
    refs.add(`command:${command.commandSha256}:${command.outcome}`);
    if (command.terminalId && SAFE_TERMINAL_ID.test(command.terminalId)) refs.add(`terminal:${command.terminalId}`);
  }
  const policyDigest = createHash("sha256")
    .update(JSON.stringify(input.validationPolicy.commandSha256s), "utf8")
    .digest("hex");
  refs.add(`validation-policy:${policyDigest}`);
  if (input.validationPolicy.commandSha256s.length === 0) refs.add("validation:skipped-by-policy");
  return [...refs].sort((left, right) => left.localeCompare(right)).slice(0, 64);
}

function validateEvidenceInput(input: Readonly<{
  handoffSha256: string;
  commands: readonly CapabilityCommandEvidence[];
  validationPolicy: Readonly<{ commandSha256s: readonly string[] }>;
}>): void {
  if (!SHA256.test(input.handoffSha256)) throw new TypeError("Capability evidence requires a handoff SHA-256");
  if (input.commands.length > 20) throw new TypeError("Capability command evidence exceeds its bounded limit");
  if (!input.validationPolicy || input.validationPolicy.commandSha256s.length > 20 ||
    input.validationPolicy.commandSha256s.some((digest) => !SHA256.test(digest))) {
    throw new TypeError("Capability validation policy evidence is invalid");
  }
  for (const command of input.commands) {
    if (!SHA256.test(command.commandSha256)) throw new TypeError("Capability command evidence requires a SHA-256");
    if (command.terminalId !== undefined && !SAFE_TERMINAL_ID.test(command.terminalId)) {
      throw new TypeError("Capability command evidence has an invalid terminal id");
    }
  }
}

function requireCurrentProfile(store: TelegramAgentStore, profileId: string): CapabilityProfile {
  const profile = store.getCapabilityProfileById(profileId);
  if (!profile) throw new TypeError(`Unknown capability profile ${profileId}`);
  for (const assignment of profile.assignments) {
    const descriptor = capabilityDescriptorById(assignment.capabilityId, assignment.descriptorDigest);
    if (!descriptor || descriptor.digest !== assignment.descriptorDigest || descriptor.kind !== assignment.capabilityKind) {
      throw new TypeError(`Capability profile ${profileId} contains a stale assignment`);
    }
  }
  return profile;
}

function persistProofs(
  store: TelegramAgentStore,
  profile: CapabilityProfile,
  proofs: readonly CapabilityProof[],
  now: number,
): MandatoryCapabilitySettlement {
  const existing = store.listCapabilityReceipts(profile.id, 256)
    .filter((receipt) => receipt.eventType === "outcome");
  const existingByCapability = new Map(existing.map((receipt) => [receipt.capabilityId, receipt]));
  for (const proof of proofs) {
    const prior = existingByCapability.get(proof.capabilityId);
    if (prior) {
      if (prior.outcome !== proof.outcome || JSON.stringify(prior.evidenceRefs) !== JSON.stringify(proof.evidenceRefs)) {
        throw new TypeError(`Capability outcome replay changed for ${proof.capabilityId}`);
      }
      continue;
    }
    store.appendCapabilityTerminalOutcome({
      profileId: profile.id,
      capabilityId: proof.capabilityId,
      outcome: proof.outcome,
      evidenceRefs: [...proof.evidenceRefs],
      reasonCode: proof.reasonCode,
      now,
    });
  }
  const finalOutcomes = store.listCapabilityReceipts(profile.id, 256)
    .filter((receipt) => receipt.eventType === "outcome");
  const finalByCapability = new Map(finalOutcomes.map((receipt) => [receipt.capabilityId, receipt.outcome]));
  const blockingCapabilities = profile.assignments
    .filter((assignment) => assignment.mandatory && finalByCapability.get(assignment.capabilityId) !== "passed")
    .map((assignment) => assignment.capabilityId)
    .sort((left, right) => left.localeCompare(right));
  return { satisfied: blockingCapabilities.length === 0, blockingCapabilities };
}

export function recordImplementationCapabilityOutcomes(input: Readonly<{
  store: TelegramAgentStore;
  profileId: string;
  handoffSha256: string;
  diff: string | null;
  commands: readonly CapabilityCommandEvidence[];
  validationPolicy: Readonly<{ commandSha256s: readonly string[] }>;
  now: number;
}>): MandatoryCapabilitySettlement {
  validateEvidenceInput(input);
  const profile = requireCurrentProfile(input.store, input.profileId);
  const paths = changedPaths(input.diff);
  const commandIdentityMatches = JSON.stringify(input.commands.map((command) => command.commandSha256)) ===
    JSON.stringify(input.validationPolicy.commandSha256s);
  const policySkipsValidation = input.validationPolicy.commandSha256s.length === 0;
  const allCommandsPassed = commandIdentityMatches &&
    (policySkipsValidation || input.commands.every((command) => command.outcome === "pass"));
  const hasChangedTest = paths.some(isTestPath);
  const hasChangedSkill = paths.some(isSkillPath);
  const evidenceRefs = boundedEvidenceRefs(input);
  const proofs = profile.assignments
    .filter((assignment) => assignment.mandatory)
    .map((assignment): CapabilityProof => {
      const passed = assignment.capabilityId === "test-driven-development"
        ? allCommandsPassed && hasChangedTest
        : assignment.capabilityId === "verification-before-completion"
          ? allCommandsPassed
          : assignment.capabilityId === "writing-skills"
            ? allCommandsPassed && hasChangedSkill
            : false;
      return {
        capabilityId: assignment.capabilityId,
        outcome: passed ? "passed" : "blocked",
        reasonCode: passed && policySkipsValidation && assignment.capabilityId === "verification-before-completion"
          ? "verification_skipped_by_policy"
          : passed ? "observed_evidence_passed" : "observed_evidence_missing",
        evidenceRefs,
      };
    });
  return persistProofs(input.store, profile, proofs, input.now);
}

export function recordDocumentationCapabilityOutcomes(input: Readonly<{
  store: TelegramAgentStore;
  profileId: string;
  reportSha256: string;
  report: Readonly<{
    disposition: "changed" | "skipped";
    files: readonly string[];
    checks: readonly string[];
  }>;
  observation: Readonly<{ clean: boolean; diff: string | null }>;
  now: number;
}>): MandatoryCapabilitySettlement {
  if (!SHA256.test(input.reportSha256)) throw new TypeError("Documentation evidence requires a report SHA-256");
  if (input.report.files.length > 50 || input.report.checks.length > 50) {
    throw new TypeError("Documentation evidence exceeds its bounded limit");
  }
  const profile = requireCurrentProfile(input.store, input.profileId);
  const observedPaths = changedPaths(input.observation.diff);
  const listedPaths = [...new Set(input.report.files)].sort((left, right) => left.localeCompare(right));
  const exactChangedReport = input.report.disposition === "changed" &&
    input.observation.diff !== null && !input.observation.clean && input.report.checks.length > 0 &&
    listedPaths.length === input.report.files.length &&
    JSON.stringify(listedPaths) === JSON.stringify(observedPaths);
  const exactNoOpReport = input.report.disposition === "skipped" && input.observation.clean &&
    input.observation.diff !== null && input.observation.diff.trim().length === 0 &&
    input.report.files.length === 0 && input.report.checks.length === 0;
  const passed = exactChangedReport || exactNoOpReport;
  const evidenceRefs = new Set<string>([
    `docs-report:${input.reportSha256}`,
    input.observation.diff === null
      ? "diff:unavailable"
      : `diff:${createHash("sha256").update(input.observation.diff, "utf8").digest("hex")}`,
    `docs-disposition:${input.report.disposition}`,
  ]);
  for (const check of input.report.checks) {
    evidenceRefs.add(`check:${createHash("sha256").update(check, "utf8").digest("hex")}`);
  }
  const boundedRefs = [...evidenceRefs].sort((left, right) => left.localeCompare(right)).slice(0, 64);
  const proofs = profile.assignments
    .filter((assignment) => assignment.mandatory)
    .map((assignment): CapabilityProof => ({
      capabilityId: assignment.capabilityId,
      outcome: passed && ["docs-guard", "verification-before-completion"].includes(assignment.capabilityId)
        ? "passed"
        : "blocked",
      reasonCode: passed ? "strict_docs_evidence_passed" : "strict_docs_evidence_missing",
      evidenceRefs: boundedRefs,
    }));
  return persistProofs(input.store, profile, proofs, input.now);
}
