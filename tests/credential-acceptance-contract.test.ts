import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildIncompleteCredentialAcceptanceReport,
  evaluateCredentialAcceptanceReport,
  isSecretShapedText,
  parseCredentialAcceptanceCaseCorpus,
  parseCredentialAcceptanceReport,
  type CredentialAcceptanceCaseCorpus,
  type CredentialAcceptanceCaseResult,
  type CredentialAcceptanceReport,
} from "../src/eval/credential-broker-acceptance";

const SHIPPED_CORPUS_PATH = fileURLToPath(new URL("../evals/credential-broker-cases.json", import.meta.url));

/** The exact mandatory live/red-state ids the implementation plan fixes for this corpus. */
const REQUIRED_LIVE_AND_RED_STATE_IDS = [
  "live-broker-noninteractive-start",
  "live-service-account-single-vault-scope",
  "live-exact-binding-valid",
  "live-out-of-scope-item-denied",
  "live-missing-field-invalid",
  "live-revoked-service-token-closed",
  "live-broker-restart-receipt-replay",
  "live-hanoon-restart-no-credential-transfer",
  "live-secret-canary-zero-findings",
  "live-doctor-all-gates",
  "live-admin-interface-unreachable",
  "live-bb-admin-negative-probes",
  "live-topology-reattest",
  "live-disposable-teardown",
  "red-secret-log-canary",
  "red-unknown-protocol-field",
  "red-stale-binding-generation",
  "red-redirect-endpoint",
  "red-unsafe-topology",
  "red-expired-topology-receipt",
  "red-audit-persistence-failure",
  "red-idempotency-digest-change",
];

function corpus(overrides: Partial<CredentialAcceptanceCaseCorpus> = {}): CredentialAcceptanceCaseCorpus {
  return {
    schemaVersion: 1,
    cases: [
      { id: "deterministic-protocol", category: "deterministic", mandatory: true, title: "Protocol schema is strict", expectedResult: "rejects unknown fields", provesAgainstCaseId: null },
      { id: "live-exact-binding-valid", category: "live", mandatory: true, title: "Exact bound item verifies", expectedResult: "valid", provesAgainstCaseId: null },
      { id: "red-unknown-protocol-field", category: "red_state", mandatory: true, title: "Unknown protocol field is rejected", expectedResult: "rejected", provesAgainstCaseId: "deterministic-protocol" },
    ],
    ...overrides,
  };
}

function passedResult(overrides: Partial<CredentialAcceptanceCaseResult> = {}): CredentialAcceptanceCaseResult {
  return {
    id: "deterministic-protocol",
    status: "passed",
    cleanupStatus: "not_applicable",
    procedureRevision: 1,
    startedAt: 1_000,
    completedAt: 2_000,
    actor: "operator",
    reviewer: "owner",
    actualResult: "rejects unknown fields",
    evidenceRefs: ["tests/credential-protocol.test.ts"],
    disposableResourceIds: [],
    ...overrides,
  };
}

function incompleteResult(id: string): CredentialAcceptanceCaseResult {
  return {
    id,
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
  };
}

function passingReport(): CredentialAcceptanceReport {
  return {
    schemaVersion: 1,
    generatedAt: 5_000,
    status: "passed",
    cases: [
      passedResult({ id: "deterministic-protocol" }),
      passedResult({
        id: "live-exact-binding-valid",
        cleanupStatus: "complete",
        disposableResourceIds: ["vault-item-fixture-1"],
        actualResult: "valid",
        evidenceRefs: ["evidence:live-exact-binding-valid-1"],
      }),
      passedResult({
        id: "red-unknown-protocol-field",
        cleanupStatus: "complete",
        disposableResourceIds: ["synthetic-request-1"],
        actualResult: "rejected",
        evidenceRefs: ["evidence:red-unknown-protocol-field-1"],
      }),
    ],
  };
}

describe("credential acceptance case corpus", () => {
  it("parses a well-formed corpus", () => {
    expect(parseCredentialAcceptanceCaseCorpus(corpus()).cases).toHaveLength(3);
  });

  it("rejects a duplicate case id", () => {
    const withDuplicate = corpus();
    expect(() => parseCredentialAcceptanceCaseCorpus({
      ...withDuplicate,
      cases: [...withDuplicate.cases, withDuplicate.cases[0]],
    })).toThrow();
  });

  it("rejects an unknown key on a case definition", () => {
    const withUnknownKey = corpus();
    expect(() => parseCredentialAcceptanceCaseCorpus({
      ...withUnknownKey,
      cases: [{ ...withUnknownKey.cases[0], extra: "nope" }, ...withUnknownKey.cases.slice(1)],
    })).toThrow();
  });

  it("requires a red_state case to name an existing counterpart", () => {
    const base = corpus();
    expect(() => parseCredentialAcceptanceCaseCorpus({
      ...base,
      cases: base.cases.map((c) => c.category === "red_state" ? { ...c, provesAgainstCaseId: null } : c),
    })).toThrow(/provesAgainstCaseId/);
    expect(() => parseCredentialAcceptanceCaseCorpus({
      ...base,
      cases: base.cases.map((c) => c.category === "red_state" ? { ...c, provesAgainstCaseId: "does-not-exist" } : c),
    })).toThrow(/provesAgainstCaseId/);
  });

  it("rejects a non-red_state case that names a counterpart", () => {
    const base = corpus();
    expect(() => parseCredentialAcceptanceCaseCorpus({
      ...base,
      cases: base.cases.map((c) => c.id === "live-exact-binding-valid" ? { ...c, provesAgainstCaseId: "deterministic-protocol" } : c),
    })).toThrow(/provesAgainstCaseId/);
  });
});

describe("credential acceptance case result", () => {
  it("allows an unexecuted incomplete case with every optional field null", () => {
    expect(() => parseCredentialAcceptanceReport(
      { schemaVersion: 1, generatedAt: 1, status: "incomplete", cases: [incompleteResult("deterministic-protocol"), incompleteResult("live-exact-binding-valid"), incompleteResult("red-unknown-protocol-field")] },
      corpus(),
    )).not.toThrow();
  });

  it("rejects a passed case missing a reviewer", () => {
    const { reviewer: _reviewer, ...withoutReviewer } = passedResult();
    expect(() => parseCredentialAcceptanceReport(
      { schemaVersion: 1, generatedAt: 1, status: "incomplete", cases: [{ ...withoutReviewer, reviewer: null }, incompleteResult("live-exact-binding-valid"), incompleteResult("red-unknown-protocol-field")] },
      corpus(),
    )).toThrow(/reviewer/);
  });

  it("rejects a passed case missing an actor, timestamps, or evidence", () => {
    expect(() => parseCredentialAcceptanceReport(
      { schemaVersion: 1, generatedAt: 1, status: "incomplete", cases: [passedResult({ actor: null }), incompleteResult("live-exact-binding-valid"), incompleteResult("red-unknown-protocol-field")] },
      corpus(),
    )).toThrow(/actor/);
    expect(() => parseCredentialAcceptanceReport(
      { schemaVersion: 1, generatedAt: 1, status: "incomplete", cases: [passedResult({ startedAt: null }), incompleteResult("live-exact-binding-valid"), incompleteResult("red-unknown-protocol-field")] },
      corpus(),
    )).toThrow(/startedAt/);
    expect(() => parseCredentialAcceptanceReport(
      { schemaVersion: 1, generatedAt: 1, status: "incomplete", cases: [passedResult({ completedAt: null }), incompleteResult("live-exact-binding-valid"), incompleteResult("red-unknown-protocol-field")] },
      corpus(),
    )).toThrow(/completedAt/);
    expect(() => parseCredentialAcceptanceReport(
      { schemaVersion: 1, generatedAt: 1, status: "incomplete", cases: [passedResult({ evidenceRefs: [] }), incompleteResult("live-exact-binding-valid"), incompleteResult("red-unknown-protocol-field")] },
      corpus(),
    )).toThrow(/evidenceRefs/);
  });

  it("rejects a passed case that is not cleaned when it touched disposable resources", () => {
    expect(() => parseCredentialAcceptanceReport(
      {
        schemaVersion: 1,
        generatedAt: 1,
        status: "incomplete",
        cases: [
          incompleteResult("deterministic-protocol"),
          passedResult({ id: "live-exact-binding-valid", disposableResourceIds: ["vault-item-1"], cleanupStatus: "pending" }),
          incompleteResult("red-unknown-protocol-field"),
        ],
      },
      corpus(),
    )).toThrow(/clean/i);
  });

  it("rejects an unknown key on a case result", () => {
    expect(() => parseCredentialAcceptanceReport(
      { schemaVersion: 1, generatedAt: 1, status: "incomplete", cases: [{ ...incompleteResult("deterministic-protocol"), extra: true }, incompleteResult("live-exact-binding-valid"), incompleteResult("red-unknown-protocol-field")] },
      corpus(),
    )).toThrow();
  });

  it("rejects a duplicate case id inside one report", () => {
    expect(() => parseCredentialAcceptanceReport(
      { schemaVersion: 1, generatedAt: 1, status: "incomplete", cases: [incompleteResult("deterministic-protocol"), incompleteResult("deterministic-protocol"), incompleteResult("live-exact-binding-valid"), incompleteResult("red-unknown-protocol-field")] },
      corpus(),
    )).toThrow(/duplicate/i);
  });

  it("rejects a report case id the corpus does not define", () => {
    expect(() => parseCredentialAcceptanceReport(
      { schemaVersion: 1, generatedAt: 1, status: "incomplete", cases: [incompleteResult("deterministic-protocol"), incompleteResult("live-exact-binding-valid"), incompleteResult("red-unknown-protocol-field"), incompleteResult("not-a-real-case")] },
      corpus(),
    )).toThrow(/unknown/i);
  });
});

describe("secret-shaped text refusal", () => {
  it.each([
    ["a PEM block", "-----BEGIN PRIVATE KEY-----\nMIIBogIBAAJ...\n-----END PRIVATE KEY-----"],
    ["a 1Password reference", "op://vault123456789012345678/item123456789012345678/password"],
    ["a bearer token", "Authorization: Bearer sometoken.value.here"],
    ["a labelled secret", "clientKey: abcdef0123456789"],
    ["a Telegram-bot-token shape", `123456789:${"A".repeat(35)}`],
  ])("flags %s", (_label, value) => {
    expect(isSecretShapedText(value)).toBe(true);
  });

  it("does not flag an opaque evidence id or path", () => {
    expect(isSecretShapedText("evidence:live-exact-binding-valid-1")).toBe(false);
    expect(isSecretShapedText("tests/credential-protocol.test.ts")).toBe(false);
    expect(isSecretShapedText("receipt_9f2c1e4a")).toBe(false);
  });

  it("rejects an evidence reference that looks like a secret", () => {
    expect(() => parseCredentialAcceptanceReport(
      {
        schemaVersion: 1,
        generatedAt: 1,
        status: "incomplete",
        cases: [
          passedResult({ evidenceRefs: ["op://vault123456789012345678/item123456789012345678/password"] }),
          incompleteResult("live-exact-binding-valid"),
          incompleteResult("red-unknown-protocol-field"),
        ],
      },
      corpus(),
    )).toThrow();
  });

  it("rejects an actualResult that looks like a secret", () => {
    expect(() => parseCredentialAcceptanceReport(
      {
        schemaVersion: 1,
        generatedAt: 1,
        status: "incomplete",
        cases: [
          passedResult({ actualResult: "clientKey: abcdef0123456789" }),
          incompleteResult("live-exact-binding-valid"),
          incompleteResult("red-unknown-protocol-field"),
        ],
      },
      corpus(),
    )).toThrow();
  });
});

describe("credential acceptance aggregate evaluation", () => {
  it("passes only when every mandatory case is passed and cleaned", () => {
    const evaluation = evaluateCredentialAcceptanceReport({ corpus: corpus(), cases: passingReport().cases });
    expect(evaluation.status).toBe("passed");
    expect(evaluation.unmetMandatoryIds).toEqual([]);
  });

  it("is non-passing when a mandatory case is missing entirely", () => {
    const report = passingReport();
    const evaluation = evaluateCredentialAcceptanceReport({
      corpus: corpus(),
      cases: report.cases.filter((c) => c.id !== "live-exact-binding-valid"),
    });
    expect(evaluation.status).not.toBe("passed");
    expect(evaluation.missingCaseIds).toContain("live-exact-binding-valid");
  });

  it("is non-passing when a mandatory case is incomplete", () => {
    const report = passingReport();
    const evaluation = evaluateCredentialAcceptanceReport({
      corpus: corpus(),
      cases: report.cases.map((c) => c.id === "live-exact-binding-valid" ? incompleteResult(c.id) : c),
    });
    expect(evaluation.status).not.toBe("passed");
    expect(evaluation.unmetMandatoryIds).toContain("live-exact-binding-valid");
  });

  it("is non-passing when a case's red-state counterpart is missing, even if that case itself is not mandatory", () => {
    const lenientCorpus = corpus({
      cases: [
        { id: "deterministic-protocol", category: "deterministic", mandatory: false, title: "Protocol schema is strict", expectedResult: "rejects unknown fields", provesAgainstCaseId: null },
        { id: "red-unknown-protocol-field", category: "red_state", mandatory: false, title: "Unknown protocol field is rejected", expectedResult: "rejected", provesAgainstCaseId: "deterministic-protocol" },
      ],
    });
    const evaluation = evaluateCredentialAcceptanceReport({
      corpus: lenientCorpus,
      cases: [passedResult({ id: "deterministic-protocol" })],
    });
    expect(evaluation.status).not.toBe("passed");
    expect(evaluation.missingCounterpartIds).toContain("red-unknown-protocol-field");
  });

  it("rejects a report whose declared status disagrees with the recomputed status", () => {
    const report = passingReport();
    expect(() => parseCredentialAcceptanceReport(
      { ...report, status: "passed", cases: report.cases.filter((c) => c.id !== "live-exact-binding-valid") },
      corpus(),
    )).toThrow(/status/i);
  });
});

describe("an unexecuted skeleton report", () => {
  it("is structurally valid but never passing", () => {
    const skeleton = buildIncompleteCredentialAcceptanceReport(corpus(), 42);
    expect(skeleton.status).toBe("incomplete");
    expect(() => parseCredentialAcceptanceReport(skeleton, corpus())).not.toThrow();
    const evaluation = evaluateCredentialAcceptanceReport({ corpus: corpus(), cases: skeleton.cases });
    expect(evaluation.status).toBe("incomplete");
  });
});

describe("the shipped credential-broker-cases.json corpus", () => {
  const shippedCorpus = parseCredentialAcceptanceCaseCorpus(JSON.parse(readFileSync(SHIPPED_CORPUS_PATH, "utf8")));

  it("parses as a valid corpus", () => {
    expect(shippedCorpus.schemaVersion).toBe(1);
  });

  it("includes every mandatory live and red-state id the plan fixes, and nothing is optional", () => {
    const ids = new Set(shippedCorpus.cases.map((c) => c.id));
    for (const requiredId of REQUIRED_LIVE_AND_RED_STATE_IDS) expect(ids.has(requiredId)).toBe(true);
    expect(shippedCorpus.cases.every((c) => c.mandatory)).toBe(true);
  });

  it("gives every red-state case a counterpart defined in the same corpus", () => {
    const redStateCases = shippedCorpus.cases.filter((c) => c.category === "red_state");
    expect(redStateCases).toHaveLength(8);
    for (const redCase of redStateCases) expect(redCase.provesAgainstCaseId).not.toBeNull();
  });

  it("is unexecuted-incomplete out of the box and becomes passing once every case is proven", () => {
    const skeleton = buildIncompleteCredentialAcceptanceReport(shippedCorpus, 1_000);
    expect(evaluateCredentialAcceptanceReport({ corpus: shippedCorpus, cases: skeleton.cases }).status).toBe("incomplete");

    const fullyProven = skeleton.cases.map((entry) => passedResult({
      id: entry.id,
      cleanupStatus: "complete",
      disposableResourceIds: ["fixture-resource-1"],
      evidenceRefs: [`evidence:${entry.id}-1`],
      actualResult: shippedCorpus.cases.find((c) => c.id === entry.id)!.expectedResult,
    }));
    const evaluation = evaluateCredentialAcceptanceReport({ corpus: shippedCorpus, cases: fullyProven });
    expect(evaluation.status).toBe("passed");
    expect(() => parseCredentialAcceptanceReport(
      { schemaVersion: 1, generatedAt: 2_000, status: "passed", cases: fullyProven },
      shippedCorpus,
    )).not.toThrow();
  });
});
