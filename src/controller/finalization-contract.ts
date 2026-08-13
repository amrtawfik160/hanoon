import { z } from "zod";
import { isUnsafeProviderText } from "./credential-policy";
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

export function controllerFinalizationCorrection(code: FinalizationRejectionCode): string {
  return CORRECTIONS[code];
}

const PROCESS_OBJECT_WORD = "(?!(?:and|then|if)\\b)[a-z0-9_'/:-]+";
const PROCESS_ACTION = `(?:check|look(?:\\s+into)?|investigate|work\\s+on|try|get\\s+back(?:\\s+to\\s+you)?|follow\\s+up)(?:\\s+${PROCESS_OBJECT_WORD}){0,12}`;
const PROCESS_CLAUSE = new RegExp(
  `^(?:(?:i(?:'ll| will)|let me)\\s+)?${PROCESS_ACTION}[.!]?$`,
  "i",
);
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
/** A bounded optional perfect marker shared by every first-person success form. */
const ACTIVE_PERFECT_MARKER = "(?:(?:have|had)\\s+)?";
// Bounded to a couple of qualifiers, so "the unit tests" and "the tests you
// allowed" both read as the test suite while a long unrelated clause does not.
const TEST_OBJECT = "(?:the\\s+)?(?:(?:[a-z]+\\s+){0,2}tests?|test\\s+suite)\\b";
/** A question mark ending the part that carries the wording. */
const QUESTION_SIBLING = /\?\s*$/;
/**
 * The confirmations that turn a statement into a question about itself. They are
 * the one thing allowed to carry question scope backwards, because "The tests
 * passed, haven't they?" asks about the assertion — whereas "The tests passed:
 * what should I do next?" asserts it and then asks something else.
 *
 * The auxiliary form is a grammar rather than a list, so ordinary tags do not
 * have to be enumerated one at a time, but it is still bounded: an auxiliary, a
 * negation, a pronoun, and then the question mark. Anything with a word after
 * the pronoun — "should I do next?" — is a new question, not a tag.
 *
 * The negation is required rather than optional. English tags a positive
 * statement negatively — "The tests passed, didn't they?" — so beside a success
 * assertion a *positive* auxiliary is not a tag at all: "The tests passed,
 * should I?" and "…, did they?" are unrelated elliptical questions, and reading
 * them as confirmation would let one excuse the assertion in front of it.
 */
const TAG_AUXILIARY = "(?:is|are|was|were|do|does|did|has|have|had|will|would|can|could|should|shall|might|must)";
const TAG_PRONOUN = "(?:i|you|we|they|he|she|it|there)";
/** The short confirmations, which agree with anything by construction. */
const LEXICAL_CONFIRMATION = /^\s*(?:right|correct|ok|okay|yes|no|yeah|agreed|don't you think)\s*\?\s*$/i;
/** A negative tag, in either word order, with its auxiliary and pronoun. */
const NEGATIVE_TAG = new RegExp(
  `^\\s*(?:(${TAG_AUXILIARY})(?:n't|\\s+not)\\s+(${TAG_PRONOUN})` +
  `|(${TAG_AUXILIARY})\\s+(${TAG_PRONOUN})\\s+not)\\s*\\?\\s*$`,
  "i",
);

/**
 * What a tag would have to say to be asking about this assertion. A negative
 * shape alone is not agreement: "The tests passed, didn't I?" is negative and
 * still about someone else entirely, so the subject and tense of the assertion
 * decide which tag can confirm it.
 */
type TagSubject = "i" | "we" | "it" | "they";

/**
 * The auxiliary that agrees with each subject, per tense. Pairing them is the
 * point: holding a set of auxiliaries and a set of pronouns separately would
 * admit any combination of the two, so "The tests passed, hasn't they?" would
 * pass on parts that are each individually plausible.
 */
const PAST_PERFECT: Record<TagSubject, readonly string[]> = { i: ["had"], we: ["had"], it: ["had"], they: ["had"] };
const PERFECT: Record<TagSubject, readonly string[]> = { i: ["have"], we: ["have"], it: ["has"], they: ["have"] };
// "aren't I?" is the idiomatic first-person present tag; "amn't" is not used.
const PRESENT_BE: Record<TagSubject, readonly string[]> = { i: ["am", "are"], we: ["are"], it: ["is"], they: ["are"] };
const PAST_BE: Record<TagSubject, readonly string[]> = { i: ["was"], we: ["were"], it: ["was"], they: ["were"] };
/**
 * A simple past takes "did". A plural subject additionally takes "have", which
 * is what makes "The tests passed, haven't they?" read naturally — but never
 * "has", which agrees with no plural subject in any tense.
 */
const SIMPLE_PAST: Record<TagSubject, readonly string[]> = {
  i: ["did"], we: ["did"], it: ["did"], they: ["did", "have"],
};

/** Assertions whose subject was dropped: "Ran the tests" means "I ran them". */
const ELIDED_SPEAKER = /^\s*(?:ran|run)\b/;

/** The verbs a success assertion uses when it has no auxiliary of its own. */
const SIMPLE_PAST_VERB = /\b(?:passed|succeeded|completed|implemented|fixed|shipped|merged|deployed|deleted|removed|purged|installed|rotated|updated|created|issued|changed|spent|paid|purchased|ran|run)\b/;
/** Finite auxiliaries end the subject phrase even when they do not carry number. */
const FINITE_AUXILIARY = /\b(?:is|are|was|were|has|have|had)\b/;
/** Auxiliaries that state their subject's number outright. */
const PLURAL_AUXILIARY = /\b(?:are|were|have)\b/;
const SINGULAR_AUXILIARY = /\b(?:is|was|has)\b/;

/**
 * Whether a bare noun reads as plural. Deliberately crude, and only ever asked
 * of the head of the phrase rather than of whatever word came first.
 */
function isPluralNoun(head: string): boolean {
  if (head === "data") return true;
  return head.endsWith("s") && !head.endsWith("ss") && !head.endsWith("us");
}

/**
 * The head of the subject noun phrase: the last word before the verb, not the
 * first word of the sentence. "The API keys were rotated" is about the keys, and
 * "The unit tests passed" about the tests — reading "API" or "unit" instead
 * inverts the number and lets a singular tag confirm a plural assertion.
 */
function nominalHead(text: string): string {
  const boundaries = [FINITE_AUXILIARY.exec(text)?.index, SIMPLE_PAST_VERB.exec(text)?.index]
    .filter((index): index is number => index !== undefined);
  const before = boundaries.length > 0 ? text.slice(0, Math.min(...boundaries)) : text;
  return [...before.matchAll(/[a-z]+/g)].at(-1)?.[0] ?? "";
}

function tagSubject(text: string): TagSubject {
  const speaker = /^\s*(i|we)\b/.exec(text)?.[1];
  if (speaker === "i" || ELIDED_SPEAKER.test(text)) return "i";
  if (speaker === "we") return "we";
  // A finite auxiliary agrees with its subject, so it states the number more
  // reliably than the noun's spelling does; the head noun answers only when
  // there is no auxiliary to ask, as in a simple past.
  if (PLURAL_AUXILIARY.test(text)) return "they";
  if (SINGULAR_AUXILIARY.test(text)) return "it";
  return isPluralNoun(nominalHead(text)) ? "they" : "it";
}

function tagAuxiliaries(text: string): Record<TagSubject, readonly string[]> {
  if (/\bhad\b/.test(text)) return PAST_PERFECT;
  if (/\b(?:has|have)\b/.test(text)) return PERFECT;
  if (/\b(?:is|are)\b/.test(text)) return PRESENT_BE;
  if (/\b(?:was|were)\b/.test(text)) return PAST_BE;
  return SIMPLE_PAST;
}

/** True when this tag is asking about this assertion rather than something else. */
function tagConfirms(assertion: string, tag: string): boolean {
  if (LEXICAL_CONFIRMATION.test(tag)) return true;
  const match = NEGATIVE_TAG.exec(tag);
  if (!match) return false;
  const auxiliary = (match[1] ?? match[3] ?? "").toLowerCase();
  const pronoun = (match[2] ?? match[4] ?? "").toLowerCase();
  const text = assertion.toLowerCase();
  const subject = tagSubject(text);
  // The tag has to name this assertion's subject *and* carry the auxiliary that
  // agrees with it, as one pair rather than as two independent choices.
  return pronoun === subject && tagAuxiliaries(text)[subject].includes(auxiliary);
}

/** Curly apostrophes are the same contraction; the grammar reads one spelling. */
function normalizedApostrophes(text: string): string {
  return text.replace(/[\u2018\u2019]/g, "'");
}
/**
 * Polarity that belongs to the comma sibling actually carrying the wording. A
 * comma does not let one half of a sentence vouch for the other: "I did not
 * deploy staging, I deployed production" still asserts the deployment.
 */
const NON_SUCCESS_SIBLING = [
  /\b(?:not|never|no longer|cannot|can't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|hasn't|haven't|hadn't|won't|wouldn't|couldn't|shouldn't)\b/i,
  /\b(?:failed|failure|unsuccessful|denied|interrupted)\b/i,
  /\b(?:will|would|could|should|plan to|intend to|propose|after approval|later)\b/i,
  /\b(?:may|might|maybe|uncertain|unsure|possibly|probably|appears?|seems?)\b/i,
];
/**
 * Every high-impact success assertion, with the claim kinds under which it can
 * honestly be made. Outside a claim these are the patterns that must not appear
 * as bare prose at all; inside one they additionally fix what the claim is
 * allowed to say it is. Both rules read this single table, so an assertion
 * cannot be high-impact for one check and invisible to the other.
 *
 * Deleting and installing carry two kinds because the same sentence covers a
 * change to the workspace and a change to something outside it, and nothing in
 * the wording distinguishes them.
 */
const HIGH_IMPACT_ASSERTIONS: readonly Readonly<{
  pattern: RegExp;
  kinds: readonly ControllerClaimKind[];
}>[] = [
  { pattern: new RegExp(`\\b(?:i|we)\\s+${ACTIVE_PERFECT_MARKER}(?:implemented|fixed|shipped)\\b`, "i"), kinds: ["workspace_change"] },
  {
    pattern: /\b(?:the\s+)?(?:fix|change|feature|implementation|code)\s+(?:is|was|has been|had been)\s+(?:implemented|fixed|shipped|complete|completed)\b/i,
    kinds: ["workspace_change"],
  },
  {
    pattern: new RegExp(`\\b${TEST_OBJECT}\\s+(?:${PASSIVE_AUXILIARY}\\s+)?(?:passed|succeeded|completed)\\b`, "i"),
    kinds: ["execution_result"],
  },
  // Saying the tests were *run* is as strong as saying they passed, and the
  // subject is routinely dropped in chat prose — "Ran the tests you allowed"
  // is the same claim as "I ran the tests". Clause-initial anchoring is what
  // keeps this narrow: it reads a clause that leads with the verb, not every
  // later mention of running something.
  {
    pattern: new RegExp(`\\b(?:i|we)\\s+${ACTIVE_PERFECT_MARKER}(?:ran|run)\\s+${TEST_OBJECT}`, "i"),
    kinds: ["execution_result"],
  },
  {
    pattern: new RegExp(`^(?:ran|run)\\s+${TEST_OBJECT}`, "i"),
    kinds: ["execution_result"],
  },
  {
    pattern: /\b(?:the\s+)?review\s+(?:is|was|has been|had been)?\s*(?:complete|completed|passed|approved)\b/i,
    kinds: ["pipeline_outcome"],
  },
  { pattern: new RegExp(`\\b(?:i|we)\\s+${ACTIVE_PERFECT_MARKER}(?:approved|completed)\\s+(?:the\\s+)?review\\b`, "i"), kinds: ["pipeline_outcome"] },
  { pattern: new RegExp(`\\b(?:i|we)\\s+${ACTIVE_PERFECT_MARKER}merged\\s+(?:the\\s+)?(?:branch|pull request|change)\\b`, "i"), kinds: ["pipeline_outcome"] },
  {
    pattern: /\b(?:the\s+)?(?:branch|pull request|change)\s+(?:is|was|has been|had been)\s+merged\b/i,
    kinds: ["pipeline_outcome"],
  },
  {
    pattern: new RegExp(`\\b(?:i|we)\\s+${ACTIVE_PERFECT_MARKER}deployed\\s+(?:the\\s+)?(?:[a-z]+\\s+){0,3}(?:service|deployment|production)\\b`, "i"),
    kinds: ["pipeline_outcome"],
  },
  {
    pattern: /\b(?:the\s+)?(?:service|deployment|production)\s+(?:is|was|has been|had been)\s+(?:deployed|live|healthy|verified)\b/i,
    kinds: ["pipeline_outcome"],
  },
  {
    pattern: new RegExp(`\\b(?:i|we)\\s+${ACTIVE_PERFECT_MARKER}(?:deleted|removed|purged)\\s+(?:the\\s+)?(?:[a-z]+\\s+){0,3}${DOMAIN_OBJECT}\\b`, "i"),
    kinds: ["workspace_change", "external_mutation"],
  },
  {
    pattern: new RegExp(`\\b(?:the\\s+)?${DOMAIN_OBJECT}\\s+${PASSIVE_AUXILIARY}\\s+(?:deleted|removed|purged)\\b`, "i"),
    kinds: ["workspace_change", "external_mutation"],
  },
  {
    pattern: new RegExp(`\\b(?:i|we)\\s+${ACTIVE_PERFECT_MARKER}installed\\s+(?:the\\s+)?(?:[a-z]+\\s+){0,2}${INSTALL_OBJECT}\\b`, "i"),
    kinds: ["workspace_change", "external_mutation"],
  },
  {
    pattern: new RegExp(`\\b(?:the\\s+)?${INSTALL_OBJECT}\\s+${PASSIVE_AUXILIARY}\\s+installed\\b`, "i"),
    kinds: ["workspace_change", "external_mutation"],
  },
  {
    pattern: new RegExp(`\\b(?:i|we)\\s+${ACTIVE_PERFECT_MARKER}(?:rotated|updated|created|issued|changed)\\s+(?:the\\s+)?${CREDENTIAL_OBJECT}\\b`, "i"),
    kinds: ["external_mutation"],
  },
  {
    pattern: new RegExp(`\\b(?:the\\s+)?${CREDENTIAL_OBJECT}\\s+${PASSIVE_AUXILIARY}\\s+(?:rotated|updated|created|issued|changed)\\b`, "i"),
    kinds: ["external_mutation"],
  },
  { pattern: new RegExp(`\\b(?:i|we)\\s+${ACTIVE_PERFECT_MARKER}(?:spent|paid)\\s+${MONEY_AMOUNT}\\b`, "i"), kinds: ["external_mutation"] },
  { pattern: new RegExp(`\\b${MONEY_AMOUNT}\\s+${PASSIVE_AUXILIARY}\\s+(?:spent|paid)\\b`, "i"), kinds: ["external_mutation"] },
  {
    pattern: new RegExp(`\\b(?:i|we)\\s+${ACTIVE_PERFECT_MARKER}purchased\\s+(?:the\\s+)?(?:[a-z]+\\s+){0,2}${PURCHASE_OBJECT}\\b`, "i"),
    kinds: ["external_mutation"],
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

// A finalization segment and a question prompt reach the same owner through the
// same Telegram message, so they are screened by the same rule.
const isUnsafeCandidateString = isUnsafeProviderText;

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

/** A piece of the original text and where it starts in it. */
type SourceSpan = Readonly<{ text: string; start: number }>;

/**
 * Appends `text.slice(from, to)` trimmed, keeping the offset the trimmed text
 * actually has in the original. Every span in this module is anchored this way,
 * so a later search for the text is never needed to find it again — a search
 * would return the first occurrence rather than this one, and would fail
 * outright once the text had been normalised for matching.
 */
function pushSpan(spans: SourceSpan[], text: string, offset: number, from: number, to: number): void {
  const raw = text.slice(from, to);
  const trimmed = raw.trim();
  if (trimmed.length === 0) return;
  spans.push({ text: trimmed, start: offset + from + (raw.length - raw.trimStart().length) });
}

const SENTENCE_TERMINATOR = new Set([".", "!", "?"]);

/**
 * Sentence spans over the original text. A line break ends a sentence just as a
 * full stop does, and is not part of either one.
 */
function sentenceSpans(text: string): SourceSpan[] {
  const spans: SourceSpan[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    if (SENTENCE_TERMINATOR.has(character)) {
      pushSpan(spans, text, 0, start, index + 1);
      index += 1;
      start = index;
      continue;
    }
    if (character === "\r" || character === "\n") {
      pushSpan(spans, text, 0, start, index);
      while (index < text.length && (text[index] === "\r" || text[index] === "\n")) index += 1;
      start = index;
      continue;
    }
    index += 1;
  }
  pushSpan(spans, text, 0, start, text.length);
  // A second terminator is not a second sentence. Ignoring punctuation-only
  // spans keeps the original offsets while preventing "I'll investigate.."
  // (or punctuation after CRLF) from manufacturing a non-process clause.
  return spans.filter((span) => !/^[.!?]+$/.test(span.text));
}

const CLAUSE_SEPARATOR = /\s*(?:,\s*)?\b(?:and|but|however|which|while|then)\b\s+|;\s*/gi;

/** Clause spans within one sentence span, still anchored to the original. */
function clauseSpansOf(sentence: SourceSpan): SourceSpan[] {
  const spans: SourceSpan[] = [];
  const separator = new RegExp(CLAUSE_SEPARATOR.source, CLAUSE_SEPARATOR.flags);
  let cursor = 0;
  let match = separator.exec(sentence.text);
  while (match !== null) {
    if (match[0].length === 0) {
      separator.lastIndex += 1;
    } else {
      pushSpan(spans, sentence.text, sentence.start, cursor, match.index);
      cursor = match.index + match[0].length;
    }
    match = separator.exec(sentence.text);
  }
  pushSpan(spans, sentence.text, sentence.start, cursor, sentence.text.length);
  return spans;
}

/** Every clause of the text, each anchored where it actually appears. */
function clauseSpans(text: string): SourceSpan[] {
  return sentenceSpans(text).flatMap(clauseSpansOf);
}

/**
 * Normalisation for matching only, never before an offset is derived. It is
 * one-for-one on characters, so a match found in the normalised form has the
 * same offset in the original span.
 */
function normalizedForMatching(text: string): string {
  return text.replace(/[’‘]/g, "'");
}

function normalizedSentences(text: string): string[] {
  return sentenceSpans(text).map((span) => normalizedForMatching(span.text));
}

function textClauses(text: string): string[] {
  return clauseSpans(text).map((span) => normalizedForMatching(span.text));
}

function isConcreteFollowUp(sentence: string): boolean {
  return CONTROLLER_COMMITMENT.test(sentence)
    && !NON_AFFIRMATIVE_FOLLOW_UP.test(sentence)
    && CONCRETE_FOLLOW_UP.test(sentence);
}

function isProcessOnly(candidate: ControllerFinalization, renderedMessage: string): boolean {
  const clauses = textClauses(renderedMessage);
  if (candidate.disposition === "deferred") return !normalizedSentences(renderedMessage).some(isConcreteFollowUp);
  return clauses.length > 0 && clauses.every((clause) => PROCESS_CLAUSE.test(clause));
}

function clauseHasHighImpactSuccess(clause: string): boolean {
  return highImpactMatchesIn(clause).length > 0;
}

type HighImpactMatch = Readonly<{
  assertion: (typeof HIGH_IMPACT_ASSERTIONS)[number];
  start: number;
  end: number;
}>;

/**
 * The punctuation that separates one assertion from the next inside a clause.
 * A colon or a dash joins two independent statements as readily as a comma does
 * — "Staging failed: production is live" reports a failure *and* a deployment —
 * so polarity must not carry across one.
 */
const SIBLING_BOUNDARY = /[,:;\u2013\u2014]/;

/** The parts of a clause that assert separately, with where each one starts. */
function assertionSiblings(clause: string): { text: string; start: number }[] {
  const siblings: { text: string; start: number }[] = [];
  let start = 0;
  let current = "";
  for (const character of clause) {
    if (SIBLING_BOUNDARY.test(character)) {
      siblings.push({ text: current, start });
      start += current.length + character.length;
      current = "";
      continue;
    }
    current += character;
  }
  siblings.push({ text: current, start });
  return siblings;
}

/**
 * True when the wording at this span asserts nothing after all — the sentence is
 * a question, or the sibling carrying the wording negates, fails, defers, or
 * hedges it. Polarity is read from the sibling rather than the whole clause so
 * that a negated first half cannot suppress an affirmative second half.
 */
function assertionIsSuppressed(clause: string, start: number, end: number): boolean {
  const siblings = assertionSiblings(clause);
  const overlapping = siblings
    .map((sibling, index) => ({ ...sibling, index }))
    .filter((sibling) => sibling.start < end && sibling.start + sibling.text.length > start);
  if (overlapping.some((sibling) => NON_SUCCESS_SIBLING.some((pattern) => pattern.test(sibling.text)))) {
    return true;
  }
  // Question scope is local too: the part carrying the wording is itself a
  // question, or the part right after it is a tag confirming that same wording.
  if (overlapping.some((sibling) => QUESTION_SIBLING.test(sibling.text))) return true;
  const last = overlapping.at(-1);
  if (last === undefined) return false;
  return tagConfirms(
    clause.slice(start, end),
    siblings[last.index + 1]?.text ?? "",
  );
}

/**
 * Every high-impact assertion a clause makes, with where each one sits. All
 * occurrences are scanned, not just the first: one properly carried mention of a
 * wording must not vouch for a second mention elsewhere in the same clause.
 */
function highImpactMatchesIn(clause: string): HighImpactMatch[] {
  const matches: HighImpactMatch[] = [];
  for (const assertion of HIGH_IMPACT_ASSERTIONS) {
    const scanner = new RegExp(
      assertion.pattern.source,
      assertion.pattern.flags.includes("g") ? assertion.pattern.flags : `${assertion.pattern.flags}g`,
    );
    let match = scanner.exec(clause);
    while (match !== null) {
      if (match[0].length === 0) {
        scanner.lastIndex += 1;
      } else if (!assertionIsSuppressed(clause, match.index, match.index + match[0].length)) {
        matches.push({ assertion, start: match.index, end: match.index + match[0].length });
      }
      match = scanner.exec(clause);
    }
  }
  return matches;
}

type SegmentSpan = Readonly<{
  start: number;
  end: number;
  segment: ControllerFinalization["segments"][number];
}>;

/** Where each segment's text lands in the message the owner actually reads. */
function segmentSpans(candidate: ControllerFinalization): SegmentSpan[] {
  const spans: SegmentSpan[] = [];
  let offset = 0;
  for (const segment of candidate.segments) {
    spans.push({ start: offset, end: offset + segment.text.length, segment });
    offset += segment.text.length;
  }
  return spans;
}

/**
 * True when a high-impact assertion the owner will read is not carried by a
 * claim entitled to make it.
 *
 * The assertion is located in the rendered message rather than segment by
 * segment, because the owner reads the concatenation: "The fix is imple" in a
 * text segment followed by "mented." in a claim is the sentence "The fix is
 * implemented", and splitting it must not launder it past the proof rules. An
 * assertion may only stand if the whole of it sits inside a single claim whose
 * kind admits that wording and whose outcome actually declares success — the
 * right kind under a failed, observed, or uncertain outcome is a success claim
 * its own declaration disowns.
 *
 * An assertion lying wholly in plain text is left to the unclaimed-text rule,
 * which is what reports it.
 */
function hasIncompatibleClaimText(candidate: ControllerFinalization, renderedMessage: string): boolean {
  const spans = segmentSpans(candidate);
  for (const { text: rawClause, start } of clauseSpans(renderedMessage)) {
    const clause = normalizedForMatching(rawClause);
    for (const { assertion, start: matchStart, end: matchEnd } of highImpactMatchesIn(clause)) {
      const assertionStart = start + matchStart;
      const assertionEnd = start + matchEnd;
      const touched = spans.filter((span) => span.start < assertionEnd && span.end > assertionStart);
      if (touched.every((span) => span.segment.type === "text")) continue;
      const only = touched.length === 1 ? touched[0]!.segment : null;
      if (!only || only.type !== "claim") return true;
      if (!assertion.kinds.includes(only.kind) || only.outcome !== "succeeded") return true;
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
