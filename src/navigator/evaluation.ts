import { createHash } from "node:crypto";
import { DEFAULT_MODEL_POOL_REGISTRY, type ModelRoute } from "../capabilities/models";
import type { ProjectPolicy } from "../domain/models";
import type { NavigatorEffectPersistence } from "./effect-persistence";
import type { NavigatorEvaluationPersistence } from "./evaluation-persistence";
import type { NavigatorImplementationPersistence } from "./implementation-persistence";
import { stableWorkArtifactId, type CaptureWorkArtifactInput } from "../work-artifacts/repository";
import type { NavigatorInferenceObservation, NavigatorProposal } from "./models";
import {
  NAVIGATOR_EVALUATION_CORPUS,
  NAVIGATOR_EVALUATION_CORPUS_DIGEST,
  type NavigatorEvaluationCase,
} from "./evaluation-corpus";
import { measureNavigatorRestartPoint } from "./restart-evaluation";
import type { DualEngineRestartPoint, NavigatorDeterministicCategory } from "./promotion";
import { DUAL_ENGINE_RESTART_POINTS } from "./promotion";

const EXTERNAL_DIGEST = "e".repeat(64);

const evaluationPolicy: ProjectPolicy = {
  projectId: "proj_eval",
  alias: "eval",
  enabled: true,
  githubRepository: "acme/eval",
  baseBranch: "main",
  implementation: { model: "implementation-model" },
  review: { model: "review-model" },
  validationCommands: [{ name: "unit", command: "npm test", timeoutMs: 600_000 }],
  requiredChecks: ["test"],
  outputRedactionPatterns: [],
  workerStartGraceMs: 120_000,
  workerLivenessWatchdogMs: 300_000,
  workerRecoveryLimit: 2,
  maxReviewCycles: 3,
  mergeMethod: "squash",
};

export type NavigatorCorpusEvaluationResult = Readonly<{
  corpusDigest: string;
  resultDigest: string;
  total: number;
  correct: number;
  unauthorizedEffects: number;
  duplicateMutations: number;
  ownerBoundaryViolations: number;
  outcomeRegressions: number;
  evidenceBindingFailures: number;
  restartPointsMeasured: readonly DualEngineRestartPoint[];
  cases: readonly Readonly<{
    id: string;
    category: NavigatorDeterministicCategory;
    expected: NavigatorEvaluationCase["expected"];
    actual: Readonly<{ decision: string; reasonCode: string }>;
    matched: boolean;
    unauthorizedEffects: number;
  }>[];
}>;

function observation(overrides: Partial<NavigatorInferenceObservation> = {}): NavigatorInferenceObservation {
  return {
    nativeToolCalls: [],
    claimedCodeWorktreeId: null,
    dynamicEffectToolIds: [],
    externalStateDigest: EXTERNAL_DIGEST,
    ...overrides,
  };
}

function modelRoute(): ModelRoute {
  return { pool: "strong", ...DEFAULT_MODEL_POOL_REGISTRY.worker.strong };
}

function artifactInput(input: Readonly<{
  artifactId: string;
  operationId: string;
  kind: CaptureWorkArtifactInput["kind"];
  title: string;
}>): CaptureWorkArtifactInput {
  return {
    artifactId: input.artifactId,
    projectId: "proj_eval",
    effortId: "effort_eval",
    operationId: input.operationId,
    kind: input.kind,
    status: "ready",
    trackerKind: "github",
    trackerNamespace: "github:acme/eval",
    externalId: input.operationId,
    externalUrl: `https://github.com/acme/eval/issues/${input.operationId}`,
    externalRevision: `${input.operationId}:1`,
    externalStatus: "open",
    assignees: [],
    title: input.title,
    trackerOrder: 0,
    content: `# ${input.title}\n\nFixed evaluation artifact.`,
    acceptanceCriteria: [`${input.title} is accepted`],
    relationships: [],
    capturedAt: 1_000,
  };
}

function buildProposal(
  snapshot: { identity: NavigatorProposal["basedOn"]; artifactBindings: readonly { artifactId: string }[] },
  kind: NavigatorEvaluationCase["proposal"],
): unknown {
  const specId = snapshot.artifactBindings.length > 1
    ? snapshot.artifactBindings[0]!.artifactId
    : snapshot.artifactBindings[0]?.artifactId ?? "missing-ticket";
  const ticketId = snapshot.artifactBindings.length > 1
    ? snapshot.artifactBindings[1]!.artifactId
    : snapshot.artifactBindings[0]?.artifactId ?? "missing-ticket";
  const base = {
    basedOn: snapshot.identity,
    rationale: "Fixed dual-engine evaluation proposal.",
    evidenceRefs: ["eval:corpus"],
  };
  if (kind === "malformed") return { kind: "invoke_skill" };
  if (kind === "native_tools") {
    return { ...base, kind: "invoke_skill", skillId: "research", subjectArtifactIds: [ticketId], objective: "Research." };
  }
  if (kind === "invoke_research") {
    return { ...base, kind: "invoke_skill", skillId: "research", subjectArtifactIds: [ticketId], objective: "Research the ticket." };
  }
  if (kind === "invoke_wayfinder") {
    return { ...base, kind: "invoke_skill", skillId: "wayfinder", subjectArtifactIds: [ticketId], objective: "Map the effort." };
  }
  if (kind === "invoke_to_spec") {
    return { ...base, kind: "invoke_skill", skillId: "to-spec", subjectArtifactIds: [ticketId], objective: "Write the specification." };
  }
  if (kind === "invoke_to_tickets") {
    return { ...base, kind: "invoke_skill", skillId: "to-tickets", subjectArtifactIds: [specId], objective: "File implementation tickets." };
  }
  if (kind === "invoke_implement") {
    return { ...base, kind: "invoke_skill", skillId: "implement", subjectArtifactIds: [ticketId], objective: "Implement the ticket." };
  }
  if (kind === "invoke_ask_matt") {
    return { ...base, kind: "invoke_skill", skillId: "ask-matt", subjectArtifactIds: [ticketId], objective: "Consult." };
  }
  if (kind === "invoke_legacy") {
    return { ...base, kind: "invoke_skill", skillId: "using-superpowers", subjectArtifactIds: [ticketId], objective: "Use a retired skill." };
  }
  if (kind === "unresolved") {
    return {
      ...base,
      kind: "unresolved_next_step",
      question: "Should this task use research or wayfinder next?",
      candidateSkillIds: ["research", "wayfinder"],
    };
  }
  if (kind === "start_release") {
    return { ...base, kind: "start_release", implementationTicketIds: [ticketId] };
  }
  if (kind === "finish") {
    return { ...base, kind: "finish", artifactIds: [ticketId] };
  }
  const boundaryCode = kind.slice("owner_boundary:".length);
  return {
    ...base,
    kind: "owner_boundary",
    boundaryCode,
    question: "Which owner decision should govern this boundary?",
    recommendedAction: "Pause and ask the owner.",
  };
}

function setupJob(
  persistence: NavigatorEvaluationPersistence,
  evaluationCase: NavigatorEvaluationCase,
  sequence: number,
): { jobId: string; now: number } {
  const now = 2_000 + sequence;
  const ticketId = stableWorkArtifactId("proj_eval", `eval-ticket-${sequence}`);
  const specId = stableWorkArtifactId("proj_eval", `eval-spec-${sequence}`);
  const bindings: Array<{ artifactId: string; snapshotId: string; snapshotDigest: string }> = [];
  if (evaluationCase.artifacts !== "none") {
    const ticket = persistence.captureWorkArtifact(artifactInput({
      artifactId: ticketId,
      operationId: `ticket-${sequence}`,
      kind: "implementation_ticket",
      title: "Evaluation ticket",
    }));
    bindings.push({
      artifactId: ticket.artifact.id,
      snapshotId: ticket.snapshot.id,
      snapshotDigest: ticket.snapshot.snapshotDigest,
    });
  }
  if (evaluationCase.artifacts === "specification+ticket") {
    const specification = persistence.captureWorkArtifact(artifactInput({
      artifactId: specId,
      operationId: `spec-${sequence}`,
      kind: "specification",
      title: "Evaluation specification",
    }));
    bindings.unshift({
      artifactId: specification.artifact.id,
      snapshotId: specification.snapshot.id,
      snapshotDigest: specification.snapshot.snapshotDigest,
    });
  }
  const draft = persistence.createJob({
    id: `job_eval_${sequence}`,
    sourceUpdateId: 90_000 + sequence,
    requestText: "Evaluate navigator dual-engine proposals.",
    ...(evaluationCase.engine === "navigator-v1"
      ? { workflow: { engine: "navigator-v1" as const, mode: "deterministic" as const } }
      : {}),
    now,
  });
  const selected = persistence.applyJobEvent(draft.id, draft.version, {
    type: "PROJECT_SELECTED",
    projectId: "proj_eval",
    policyVersion: 1,
    policy: evaluationPolicy,
  }, now + 1);
  let job = selected;
  if (bindings.length > 0 && evaluationCase.engine === "navigator-v1") {
    job = persistence.bindNavigatorJobArtifacts({
      jobId: selected.id,
      expectedVersion: selected.version,
      artifactBindings: bindings,
      now: now + 2,
    });
  }
  if (evaluationCase.taskOutcome || evaluationCase.jobState) {
    persistence.setEvaluationJobFacts({
      jobId: job.id,
      ...(evaluationCase.taskOutcome ? { taskOutcome: evaluationCase.taskOutcome } : {}),
      ...(evaluationCase.jobState ? { state: evaluationCase.jobState } : {}),
    });
  }
  return { jobId: job.id, now: now + 3 };
}

export async function evaluateNavigatorCorpus(
  evaluation: NavigatorEvaluationPersistence,
  persistence: Readonly<{
    effectPersistence: NavigatorEffectPersistence;
    implementationPersistence: NavigatorImplementationPersistence;
  }>,
): Promise<NavigatorCorpusEvaluationResult> {
  const cases: NavigatorCorpusEvaluationResult["cases"][number][] = [];
  for (const [sequence, evaluationCase] of NAVIGATOR_EVALUATION_CORPUS.entries()) {
    if (evaluationCase.category === "restart") {
      const restart = await measureNavigatorRestartPoint(
        evaluation,
        persistence,
        evaluationCase,
        sequence + 1,
      );
      cases.push({
        id: evaluationCase.id,
        category: evaluationCase.category,
        expected: evaluationCase.expected,
        actual: restart.actual,
        matched: restart.matched,
        unauthorizedEffects: restart.duplicateMutations,
      });
      continue;
    }
    const setup = setupJob(evaluation, evaluationCase, sequence + 1);
    const snapshot = evaluation.createNavigatorSnapshot({
      jobId: setup.jobId,
      externalStateDigest: EXTERNAL_DIGEST,
      evidenceRefs: ["eval:corpus"],
      now: setup.now,
    });
    const decision = evaluation.recordNavigatorProposal({
      snapshotId: snapshot.snapshotId,
      rawProposal: buildProposal(snapshot, evaluationCase.proposal),
      observation: observation(evaluationCase.proposal === "native_tools" ? { nativeToolCalls: ["shell"] } : {}),
      selectModelRoute: modelRoute,
      now: setup.now + 1,
    });
    const effects = evaluation.listEffectsForJob(setup.jobId).filter((effect) =>
      effect.kind === "run_navigator_skill" || effect.kind === "run_navigator_release");
    const unauthorizedEffects = evaluationCase.engine === "recipe-v1" || decision.decision !== "accepted"
      ? effects.length
      : 0;
    const actual = { decision: decision.decision, reasonCode: decision.reasonCode };
    const matched = actual.decision === evaluationCase.expected.decision &&
      actual.reasonCode === evaluationCase.expected.reasonCode;
    cases.push({
      id: evaluationCase.id,
      category: evaluationCase.category,
      expected: evaluationCase.expected,
      actual,
      matched,
      unauthorizedEffects,
    });
  }
  const correct = cases.filter((entry) => entry.matched).length;
  const unauthorizedEffects = cases.reduce((sum, entry) => sum + entry.unauthorizedEffects, 0);
  const restartCases = cases.filter((entry) => entry.category === "restart");
  const restartPointsMeasured = DUAL_ENGINE_RESTART_POINTS.filter((point) =>
    NAVIGATOR_EVALUATION_CORPUS.some((entry) => entry.category === "restart" && entry.restartPoint === point) &&
    restartCases.filter((entry) => {
      const fixture = NAVIGATOR_EVALUATION_CORPUS.find((item) => item.id === entry.id);
      return fixture?.restartPoint === point;
    }).every((entry) => entry.matched));
  const duplicateMutations = restartCases.reduce((sum, entry) => sum + entry.unauthorizedEffects, 0);
  const ownerBoundaryViolations = cases.filter((entry) =>
    entry.category === "owner_boundaries" && entry.actual.decision === "accepted").length;
  const outcomeRegressions = cases.length - correct;
  const evidenceBindingFailures = cases.filter((entry) =>
    !entry.matched && /binding|digest|stale_specification|stale_ticket/u.test(entry.actual.reasonCode)).length;
  const resultDigest = createHash("sha256")
    .update(JSON.stringify(cases.map((entry) => [entry.id, entry.actual, entry.matched])), "utf8")
    .digest("hex");
  return {
    corpusDigest: NAVIGATOR_EVALUATION_CORPUS_DIGEST,
    resultDigest,
    total: cases.length,
    correct,
    unauthorizedEffects,
    duplicateMutations,
    ownerBoundaryViolations,
    outcomeRegressions,
    evidenceBindingFailures,
    restartPointsMeasured,
    cases,
  };
}
