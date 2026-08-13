import { z } from "zod";
import { CONTROLLER_PROOF_KINDS, type ControllerProofKind } from "./models";
import { canonicalControllerText } from "./questions";

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
  "invocation_in_flight",
  "process_only",
  "high_impact_text_unclaimed",
] as const;

export type ControllerClaimKind = (typeof CONTROLLER_CLAIM_KINDS)[number];
export type FinalizationRejectionCode = (typeof FINALIZATION_REJECTION_CODES)[number];
export type PersistedFinalizationRejectionCode = Exclude<
  FinalizationRejectionCode,
  "accepted_already" | "revision_limit"
>;
type EvidenceRef = `evidence:${number}`;

const boundedSegmentText = z.string().refine(
  (text) => Array.from(text).length <= 4_000,
  "segment text must be at most 4000 characters",
).refine(
  (text) => text.trim().length > 0,
  "segment text must be nonempty",
);
const boundedSubjectRef = z.string().min(1).max(256);
const evidenceRefSchema = z.string().regex(/^evidence:[1-9][0-9]*$/) as z.ZodType<EvidenceRef>;
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

export const controllerFinalizationJsonSchema = Object.freeze(
  z.toJSONSchema(controllerFinalizationSchema),
);

export type ControllerFinalization = z.infer<typeof controllerFinalizationSchema>;
type ControllerClaim = Extract<ControllerFinalization["segments"][number], { type: "claim" }>;

export type ControllerFinalizationValidationContext = Readonly<{
  acceptedAlready: boolean;
  invocationInFlight: boolean;
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
  invocation_in_flight: "Wait for the current mutating capability invocation to settle before finalizing.",
  process_only: "Replace process intent with a direct answer or durable deferred obligation.",
  high_impact_text_unclaimed: "Move high-impact success assertions into evidence-backed claim segments.",
};

export function controllerFinalizationCorrection(code: FinalizationRejectionCode): string {
  return CORRECTIONS[code];
}

const PROCESS_OBJECT_WORD = "(?!(?:and|then|if)\\b)[a-z0-9_'/:-]+";
const PROCESS_ACTION = `(?:check|look(?:\\s+into)?|investigat(?:e|ing)|work(?:ing)?\\s+on|try|take\\s+care\\s+of|handle|get\\s+back(?:\\s+to\\s+you)?|follow\\s+up)(?:\\s+${PROCESS_OBJECT_WORD}){0,12}`;
const PROCESS_CLAUSE = new RegExp(
  `^(?:(?:i(?:'ll| will| am|'m)|let me)\\s+)?${PROCESS_ACTION}[.!]?$`,
  "i",
);
const GENERIC_PROCESS_COMMITMENT = /^(?:(?:i(?:'ll| will| am|'m)|we(?:'ll| will| are|'re)|let me)\s+)[a-z][a-z'-]*(?:\s+[a-z0-9_'/:-]+){0,16}[.!]?$/i;
const PROCESS_STATUS_CLAUSE = /^(?:the\s+)?(?:work|task|job|operation)\s+(?:is|remains?)\s+(?:in\s+progress|underway|ongoing)[.!]?$/i;
const FOLLOW_UP_OBJECT_WORD = "[a-z0-9_'/:-]+";
const CONCRETE_FOLLOW_UP = new RegExp(
  `\\b(?:get\\s+back\\s+to\\s+you|follow\\s+up)\\s+(?:with|when|after|once)\\s+${FOLLOW_UP_OBJECT_WORD}(?:\\s+${FOLLOW_UP_OBJECT_WORD}){0,11}\\b`,
  "i",
);
const CONTROLLER_COMMITMENT = /(?:^|[,;]\s*)(?:i(?:'ll| will)|let me)\b/i;
const NON_AFFIRMATIVE_FOLLOW_UP = /\?\s*$|\bif\b|\b(?:not|never|may|might|maybe|possibly|probably|appears?|seems?|uncertain|unsure)\b|\b(?:won't|can't|couldn't|shouldn't|wouldn't)\b/i;
const DOMAIN_OBJECT = "(?:files?|records?|data|resources?|jobs?|monitors?|projects?|worktrees?|directories|branches|deployments?|credentials?|secrets?)";
const INSTALL_OBJECT = "(?:packages?|dependencies|plugins?|skills?|software|tools?|services?|extensions?)";
const PURCHASE_OBJECT = "(?:packages?|dependencies|plugins?|skills?|software|tools?|services?|extensions?|deployments?|resources?)";
const MONEY_AMOUNT = "(?:[$€£]\\s*[0-9]+|(?:usd|eur|gbp)\\s+[0-9]+|(?:[a-z]+\\s+){0,3}(?:dollars?|euros?|pounds?))";
const PASSIVE_AUXILIARY = "(?:is|are|was|were|has\\s+been|have\\s+been|had\\s+been)";
const CREDENTIAL_OBJECT = "(?:credentials?|passwords?|secrets?|tokens?|api[_ -]?keys?)";
const NON_SUCCESS_CLAUSE = [
  /\?\s*$/,
  /\b(?:not|never|no longer|cannot|can't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|won't|wouldn't|couldn't|shouldn't)\b/i,
  /\b(?:failed|failure|unsuccessful|denied|interrupted)\b/i,
  /\b(?:will|would|could|should|plan to|intend to|propose|after approval|later)\b/i,
  /\b(?:may|might|maybe|uncertain|unsure|possibly|probably|appears?|seems?)\b/i,
];
const OPERATIONAL_DEFAULT_IGNORABLES = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\ufe00-\ufe0f\ufe20-\ufe2f\uffa0]/gu;
type OperationalAssertion = Readonly<{
  pattern: RegExp;
  kinds: readonly ControllerClaimKind[];
}>;

const OPERATIONAL_SUCCESS_STATE = "(?:done|complete|completed|finished|successful|succeeded|passed|green|live|healthy|verified|ready|all\\s+set)";
const OPERATIONAL_STATE_LINK = "(?:is|are|was|were|has\\s+been|have\\s+been|had\\s+been)?";
const GENERIC_COMPLETION_SUBJECT = "(?:everything|all(?:\\s+(?:the\\s+)?(?:work|tasks?|items?))?|the\\s+(?:work|task|job|operation))";

/**
 * The same bounded assertion table drives both sides of the contract: a
 * sentence is blocked when it is plain text, and a claim must use a kind and
 * successful evidence that are entitled to carry the matched wording. The
 * patterns describe operational grammar rather than whole-message whitelist
 * strings, so ordinary prose remains expressive while paraphrased success
 * wording is still attached to typed evidence.
 */
const OPERATIONAL_ASSERTIONS: readonly OperationalAssertion[] = [
  {
    pattern: /\b(?:implemented|fixed|repaired|resolved|addressed|handled|changed|updated|modified)\b/i,
    kinds: ["workspace_change"],
  },
  {
    pattern: /\b(?:built|compiled|tested|verified|validated|executed)\b/i,
    kinds: ["execution_result"],
  },
  {
    pattern: /\b(?:shipped|deployed|released|rolled\s+out|merged|published|promoted|provisioned|configured|enabled|activated|launched|landed)\b/i,
    kinds: ["external_mutation", "pipeline_outcome"],
  },
  {
    pattern: /\b(?:done|complete|completed|finished|successful|succeeded|passed|green|live|resolved|wrapped\s+up|good\s+to\s+go|went\s+smoothly|cleared\s+(?:its|the)\s+(?:final\s+)?gate)\b/i,
    kinds: ["pipeline_outcome"],
  },
  {
    pattern: /\b(?:the\s+)?(?:agent|system|service|health(?:\s+check)?|monitoring)\s+(?:is|was|has\s+been|had\s+been)?\s*(?:healthy|ready|good\s+to\s+go)\b/i,
    kinds: ["health_assessment"],
  },
  {
    pattern: /\b(?:i|we)\s+(?:have\s+)?(?:implemented|fixed|shipped)\b/i,
    kinds: ["workspace_change"],
  },
  {
    pattern: /\b(?:the\s+)?(?:fix|change|feature|implementation|code)\s+(?:is|was|has been|had been)\s+(?:implemented|fixed|shipped|complete|completed)\b/i,
    kinds: ["workspace_change"],
  },
  {
    pattern: /\b(?:the\s+)?tests?(?:\s+suite)?\s+(?:is|are|was|were|has been|have been|had been)?\s*(?:passed|succeeded|completed)\b/i,
    kinds: ["execution_result"],
  },
  {
    pattern: /\b(?:all\s+)?tests?(?:\s+suite)?\s+(?:pass|passed|succeed|succeeded|complete|completed)\b/i,
    kinds: ["execution_result"],
  },
  {
    pattern: /\b(?:the\s+)?review\s+(?:is|was|has been|had been)?\s*(?:complete|completed|passed|approved)\b/i,
    kinds: ["pipeline_outcome"],
  },
  {
    pattern: /\b(?:i|we)\s+(?:have\s+)?(?:approved|completed)\s+(?:the\s+)?review\b/i,
    kinds: ["pipeline_outcome"],
  },
  {
    pattern: /\b(?:i|we)\s+(?:have\s+)?merged\s+(?:the\s+)?(?:branch|pull request|change)\b/i,
    kinds: ["pipeline_outcome"],
  },
  {
    pattern: /\b(?:the\s+)?(?:branch|pull request|change)\s+(?:is|was|has been|had been)\s+merged\b/i,
    kinds: ["pipeline_outcome"],
  },
  {
    pattern: /\b(?:i|we)\s+(?:have\s+)?deployed\s+(?:the\s+)?(?:[a-z]+\s+){0,3}(?:service|deployment|production)\b/i,
    kinds: ["pipeline_outcome"],
  },
  {
    pattern: /\b(?:the\s+)?(?:service|deployment|production)\s+(?:is|was|has been|had been)\s+(?:deployed|live|healthy|verified)\b/i,
    kinds: ["pipeline_outcome"],
  },
  {
    pattern: new RegExp("\\b(?:i|we)\\s+(?:have\\s+)?(?:deleted|removed|purged)\\s+(?:the\\s+)?(?:[a-z]+\\s+){0,3}" + DOMAIN_OBJECT + "\\b", "i"),
    kinds: ["workspace_change", "external_mutation"],
  },
  {
    pattern: new RegExp("\\b(?:the\\s+)?" + DOMAIN_OBJECT + "\\s+" + PASSIVE_AUXILIARY + "\\s+(?:deleted|removed|purged)\\b", "i"),
    kinds: ["workspace_change", "external_mutation"],
  },
  {
    pattern: new RegExp("\\b(?:i|we)\\s+(?:have\\s+)?installed\\s+(?:the\\s+)?(?:[a-z]+\\s+){0,2}" + INSTALL_OBJECT + "\\b", "i"),
    kinds: ["workspace_change", "external_mutation"],
  },
  {
    pattern: new RegExp("\\b(?:the\\s+)?" + INSTALL_OBJECT + "\\s+" + PASSIVE_AUXILIARY + "\\s+installed\\b", "i"),
    kinds: ["workspace_change", "external_mutation"],
  },
  {
    pattern: new RegExp("\\b(?:i|we)\\s+(?:have\\s+)?(?:rotated|updated|created|issued|changed)\\s+(?:the\\s+)?" + CREDENTIAL_OBJECT + "\\b", "i"),
    kinds: ["external_mutation"],
  },
  {
    pattern: new RegExp("\\b(?:the\\s+)?" + CREDENTIAL_OBJECT + "\\s+" + PASSIVE_AUXILIARY + "\\s+(?:rotated|updated|created|issued|changed)\\b", "i"),
    kinds: ["external_mutation"],
  },
  {
    pattern: new RegExp("\\b(?:i|we)\\s+(?:have\\s+)?(?:spent|paid)\\s+" + MONEY_AMOUNT + "\\b", "i"),
    kinds: ["external_mutation"],
  },
  {
    pattern: new RegExp("\\b" + MONEY_AMOUNT + "\\s+" + PASSIVE_AUXILIARY + "\\s+(?:spent|paid)\\b", "i"),
    kinds: ["external_mutation"],
  },
  {
    pattern: new RegExp("\\b(?:i|we)\\s+(?:have\\s+)?purchased\\s+(?:the\\s+)?(?:[a-z]+\\s+){0,2}" + PURCHASE_OBJECT + "\\b", "i"),
    kinds: ["external_mutation"],
  },
  {
    pattern: /\b(?:the\s+)?(?:deployment|release)\s+(?:succeeded|passed|completed|finished)\b/i,
    kinds: ["pipeline_outcome"],
  },
  {
    pattern: /\b(?:the\s+)?(?:thread|job)(?:\s+[a-z][a-z0-9_-]*){0,3}\s+(?:succeeded|completed|finished|passed)\b/i,
    kinds: ["observed_state"],
  },
  {
    pattern: new RegExp("\\b(?:i|we)\\s+(?:have\\s+)?(?:started|stopped|restarted|retried|cancelled|canceled|resumed|paused|queued|created|deleted|removed)\\s+(?:the\\s+)?(?:thread|job)\\b", "i"),
    kinds: ["external_mutation"],
  },
  {
    pattern: new RegExp("\\b(?:i|we)\\s+(?:have\\s+)?(?:sent|posted|delivered)\\s+(?:a\\s+)?(?:message|request|instruction)\\s+to\\s+(?:the\\s+)?(?:thread|job)\\b", "i"),
    kinds: ["external_mutation"],
  },
  {
    pattern: /\b(?:the\s+)?(?:thread|job)\s+(?:is|was|has been|had been)\s+(?:started|stopped|restarted|retried|cancelled|canceled|resumed|paused|queued|created|deleted|removed)\b/i,
    kinds: ["external_mutation"],
  },
  {
    pattern: new RegExp("\\b" + GENERIC_COMPLETION_SUBJECT + "\\s+" + OPERATIONAL_STATE_LINK + "\\s*" + OPERATIONAL_SUCCESS_STATE + "\\b", "i"),
    kinds: ["pipeline_outcome"],
  },
  {
    pattern: new RegExp("\\b(?:the\\s+)?(?:build|compile|compilation|artifact)\\s+" + OPERATIONAL_STATE_LINK + "\\s*" + OPERATIONAL_SUCCESS_STATE + "\\b", "i"),
    kinds: ["execution_result"],
  },
  {
    pattern: new RegExp("\\b(?:ci|continuous integration|pipeline)\\s+" + OPERATIONAL_STATE_LINK + "\\s*(?:green|successful|succeeded|passed|complete|completed|finished)\\b", "i"),
    kinds: ["pipeline_outcome"],
  },
  {
    pattern: new RegExp("\\b(?:the\\s+)?checks?\\s+" + OPERATIONAL_STATE_LINK + "\\s*(?:green|successful|succeeded|passed|complete|completed|finished)\\b", "i"),
    kinds: ["execution_result", "pipeline_outcome"],
  },
  {
    pattern: new RegExp("\\b(?:the\\s+)?(?:rollout|release|deployment)\\s+" + OPERATIONAL_STATE_LINK + "\\s*(?:green|successful|succeeded|passed|complete|completed|finished|live|healthy|verified)\\b", "i"),
    kinds: ["pipeline_outcome"],
  },
  {
    pattern: /\bproduction\s+(?:is|was|has been|had been)\s+(?:up|online)\b/i,
    kinds: ["pipeline_outcome"],
  },
  {
    pattern: /\b(?:the\s+)?release\s+(?:went|has gone|had gone)\s+out\b/i,
    kinds: ["pipeline_outcome"],
  },
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

const MAX_FINALIZATION_TEXT_SCAN = 16_384;

function isUnsafeCandidateString(candidateString: string): boolean {
  return canonicalControllerText(candidateString, MAX_FINALIZATION_TEXT_SCAN) === null;
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

function unsafeStorageProjection(
  candidate: ControllerFinalization,
  renderedMessage: string,
): ControllerFinalization | null {
  if (nonTextCandidateStrings(candidate).some(isUnsafeCandidateString)) return fixedStorageProjection();
  if (isUnsafeCandidateString(renderedMessage)
    || candidate.segments.some((segment) => isUnsafeCandidateString(segment.text))) return redactedCandidate(candidate);
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

function normalizedSentences(text: string): string[] {
  const normalized = text.normalize("NFKC").replace(OPERATIONAL_DEFAULT_IGNORABLES, "")
    .replace(/[’‘]/g, "'").replace(/[\r\n]+/g, " ");
  return (normalized.match(/[^.!?]+[.!?]?/g) ?? [normalized])
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function textClauses(text: string): string[] {
  return normalizedSentences(text)
    .flatMap((sentence) => sentence.split(/\s*(?:,\s*)?\b(?:and|but|although|however|which|while|then)\b\s+|;\s*/i))
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

type OperationalMatch = Readonly<{
  assertion: OperationalAssertion;
  start: number;
  end: number;
}>;

function operationalMatchesIn(clause: string): OperationalMatch[] {
  if (NON_SUCCESS_CLAUSE.some((pattern) => pattern.test(clause))) return [];
  const matches: OperationalMatch[] = [];
  for (const assertion of OPERATIONAL_ASSERTIONS) {
    const flags = assertion.pattern.flags.includes("g") ? assertion.pattern.flags : `${assertion.pattern.flags}g`;
    const scanner = new RegExp(assertion.pattern.source, flags);
    let match = scanner.exec(clause);
    while (match !== null) {
      if (match[0].length === 0) {
        scanner.lastIndex += 1;
      } else {
        matches.push({ assertion, start: match.index, end: match.index + match[0].length });
      }
      match = scanner.exec(clause);
    }
  }
  return matches;
}

function effectiveOperationalMatches(clause: string): OperationalMatch[] {
  const matches = operationalMatchesIn(clause);
  return matches.filter((match) => !matches.some((other) => (
    other !== match &&
    other.start <= match.start &&
    other.end >= match.end &&
    other.end - other.start > match.end - match.start
  )));
}

type SourceTextSpan = Readonly<{ text: string; start: number }>;

function trimmedSourceSpan(text: string, start: number, end: number, offset: number): SourceTextSpan | null {
  const raw = text.slice(start, end);
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return {
    text: trimmed,
    start: offset + start + (raw.length - raw.trimStart().length),
  };
}

function sentenceSourceSpans(text: string): SourceTextSpan[] {
  const sentences: SourceTextSpan[] = [];
  const sentencePattern = /[^.!?]+[.!?]?/g;
  let sentenceMatch = sentencePattern.exec(text);
  while (sentenceMatch !== null) {
    const span = trimmedSourceSpan(text, sentenceMatch.index, sentenceMatch.index + sentenceMatch[0].length, 0);
    if (span) sentences.push(span);
    sentenceMatch = sentencePattern.exec(text);
  }
  return sentences;
}

function splitOperationalSentence(sentence: SourceTextSpan): SourceTextSpan[] {
  const clauses: SourceTextSpan[] = [];
  const clauseSeparator = /\s*(?:,\s*)?\b(?:and|but|although|however|which|while|then)\b\s+|;\s*/gi;
  let cursor = 0;
  let separator = clauseSeparator.exec(sentence.text);
  while (separator !== null) {
    const span = trimmedSourceSpan(sentence.text, cursor, separator.index, sentence.start);
    if (span) clauses.push(span);
    cursor = separator.index + separator[0].length;
    separator = clauseSeparator.exec(sentence.text);
  }
  const span = trimmedSourceSpan(sentence.text, cursor, sentence.text.length, sentence.start);
  if (span) clauses.push(span);
  return clauses;
}

function operationalClauseSpans(text: string): SourceTextSpan[] {
  return sentenceSourceSpans(text).flatMap(splitOperationalSentence);
}

function hasObfuscatedOperationalAssertion(text: string): boolean {
  const normalized = text.normalize("NFKC");
  const canonical = normalized.replace(OPERATIONAL_DEFAULT_IGNORABLES, "");
  if (canonical === text) return false;
  return operationalClauseSpans(canonical).some((span) => clauseHasHighImpactSuccess(span.text));
}

function isConcreteFollowUp(sentence: string): boolean {
  return CONTROLLER_COMMITMENT.test(sentence)
    && !NON_AFFIRMATIVE_FOLLOW_UP.test(sentence)
    && CONCRETE_FOLLOW_UP.test(sentence);
}

function isProcessOnly(candidate: ControllerFinalization, renderedMessage: string): boolean {
  const clauses = textClauses(renderedMessage);
  if (candidate.disposition === "deferred") return !normalizedSentences(renderedMessage).some(isConcreteFollowUp);
  return clauses.length > 0 && clauses.every((clause) => (
    PROCESS_CLAUSE.test(clause) || PROCESS_STATUS_CLAUSE.test(clause) || GENERIC_PROCESS_COMMITMENT.test(clause)
  ));
}

function clauseHasHighImpactSuccess(clause: string): boolean {
  return operationalMatchesIn(clause).length > 0;
}

type FinalizationSegmentSpan = Readonly<{
  start: number;
  end: number;
  segment: ControllerFinalization["segments"][number];
}>;

function finalizationSegmentSpans(candidate: ControllerFinalization): FinalizationSegmentSpan[] {
  const spans: FinalizationSegmentSpan[] = [];
  let offset = 0;
  for (const segment of candidate.segments) {
    spans.push({ start: offset, end: offset + segment.text.length, segment });
    offset += segment.text.length;
  }
  return spans;
}

/**
 * The owner reads the rendered concatenation, so an operational assertion must
 * be located there rather than screened independently per segment. A match that
 * crosses a text/claim boundary cannot be attributed to one typed claim and is
 * rejected closed; a complete match in plain text is left to the unclaimed-text
 * branch below.
 */
function hasIncompatibleClaimText(candidate: ControllerFinalization, renderedMessage: string): boolean {
  const segmentSpans = finalizationSegmentSpans(candidate);
  for (const sourceSpan of operationalClauseSpans(renderedMessage)) {
    const clause = sourceSpan.text.replace(/[’‘]/g, "'");
    for (const match of effectiveOperationalMatches(clause)) {
      const assertionStart = sourceSpan.start + match.start;
      const assertionEnd = sourceSpan.start + match.end;
      const touched = segmentSpans.filter((span) => span.start < assertionEnd && span.end > assertionStart);
      if (touched.length === 0 || touched.every((span) => span.segment.type === "text")) continue;
      const onlySegment = touched.length === 1 ? touched[0]!.segment : null;
      if (!onlySegment || onlySegment.type !== "claim") return true;
      if (!match.assertion.kinds.includes(onlySegment.kind) || onlySegment.outcome !== "succeeded") return true;
    }
  }
  return false;
}

function plainTextRuns(candidate: ControllerFinalization): string[] {
  const runs: string[] = [];
  let currentRun = "";
  for (const segment of candidate.segments) {
    if (segment.type === "text") {
      currentRun += segment.text;
      continue;
    }
    if (currentRun.length > 0) runs.push(currentRun);
    currentRun = "";
  }
  if (currentRun.length > 0) runs.push(currentRun);
  return runs;
}

function hasUnclaimedHighImpactText(candidate: ControllerFinalization): boolean {
  return plainTextRuns(candidate).some((run) => textClauses(run).some(clauseHasHighImpactSuccess));
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
  if (context.invocationInFlight) return "invocation_in_flight";
  if (context.revisionCount >= 8) return "revision_limit";
  if (context.evidenceLimitExceeded) return "evidence_limit_exceeded";
  return null;
}

function claimRejectionCode(
  candidate: ControllerFinalization,
  renderedMessage: string,
  context: ControllerFinalizationValidationContext,
): FinalizationRejectionCode | null {
  const candidateClaims = claims(candidate);
  if (hasDuplicateEvidenceReference(candidateClaims)) return "duplicate_evidence_reference";
  if (hasMissingEvidence(candidateClaims, context)) return "evidence_missing";
  if (hasSubjectMismatch(candidateClaims, context)) return "subject_mismatch";
  if (hasProofIncompatibility(candidateClaims, context)) return "proof_incompatible";
  if (candidateClaims.length > 0 && hasObfuscatedOperationalAssertion(renderedMessage)) return "proof_incompatible";
  if (hasIncompatibleClaimText(candidate, renderedMessage)) return "proof_incompatible";
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
    ?? claimRejectionCode(candidate, renderedMessage, context)
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
  const unsafeProjection = unsafeStorageProjection(candidate, renderedMessage);
  if (unsafeProjection) return rejected("invalid_contract", unsafeProjection);
  const rejectionCode = semanticRejectionCode(candidate, renderedMessage, context);
  if (rejectionCode) return rejected(rejectionCode, candidate);
  return { outcome: "accepted", candidate, renderedMessage };
}
