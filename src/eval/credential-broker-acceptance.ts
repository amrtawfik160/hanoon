/**
 * Versioned acceptance contract for the Hanoon credential broker foundation.
 *
 * `evals/credential-broker-cases.json` is the fixed catalog of what must be
 * proven (schema version 1). A separate, uncommitted report — recorded by
 * `scripts/record-credential-broker-acceptance.mjs` during a real disposable
 * run — claims a result for each cataloged case. This module defines both
 * shapes and the one aggregation rule that turns per-case results into one
 * overall status: `passed` only when every mandatory case is passed and
 * cleaned, and every case that another case's red-state proof depends on is
 * itself passed and cleaned too. Nothing here executes a broker, provider, or
 * BB operation — it only validates already-recorded, secret-free claims.
 */
import { z } from "zod";

export const CREDENTIAL_ACCEPTANCE_SCHEMA_VERSION = 1 as const;

export const CREDENTIAL_ACCEPTANCE_CASE_CATEGORIES = [
  "deterministic",
  "contract",
  "live",
  "red_state",
] as const;
export type CredentialAcceptanceCaseCategory = (typeof CREDENTIAL_ACCEPTANCE_CASE_CATEGORIES)[number];

export const CREDENTIAL_ACCEPTANCE_STATUSES = ["passed", "failed", "incomplete"] as const;
export type CredentialAcceptanceStatus = (typeof CREDENTIAL_ACCEPTANCE_STATUSES)[number];

export const CREDENTIAL_ACCEPTANCE_CLEANUP_STATUSES = ["not_applicable", "pending", "complete"] as const;
export type CredentialAcceptanceCleanupStatus = (typeof CREDENTIAL_ACCEPTANCE_CLEANUP_STATUSES)[number];

const unique = (entries: readonly string[]): boolean => new Set(entries).size === entries.length;

/**
 * Deliberately conservative: this gates evidence text that ships in an
 * acceptance report, not general prose, so a false positive only means an
 * operator picks a less alarming opaque id — cheap — while a false negative
 * would let a secret ship inside a report committed nowhere near a vault.
 */
const SECRET_SHAPED_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]+-----/,
  /\bop:\/\/[A-Za-z0-9_-]+\//i,
  /\bbearer\s+\S+/i,
  /\b(?:api[_-]?key|password|secret|token|credential|clientkey|client_key)\s*[:=]\s*\S+/i,
  /\b(?:sk|rk)-[A-Za-z0-9_-]{10,}\b/i,
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
];

export function isSecretShapedText(value: string): boolean {
  return SECRET_SHAPED_PATTERNS.some((pattern) => pattern.test(value));
}

const caseIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(80);

function safeText(min: number, max: number) {
  return z.string().trim().min(min).max(max).refine(
    (value) => !isSecretShapedText(value),
    "value must not resemble a secret, vault reference, PEM, or token",
  );
}

const evidenceRefSchema = safeText(1, 256);
const disposableResourceIdSchema = safeText(1, 128);

export const credentialAcceptanceCaseDefinitionSchema = z.object({
  id: caseIdSchema,
  category: z.enum(CREDENTIAL_ACCEPTANCE_CASE_CATEGORIES),
  mandatory: z.boolean(),
  title: safeText(1, 140),
  expectedResult: safeText(1, 200),
  /** Set only on a `red_state` case: the id of the case whose fail-closed guarantee it adversarially proves. */
  provesAgainstCaseId: caseIdSchema.nullable(),
}).strict();
export type CredentialAcceptanceCaseDefinition = z.infer<typeof credentialAcceptanceCaseDefinitionSchema>;

export const credentialAcceptanceCaseCorpusSchema = z.object({
  schemaVersion: z.literal(1),
  cases: z.array(credentialAcceptanceCaseDefinitionSchema).min(1).max(128),
}).strict().superRefine((candidate, context) => {
  const ids = candidate.cases.map((c) => c.id);
  if (!unique(ids)) context.addIssue({ code: "custom", message: "case ids must be unique" });
  const idSet = new Set(ids);
  for (const [index, definition] of candidate.cases.entries()) {
    const isRedState = definition.category === "red_state";
    if (isRedState && definition.provesAgainstCaseId === null) {
      context.addIssue({
        code: "custom",
        path: ["cases", index, "provesAgainstCaseId"],
        message: "a red_state case must set provesAgainstCaseId",
      });
    }
    if (isRedState && definition.provesAgainstCaseId !== null && !idSet.has(definition.provesAgainstCaseId)) {
      context.addIssue({
        code: "custom",
        path: ["cases", index, "provesAgainstCaseId"],
        message: "provesAgainstCaseId must name a case defined in this corpus",
      });
    }
    if (!isRedState && definition.provesAgainstCaseId !== null) {
      context.addIssue({
        code: "custom",
        path: ["cases", index, "provesAgainstCaseId"],
        message: "only a red_state case may set provesAgainstCaseId",
      });
    }
  }
});
export type CredentialAcceptanceCaseCorpus = z.infer<typeof credentialAcceptanceCaseCorpusSchema>;

export function parseCredentialAcceptanceCaseCorpus(candidate: unknown): CredentialAcceptanceCaseCorpus {
  return credentialAcceptanceCaseCorpusSchema.parse(candidate);
}

export const credentialAcceptanceCaseResultSchema = z.object({
  id: caseIdSchema,
  status: z.enum(CREDENTIAL_ACCEPTANCE_STATUSES),
  cleanupStatus: z.enum(CREDENTIAL_ACCEPTANCE_CLEANUP_STATUSES),
  procedureRevision: z.number().int().min(1).max(10_000),
  startedAt: z.number().int().min(0).nullable(),
  completedAt: z.number().int().min(0).nullable(),
  actor: safeText(1, 120).nullable(),
  reviewer: safeText(1, 120).nullable(),
  actualResult: safeText(1, 200).nullable(),
  evidenceRefs: z.array(evidenceRefSchema).max(32),
  disposableResourceIds: z.array(disposableResourceIdSchema).max(32),
}).strict().superRefine((entry, context) => {
  if (entry.startedAt !== null && entry.completedAt !== null && entry.completedAt < entry.startedAt) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "completedAt must not precede startedAt" });
  }
  if (entry.status !== "incomplete") {
    if (entry.startedAt === null) context.addIssue({ code: "custom", path: ["startedAt"], message: "an executed case requires startedAt" });
    if (entry.completedAt === null) context.addIssue({ code: "custom", path: ["completedAt"], message: "an executed case requires completedAt" });
    if (entry.actor === null) context.addIssue({ code: "custom", path: ["actor"], message: "an executed case requires actor" });
    if (entry.reviewer === null) context.addIssue({ code: "custom", path: ["reviewer"], message: "an executed case requires reviewer" });
    if (entry.actualResult === null) context.addIssue({ code: "custom", path: ["actualResult"], message: "an executed case requires actualResult" });
    if (entry.evidenceRefs.length === 0) context.addIssue({ code: "custom", path: ["evidenceRefs"], message: "an executed case requires at least one evidence reference" });
  }
  if (entry.status === "passed" && !isCredentialAcceptanceCaseCleaned(entry)) {
    context.addIssue({ code: "custom", path: ["cleanupStatus"], message: "a passed case must be cleaned before it can count" });
  }
});
export type CredentialAcceptanceCaseResult = z.infer<typeof credentialAcceptanceCaseResultSchema>;

/** A case counts as cleaned when it is explicitly closed out, or when it never touched a disposable resource in the first place. */
export function isCredentialAcceptanceCaseCleaned(entry: Pick<CredentialAcceptanceCaseResult, "cleanupStatus" | "disposableResourceIds">): boolean {
  if (entry.cleanupStatus === "complete") return true;
  return entry.cleanupStatus === "not_applicable" && entry.disposableResourceIds.length === 0;
}

export const credentialAcceptanceReportSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.number().int().min(0),
  status: z.enum(CREDENTIAL_ACCEPTANCE_STATUSES),
  cases: z.array(credentialAcceptanceCaseResultSchema).min(1).max(128),
}).strict().superRefine((report, context) => {
  if (!unique(report.cases.map((c) => c.id))) {
    context.addIssue({ code: "custom", path: ["cases"], message: "duplicate case id in report" });
  }
});
export type CredentialAcceptanceReport = z.infer<typeof credentialAcceptanceReportSchema>;

export type CredentialAcceptanceEvaluation = Readonly<{
  status: CredentialAcceptanceStatus;
  /** Mandatory corpus case ids absent from the report entirely. */
  missingCaseIds: readonly string[];
  /** Report case ids the corpus does not define. */
  unknownCaseIds: readonly string[];
  /** Mandatory corpus case ids present but not passed-and-cleaned. */
  unmetMandatoryIds: readonly string[];
  /** Red-state case ids that some other case's proof depends on, and that are themselves absent or not passed-and-cleaned. */
  missingCounterpartIds: readonly string[];
}>;

function passedAndCleaned(entry: CredentialAcceptanceCaseResult | undefined): boolean {
  return entry !== undefined && entry.status === "passed" && isCredentialAcceptanceCaseCleaned(entry);
}

/**
 * Recomputes the one true aggregate status from a corpus and a set of
 * per-case results. A hand-edited `status: "passed"` in a report file carries
 * no weight on its own — `parseCredentialAcceptanceReport` always recomputes
 * this and rejects a report whose declared status disagrees.
 */
export function evaluateCredentialAcceptanceReport(input: Readonly<{
  corpus: CredentialAcceptanceCaseCorpus;
  cases: readonly CredentialAcceptanceCaseResult[];
}>): CredentialAcceptanceEvaluation {
  const byId = new Map(input.cases.map((entry) => [entry.id, entry]));
  const corpusIds = new Set(input.corpus.cases.map((c) => c.id));

  const missingCaseIds = input.corpus.cases
    .filter((definition) => definition.mandatory && !byId.has(definition.id))
    .map((definition) => definition.id);
  const unknownCaseIds = input.cases
    .map((entry) => entry.id)
    .filter((id) => !corpusIds.has(id));
  const unmetMandatoryIds = input.corpus.cases
    .filter((definition) => definition.mandatory && byId.has(definition.id))
    .filter((definition) => !passedAndCleaned(byId.get(definition.id)))
    .map((definition) => definition.id);

  const counterpartsByTarget = new Map<string, CredentialAcceptanceCaseDefinition[]>();
  for (const definition of input.corpus.cases) {
    if (definition.category !== "red_state" || definition.provesAgainstCaseId === null) continue;
    const list = counterpartsByTarget.get(definition.provesAgainstCaseId) ?? [];
    list.push(definition);
    counterpartsByTarget.set(definition.provesAgainstCaseId, list);
  }
  const missingCounterpartIds = [...counterpartsByTarget.values()]
    .flat()
    .filter((counterpart) => !passedAndCleaned(byId.get(counterpart.id)))
    .map((counterpart) => counterpart.id);

  const hasFailure = unknownCaseIds.length > 0 ||
    input.cases.some((entry) => entry.status === "failed" && corpusIds.has(entry.id));
  const isIncomplete = missingCaseIds.length > 0 || unmetMandatoryIds.length > 0 || missingCounterpartIds.length > 0;

  const status: CredentialAcceptanceStatus = hasFailure ? "failed" : isIncomplete ? "incomplete" : "passed";
  return Object.freeze({
    status,
    missingCaseIds: Object.freeze(missingCaseIds),
    unknownCaseIds: Object.freeze(unknownCaseIds),
    unmetMandatoryIds: Object.freeze(unmetMandatoryIds),
    missingCounterpartIds: Object.freeze(missingCounterpartIds),
  });
}

/**
 * Parses a candidate report against a fixed corpus, cross-checks every case
 * id, and requires the declared aggregate status to equal the recomputed one
 * — the one place a hand-edited "passed" is caught rather than trusted.
 */
export function parseCredentialAcceptanceReport(
  candidate: unknown,
  corpus: CredentialAcceptanceCaseCorpus,
): CredentialAcceptanceReport {
  const report = credentialAcceptanceReportSchema.parse(candidate);
  const corpusIds = new Set(corpus.cases.map((c) => c.id));
  const unknown = report.cases.map((entry) => entry.id).filter((id) => !corpusIds.has(id));
  if (unknown.length > 0) {
    throw new Error(`credential acceptance report names unknown case id(s): ${unknown.join(", ")}`);
  }
  const evaluation = evaluateCredentialAcceptanceReport({ corpus, cases: report.cases });
  if (evaluation.status !== report.status) {
    throw new Error(
      `credential acceptance report status "${report.status}" does not match the recomputed status "${evaluation.status}"`,
    );
  }
  return report;
}

/** One `incomplete`, unexecuted result per corpus case — what `record ... init` writes before any real work happens. */
export function buildIncompleteCredentialAcceptanceReport(
  corpus: CredentialAcceptanceCaseCorpus,
  generatedAt: number,
): CredentialAcceptanceReport {
  const cases: CredentialAcceptanceCaseResult[] = corpus.cases.map((definition) => ({
    id: definition.id,
    status: "incomplete",
    cleanupStatus: "not_applicable",
    procedureRevision: 1,
    startedAt: null,
    completedAt: null,
    actor: null,
    reviewer: null,
    actualResult: null,
    evidenceRefs: [],
    disposableResourceIds: [],
  }));
  return credentialAcceptanceReportSchema.parse({
    schemaVersion: CREDENTIAL_ACCEPTANCE_SCHEMA_VERSION,
    generatedAt,
    status: evaluateCredentialAcceptanceReport({ corpus, cases }).status,
    cases,
  });
}
