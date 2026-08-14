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
  pipeline_outcome: ["pipeline_outcome", "production_outcome"],
  health_assessment: ["health_snapshot"],
  uncertainty: CONTROLLER_PROOF_KINDS,
};

function emptyFinalizationContext(
  overrides: Partial<ControllerFinalizationValidationContext> = {},
): ControllerFinalizationValidationContext {
  return {
    acceptedAlready: false,
    invocationInFlight: false,
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
      "invocation_in_flight",
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
    ["operation callback", `o:${"b".repeat(32)}`],
    ["question callback", `q:${"c".repeat(32)}`],
    ["controller interaction callback", `i:${"d".repeat(32)}`],
    ["thread interaction callback", `w:${"e".repeat(32)}`],
    ["encoded callback", `m%3A${"b".repeat(32)}`],
    ["encoded operation callback", `o%3A${"c".repeat(32)}`],
    ["encoded question callback", `q%3A${"d".repeat(32)}`],
    ["encoded controller interaction callback", `i%3A${"e".repeat(32)}`],
    ["encoded thread interaction callback", `w%3A${"f".repeat(32)}`],
    ["repeatedly encoded callback", `m%25253A${"c".repeat(32)}`],
  ])("rejects and erases %s material", (_label, unsafeToken) => {
    const unsafeText = `Internal material: ${unsafeToken}`;
    const validation = validateControllerFinalization(textFinalization(unsafeText), emptyFinalizationContext());
    expect(validation).toMatchObject({ outcome: "rejected", code: "invalid_contract" });
    expect(JSON.stringify(validation)).not.toContain(unsafeToken);
    expect(JSON.stringify(validation)).not.toContain(unsafeText);
  });

  it.each([
    ["GitHub token", `ghp_${"A".repeat(32)}`],
    ["AWS access key", `AKIA${"7".repeat(16)}`],
    ["provider key", `sk-proj-${"B".repeat(24)}`],
    ["Telegram bot token", `1234567890:${"C".repeat(35)}`],
    ["private-key material", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"],
    ["nested encoded provider key", encodeURIComponent(encodeURIComponent(`Bearer rk-live-${"D".repeat(24)}`))],
  ])("rejects and erases %s before persistence", (_label, unsafeToken) => {
    const validation = validateControllerFinalization(
      claimFinalization({
        kind: "uncertainty",
        outcome: "uncertain",
        text: `Protected output: ${unsafeToken}`,
      }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state")),
    );
    expect(validation).toMatchObject({ outcome: "rejected", code: "invalid_contract" });
    expect(JSON.stringify(validation)).not.toContain(unsafeToken);
    expect(JSON.stringify(validation)).not.toContain(decodeURIComponent(decodeURIComponent(unsafeToken)));
  });

  it("scans rendered output across claim boundaries before accepting it", () => {
    const providerToken = `ghs_${"E".repeat(28)}`;
    const candidate: ControllerFinalization = {
      disposition: "answered",
      segments: [
        { type: "text", text: "Protected output: ghs_" },
        claimFinalization({
          kind: "uncertainty",
          outcome: "uncertain",
          text: "E".repeat(28),
        }).segments[0],
      ],
      obligationRefs: [],
    };
    const validation = validateControllerFinalization(candidate, contextWithEvidence(
      evidenceRow("evidence:1", "project_state"),
    ));
    expect(validation).toMatchObject({ outcome: "rejected", code: "invalid_contract" });
    expect(JSON.stringify(validation)).not.toContain(providerToken);
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

  it.each([
    ["base64 credential assignment", Buffer.from("api_key=TOP_SECRET_VALUE_12345", "utf8").toString("base64"), "api_key=TOP_SECRET_VALUE_12345"],
    ["base64url credential assignment", Buffer.from("api_key=TOP_SECRET_VALUE_12345", "utf8").toString("base64url"), "api_key=TOP_SECRET_VALUE_12345"],
    ["base64 bearer credential", Buffer.from(`Bearer ghp_${"G".repeat(28)}`, "utf8").toString("base64"), `Bearer ghp_${"G".repeat(28)}`],
  ])("rejects and erases bounded %s", (_label, encoded, decoded) => {
    const validation = validateControllerFinalization(
      textFinalization(`Encoded provider output: ${encoded}`),
      emptyFinalizationContext(),
    );
    const serialized = JSON.stringify(validation);

    expect(validation).toMatchObject({ outcome: "rejected", code: "invalid_contract" });
    expect(serialized).not.toContain(encoded);
    expect(serialized).not.toContain(decoded);
  });

  it("rejects base64 credential material split across rendered segments", () => {
    const decoded = "api_key=TOP_SECRET_VALUE_12345";
    const encoded = Buffer.from(decoded, "utf8").toString("base64url");
    const midpoint = Math.floor(encoded.length / 2);
    const candidate: ControllerFinalization = {
      disposition: "answered",
      segments: [
        { type: "text", text: "Encoded provider output: " + encoded.slice(0, midpoint) },
        claimFinalization({ kind: "uncertainty", outcome: "uncertain", text: encoded.slice(midpoint) }).segments[0],
      ],
      obligationRefs: [],
    };

    const validation = validateControllerFinalization(candidate, contextWithEvidence(
      evidenceRow("evidence:1", "project_state"),
    ));
    const serialized = JSON.stringify(validation);

    expect(validation).toMatchObject({ outcome: "rejected", code: "invalid_contract" });
    expect(serialized).not.toContain(encoded);
    expect(serialized).not.toContain(decoded);
  });

  it("uses the fixed projection when base64 credential material is in a non-text field", () => {
    const decoded = "api_key=TOP_SECRET_VALUE_12345";
    const encoded = Buffer.from(decoded, "utf8").toString("base64url");
    const candidate = claimFinalization({
      subjectRef: encoded,
    });

    const validation = validateControllerFinalization(candidate, emptyFinalizationContext());

    expect(validation).toMatchObject({
      outcome: "rejected",
      code: "invalid_contract",
      storedCandidate: textFinalization("[redacted]"),
    });
    expect(JSON.stringify(validation)).not.toContain(encoded);
    expect(JSON.stringify(validation)).not.toContain(decoded);
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

  it("does not treat merge-only pipeline evidence as production proof", () => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text: "Deployment succeeded." }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
  });

  it("does not let pipeline evidence prove an execution test claim", () => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text: "All tests passed." }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
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

  it("does not interpret an opaque delegation UUID as encoded credential text", () => {
    const ref = "delegation:del-20fdbb26-2c90-4bae-a60c-234895988d03";
    const candidate: ControllerFinalization = {
      disposition: "deferred",
      segments: [{ type: "text", text: "I'll follow up when the work finishes." }],
      obligationRefs: [ref],
    };
    expect(validateControllerFinalization(candidate, emptyFinalizationContext({
      liveObligationRefs: new Set([ref]),
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
    ["health_assessment", "health_snapshot"],
  ] as const)("allows current observation to support successful %s", (kind, proofKind) => {
    expect(validateControllerFinalization(
      claimFinalization({ kind, outcome: "succeeded" }),
      contextWithEvidence(evidenceRow("evidence:1", proofKind, "observed")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it("does not let an observed failed production outcome support a successful pipeline claim", () => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text: "The rollout succeeded." }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "observed")),
      "proof_incompatible",
    );
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

describe("fail-closed operational claim binding", () => {
  it.each([
    ["generic completion", "Everything is done."],
    ["build success", "The build succeeded."],
    ["CI success", "CI is green."],
    ["rollout success", "The rollout succeeded."],
    ["canary health", "The canary was healthy."],
    ["production canary", "Production canary passed."],
    ["finished work", "The work is finished."],
  ] as const)("rejects %s when declared as an observed state without its outcome", (_label, text) => {
    expectRejection(
      claimFinalization({ kind: "observed_state", outcome: "observed", text }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "observed")),
      "proof_incompatible",
    );
  });

  it.each([
    ["generic completion", "Everything is done.", "pipeline_outcome", "pipeline_outcome"],
    ["build success", "The build succeeded.", "execution_result", "command_result"],
    ["CI success", "CI is green.", "pipeline_outcome", "pipeline_outcome"],
    ["rollout success", "The rollout succeeded.", "pipeline_outcome", "production_outcome"],
    ["finished work", "The work is finished.", "pipeline_outcome", "pipeline_outcome"],
  ] as const)("accepts %s when its claim kind and evidence carry the assertion", (_label, text, kind, proofKind) => {
    expect(validateControllerFinalization(
      claimFinalization({ kind, outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", proofKind, "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    "Everything is done.",
    "The work is finished.",
  ])("does not treat one successful project-state observation as proof of total completion: %s", (text) => {
    expectRejection(
      claimFinalization({ kind: "observed_state", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state", "succeeded")),
      "proof_incompatible",
    );
  });

  it.each([
    "Everything is done.",
    "The build succeeded.",
    "CI is green.",
    "The rollout succeeded.",
    "The work is finished.",
    "Production is up.",
    "The release went out.",
  ])("rejects an unclaimed operational paraphrase: %s", (text) => {
    expectRejection(textFinalization(text), emptyFinalizationContext(), "high_impact_text_unclaimed");
  });

  it.each([
    "The fix is\nimplemented.",
    "The fix is\r\nimplemented.",
    "The build\nsucceeded.",
    "Everything is\ndone.",
  ])("does not let line boundaries split an operational assertion: %s", (text) => {
    expectRejection(textFinalization(text), emptyFinalizationContext(), "high_impact_text_unclaimed");
  });

  it("does not let a negative subordinate clause suppress an earlier success assertion", () => {
    expectRejection(
      textFinalization("The tests passed, although deployment failed."),
      emptyFinalizationContext(),
      "high_impact_text_unclaimed",
    );
  });

  it("does not let a negative because-clause suppress an earlier success assertion", () => {
    expectRejection(
      textFinalization("The tests passed because deployment failed."),
      emptyFinalizationContext(),
      "high_impact_text_unclaimed",
    );
  });

  it.each([
    ["a so-clause", "The deployment was not live so the tests passed."],
    ["an earlier negation", "The deployment was not live before the tests passed."],
    ["a question", "Did the deployment succeed?"],
    ["a so-clause after a negative predicate", "The tests did not fail so production is live."],
    ["a therefore-clause", "The canary did not fail therefore production is live."],
    ["a yet-clause", "The deployment was not blocked yet production is live."],
  ] as const)("keeps an affirmative assertion visible in %s", (_label, text) => {
    expectRejection(textFinalization(text), emptyFinalizationContext(), "high_impact_text_unclaimed");
  });

  it.each([
    "Can you inspect this, and the deployment succeeded.",
    "Could you note this: production is live.",
    "Can you confirm whether the fix is implemented?",
  ])("does not let a question-start suppress an operational assertion: %s", (text) => {
    expectRejection(
      textFinalization(text),
      emptyFinalizationContext(),
      "high_impact_text_unclaimed",
    );
  });

  it.each([
    "Working on it now.",
    "I'm working on it now.",
    "The work is in progress.",
  ])("rejects process-only wording even when carried by a claim: %s", (text) => {
    expectRejection(
      claimFinalization({ kind: "uncertainty", outcome: "uncertain", text }),
      contextWithEvidence(evidenceRow("evidence:1", "project_state")),
      "process_only",
    );
  });

  it("rejects an operational assertion split across a text and claim boundary", () => {
    const candidate: ControllerFinalization = {
      disposition: "answered",
      segments: [
        { type: "text", text: "The build suc" },
        claimFinalization({ kind: "uncertainty", outcome: "uncertain", text: "ceeded." }).segments[0],
      ],
      obligationRefs: [],
    };

    expectRejection(
      candidate,
      contextWithEvidence(evidenceRow("evidence:1", "project_state")),
      "proof_incompatible",
    );
  });

  it("rejects process-only wording split across a text and claim boundary", () => {
    const candidate: ControllerFinalization = {
      disposition: "answered",
      segments: [
        { type: "text", text: "Working on" },
        claimFinalization({ kind: "uncertainty", outcome: "uncertain", text: " it now." }).segments[0],
      ],
      obligationRefs: [],
    };

    expectRejection(
      candidate,
      contextWithEvidence(evidenceRow("evidence:1", "project_state")),
      "process_only",
    );
  });

  it("does not let a compatible kind hide an incompatible operational paraphrase", () => {
    expectRejection(
      claimFinalization({ kind: "execution_result", outcome: "succeeded", text: "The rollout succeeded." }),
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
      "proof_incompatible",
    );
  });

  it.each([
    ["a deployment assertion", "The service was configured.", "execution_result", "command_result"],
    ["a release assertion", "The release was deployed.", "workspace_change", "workspace_change"],
  ] as const)("does not let %s ride on a broad command/file proof", (_label, text, kind, proofKind) => {
    expectRejection(
      claimFinalization({ kind, outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", proofKind, "succeeded")),
      "proof_incompatible",
    );
  });

  it("requires a positive typed health observation for a healthy claim", () => {
    expect(validateControllerFinalization(
      claimFinalization({ kind: "health_assessment", outcome: "succeeded", text: "The agent is healthy." }),
      contextWithEvidence(evidenceRow("evidence:1", "health_snapshot", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
    expectRejection(
      claimFinalization({ kind: "health_assessment", outcome: "succeeded", text: "The agent is healthy." }),
      contextWithEvidence(evidenceRow("evidence:1", "health_snapshot", "interrupted")),
      "proof_incompatible",
    );
  });
});

describe("bounded text heuristics", () => {
  it.each([
    ["deployment with an explicit negative predicate", "The deployment passed, not failed."],
    ["deployment despite a failed test", "The deployment passed despite the test failed."],
    ["deployment with parenthetical negation", "The deployment passed (the deployment failed)."],
    ["canary with an explicit negative predicate", "The canary passed, not failed."],
    ["merge with parenthetical negation", "The merge succeeded (the merge failed)."],
    ["production with parenthetical negation", "Production is live (production failed)."],
  ] as const)("does not let mixed-polarity %s hide a positive assertion", (_label, text) => {
    expectRejection(textFinalization(text), emptyFinalizationContext(), "high_impact_text_unclaimed");
  });

  it.each([
    "The deployment failed.",
    "The canary did not pass.",
    "The merge was not completed.",
    "Production is not live.",
    "Production is not yet live.",
  ])("keeps a wholly negative operational statement acceptable: %s", (text) => {
    expect(validateControllerFinalization(textFinalization(text), emptyFinalizationContext()))
      .toMatchObject({ outcome: "accepted" });
  });

  it.each([
    "I'll check this.",
    "Let me look into it.",
    "I will investigate.",
    "I'll work on this.",
    "I'll try.",
    "I'll get back to you.",
    "I'll follow up.",
    "I'll take care of it.",
    "I will handle it.",
    "I am addressing it now.",
    "I'll resolve the situation.",
    "We are progressing it.",
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
    "The migration is wrapped up.",
    "The issue has been resolved.",
    "The launch cleared its final gate.",
    "The rollout went smoothly.",
    "The change landed.",
    "The service is good to go.",
  ])("rejects unclaimed high-impact assertion: %s", (text) => {
    expectRejection(textFinalization(text), emptyFinalizationContext(), "high_impact_text_unclaimed");
  });

  it.each([
    ["deployment success", "Deployment succeeded.", "high_impact_text_unclaimed"],
    ["all tests pass", "All tests pass.", "high_impact_text_unclaimed"],
    ["thread success", "The thread operation succeeded.", "high_impact_text_unclaimed"],
    ["job mutation", "I cancelled the job.", "high_impact_text_unclaimed"],
    ["thread mutation", "I sent a message to the thread.", "high_impact_text_unclaimed"],
    ["process-only investigation", "I am investigating.", "process_only"],
  ] as const)("dispositions evidence-free operational text: %s", (_label, text, code) => {
    expectRejection(textFinalization(text), emptyFinalizationContext(), code);
  });

  it.each([
    ["modal", "Tests can pass with either configuration."],
    ["conditional result", "The function returns true when tests pass."],
    ["imperative", "Pass the tests before merging."],
    ["infinitive", "To pass the tests, configure the service."],
  ] as const)("leaves non-result base success grammar as ordinary prose: %s", (_label, text) => {
    expect(validateControllerFinalization(textFinalization(text), emptyFinalizationContext()))
      .toMatchObject({ outcome: "accepted" });
  });

  it.each([
    "Should I deploy the service?",
    "I did not deploy the service.",
    "The deployment failed.",
    "The deployment may have succeeded, but I am uncertain.",
    "We could install the package later.",
    "Please do not delete those records.",
    "The review is not complete.",
    "I removed ambiguity from the explanation.",
    "We paid attention to the details.",
    "Should the package be installed?",
    "The records were not deleted.",
    "I don't think the fix is implemented.",
    "It seems the fix is implemented.",
  ])("does not treat non-success text as a high-impact success: %s", (text) => {
    expect(validateControllerFinalization(textFinalization(text), emptyFinalizationContext()))
      .toMatchObject({ outcome: "accepted" });
  });

  it.each([
    "I will deploy the service after approval.",
    "We will purchase the service after approval.",
  ])("rejects a future action as process-only rather than an answered result: %s", (text) => {
    expectRejection(textFinalization(text), emptyFinalizationContext(), "process_only");
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

  it("rejects an operational assertion concatenated across a claim boundary", () => {
    const candidate: ControllerFinalization = {
      disposition: "answered",
      segments: [
        { type: "text", text: "The fix is imple" },
        claimFinalization({ kind: "uncertainty", outcome: "uncertain", text: "mented." }).segments[0],
      ],
      obligationRefs: [],
    };
    expectRejection(candidate, contextWithEvidence(
      evidenceRow("evidence:1", "project_state"),
    ), "proof_incompatible");
  });

  it("allows a high-impact assertion when it is carried by a compatible claim segment", () => {
    expect(validateControllerFinalization(
      claimFinalization({
        kind: "pipeline_outcome",
        outcome: "succeeded",
        text: "The deployment succeeded in production.",
      }),
      contextWithEvidence(evidenceRow("evidence:1", "production_outcome", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it("requires production proof for a canary claim", () => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text: "Production canary passed." }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
    expect(validateControllerFinalization(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text: "Production canary passed." }),
      contextWithEvidence(evidenceRow("evidence:1", "production_outcome", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["shipped", "The change shipped to production."],
    ["merged", "The release was merged to production."],
    ["published", "The package was published to production."],
    ["live", "The feature is live in production."],
    ["running", "The service is running in production."],
    ["production modifier", "The production change shipped."],
    ["production release", "The production release was published."],
    ["not-only production", "The package was published not only to production."],
    ["against preposition", "The change shipped against production."],
    ["published across production", "The release was published across production."],
    ["published throughout production", "The release was published throughout production."],
  ] as const)("requires production proof for %s wording even when the verb is broadly accepted", (_label, text) => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
    expect(validateControllerFinalization(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "production_outcome", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["production tests", "Production tests passed."],
    ["production smoke and regression tests", "Production smoke and regression tests passed."],
    ["production tests all passed", "Production tests all passed."],
    ["tests using production", "Tests passed using production."],
    ["production label tests", "Production: tests passed."],
  ] as const)("requires execution and production proof for %s wording", (_label, text) => {
    const claim = claimFinalization({ kind: "execution_result", outcome: "succeeded", text });
    expectRejection(
      claim,
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
    expectRejection(
      claim,
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
      "proof_incompatible",
    );
    expectRejection(
      claim,
      contextWithEvidence(evidenceRow("evidence:1", "production_outcome", "succeeded")),
      "proof_incompatible",
    );
    const claimWithCombinedEvidence = claimFinalization({
      kind: "execution_result",
      outcome: "succeeded",
      text,
      evidenceRefs: ["evidence:1", "evidence:2"],
    });
    expectRejection(
      claimWithCombinedEvidence,
      contextWithEvidence(
        evidenceRow("evidence:1", "command_result", "succeeded"),
        evidenceRow("evidence:2", "production_outcome", "succeeded"),
      ),
      "proof_incompatible",
    );
  });

  it.each([
    ["and connector", "Tests passed and used production."],
    ["because connector", "Tests passed because they ran against production."],
    ["but connector", "Tests passed but used production."],
    ["although connector", "Tests passed although they ran against production."],
  ] as const)("keeps production binding across one-claim connectors: %s", (_label, text) => {
    expectRejection(
      claimFinalization({ kind: "execution_result", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
      "proof_incompatible",
    );
  });

  it("keeps a semicolon production qualifier bound to the execution claim", () => {
    const claim = claimFinalization({
      kind: "execution_result",
      outcome: "succeeded",
      text: "Tests passed; they ran against production.",
    }).segments[0];
    expectRejection(
      { disposition: "answered", segments: [claim], obligationRefs: [] },
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
      "proof_incompatible",
    );
  });

  it("keeps a semicolon plain qualifier bound to the preceding execution claim", () => {
    const claim = claimFinalization({
      kind: "execution_result",
      outcome: "succeeded",
      text: "Tests passed;",
    }).segments[0];
    expectRejection(
      {
        disposition: "answered",
        segments: [claim, { type: "text", text: " they ran against production." }],
        obligationRefs: [],
      },
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
      "proof_incompatible",
    );
  });

  it("keeps a plain-segment production qualifier bound to the execution claim", () => {
    const claim = claimFinalization({
      kind: "execution_result",
      outcome: "succeeded",
      text: "Tests passed",
    }).segments[0];
    expectRejection(
      {
        disposition: "answered",
        segments: [claim, { type: "text", text: " and used production." }],
        obligationRefs: [],
      },
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
      "proof_incompatible",
    );
  });

  it.each([".", "?", "!"])("allows punctuation to delimit a plain production sentence: %s", (punctuation) => {
    const claim = claimFinalization({
      kind: "execution_result",
      outcome: "succeeded",
      text: `Tests passed${punctuation}`,
    }).segments[0];
    expect(validateControllerFinalization(
      {
        disposition: "answered",
        segments: [claim, { type: "text", text: " they ran against production." }],
        obligationRefs: [],
      },
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["CI object", "CI passed every test.", "pipeline_outcome"],
    ["review object", "The review passed all tests.", "pipeline_outcome"],
    ["deployment object", "The deployment passed every test.", "production_outcome"],
    ["release object", "The release passed all regression tests.", "production_outcome"],
    ["compound subjects", "Tests and CI passed.", "pipeline_outcome"],
  ] as const)("fails closed when a test noun shares a larger success predicate: %s", (_label, text, proofKind) => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", proofKind, "succeeded")),
      "proof_incompatible",
    );
  });

  it.each([
    ["CI before tests", "CI and tests passed.", "pipeline_outcome"],
    ["review before tests", "The review and tests passed.", "pipeline_outcome"],
    ["deployment before tests", "The deployment and tests passed.", "production_outcome"],
    ["tests with review", "Tests together with review passed.", "pipeline_outcome"],
  ] as const)("fails closed for mixed subject order in one predicate: %s", (_label, text, proofKind) => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", proofKind, "succeeded")),
      "proof_incompatible",
    );
  });

  it("accepts separately subject-bound execution and production claims", () => {
    const executionClaim = claimFinalization({
      kind: "execution_result",
      outcome: "succeeded",
      text: "Tests passed.",
      subjectRef: "bb-item:command-1",
      evidenceRefs: ["evidence:1"],
    }).segments[0];
    const productionClaim = claimFinalization({
      kind: "pipeline_outcome",
      outcome: "succeeded",
      text: "Production release succeeded.",
      subjectRef: "job:job_1",
      evidenceRefs: ["evidence:2"],
    }).segments[0];
    expect(validateControllerFinalization(
      {
        disposition: "answered",
        segments: [executionClaim, { type: "text", text: " and " }, productionClaim],
        obligationRefs: [],
      },
      contextWithEvidence(
        evidenceRow("evidence:1", "command_result", "succeeded", "bb-item:command-1"),
        evidenceRow("evidence:2", "production_outcome", "succeeded", "job:job_1"),
      ),
    )).toMatchObject({ outcome: "accepted" });
  });

  it("rejects a direct production test claim with command and production subjects", () => {
    expectRejection(
      claimFinalization({
        kind: "execution_result",
        outcome: "succeeded",
        text: "Production tests passed.",
        subjectRef: "bb-item:command-1",
        evidenceRefs: ["evidence:1", "evidence:2"],
      }),
      contextWithEvidence(
        evidenceRow("evidence:1", "command_result", "succeeded", "bb-item:command-1"),
        evidenceRow("evidence:2", "production_outcome", "succeeded", "job:job_1"),
      ),
      "subject_mismatch",
    );
  });

  it("does not let production-only evidence carry production test success", () => {
    expectRejection(
      claimFinalization({
        kind: "pipeline_outcome",
        outcome: "succeeded",
        text: "Production tests all passed.",
      }),
      contextWithEvidence(evidenceRow("evidence:1", "production_outcome", "succeeded")),
      "proof_incompatible",
    );
  });

  it.each([
    ["tests all passed", "The tests all passed."],
    ["test cases passed", "The test cases passed."],
  ] as const)("binds natural test-success wording to execution evidence: %s", (_label, text) => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "production_outcome", "succeeded")),
      "proof_incompatible",
    );
    expect(validateControllerFinalization(
      claimFinalization({ kind: "execution_result", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["auxiliary after subject", "Tests have all passed."],
    ["universal singular subject", "Every test passed."],
    ["quantified test cases", "All of the test cases passed."],
  ] as const)("entitles varied test-success predicates to execution proof: %s", (_label, text) => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
    expect(validateControllerFinalization(
      claimFinalization({ kind: "execution_result", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["unexpectedly", "Tests unexpectedly passed."],
    ["finally", "Tests finally passed."],
    ["repeatedly", "Tests repeatedly passed."],
  ] as const)("entitles adverbial test-success predicates to execution proof: %s", (_label, text) => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
    expect(validateControllerFinalization(
      claimFinalization({ kind: "execution_result", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["reporting handoff to CI", "Tests reported CI passed.", false],
    ["auxiliary and adverbial chain", "Tests did ultimately pass.", true],
    ["relative test participant", "The tests that ran passed.", true],
    ["relative pronoun participant", "The tests I ran passed.", true],
    ["named relative participant", "The tests Alice ran passed.", true],
    ["possessive relative participant", "The tests my team ran passed.", true],
    ["reduced overnight relative", "The tests run overnight passed.", true],
    ["possessive named subject", "Alice's tests passed.", true],
    ["focus modifier", "Tests even passed.", true],
    ["temporal modifier", "Tests have now passed.", true],
    ["gerund test subject", "Regression testing passed.", true],
    ["compound test subject", "Unit and integration tests passed.", true],
    ["relative test subject", "The tests that were run passed.", true],
    ["relative subject with team", "The tests that the team ran passed.", true],
    ["postposed test subject", "Passed tests.", true],
    ["postposed quantified subject", "Passed: all tests.", true],
    ["postposed regression tests", "Passed all regression tests.", true],
    ["test run subject", "The test run passed.", true],
    ["relative base pass", "The tests that ran pass.", true],
    ["relative base succeed", "The tests I ran succeed.", true],
  ] as const)("binds success to the nearest local subject: %s", (_label, text, testSubjectIsNearest) => {
    const pipelineClaim = claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text });
    const executionClaim = claimFinalization({ kind: "execution_result", outcome: "succeeded", text });
    const pipelineContext = contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded"));
    const executionContext = contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded"));
    if (testSubjectIsNearest) {
      expectRejection(pipelineClaim, pipelineContext, "proof_incompatible");
      expect(validateControllerFinalization(executionClaim, executionContext)).toMatchObject({ outcome: "accepted" });
      return;
    }
    expect(validateControllerFinalization(pipelineClaim, pipelineContext)).toMatchObject({ outcome: "accepted" });
    expectRejection(executionClaim, executionContext, "proof_incompatible");
  });

  it("does not transfer test entitlement through a competing predicate subject", () => {
    const text = "The tests reported the review passed.";
    expect(validateControllerFinalization(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it("fails closed when test and review subjects share one success predicate", () => {
    const text = "The tests and the review passed.";
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
    expectRejection(
      claimFinalization({ kind: "execution_result", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
      "proof_incompatible",
    );
  });

  it("keeps a larger CI predicate bound to pipeline evidence when tests are only the reporter", () => {
    const text = "Tests reported CI passed.";
    expect(validateControllerFinalization(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
    expectRejection(
      claimFinalization({ kind: "execution_result", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
      "proof_incompatible",
    );
  });

  it.each([
    ["adverbial result", "Tests did indeed pass."],
    ["named test suite", "Ada's test suite passed."],
    ["possessive test suite", "The team's test suite passed."],
    ["named prepositional subject", "The tests of Ada passed."],
    ["reduced relative", "The tests run by CI passed."],
  ] as const)("recognizes whole local test predicates: %s", (_label, text) => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
    expect(validateControllerFinalization(
      claimFinalization({ kind: "execution_result", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    "Passed tests and the review.",
    "Passed the review and tests.",
    "Passed tests and CI.",
  ])("fails closed for reverse/postposed compound test predicates: %s", (text) => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
    expectRejection(
      claimFinalization({ kind: "execution_result", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
      "proof_incompatible",
    );
  });

  it("keeps neighboring pipeline and test predicates locally entitled", () => {
    const pipelineClaim = claimFinalization({
      kind: "pipeline_outcome",
      outcome: "succeeded",
      text: "The review succeeded",
      evidenceRefs: ["evidence:1"],
    }).segments[0];
    const executionClaim = claimFinalization({
      kind: "execution_result",
      outcome: "succeeded",
      text: "all tests passed",
      evidenceRefs: ["evidence:2"],
    }).segments[0];
    expect(validateControllerFinalization(
      {
        disposition: "answered",
        segments: [pipelineClaim, { type: "text", text: " and " }, executionClaim],
        obligationRefs: [],
      },
      contextWithEvidence(
        evidenceRow("evidence:1", "pipeline_outcome", "succeeded"),
        evidenceRow("evidence:2", "command_result", "succeeded"),
      ),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["test production qualifier", "execution_result", "Tests passed in ", "command_result"],
    ["release production qualifier", "pipeline_outcome", "The release was published to ", "pipeline_outcome"],
  ] as const)("does not let production qualifiers escape across segments: %s", (_label, kind, claimText, proofKind) => {
    const claim = claimFinalization({ kind, outcome: "succeeded", text: claimText }).segments[0];
    expectRejection(
      {
        disposition: "answered",
        segments: [claim, { type: "text", text: "production." }],
        obligationRefs: [],
      },
      contextWithEvidence(evidenceRow("evidence:1", proofKind, "succeeded")),
      "proof_incompatible",
    );
  });

  it.each([
    ["never down", "Production was never down: the release was published."],
    ["nowhere outside", "The release was published nowhere outside production."],
  ] as const)("requires production proof for affirmative production polarity: %s", (_label, text) => {
    const claim = claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text });
    expectRejection(
      claim,
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
    expect(validateControllerFinalization(
      claim,
      contextWithEvidence(evidenceRow("evidence:1", "production_outcome", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["negated negative state", "Production was not broken and published."],
    ["negated outside relation", "The release was published not outside production."],
  ] as const)("requires production proof for a negated negative production predicate: %s", (_label, text) => {
    const claim = claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text });
    expectRejection(
      claim,
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
    expect(validateControllerFinalization(
      claim,
      contextWithEvidence(evidenceRow("evidence:1", "production_outcome", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["negative positive state", "Production is not live.", "pipeline_outcome", "failed", "pipeline_outcome", "failed"],
    ["negative production state", "The tests passed because production is down.", "execution_result", "succeeded", "command_result", "succeeded"],
    ["success outside production", "The release was published outside production.", "pipeline_outcome", "succeeded", "pipeline_outcome", "succeeded"],
    ["unrelated earlier negation", "The release was not delayed and was published outside production.", "pipeline_outcome", "succeeded", "pipeline_outcome", "succeeded"],
    ["only outside production", "The release was published only outside production.", "pipeline_outcome", "succeeded", "pipeline_outcome", "succeeded"],
    ["all outside production", "The release was published all outside production.", "pipeline_outcome", "succeeded", "pipeline_outcome", "succeeded"],
    ["non-production", "The release was published in non-production.", "pipeline_outcome", "succeeded", "pipeline_outcome", "succeeded"],
    ["without ever touching", "The tests passed without ever touching production.", "execution_result", "succeeded", "command_result", "succeeded"],
    ["explicit no-touch", "The tests passed without accessing production.", "execution_result", "succeeded", "command_result", "succeeded"],
  ] as const)("keeps a narrow production exception: %s", (_label, text, kind, claimOutcome, proofKind, evidenceOutcome) => {
    expect(validateControllerFinalization(
      claimFinalization({ kind, outcome: claimOutcome, text }),
      contextWithEvidence(evidenceRow("evidence:1", proofKind, evidenceOutcome)),
    )).toMatchObject({ outcome: "accepted" });
  });

  it.each([
    ["no production failures", "The tests passed with no production failures.", "execution_result", "command_result"],
    ["nowhere at all outside", "The release was published nowhere at all outside production.", "pipeline_outcome", "pipeline_outcome"],
    ["not outside", "The release was published not outside production.", "pipeline_outcome", "pipeline_outcome"],
    ["within rather than outside", "The release was published within rather than outside production.", "pipeline_outcome", "pipeline_outcome"],
    ["inside rather than outside", "The release was published inside rather than outside production.", "pipeline_outcome", "pipeline_outcome"],
    ["within instead of outside", "The release was published within instead of outside production.", "pipeline_outcome", "pipeline_outcome"],
    ["everywhere but outside", "The release was published everywhere but outside production.", "pipeline_outcome", "pipeline_outcome"],
    ["anything other than outside", "The release was published anything other than outside production.", "pipeline_outcome", "pipeline_outcome"],
    ["anything but outside", "The release was published anything but outside production.", "pipeline_outcome", "pipeline_outcome"],
    ["anything but non-production", "The release was published anything but non-production.", "pipeline_outcome", "pipeline_outcome"],
    ["not non-production", "The release was published not non-production.", "pipeline_outcome", "pipeline_outcome"],
    ["not without touching", "The tests passed not without touching production.", "execution_result", "command_result"],
  ] as const)("requires production proof for ambiguous non-production wording: %s", (_label, text, kind, proofKind) => {
    expectRejection(
      claimFinalization({ kind, outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", proofKind, "succeeded")),
      "proof_incompatible",
    );
  });

  it("does not turn a test result that explicitly avoided production into a production claim", () => {
    expect(validateControllerFinalization(
      claimFinalization({
        kind: "execution_result",
        outcome: "succeeded",
        text: "The tests passed without touching production.",
      }),
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it("does not let an outer negator create a no-touch production exception", () => {
    expectRejection(
      claimFinalization({
        kind: "execution_result",
        outcome: "succeeded",
        text: "The tests passed not without touching production.",
      }),
      contextWithEvidence(evidenceRow("evidence:1", "command_result", "succeeded")),
      "proof_incompatible",
    );
  });

  it.each([
    "All tests are passing.",
    "tests ran successfully",
    "tests were a success",
    "No tests failed.",
  ])("rejects a natural test result in plain text: %s", (text) => {
    expectRejection(textFinalization(text), emptyFinalizationContext(), "high_impact_text_unclaimed");
  });

  it.each([
    "parser passed the value to next stage",
    "Use the passed value as default",
    "Pass the test fixture into helper",
    "Parser passed value downstream.",
  ])("keeps non-result pass grammar ordinary: %s", (text) => {
    expect(validateControllerFinalization(textFinalization(text), emptyFinalizationContext()))
      .toMatchObject({ outcome: "accepted" });
  });

  it("keeps a protected CI predicate when generic passed is transitive prose", () => {
    expect(validateControllerFinalization(
      claimFinalization({
        kind: "pipeline_outcome",
        outcome: "succeeded",
        text: "CI passed value downstream.",
      }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
    )).toMatchObject({ outcome: "accepted" });
  });

  it("rejects a Cyrillic confusable in a plain operational result", () => {
    expectRejection(
      textFinalization("Tests p\u0430ssed."),
      emptyFinalizationContext(),
      "high_impact_text_unclaimed",
    );
  });

  it("rejects a Cyrillic confusable test subject in a pipeline-only claim", () => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text: "Te\u0455ts passed." }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
  });

  it("rejects a Greek confusable in a plain operational result", () => {
    expectRejection(
      textFinalization("Tests p\u03b1ssed."),
      emptyFinalizationContext(),
      "high_impact_text_unclaimed",
    );
  });

  it.each(["\u0422ests passed.", "\u0442ests passed."])("rejects a Cyrillic T confusable in a pipeline-only test claim: %s", (text) => {
    expectRejection(
      claimFinalization({ kind: "pipeline_outcome", outcome: "succeeded", text }),
      contextWithEvidence(evidenceRow("evidence:1", "pipeline_outcome", "succeeded")),
      "proof_incompatible",
    );
  });

  it.each([
    "Ｔｈｅ ｂｕｉｌｄ ｓｕｃｃｅｅｄｅｄ.",
    "The bui\u200Bld succeeded.",
  ])("rejects Unicode-obfuscated operational prose: %s", (text) => {
    expectRejection(textFinalization(text), emptyFinalizationContext(), "high_impact_text_unclaimed");
  });

  it.each([
    "Full-width typography is fine for this note.",
    "The α symbol is ordinary Unicode.",
  ])("does not reject ordinary prose merely because it uses Unicode text: %s", (text) => {
    expect(validateControllerFinalization(
      textFinalization(text),
      emptyFinalizationContext(),
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
      ["invocation_in_flight", validateControllerFinalization(
        textFinalization("The answer is complete."),
        emptyFinalizationContext({ invocationInFlight: true }),
      )],
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
