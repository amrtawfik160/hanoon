import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CONTROLLER_CLAIM_KINDS,
  FINALIZATION_REJECTION_CODES,
  controllerFinalizationJsonSchema,
  controllerFinalizationSchema,
  renderControllerFinalization,
  validateControllerFinalization,
  type ControllerClaimKind,
  type ControllerFinalization,
  type ControllerFinalizationValidationContext,
} from "../src/controller/finalization-contract";
import { CONTROLLER_PROOF_KINDS, type ControllerProofKind } from "../src/controller/models";

type EvidenceRow = ControllerFinalizationValidationContext["evidenceByRef"] extends ReadonlyMap<unknown, infer Row>
  ? Row
  : never;

const CLAIM_PROOFS: Record<ControllerClaimKind, readonly ControllerProofKind[]> = {
  observed_state: ["project_state", "job_state", "thread_state", "monitor_state", "memory_state"],
  execution_result: ["command_result", "tool_result"],
  workspace_change: ["workspace_change"],
  external_mutation: ["external_mutation"],
  pipeline_outcome: ["pipeline_outcome"],
  health_assessment: ["health_snapshot"],
  uncertainty: CONTROLLER_PROOF_KINDS,
};

function emptyFinalizationContext(
  overrides: Partial<ControllerFinalizationValidationContext> = {},
): ControllerFinalizationValidationContext {
  return {
    acceptedAlready: false,
    revisionCount: 0,
    evidenceLimitExceeded: false,
    evidenceByRef: new Map(),
    ownerBoundaryPresent: false,
    liveObligationRefs: new Set(),
    ...overrides,
  };
}

function evidenceRow(
  ref: `evidence:${number}`,
  proofKind: ControllerProofKind,
  outcome: EvidenceRow["outcome"] = "observed",
  subjectRef = "job:job_1",
): EvidenceRow {
  return { ref, outcome, proofKinds: [proofKind], subjectRefs: [subjectRef] };
}

function contextWithEvidence(
  ...rows: readonly EvidenceRow[]
): ControllerFinalizationValidationContext {
  return emptyFinalizationContext({
    evidenceByRef: new Map(rows.map((row) => [row.ref, row])),
  });
}

function textFinalization(text: string): ControllerFinalization {
  return { disposition: "answered", segments: [{ type: "text", text }], obligationRefs: [] };
}

function claimFinalization(options: {
  kind?: ControllerClaimKind;
  outcome?: "observed" | "succeeded" | "failed" | "uncertain";
  subjectRef?: string;
  evidenceRefs?: `evidence:${number}`[];
  text?: string;
} = {}): ControllerFinalization {
  return {
    disposition: "answered",
    segments: [{
      type: "claim",
      text: options.text ?? "The recorded state is available.",
      kind: options.kind ?? "observed_state",
      outcome: options.outcome ?? "observed",
      subjectRef: options.subjectRef ?? "job:job_1",
      evidenceRefs: options.evidenceRefs ?? ["evidence:1"],
    }],
    obligationRefs: [],
  };
}

function expectRejection(
  candidate: unknown,
  context: ControllerFinalizationValidationContext,
  code: (typeof FINALIZATION_REJECTION_CODES)[number],
): void {
  expect(validateControllerFinalization(candidate, context)).toMatchObject({ outcome: "rejected", code });
}

describe("controller finalization public contract", () => {
  it("exports the exact provider JSON Schema generated from the runtime contract", () => {
    expect(controllerFinalizationJsonSchema).toEqual(z.toJSONSchema(controllerFinalizationSchema));
  });
  it("pins the stable rejection vocabulary", () => {
    expect(FINALIZATION_REJECTION_CODES).toEqual([
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
    ]);
    expect(CONTROLLER_CLAIM_KINDS).toEqual([
      "observed_state",
      "execution_result",
      "workspace_change",
      "external_mutation",
      "pipeline_outcome",
      "health_assessment",
      "uncertainty",
    ]);
  });

  it("accepts a plain conversational answer without operational claims", () => {
    expect(validateControllerFinalization({
      disposition: "answered",
      segments: [{ type: "text", text: "The simplest option is SQLite for this scale." }],
      obligationRefs: [],
    }, emptyFinalizationContext())).toMatchObject({
      outcome: "accepted",
      renderedMessage: "The simplest option is SQLite for this scale.",
    });
  });

  it("renders exact segment concatenation without separators", () => {
    const candidate: ControllerFinalization = {
      disposition: "answered",
      segments: [
        { type: "text", text: "First" },
        { type: "text", text: " second" },
        { type: "text", text: "." },
      ],
      obligationRefs: [],
    };
    expect(renderControllerFinalization(candidate)).toBe("First second.");
  });

  it("counts rendered Unicode code points rather than UTF-16 units", () => {
    const candidate = textFinalization("😀".repeat(4_000));
    expect(renderControllerFinalization(candidate)).toBe("😀".repeat(4_000));
    expect(() => renderControllerFinalization(textFinalization("😀".repeat(4_001))))
      .toThrow("final message exceeds 4000 characters");
  });
});

describe("strict structural bounds", () => {
  it.each([
    ["unknown root key", { ...textFinalization("Hello."), extra: true }],
    ["unknown segment key", {
      disposition: "answered",
      segments: [{ type: "text", text: "Hello.", extra: true }],
      obligationRefs: [],
    }],
    ["whitespace segment", textFinalization("   \n")],
    ["4,001 rendered characters", {
      disposition: "answered",
      segments: [{ type: "text", text: "a".repeat(2_001) }, { type: "text", text: "b".repeat(2_000) }],
      obligationRefs: [],
    }],
    ["25 segments", {
      disposition: "answered",
      segments: Array.from({ length: 25 }, () => ({ type: "text" as const, text: "x" })),
      obligationRefs: [],
    }],
    ["13 claim segments", {
      disposition: "answered",
      segments: Array.from({ length: 13 }, () => claimFinalization().segments[0]),
      obligationRefs: [],
    }],
    ["nine evidence references", claimFinalization({
      evidenceRefs: Array.from({ length: 9 }, (_, index) => `evidence:${index + 1}` as const),
    })],
    ["nine obligations", {
      disposition: "deferred",
      segments: [{ type: "text", text: "Follow-up is scheduled." }],
      obligationRefs: Array.from({ length: 9 }, (_, index) => `obligation:${index + 1}`),
    }],
  ])("rejects %s as an invalid contract", (_label, candidate) => {
    const validation = validateControllerFinalization(candidate, emptyFinalizationContext());
    expect(validation).toEqual({
      outcome: "rejected",
      code: "invalid_contract",
      correction: expect.any(String),
      storedCandidate: textFinalization("[redacted]"),
    });
  });

  it("accepts all structural maxima when their semantics are valid", () => {
    const evidence = evidenceRow("evidence:1", "project_state");
    const twelveClaims = Array.from({ length: 12 }, () => claimFinalization().segments[0]);
    const twelveTexts = [
      { type: "text" as const, text: "I'll follow up with the measured result." },
      ...Array.from({ length: 11 }, () => ({ type: "text" as const, text: "x" })),
    ];
    const candidate: ControllerFinalization = {
      disposition: "deferred",
      segments: [...twelveClaims, ...twelveTexts],
      obligationRefs: Array.from({ length: 8 }, (_, index) => `obligation:${index + 1}`),
    };
    const liveObligationRefs = new Set(candidate.obligationRefs);
    expect(validateControllerFinalization(candidate, {
      ...contextWithEvidence(evidence),
      liveObligationRefs,
    })).toMatchObject({ outcome: "accepted" });
  });

  it("exposes a strict schema with the independent claim cap", () => {
    expect(controllerFinalizationSchema.safeParse(textFinalization("Hello.")).success).toBe(true);
    expect(controllerFinalizationSchema.safeParse({
      disposition: "answered",
      segments: Array.from({ length: 13 }, () => claimFinalization().segments[0]),
      obligationRefs: [],
    }).success).toBe(false);
  });

  it("enforces segment bounds in Unicode code points through the schema and validator", () => {
    const maximum = textFinalization("😀".repeat(4_000));
    const overLimit = textFinalization("😀".repeat(4_001));

    expect(controllerFinalizationSchema.safeParse(maximum).success).toBe(true);
    expect(validateControllerFinalization(maximum, emptyFinalizationContext()))
      .toMatchObject({ outcome: "accepted" });
    expect(controllerFinalizationSchema.safeParse(overLimit).success).toBe(false);
    expect(validateControllerFinalization(overLimit, emptyFinalizationContext()))
      .toMatchObject({ outcome: "rejected", code: "invalid_contract" });
  });
});

describe("unsafe candidate redaction", () => {
  it("redacts every segment text while preserving safe non-text fields", () => {
    const unsafeText = "api_key=TOP_SECRET_VALUE_12345";
    const candidate = {
      disposition: "answered",
      segments: [
        { type: "text", text: "Safe preface." },
        {
          type: "claim",
          text: unsafeText,
          kind: "observed_state",
          outcome: "observed",
          subjectRef: "job:job_1",
          evidenceRefs: ["evidence:1"],
        },
      ],
      obligationRefs: [],
    };
    const validation = validateControllerFinalization(candidate, contextWithEvidence(
      evidenceRow("evidence:1", "project_state"),
    ));
    expect(validation).toEqual({
      outcome: "rejected",
      code: "invalid_contract",
      correction: expect.any(String),
      storedCandidate: {
        ...candidate,
        segments: [
          { type: "text", text: "[redacted]" },
          { ...candidate.segments[1], text: "[redacted]" },
        ],
      },
    });
    expect(JSON.stringify(validation)).not.toContain(unsafeText);
    expect(JSON.stringify(validation)).not.toContain("Safe preface.");
  });

  it.each([
    ["raw callback", `m:${"a".repeat(32)}`],
    ["encoded callback", `m%3A${"b".repeat(32)}`],
    ["repeatedly encoded callback", `m%25253A${"c".repeat(32)}`],
  ])("rejects and erases %s material", (_label, unsafeToken) => {
    const unsafeText = `Internal material: ${unsafeToken}`;
    const validation = validateControllerFinalization(textFinalization(unsafeText), emptyFinalizationContext());
    expect(validation).toMatchObject({ outcome: "rejected", code: "invalid_contract" });
    expect(JSON.stringify(validation)).not.toContain(unsafeToken);
    expect(JSON.stringify(validation)).not.toContain(unsafeText);
  });

  it.each([
    ["subject ref", claimFinalization({ subjectRef: "token=SUBJECT_SECRET_12345" })],
    ["obligation ref", {
      disposition: "deferred",
      segments: [{ type: "text", text: "Follow-up is scheduled." }],
      obligationRefs: ["password=OBLIGATION_SECRET_12345"],
    }],
  ])("uses the fixed projection when an unsafe %s is not segment text", (_label, candidate) => {
    const validation = validateControllerFinalization(candidate, emptyFinalizationContext());
    expect(validation).toMatchObject({
      outcome: "rejected",
      code: "invalid_contract",
      storedCandidate: textFinalization("[redacted]"),
    });
    expect(JSON.stringify(validation)).not.toContain("SECRET_12345");
  });

  it.each([
    ["raw callback across text/text", [
      { type: "text", text: "m:" },
      { type: "text", text: "a".repeat(32) },
    ], `m:${"a".repeat(32)}`],
    ["encoded callback across text/claim", [
      { type: "text", text: "encoded-prefix m" },
      claimFinalization({ kind: "uncertainty", outcome: "uncertain", text: `%3A${"b".repeat(32)}` }).segments[0],
    ], `encoded-prefix m%3A${"b".repeat(32)}`],
    ["repeatedly encoded callback across claim/text", [
      claimFinalization({ kind: "uncertainty", outcome: "uncertain", text: "repeated-prefix m" }).segments[0],
      { type: "text", text: `%25253A${"c".repeat(32)}` },
    ], `repeated-prefix m%25253A${"c".repeat(32)}`],
    ["credential assignment across text/claim", [
      { type: "text", text: "api_key" },
      claimFinalization({ kind: "uncertainty", outcome: "uncertain", text: "=TOP_SECRET_VALUE_12345" }).segments[0],
    ], "api_key=TOP_SECRET_VALUE_12345"],
  ])("rejects and fully redacts %s", (_label, segments, assembledUnsafeText) => {
    const candidate = { disposition: "answered", segments, obligationRefs: [] };
    const validation = validateControllerFinalization(candidate, contextWithEvidence(
      evidenceRow("evidence:1", "project_state"),
    ));
    const serialized = JSON.stringify(validation);

    expect(validation).toMatchObject({
      outcome: "rejected",
      code: "invalid_contract",
      storedCandidate: {
        segments: segments.map((segment) => ({ ...segment, text: "[redacted]" })),
      },
    });
    expect(serialized).not.toContain(assembledUnsafeText);
    for (const segment of segments) expect(serialized).not.toContain(segment.text);
  });
});

describe("ordered rejection branches", () => {
  const ordinary = textFinalization("SQLite is suitable here.");

  it("checks accepted state at its false and true boundary", () => {
    expect(validateControllerFinalization(ordinary, emptyFinalizationContext({ acceptedAlready: false })))
      .toMatchObject({ outcome: "accepted" });
    expectRejection(ordinary, emptyFinalizationContext({ acceptedAlready: true }), "accepted_already");
  });

  it("checks revision count immediately below and at the cutoff", () => {
    expect(validateControllerFinalization(ordinary, emptyFinalizationContext({ revisionCount: 7 })))
      .toMatchObject({ outcome: "accepted" });
    expectRejection(ordinary, emptyFinalizationContext({ revisionCount: 8 }), "revision_limit");
  });

  it("checks the evidence-limit flag at both boolean boundaries", () => {
    expect(validateControllerFinalization(ordinary, emptyFinalizationContext({ evidenceLimitExceeded: false })))
      .toMatchObject({ outcome: "accepted" });
    expectRejection(
      ordinary,
      emptyFinalizationContext({ evidenceLimitExceeded: true }),
      "evidence_limit_exceeded",
    );
  });

  it("rejects duplicate evidence references within one claim", () => {
    const candidate = claimFinalization({ evidenceRefs: ["evidence:1", "evidence:1"] });
    expectRejection(candidate, contextWithEvidence(evidenceRow("evidence:1", "project_state")), "duplicate_evidence_reference");
  });

  it("rejects a foreign evidence reference absent from the context", () => {
    expectRejection(claimFinalization(), emptyFinalizationContext(), "evidence_missing");
  });

  it("rejects a wrong evidence subject", () => {
    expectRejection(
      claimFinalization(),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed", "job:someone_else")),
      "subject_mismatch",
    );
  });

  it("rejects a successful deployment claim backed only by a command result", () => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text: "Deployment succeeded." }),
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
      "proof_incompatible",
    );
  });

  it("requires an owner boundary for needs_owner", () => {
    const candidate: ControllerFinalization = {
      disposition: "needs_owner",
      segments: [{ type: "text", text: "Please choose the deployment region." }],
      obligationRefs: [],
    };
    expectRejection(candidate, emptyFinalizationContext(), "owner_boundary_missing");
    expect(validateControllerFinalization(candidate, emptyFinalizationContext({ ownerBoundaryPresent: true })))
      .toMatchObject({ outcome: "accepted" });
  });

  it.each(["answered", "needs_owner"] as const)("forbids obligations for %s", (disposition) => {
    const candidate: ControllerFinalization = {
      disposition,
      segments: [{ type: "text", text: "The response is complete." }],
      obligationRefs: ["obligation:1"],
    };
    expectRejection(
      candidate,
      emptyFinalizationContext({ ownerBoundaryPresent: true, liveObligationRefs: new Set(["obligation:1"]) }),
      "obligation_forbidden",
    );
  });

  it("requires at least one deferred obligation", () => {
    const candidate: ControllerFinalization = {
      disposition: "deferred",
      segments: [{ type: "text", text: "The next check is pending." }],
      obligationRefs: [],
    };
    expectRejection(candidate, emptyFinalizationContext(), "obligation_missing");
  });

  it("requires every deferred obligation to be live", () => {
    const candidate: ControllerFinalization = {
      disposition: "deferred",
      segments: [{ type: "text", text: "I'll follow up with the measured result." }],
      obligationRefs: ["obligation:1", "obligation:2"],
    };
    expectRejection(
      candidate,
      emptyFinalizationContext({ liveObligationRefs: new Set(["obligation:1"]) }),
      "obligation_not_live",
    );
    expect(validateControllerFinalization(candidate, emptyFinalizationContext({
      liveObligationRefs: new Set(["obligation:1", "obligation:2"]),
    }))).toMatchObject({ outcome: "accepted" });
  });

  it("rejects process-only intent", () => {
    expectRejection(
      textFinalization("I'll investigate and get back to you."),
      emptyFinalizationContext(),
      "process_only",
    );
  });

  it("rejects an unclaimed high-impact success assertion", () => {
    expectRejection(textFinalization("I deployed the fix to production."), emptyFinalizationContext(), "high_impact_text_unclaimed");
  });

  it("uses the declared stable order when failures overlap", () => {
    const missingEvidence = claimFinalization({ evidenceRefs: ["evidence:2"] });
    expectRejection(missingEvidence, emptyFinalizationContext({
      acceptedAlready: true,
      revisionCount: 8,
      evidenceLimitExceeded: true,
    }), "accepted_already");
    expectRejection(missingEvidence, emptyFinalizationContext({
      revisionCount: 8,
      evidenceLimitExceeded: true,
    }), "revision_limit");
    expectRejection(missingEvidence, emptyFinalizationContext({ evidenceLimitExceeded: true }), "evidence_limit_exceeded");
    expectRejection(missingEvidence, emptyFinalizationContext(), "evidence_missing");
  });

  it("pins every coexisting rejection-stage boundary", () => {
    const duplicateMissing = claimFinalization({ evidenceRefs: ["evidence:2", "evidence:2"] });
    const missingAndWrongSubject = claimFinalization({ evidenceRefs: ["evidence:1", "evidence:2"] });
    const wrongSubjectAndProof = claimFinalization({ kind: "execution_result" });
    const proofAndOwnerBoundary = {
      ...claimFinalization({ kind: "execution_result" }),
      disposition: "needs_owner" as const,
    };
    const ownerBoundaryAndObligation: ControllerFinalization = {
      disposition: "needs_owner",
      segments: [{ type: "text", text: "Choose the deployment region." }],
      obligationRefs: ["obligation:1"],
    };
    const nonLiveProcessOnly: ControllerFinalization = {
      disposition: "deferred",
      segments: [{ type: "text", text: "I'll investigate." }],
      obligationRefs: ["obligation:1"],
    };

    expectRejection(ordinary, emptyFinalizationContext({ acceptedAlready: true, revisionCount: 8 }), "accepted_already");
    expectRejection(ordinary, emptyFinalizationContext({ acceptedAlready: true, evidenceLimitExceeded: true }), "accepted_already");
    expectRejection(ordinary, emptyFinalizationContext({ revisionCount: 8, evidenceLimitExceeded: true }), "revision_limit");
    expectRejection(duplicateMissing, emptyFinalizationContext({ evidenceLimitExceeded: true }), "evidence_limit_exceeded");
    expectRejection(duplicateMissing, emptyFinalizationContext(), "duplicate_evidence_reference");
    expectRejection(missingAndWrongSubject, contextWithEvidence(
      evidenceRow("evidence:1", "project_state", "observed", "job:someone_else"),
    ), "evidence_missing");
    expectRejection(wrongSubjectAndProof, contextWithEvidence(
      evidenceRow("evidence:1", "project_state", "observed", "job:someone_else"),
    ), "subject_mismatch");
    expectRejection(proofAndOwnerBoundary, contextWithEvidence(
      evidenceRow("evidence:1", "project_state"),
    ), "proof_incompatible");
    expectRejection(ownerBoundaryAndObligation, emptyFinalizationContext({
      liveObligationRefs: new Set(["obligation:1"]),
    }), "owner_boundary_missing");
    expectRejection(nonLiveProcessOnly, emptyFinalizationContext(), "obligation_not_live");
  });

  it("keeps mutually exclusive disposition failures on direct boundaries", () => {
    // answered/needs_owner obligation failures cannot coexist with deferred missing/non-live failures.
    expectRejection({
      disposition: "answered",
      segments: [{ type: "text", text: "The answer is complete." }],
      obligationRefs: ["obligation:1"],
    }, emptyFinalizationContext(), "obligation_forbidden");
    expectRejection({
      disposition: "deferred",
      segments: [{ type: "text", text: "I'll follow up with the measured result." }],
      obligationRefs: [],
    }, emptyFinalizationContext(), "obligation_missing");
  });
});

describe("claim proof compatibility", () => {
  const compatiblePairs = CONTROLLER_CLAIM_KINDS.flatMap((kind) => (
    CLAIM_PROOFS[kind].map((proofKind) => [kind, proofKind] as const)
  ));
  const incompatiblePairs = CONTROLLER_CLAIM_KINDS.flatMap((kind) => (
    CONTROLLER_PROOF_KINDS
      .filter((proofKind) => !CLAIM_PROOFS[kind].includes(proofKind))
      .map((proofKind) => [kind, proofKind] as const)
  ));

  it.each(compatiblePairs)("accepts %s with %s proof", (kind, proofKind) => {
    const candidate = claimFinalization({ kind, outcome: "uncertain" });
    const validation = validateControllerFinalization(
      candidate,
      contextWithEvidence(evidenceRow("evidence:1", proofKind)),
    );
    expect(validation).toMatchObject({ outcome: "accepted" });
  });

  it.each(incompatiblePairs)("rejects %s with incompatible %s proof", (kind, proofKind) => {
    const candidate = claimFinalization({ kind, outcome: "uncertain" });
    expectRejection(
      candidate,
      contextWithEvidence(evidenceRow("evidence:1", proofKind)),
      "proof_incompatible",
    );
  });

  it("requires every referenced row to have compatible proof and subject", () => {
    const candidate = claimFinalization({
      kind: "execution_result",
      outcome: "succeeded",
      evidenceRefs: ["evidence:1", "evidence:2"],
    });
    expectRejection(candidate, contextWithEvidence(
      evidenceRow("evidence:1", "command_result", "succeeded"),
      evidenceRow("evidence:2", "project_state", "succeeded"),
    ), "proof_incompatible");
    expectRejection(candidate, contextWithEvidence(
      evidenceRow("evidence:1", "command_result", "succeeded"),
      evidenceRow("evidence:2", "tool_result", "succeeded", "job:someone_else"),
    ), "subject_mismatch");
  });
});

describe("claim outcome compatibility", () => {
  it.each([
    ["observed", "observed", "accepted"],
    ["observed", "succeeded", "accepted"],
    ["observed", "failed", "rejected"],
    ["observed", "interrupted", "rejected"],
    ["observed", "denied", "rejected"],
    ["failed", "observed", "rejected"],
    ["failed", "succeeded", "rejected"],
    ["failed", "failed", "accepted"],
    ["failed", "interrupted", "accepted"],
    ["failed", "denied", "accepted"],
  ] as const)("declared %s with evidence %s is %s", (claimOutcome, evidenceOutcome, expected) => {
    const validation = validateControllerFinalization(
      claimFinalization({ kind: "execution_result", outcome: claimOutcome }),
      contextWithEvidence(evidenceRow("evidence:1", "command_result", evidenceOutcome)),
    );
    expect(validation.outcome).toBe(expected);
    if (expected === "rejected") expect(validation).toMatchObject({ code: "proof_incompatible" });
  });

  // A high-impact assertion inside a claim segment used to have its wording
  // ignored entirely: only the plain-text runs between claims were screened. So
  // "I implemented the fix" could be declared observed_state and proved by
  // having looked at the project.
  it.each([
    ["an implementation", "I implemented the fix.", "workspace_change"],
    ["a fix", "The fix is complete.", "workspace_change"],
    ["a test run", "The tests passed.", "execution_result"],
    ["a completed review", "The review is approved.", "pipeline_outcome"],
    ["a merge", "I merged the branch.", "pipeline_outcome"],
    ["a deployment", "The deployment is live.", "pipeline_outcome"],
    ["a credential rotation", "I rotated the credentials.", "external_mutation"],
    ["a spend", "I spent $40.", "external_mutation"],
    ["a purchase", "I purchased the service.", "external_mutation"],
  ] as const)("refuses %s asserted under observed_state", (_scenario, text, _required) => {
    expectRejection(
      claimFinalization({ kind: "observed_state", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
      "proof_incompatible",
    );
  });

  it.each([
    ["an implementation", "I implemented the fix.", "workspace_change", "workspace_change"],
    ["a test run", "The tests passed.", "execution_result", "command_result"],
    ["a merge", "I merged the branch.", "pipeline_outcome", "pipeline_outcome"],
    ["a credential rotation", "I rotated the credentials.", "external_mutation", "external_mutation"],
  ] as const)("accepts %s asserted under its own claim kind", (_scenario, text, kind, proofKind) => {
    expect(validateControllerFinalization(
      claimFinalization({ kind, outcome: "succeeded", text, subjectRef: "job:job_1" }),
      contextWithEvidence(evidenceRow("evidence:1", proofKind, "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["deleting", "I deleted the files.", "workspace_change", "workspace_change"],
    ["deleting externally", "I deleted the resources.", "external_mutation", "external_mutation"],
    ["installing", "I installed the dependencies.", "workspace_change", "workspace_change"],
    ["installing externally", "I installed the service.", "external_mutation", "external_mutation"],
  ] as const)("accepts %s under either of its two admissible kinds", (_scenario, text, kind, proofKind) => {
    expect(validateControllerFinalization(
      claimFinalization({ kind, outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", proofKind, "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it("refuses deleting asserted as a pipeline outcome", () => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text: "I deleted the files." }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
  });

  it.each([
    ["a question", "Did the tests pass?"],
    ["a negation", "The tests did not pass."],
    ["a failure", "The tests failed."],
    ["an intention", "I will run the tests."],
    ["a hedge", "The tests may have passed."],
  ] as const)("leaves %s outside the high-impact claim screen", (_scenario, text) => {
    expect(validateControllerFinalization(
      claimFinalization({ kind: "observed_state", outcome: "observed", text }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["the exact permission-path sentence", "Ran the tests you allowed; one project is in scope."],
    ["a bare subject-elided assertion", "Ran the tests."],
    ["a subject-elided assertion with no trailing stop", "Ran the tests"],
    ["a subject-led past tense", "I ran the tests."],
    ["a subject-led present perfect", "We have run the unit tests."],
    ["an assertion trailing another clause", "The build is green and I ran the tests."],
    ["an assertion leading another clause", "Ran the tests, then read the project."],
  ] as const)("refuses %s asserted under observed_state", (_scenario, text) => {
    expectRejection(
      claimFinalization({ kind: "observed_state", outcome: "observed", text }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
      "proof_incompatible",
    );
  });

  it("accepts a subject-elided test run filed as an execution result", () => {
    expect(validateControllerFinalization(
      claimFinalization({
        kind: "execution_result",
        outcome: "succeeded",
        text: "Ran the tests you allowed.",
      }),
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["a question", "Ran the tests?"],
    ["a negation", "I did not run the tests."],
    ["a future intention", "I will run the tests."],
    ["a hedge", "I may have run the tests."],
  ] as const)("leaves %s about a test run outside the screen", (_scenario, text) => {
    expect(validateControllerFinalization(
      claimFinalization({ kind: "observed_state", outcome: "observed", text }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it("leaves an unrelated use of the word run alone", () => {
    // "run" is an ordinary verb; only a claim to have run tests is high impact.
    expect(validateControllerFinalization(
      claimFinalization({
        kind: "observed_state",
        outcome: "observed",
        text: "The job is still running the build.",
      }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["a test run", "The tests passed.", "execution_result", "command_result"],
    ["an implementation", "I implemented the fix.", "workspace_change", "workspace_change"],
    ["a merge", "I merged the branch.", "pipeline_outcome", "pipeline_outcome"],
    ["a credential rotation", "I rotated the credentials.", "external_mutation", "external_mutation"],
  ] as const)("refuses %s asserted under a non-succeeded outcome", (_scenario, text, kind, proofKind) => {
    // The right kind is not enough: success wording under a failed, observed, or
    // uncertain declaration is still a success claim the declaration disowns.
    for (const outcome of ["failed", "observed", "uncertain"] as const) {
      expectRejection(
        claimFinalization({ kind, outcome, text, evidenceRefs: ["evidence:1"] }),
        contextWithEvidence(evidenceRow("evidence:1", proofKind, outcome === "failed" ? "failed" : "observed")),
        "proof_incompatible",
      );
    }
    expect(validateControllerFinalization(
      claimFinalization({ kind, outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", proofKind, "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it("keeps genuinely negative wording compatible with a failed outcome", () => {
    expect(validateControllerFinalization(
      claimFinalization({
        kind: "execution_result",
        outcome: "failed",
        text: "The tests failed.",
      }),
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "failed")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["text then claim", [
      { type: "text" as const, text: "The fix is imple" },
      { type: "claim" as const, text: "mented.", kind: "uncertainty" as const, outcome: "uncertain" as const,
        subjectRef: "job:job_1", evidenceRefs: ["evidence:1" as const] },
    ]],
    ["claim then text", [
      { type: "claim" as const, text: "The fix is imple", kind: "uncertainty" as const, outcome: "uncertain" as const,
        subjectRef: "job:job_1", evidenceRefs: ["evidence:1" as const] },
      { type: "text" as const, text: "mented." },
    ]],
    ["claim then claim", [
      { type: "claim" as const, text: "The fix is imple", kind: "uncertainty" as const, outcome: "uncertain" as const,
        subjectRef: "job:job_1", evidenceRefs: ["evidence:1" as const] },
      { type: "claim" as const, text: "mented.", kind: "uncertainty" as const, outcome: "uncertain" as const,
        subjectRef: "job:job_1", evidenceRefs: ["evidence:1" as const] },
    ]],
    ["three segments", [
      { type: "text" as const, text: "The fix is " },
      { type: "claim" as const, text: "imple", kind: "uncertainty" as const, outcome: "uncertain" as const,
        subjectRef: "job:job_1", evidenceRefs: ["evidence:1" as const] },
      { type: "text" as const, text: "mented." },
    ]],
  ])("refuses a high-impact assertion split across %s", (_scenario, segments) => {
    // The owner reads the concatenation, so that is what must be proved.
    expectRejection(
      { disposition: "answered", segments, obligationRefs: [] },
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
      "proof_incompatible",
    );
  });

  it("does not let a legitimate assertion elsewhere mask a split one", () => {
    expectRejection(
      {
        disposition: "answered",
        segments: [
          {
            type: "claim", text: "I implemented the fix.", kind: "workspace_change", outcome: "succeeded",
            subjectRef: "job:job_1", evidenceRefs: ["evidence:1"],
          },
          { type: "text", text: " The fix is imple" },
          {
            type: "claim", text: "mented.", kind: "uncertainty", outcome: "uncertain",
            subjectRef: "job:job_1", evidenceRefs: ["evidence:1"],
          },
        ],
        obligationRefs: [],
      },
      contextWithEvidence(evidenceRow("evidence:1", "workspace_change", "succeeded")),
      "proof_incompatible",
    );
  });

  it("does not let an earlier legitimate occurrence mask a later split one", () => {
    // The same wording twice in one clause: the first occurrence is properly
    // carried, and scanning only the first would let the second slip past.
    expectRejection(
      {
        disposition: "answered",
        segments: [
          {
            type: "claim", text: "The tests passed, ", kind: "execution_result", outcome: "succeeded",
            subjectRef: "job:job_1", evidenceRefs: ["evidence:1"],
          },
          { type: "text", text: "the tests pa" },
          {
            type: "claim", text: "ssed.", kind: "uncertainty", outcome: "uncertain",
            subjectRef: "job:job_1", evidenceRefs: ["evidence:1"],
          },
        ],
        obligationRefs: [],
      },
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
      "proof_incompatible",
    );
  });

  it.each([
    ["a negated sibling", "I did not deploy staging, I deployed production."],
    ["a failed sibling", "The staging deploy failed, I deployed production."],
    ["a future sibling", "I will deploy staging, I deployed production."],
    ["an uncertain sibling", "Staging may be stale, I deployed production."],
    ["a negated sibling before a test run", "I did not run the linter, the tests passed."],
  ] as const)("does not let %s vouch for the success beside it", (_scenario, text) => {
    // Polarity belongs to the sibling that carries the wording. A comma does not
    // let "I did not deploy staging" speak for "I deployed production".
    expectRejection(
      claimFinalization({ kind: "observed_state", outcome: "observed", text }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
      "proof_incompatible",
    );
    expectRejection(
      textFinalization(text),
      emptyFinalizationContext(),
      "high_impact_text_unclaimed",
    );
  });

  it.each([
    ["a comma", "Staging failed, production is live."],
    ["a colon", "Staging failed: production is live."],
    ["an em dash", "Staging failed — production is live."],
    ["an en dash", "Staging failed – production is live."],
    ["a semicolon", "Staging failed; production is live."],
    ["a colon before a test run", "Linting failed: the tests passed."],
  ] as const)("does not let a failure before %s vouch for the success after it", (_scenario, text) => {
    expectRejection(
      claimFinalization({ kind: "observed_state", outcome: "observed", text }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
      "proof_incompatible",
    );
    expectRejection(textFinalization(text), emptyFinalizationContext(), "high_impact_text_unclaimed");
  });

  it.each([
    ["a negation after a colon", "Note: I did not deploy production."],
    ["a hedge after an em dash", "Checked staging — production may be live."],
    ["a future after a semicolon", "Staging is ready; I will deploy production."],
    ["a question after a colon", "One thing: did the tests pass?"],
  ] as const)("still accepts %s", (_scenario, text) => {
    expect(validateControllerFinalization(
      claimFinalization({ kind: "observed_state", outcome: "observed", text }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["a colon", "The tests passed: what should I do next?"],
    ["an em dash", "The tests passed — what should I do next?"],
    ["an en dash", "The tests passed – what should I do next?"],
    ["a semicolon", "The tests passed; what should I do next?"],
    ["a comma", "The tests passed, what should I do next?"],
    // A positive modal beside a positive assertion is an unrelated elliptical
    // question, not a tag: English tags a positive statement negatively.
    ["a positive modal", "The tests passed, should I?"],
    ["another positive modal", "The tests passed, could I?"],
    ["a positive auxiliary", "The tests passed, will they?"],
    ["a bare positive auxiliary", "The tests passed, did they?"],
    // Negative shape alone is not agreement: the tag has to match the subject
    // and tense of the assertion it claims to be asking about.
    ["a mismatched subject", "The tests passed, didn't I?"],
    ["a mismatched modal", "The tests passed, shouldn't I?"],
    ["another mismatched modal", "The tests passed, couldn't I?"],
    ["a mismatched subject on an implementation", "I implemented the fix, didn't they?"],
    ["a mismatched tense on a deployment", "The deployment is live, didn't it?"],
    ["a mismatched subject on an elided assertion", "Ran the tests, didn't it?"],
  ] as const)("does not let an unrelated question after %s suppress the success", (_scenario, text) => {
    expectRejection(textFinalization(text), emptyFinalizationContext(), "high_impact_text_unclaimed");
    expectRejection(
      claimFinalization({ kind: "observed_state", outcome: "observed", text }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
      "proof_incompatible",
    );
  });

  it.each([
    ["a bare tag question", "The tests passed, right?"],
    ["a confirming tag", "The tests passed, correct?"],
    ["a plural tag", "The tests passed, didn't they?"],
    ["a perfect-aspect tag", "The tests passed, haven't they?"],
    ["a first-person tag", "I implemented the fix, didn't I?"],
    ["a curly-apostrophe tag", "The tests passed, haven\u2019t they?"],
    ["a modal tag", "The deployment is live, isn't it?"],
    ["an inverted-order negative tag", "The deployment is live, is it not?"],
    ["a tag on a subject-elided assertion", "Ran the tests, didn't I?"],
    ["a plural-subject tag", "The credentials are rotated, aren't they?"],
    ["a question about the assertion itself", "Did the tests pass?"],
    ["a question in the asserting part", "The tests passed?"],
  ] as const)("still accepts %s", (_scenario, text) => {
    expect(validateControllerFinalization(
      claimFinalization({ kind: "observed_state", outcome: "observed", text }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["a question spanning siblings", "The tests passed, right?"],
    ["a negation in the same sibling", "I did not deploy production."],
    ["a future in the same sibling", "I will deploy production."],
    ["a hedge in the same sibling", "The deployment may be live."],
  ] as const)("still accepts %s", (_scenario, text) => {
    expect(validateControllerFinalization(
      claimFinalization({ kind: "observed_state", outcome: "observed", text }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it("accepts a high-impact assertion wholly inside one compatible succeeded claim", () => {
    expect(validateControllerFinalization(
      {
        disposition: "answered",
        segments: [
          { type: "text", text: "Good news. " },
          {
            type: "claim", text: "I implemented the fix.", kind: "workspace_change", outcome: "succeeded",
            subjectRef: "job:job_1", evidenceRefs: ["evidence:1"],
          },
          { type: "text", text: " Anything else?" },
        ],
        obligationRefs: [],
      },
      contextWithEvidence(evidenceRow("evidence:1", "workspace_change", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it("leaves ordinary multi-segment prose alone", () => {
    expect(validateControllerFinalization(
      {
        disposition: "answered",
        segments: [
          { type: "text", text: "The project has " },
          {
            type: "claim", text: "three worker profiles", kind: "observed_state", outcome: "observed",
            subjectRef: "job:job_1", evidenceRefs: ["evidence:1"],
          },
          { type: "text", text: " configured." },
        ],
        obligationRefs: [],
      },
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it("screens a clause joined by a conjunction, not only a new sentence", () => {
    expectRejection(
      claimFinalization({
        kind: "observed_state",
        outcome: "succeeded",
        text: "The project is configured and I merged the branch.",
      }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
      "proof_incompatible",
    );
  });

  it("refuses a high-impact assertion filed as uncertainty", () => {
    // Hedged wording is already excluded by the non-success controls, so a claim
    // reaching here asserts the merge outright whatever kind it declares.
    expectRejection(
      claimFinalization({ kind: "uncertainty", outcome: "succeeded", text: "I merged the branch." }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
  });

  it("screens each clause of a claim separately", () => {
    // The state reading is fine; the merge riding along beside it is not.
    expectRejection(
      claimFinalization({
        kind: "observed_state",
        outcome: "succeeded",
        text: "The project is configured. I merged the branch.",
      }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
      "proof_incompatible",
    );
  });

  it("still accepts an ordinary project-state reading", () => {
    expect(validateControllerFinalization(
      claimFinalization({
        kind: "observed_state",
        outcome: "observed",
        text: "The project has three configured worker profiles.",
      }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["observed_state", "project_state"],
    ["pipeline_outcome", "pipeline_outcome"],
    ["health_assessment", "health_snapshot"],
  ] as const)("allows current observation to support successful %s", (kind, proofKind) => {
    expect(validateControllerFinalization(
      claimFinalization({ kind, outcome: "succeeded" }),
      contextWithEvidence(evidenceRow("evidence:1", proofKind, "observed")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["execution_result", "command_result"],
    ["workspace_change", "workspace_change"],
    ["external_mutation", "external_mutation"],
  ] as const)("requires succeeded evidence for successful %s", (kind, proofKind) => {
    expectRejection(
      claimFinalization({ kind, outcome: "succeeded" }),
      contextWithEvidence(evidenceRow("evidence:1", proofKind, "observed")),
      "proof_incompatible",
    );
    expect(validateControllerFinalization(
      claimFinalization({ kind, outcome: "succeeded" }),
      contextWithEvidence(evidenceRow("evidence:1", proofKind, "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each(["failed", "interrupted", "denied"] as const)(
    "rejects a negative %s row in an otherwise successful multi-row claim",
    (negativeOutcome) => {
      const candidate = claimFinalization({
        kind: "execution_result",
        outcome: "succeeded",
        evidenceRefs: ["evidence:1", "evidence:2"],
      });
      expectRejection(candidate, contextWithEvidence(
        evidenceRow("evidence:1", "command_result", "succeeded"),
        evidenceRow("evidence:2", "tool_result", negativeOutcome),
      ), "proof_incompatible");
    },
  );

  it("accepts an uncertain declaration backed by a current observation", () => {
    expect(validateControllerFinalization(
      claimFinalization({ kind: "uncertainty", outcome: "uncertain" }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it("requires a declared uncertainty or negative evidence for the uncertainty kind", () => {
    expectRejection(
      claimFinalization({ kind: "uncertainty", outcome: "observed" }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
      "proof_incompatible",
    );
    expect(validateControllerFinalization(
      claimFinalization({ kind: "uncertainty", outcome: "failed" }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "failed")),
    )).toMatchObject({ outcome: "accepted" });
  });
});

describe("bounded text heuristics", () => {
  it.each([
    "I'll check this.",
    "Let me look into it.",
    "I will investigate.",
    "I'll work on this.",
    "I'll try.",
    "I'll get back to you.",
    "I'll follow up.",
    "I'll check the logs.",
    "I'll look into the current job.",
    "I'll work on the migration.",
    "I’ll investigate and get back to you.",
    "I'll investigate. I'll get back to you.",
  ])("rejects process-only statement: %s", (text) => {
    expectRejection(textFinalization(text), emptyFinalizationContext(), "process_only");
  });

  it.each([
    "SQLite looks appropriate for this scale.",
    "I checked the options; SQLite is the simplest choice.",
    "Should I investigate the deployment history?",
    "I can investigate if you want me to.",
    "I'll investigate. SQLite is the simplest choice.",
    "I'll investigate. Should I follow up?",
  ])("does not broaden process-only detection to: %s", (text) => {
    expect(validateControllerFinalization(textFinalization(text), emptyFinalizationContext()))
      .toMatchObject({ outcome: "accepted" });
  });

  it.each([
    "I'll follow up with the measured result.",
    "I'll investigate and follow up with the measured result.",
    "I will get back to you when the monitor fires.",
    "Let me follow up once the job completes.",
    "After the monitor fires, I'll get back to you with the measured result.",
  ])("accepts controller-owned concrete deferred follow-up: %s", (text) => {
    const candidate: ControllerFinalization = {
      disposition: "deferred",
      segments: [{ type: "text", text }],
      obligationRefs: ["obligation:1"],
    };
    expect(validateControllerFinalization(candidate, emptyFinalizationContext({
      liveObligationRefs: new Set(["obligation:1"]),
    }))).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    "I'll try.",
    "I'll investigate and follow up.",
    "I'll get back to you.",
    "I won't follow up with the measured result.",
    "I will not follow up with the measured result.",
    "You can follow up with the measured result.",
    "It might follow up with the measured result.",
    "I'll investigate, then I'll get back to you.",
  ])("rejects deferred process intent without concrete follow-up: %s", (text) => {
    const candidate: ControllerFinalization = {
      disposition: "deferred",
      segments: [{ type: "text", text }],
      obligationRefs: ["obligation:1"],
    };
    expectRejection(
      candidate,
      emptyFinalizationContext({ liveObligationRefs: new Set(["obligation:1"]) }),
      "process_only",
    );
  });

  it("rejects process-only intent split across adjacent segments", () => {
    const candidate: ControllerFinalization = {
      disposition: "answered",
      segments: [
        { type: "text", text: "I'll investigate." },
        { type: "text", text: " I'll get back to you." },
      ],
      obligationRefs: [],
    };
    expectRejection(candidate, emptyFinalizationContext(), "process_only");
  });

  it.each([
    "I implemented the fix.",
    "The tests passed.",
    "The review is complete.",
    "The pull request was merged.",
    "I deployed the service to production.",
    "I deleted the stale records.",
    "I installed the package.",
    "I rotated the credentials.",
    "I spent five hundred dollars on the migration.",
    "I deployed production, and I will monitor it.",
    "I did not deploy staging, but I deployed production.",
    "I deployed production, which I will monitor.",
    "The fix is implemented.",
    "The test suite was passed.",
    "We approved the review.",
    "The branch was merged.",
    "Production was deployed.",
    "We deleted the stale records.",
    "The package was installed.",
    "We rotated the credentials.",
    "We paid USD 500 for the service.",
    "We purchased the deployment service.",
    "The credentials were rotated.",
    "USD 500 was spent on the service.",
    "The tests were completed.",
    "I can confirm the fix is implemented.",
  ])("rejects unclaimed high-impact assertion: %s", (text) => {
    expectRejection(textFinalization(text), emptyFinalizationContext(), "high_impact_text_unclaimed");
  });

  it.each([
    "Should I deploy the service?",
    "I did not deploy the service.",
    "I will deploy the service after approval.",
    "The deployment failed.",
    "The deployment may have succeeded, but I am uncertain.",
    "We could install the package later.",
    "Please do not delete those records.",
    "The review is not complete.",
    "I removed ambiguity from the explanation.",
    "We paid attention to the details.",
    "Should the package be installed?",
    "The records were not deleted.",
    "We will purchase the service after approval.",
    "Can you confirm whether the fix is implemented?",
    "I don't think the fix is implemented.",
    "It seems the fix is implemented.",
  ])("does not treat non-success text as a high-impact success: %s", (text) => {
    expect(validateControllerFinalization(textFinalization(text), emptyFinalizationContext()))
      .toMatchObject({ outcome: "accepted" });
  });

  it("rejects a completed assertion split across adjacent text segments", () => {
    const candidate: ControllerFinalization = {
      disposition: "answered",
      segments: [
        { type: "text", text: "The fix is imple" },
        { type: "text", text: "mented." },
      ],
      obligationRefs: [],
    };
    expectRejection(candidate, emptyFinalizationContext(), "high_impact_text_unclaimed");
  });

  it("does not let a claim boundary launder an assertion the owner still reads whole", () => {
    const candidate: ControllerFinalization = {
      disposition: "answered",
      segments: [
        { type: "text", text: "The fix is imple" },
        claimFinalization({ kind: "uncertainty", outcome: "uncertain", text: "mented." }).segments[0],
      ],
      obligationRefs: [],
    };
    // The owner reads "The fix is implemented." however it was assembled.
    expect(validateControllerFinalization(candidate, contextWithEvidence(
      evidenceRow("evidence:1", "project_state"),
    ))).toMatchObject({ outcome: "rejected", code: "proof_incompatible" });
  });

  it("allows a high-impact assertion when it is carried by a compatible claim segment", () => {
    expect(validateControllerFinalization(
      claimFinalization({
        kind: "pipeline_outcome",
        outcome: "succeeded",
        text: "The deployment succeeded in production.",
      }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });
});

describe("fixed corrections", () => {
  it("returns bounded code-specific corrections without interpolating candidate or evidence strings", () => {
    const missingRefCandidate = claimFinalization({
      subjectRef: "job:private_subject",
      evidenceRefs: ["evidence:987654"],
    });
    const first = validateControllerFinalization(missingRefCandidate, emptyFinalizationContext());
    const second = validateControllerFinalization(
      claimFinalization({ subjectRef: "job:other_subject", evidenceRefs: ["evidence:42"] }),
      emptyFinalizationContext(),
    );
    expect(first).toMatchObject({ outcome: "rejected", code: "evidence_missing" });
    expect(second).toMatchObject({ outcome: "rejected", code: "evidence_missing" });
    if (first.outcome !== "rejected" || second.outcome !== "rejected") throw new Error("expected rejection");
    expect(first.correction).toBe(second.correction);
    expect(first.correction.length).toBeLessThanOrEqual(256);
    expect(first.correction).not.toMatch(/private_subject|987654/);
  });

  it("returns a distinct bounded correction for every rejection code", () => {
    const ordinary = textFinalization("candidate-marker");
    const wrongSubject = evidenceRow("evidence:1", "project_state", "observed", "evidence-marker");
    const cases: readonly [string, ReturnType<typeof validateControllerFinalization>][] = [
      ["invalid_contract", validateControllerFinalization({ invalid: "candidate-marker" }, emptyFinalizationContext())],
      ["accepted_already", validateControllerFinalization(ordinary, emptyFinalizationContext({ acceptedAlready: true }))],
      ["revision_limit", validateControllerFinalization(ordinary, emptyFinalizationContext({ revisionCount: 8 }))],
      ["evidence_limit_exceeded", validateControllerFinalization(ordinary, emptyFinalizationContext({ evidenceLimitExceeded: true }))],
      ["duplicate_evidence_reference", validateControllerFinalization(
        claimFinalization({ evidenceRefs: ["evidence:1", "evidence:1"] }),
        contextWithEvidence(evidenceRow("evidence:1", "project_state")),
      )],
      ["evidence_missing", validateControllerFinalization(claimFinalization(), emptyFinalizationContext())],
      ["subject_mismatch", validateControllerFinalization(claimFinalization(), contextWithEvidence(wrongSubject))],
      ["proof_incompatible", validateControllerFinalization(
        claimFinalization({ kind: "execution_result" }),
        contextWithEvidence(evidenceRow("evidence:1", "project_state")),
      )],
      ["owner_boundary_missing", validateControllerFinalization({
        disposition: "needs_owner",
        segments: [{ type: "text", text: "Choose a region." }],
        obligationRefs: [],
      }, emptyFinalizationContext())],
      ["obligation_forbidden", validateControllerFinalization({
        disposition: "answered",
        segments: [{ type: "text", text: "The answer is complete." }],
        obligationRefs: ["obligation:1"],
      }, emptyFinalizationContext())],
      ["obligation_missing", validateControllerFinalization({
        disposition: "deferred",
        segments: [{ type: "text", text: "I'll follow up with the result." }],
        obligationRefs: [],
      }, emptyFinalizationContext())],
      ["obligation_not_live", validateControllerFinalization({
        disposition: "deferred",
        segments: [{ type: "text", text: "I'll follow up with the result." }],
        obligationRefs: ["obligation:1"],
      }, emptyFinalizationContext())],
      ["process_only", validateControllerFinalization(textFinalization("I'll investigate."), emptyFinalizationContext())],
      ["high_impact_text_unclaimed", validateControllerFinalization(
        textFinalization("The fix is implemented."),
        emptyFinalizationContext(),
      )],
    ];

    const corrections = cases.map(([expectedCode, validation]) => {
      expect(validation).toMatchObject({ outcome: "rejected", code: expectedCode });
      if (validation.outcome !== "rejected") throw new Error("expected rejection");
      expect(validation.correction.length).toBeGreaterThan(0);
      expect(validation.correction.length).toBeLessThanOrEqual(256);
      expect(validation.correction).not.toMatch(/candidate-marker|evidence-marker/);
      return validation.correction;
    });
    expect(new Set(corrections).size).toBe(FINALIZATION_REJECTION_CODES.length);
  });
});

describe("tag agreement across subjects and auxiliaries", () => {
  const AUXILIARIES = ["is", "are", "was", "were", "has", "have", "had", "did"] as const;
  const PRONOUNS = ["i", "we", "it", "they"] as const;
  const PRONOUN_TEXT: Record<(typeof PRONOUNS)[number], string> = {
    i: "I", we: "we", it: "it", they: "they",
  };

  // Written out rather than derived from the implementation, so the table is an
  // independent statement of which pair confirms which assertion.
  const CASES: [string, string[]][] = [
    ["I implemented the fix", ["did i"]],
    ["We shipped the change", ["did we"]],
    ["Ran the tests", ["did i"]],
    ["The tests passed", ["did they", "have they"]],
    ["The deployment is live", ["is it"]],
    ["The credentials are rotated", ["are they"]],
    ["The fix has been implemented", ["has it"]],
    ["The credentials have been rotated", ["have they"]],
    ["The fix had been implemented", ["had it"]],
  ];

  it.each(CASES)("accepts only the agreeing pair for %s", (assertion, allowed) => {
    const context = contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed"));
    for (const auxiliary of AUXILIARIES) {
      for (const pronoun of PRONOUNS) {
        const tag = `${auxiliary}n't ${PRONOUN_TEXT[pronoun]}?`;
        const text = `${assertion}, ${tag}`;
        const expected = allowed.includes(`${auxiliary} ${pronoun}`) ? "accepted" : "rejected";
        expect([text, validateControllerFinalization(
          claimFinalization({ kind: "observed_state", outcome: "observed", text }), context,
        ).outcome]).toEqual([text, expected]);
      }
    }
  });

  it("never lets a plural subject take a singular perfect auxiliary", () => {
    for (const assertion of ["The tests passed", "The credentials have been rotated"]) {
      expectRejection(
        textFinalization(`${assertion}, hasn't they?`),
        emptyFinalizationContext(),
        "high_impact_text_unclaimed",
      );
    }
  });
});

describe("source-preserving clause offsets", () => {
  const observed = () => contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed"));

  it.each([
    ["a curly mismatched tag", "The tests passed, shouldn\u2019t I?"],
    ["a curly mismatched subject", "The tests passed, didn\u2019t I?"],
    ["a newline before more prose", "The tests passed\nAnything else"],
    ["a carriage return before more prose", "The tests passed\r\nAnything else"],
    ["a curly tag after a newline", "Work is done\nThe tests passed, shouldn\u2019t I?"],
  ] as const)("screens %s on the incompatible-claim path", (_scenario, text) => {
    // Normalization must never move the offsets used to locate a clause in the
    // original, or the clause is silently skipped and nothing is screened.
    expectRejection(
      claimFinalization({ kind: "observed_state", outcome: "observed", text }),
      observed(),
      "proof_incompatible",
    );
  });

  it.each([
    ["a curly mismatched tag", "The tests passed, shouldn\u2019t I?"],
    ["a newline before more prose", "The tests passed\nAnything else"],
    ["a carriage return before more prose", "The tests passed\r\nAnything else"],
  ] as const)("screens %s on the plain-text path", (_scenario, text) => {
    expectRejection(textFinalization(text), emptyFinalizationContext(), "high_impact_text_unclaimed");
  });

  it("keeps a curly agreeing tag accepted, exactly as its ASCII spelling is", () => {
    for (const text of ["The tests passed, didn't they?", "The tests passed, didn\u2019t they?"]) {
      expect(validateControllerFinalization(
        claimFinalization({ kind: "observed_state", outcome: "observed", text }), observed(),
      )).toMatchObject({ outcome: "accepted" });
    }
  });

  it("screens each occurrence of a repeated clause against its own tag", () => {
    // Recovering an offset by searching for the clause text would find the first
    // occurrence twice and never reach the mismatched second one.
    const observedContext = contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed"));
    expect(validateControllerFinalization(
      claimFinalization({
        kind: "observed_state", outcome: "observed",
        text: "The tests passed, didn't they? The tests passed, didn't they?",
      }), observedContext,
    )).toMatchObject({ outcome: "accepted" });
    expectRejection(
      claimFinalization({
        kind: "observed_state", outcome: "observed",
        text: "The tests passed, didn't they? The tests passed, shouldn't I?",
      }),
      observedContext,
      "proof_incompatible",
    );
  });

  it("screens a repeated identical clause at each of its own positions", () => {
    // Recovering an offset by searching for the clause text would find the first
    // occurrence twice and never reach the second.
    expectRejection(
      {
        disposition: "answered",
        segments: [
          { type: "claim", text: "The tests passed. The tests passed.", kind: "execution_result",
            outcome: "succeeded", subjectRef: "job:job_1", evidenceRefs: ["evidence:1"] },
          { type: "text", text: " The tests pa" },
          { type: "claim", text: "ssed.", kind: "uncertainty", outcome: "uncertain",
            subjectRef: "job:job_1", evidenceRefs: ["evidence:1"] },
        ],
        obligationRefs: [],
      },
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
      "proof_incompatible",
    );
  });
});

describe("nominal number from agreement and head noun", () => {
  const plain = (text: string) => validateControllerFinalization(
    textFinalization(text), emptyFinalizationContext()).outcome;

  it.each([
    ["a multiword plural with past be", "The API keys were rotated", "weren't they?", "wasn't it?"],
    ["a multiword plural with perfect", "The API keys have been rotated", "haven't they?", "hasn't it?"],
    ["an irregular plural with past be", "The data were deleted", "weren't they?", "wasn't it?"],
    ["a multiword plural in simple past", "The unit tests passed", "didn't they?", "didn't it?"],
    ["a multiword singular with present be", "The release deployment is live", "isn't it?", "aren't they?"],
    ["a multiword singular in simple past", "The unit test passed", "didn't it?", "didn't they?"],
  ] as const)("reads %s", (_scenario, assertion, agreeing, mismatched) => {
    expect([assertion, agreeing, plain(`${assertion}, ${agreeing}`)])
      .toEqual([assertion, agreeing, "accepted"]);
    expect([assertion, mismatched, plain(`${assertion}, ${mismatched}`)])
      .toEqual([assertion, mismatched, "rejected"]);
  });

  it.each([
    ["inverted order", "The API keys were rotated, were they not?", "accepted"],
    ["inverted mismatched order", "The API keys were rotated, was it not?", "rejected"],
    ["curly contracted", "The API keys were rotated, weren\u2019t they?", "accepted"],
    ["curly contracted mismatch", "The API keys were rotated, wasn\u2019t it?", "rejected"],
  ] as const)("reads a multiword plural with %s", (_scenario, text, expected) => {
    expect([text, plain(text)]).toEqual([text, expected]);
  });
});
