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

  it("stops plain-text assertion concatenation at claim boundaries", () => {
    const candidate: ControllerFinalization = {
      disposition: "answered",
      segments: [
        { type: "text", text: "The fix is imple" },
        claimFinalization({ kind: "uncertainty", outcome: "uncertain", text: "mented." }).segments[0],
      ],
      obligationRefs: [],
    };
    expect(validateControllerFinalization(candidate, contextWithEvidence(
      evidenceRow("evidence:1", "project_state"),
    ))).toMatchObject({ outcome: "accepted" });
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
