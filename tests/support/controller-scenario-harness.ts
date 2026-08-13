import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type Database from "better-sqlite3";
import type {
  ControllerAdapter,
  ControllerEventResult,
  ControllerInteractionReference,
  ControllerInteractionResolution,
  ControllerInteractionSnapshot,
} from "../../src/controller/bb-controller";
import { ControllerInteractionService } from "../../src/controller/interaction-service";
import { LunaControllerService } from "../../src/controller/service";
import { CONTROLLER_TOOL_NAMES, registerControllerTools } from "../../src/controller/tools";
import { ControllerEvidenceProjector } from "../../src/controller/evidence-projector";
import type {
  ControllerInteraction,
  ControllerInteractionStore,
} from "../../src/storage/controller-interaction-repository";
import {
  parseControllerScenarioCorpus,
  parseControllerScenarioTrial,
  validateControllerScenarioTrialEvidence,
  type ControllerScenarioTrial,
} from "../../src/eval/controller-scenario-contract";
import {
  controllerInteractionToken,
  renderControllerInteraction,
  type RenderedQuestion,
} from "../../src/controller/questions";
import { hashSecret } from "../../src/crypto";
import { openStore } from "../../src/storage/store";
import { TelegramIngress } from "../../src/telegram/ingress";
import { encodeCallbackData } from "../../src/telegram/view";
import type { ProjectPolicy } from "../../src/domain/models";
import type { TelegramAgentStore } from "../../src/storage/store";

const FIXTURE_NOW = 1_000;
const CONTROLLER_KEY = "owner-7-controller";
const OWNER_ID = "7";
const JOB_ID = "job_fixture_1";

let scenarioResourcesCreated = 0;
let scenarioResourcesDisposed = 0;
let scenarioResourcesActive = 0;

export function controllerScenarioResourceStats(): Readonly<{
  created: number;
  disposed: number;
  active: number;
}> {
  return {
    created: scenarioResourcesCreated,
    disposed: scenarioResourcesDisposed,
    active: scenarioResourcesActive,
  };
}

function beginScenarioResources(): void {
  scenarioResourcesCreated += 1;
  scenarioResourcesActive += 1;
}

async function disposeScenarioResources(harness: { lifecycle: { dispose(): Promise<void> } }): Promise<void> {
  try {
    await harness.lifecycle.dispose();
  } finally {
    scenarioResourcesDisposed += 1;
    scenarioResourcesActive -= 1;
  }
}

function fixedProjectPolicy(): ProjectPolicy {
  return {
    projectId: "proj_1",
    alias: "cyndra",
    enabled: true,
    githubRepository: "acme/cyndra",
    baseBranch: "main",
    implementation: { model: "implementation-model" },
    review: { model: "review-model" },
    validationCommands: [{ name: "unit", command: "npm test", timeoutMs: 600_000 }],
    production: {
      deployCommands: [{ name: "deploy", command: "./scripts/deploy-production.sh", timeoutMs: 1_800_000 }],
      canaryCommands: [{ name: "canary", command: "./scripts/verify-production.sh", timeoutMs: 300_000 }],
      convexDeployRequired: false,
    },
    requiredChecks: ["test"],
    outputRedactionPatterns: [],
    workerLivenessWatchdogMs: 300_000,
    maxReviewCycles: 3,
    mergeMethod: "squash",
  };
}

type ScenarioCase = ReturnType<typeof parseControllerScenarioCorpus>["cases"][number];

type ScenarioGrade = Readonly<{
  responseText: string;
  outcomePassed: boolean;
  tracePassed: boolean;
  assertionFacts?: ScenarioAssertionFacts;
  outcomeProofs: readonly string[];
  traceProofs: readonly string[];
  answerProofs: readonly string[];
}>;

function scenarioTrial(
  scenarioCase: ScenarioCase,
  trial: number,
  seed: number,
  startedAt: number,
  toolSurface: ReturnType<typeof registeredToolSurface>,
  grade: ScenarioGrade,
): ControllerScenarioTrial {
  if (!grade.assertionFacts) throw new Error(`scenario ${scenarioCase.id} has no durable assertion facts`);
  const assertions = evaluateDeclaredAssertions(scenarioCase, grade.assertionFacts);
  const outcomePassed = scenarioCase.requiredOutcomeAssertions.every((id) => assertions[id] === true) &&
    !scenarioCase.forbiddenOutcomeAssertions.some((id) => assertions[id] === true);
  const tracePassed = scenarioCase.requiredTraceAssertions.every((id) => assertions[id] === true);
  const answerStatus = scenarioCase.answerGrader === "required"
    ? evaluateScenarioAnswer(scenarioCase, grade.assertionFacts) ? "passed" : "failed"
    : "not_applicable";
  const parsed = parseControllerScenarioTrial({
    schemaVersion: 1,
    scenarioVersion: scenarioCase.scenarioVersion,
    scenarioDefinitionSha256: sha256(canonicalJson(scenarioCase)),
    scenarioId: scenarioCase.id,
    trial,
    seed,
    harness: harnessIdentity(scenarioCase, trial, seed, toolSurface),
    budget: scenarioCase.budget,
    outcome: {
      status: outcomePassed ? "passed" : "failed",
      graderId: "durable-outcome",
      graderVersion: 1,
      proofRefs: [
        ...grade.outcomeProofs.map((proofRef) => bindProofRef(scenarioCase.id, proofRef)),
        ...scenarioCase.requiredOutcomeAssertions.map((id) => assertionProof(scenarioCase.id, id, assertions[id] === true)),
        ...scenarioCase.forbiddenOutcomeAssertions.map((id) => assertionProof(scenarioCase.id, id, assertions[id] === true)),
      ],
    },
    trace: {
      status: tracePassed ? "passed" : "failed",
      graderId: "typed-trace",
      graderVersion: 1,
      proofRefs: [
        ...grade.traceProofs.map((proofRef) => bindProofRef(scenarioCase.id, proofRef)),
        ...scenarioCase.requiredTraceAssertions.map((id) => assertionProof(scenarioCase.id, id, assertions[id] === true)),
      ],
    },
    answer: {
      status: answerStatus,
      graderId: "answer-form",
      graderVersion: 1,
      proofRefs: grade.answerProofs.map((proofRef) => bindProofRef(scenarioCase.id, proofRef)),
    },
    metrics: {
      wallMs: Math.max(0, Math.ceil(performance.now() - startedAt)),
      tokens: null,
      costUsd: null,
      terminalFailureClass: null,
    },
  });
  return validateControllerScenarioTrialEvidence(parsed);
}

function controllerInteractionStore(store: TelegramAgentStore): ControllerInteractionStore {
  return {
    isControllerInteractionDeliveryFenceCurrent: (input) => store.isControllerInteractionDeliveryFenceCurrent(input),
    record: (input) => store.recordControllerInteraction(input),
    markResolved: (input) => store.markControllerInteractionResolved(input),
    answerByToken: (input) => store.answerControllerInteractionByToken(input),
    answerWithText: (input) => store.answerControllerInteractionWithText(input),
    getPending: (controllerKey) => store.getPendingControllerInteraction(controllerKey),
    getAnswered: (controllerKey) => store.getAnsweredControllerInteraction(controllerKey),
    markDelivered: (input) => store.markControllerInteractionDelivered(input),
  };
}

export type ControllerScenarioRunOptions = Readonly<{
  checkpoint: "baseline" | "kernel" | "cutover";
  trials: number;
  seed: number;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function proof(value: string): string {
  return `sha256:${sha256(value)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("registered tool surface contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("registered tool surface contains a non-JSON value");
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function registeredToolSurface(agentTools: ReadonlyArray<{ name: string; inputSchema: unknown }>) {
  const tools = [...agentTools]
    .map(({ name, inputSchema }) => ({ name, inputSchema }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const parameterSchemaSha256 = Object.fromEntries(
    tools.map((tool) => [tool.name, sha256(canonicalJson(tool.inputSchema))]),
  );
  return {
    advertisedTools: tools.map((tool) => tool.name),
    parameterSchemaSha256,
    capabilityManifestSha256: sha256(canonicalJson({ tools })),
  };
}

export function loadControllerScenarioCorpus(): ReturnType<typeof parseControllerScenarioCorpus> {
  const path = fileURLToPath(new URL("../../evals/controller-scenarios.json", import.meta.url));
  return parseControllerScenarioCorpus(JSON.parse(readFileSync(path, "utf8")));
}

type ScriptedAdapterOptions = Readonly<{
  finalizeOnEvents?: boolean;
  eventReferences?: () => readonly ControllerInteractionReference[];
  eventSequence?: () => number;
  onSend?: (text: string) => void;
  getInteraction?: (threadId: string, interactionId: string, signal: AbortSignal) => Promise<ControllerInteractionSnapshot>;
  resolveInteraction?: (
    threadId: string,
    interactionId: string,
    resolution: ControllerInteractionResolution,
    signal: AbortSignal,
  ) => Promise<void>;
}>;

function scriptedAdapter(
  observeToolCall: () => Promise<boolean>,
  finalizeTurn: () => Promise<void>,
  reserveSpawn: (turnId: string) => boolean,
  options: ScriptedAdapterOptions = {},
): ControllerAdapter {
  return {
    spawn: async (turn) => {
      if (!reserveSpawn(turn.id)) throw new Error("fixed scenario spawn reservation failed");
      return { threadId: "thr_fixed_controller", projectId: "proj_fixed", hostId: "host_fixed", spawnToken: turn.id };
    },
    send: async (_threadId, text) => options.onSend?.(text),
    steer: async () => undefined,
    answerQuestion: async () => undefined,
    status: async () => "idle",
    latestSeq: async () => options.eventSequence?.() ?? 0,
    events: async (): Promise<ControllerEventResult> => {
      const toolCalls = await observeToolCall() ? 1 : 0;
      if (options.finalizeOnEvents !== false) await finalizeTurn();
      return {
        latestSeq: options.eventSequence?.() ?? 1,
        inputAccepted: true,
        assistantOutputObserved: true,
        toolActivityObserved: toolCalls > 0,
        completed: true,
        error: null,
        interactionReferences: options.eventReferences?.() ?? [],
        toolCalls,
        commandFailures: 0,
        totalTokens: 0,
      };
    },
    findSpawnCandidate: async () => null,
    ...(options.getInteraction ? { getInteraction: options.getInteraction } : {}),
    ...(options.resolveInteraction ? { resolveInteraction: options.resolveInteraction } : {}),
  };
}

type JobStatusProjection = Readonly<{ id: string; state: string; serialized: string }>;

function parseJobStatusProjection(result: unknown): JobStatusProjection {
  if (typeof result !== "string" || result.length > 8_000) throw new Error("job-status tool returned an invalid bounded projection");
  const parsed: unknown = JSON.parse(result);
  if (!parsed || typeof parsed !== "object") throw new Error("job-status tool returned no projection");
  const job = (parsed as { job?: unknown }).job;
  if (!job || typeof job !== "object") throw new Error("job-status tool returned no job");
  const { id, state } = job as { id?: unknown; state?: unknown };
  if (typeof id !== "string" || typeof state !== "string") throw new Error("job-status tool returned an invalid job");
  return { id, state, serialized: result };
}

function scenarioRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseScenarioToolResult(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("fixed scenario tool result was not text");
  const parsed = scenarioRecord(JSON.parse(value));
  if (!parsed) throw new Error("fixed scenario tool result was not an object");
  return parsed;
}

type ScenarioAssertionFacts = Readonly<{
  turn: ReturnType<TelegramAgentStore["getControllerTurn"]>;
  reply: ReturnType<TelegramAgentStore["getOutbox"]>;
  replyCount: number;
  responseCount: number;
  digestCount: number;
  jobBefore: ReturnType<TelegramAgentStore["getJob"]>;
  jobAfter: ReturnType<TelegramAgentStore["getJob"]>;
  effectsBeforeCount: number;
  effectsAfterCount: number;
  jobCountBefore: number;
  jobCountAfter: number;
  jobSourceUpdateCount: number;
  observedJobStatus: JobStatusProjection | null;
  finalizationRows: readonly { state: string; rejectionCode: string | null }[];
  finalizationOutcome: "accepted" | "rejected" | "stale" | null;
  denialCode: string | null;
  staleToolReturned: boolean;
  receipts: readonly { toolName: string; state: string; result: string | null }[];
  observedToolCalls: number;
  replaySameJob: boolean;
  replayOutcome: string | null;
  evidence: readonly unknown[];
  sentTexts: readonly string[];
  telegramApprovalRendered: boolean;
  interactionRowState: string | null;
  interactionAnswer: Readonly<Record<string, unknown>> | null;
  successfulResolutionCount: number;
  answeredBeforeResolution: boolean;
  providerContinued: boolean;
  survivedRestart: boolean;
  serviceReopened: boolean;
  firstDelivery: boolean;
  secondDelivery: boolean;
  monitor: ReturnType<TelegramAgentStore["listMonitors"]>[number] | null;
  monitorId: string | null;
  deferredAccepted: boolean;
  acceptedObligationRefs: readonly string[];
  unboundRejectionCode: string | null;
  watchCapabilityObserved: boolean;
}>;

type ScenarioAssertionEvaluator = (facts: ScenarioAssertionFacts) => boolean;

/**
 * The corpus is an executable contract. Every id is deliberately listed here;
 * adding a decorative or misspelled id to the corpus fails the evaluator
 * instead of silently changing coverage.
 */
export const CONTROLLER_ASSERTION_REGISTRY: Readonly<Record<string, ScenarioAssertionEvaluator>> = {
  controller_turn_completed: (facts) => facts.turn?.state === "completed",
  reply_outbox_once: (facts) => facts.reply !== null && facts.replyCount === 1,
  digest_once: (facts) => facts.digestCount === 1,
  controller_turn_submitted: (facts) => facts.turn?.submittedAt !== null,
  duplicate_reply: (facts) => facts.responseCount > 1,
  job_mutated: (facts) => facts.jobCountAfter > facts.jobCountBefore,
  external_mutation: (facts) => facts.effectsAfterCount > facts.effectsBeforeCount,
  actual_job_state_reported: (facts) => facts.observedJobStatus?.id === "job_fixture_1" && facts.observedJobStatus.state === "awaiting_project",
  job_state_unchanged: (facts) => facts.jobBefore !== null && facts.jobAfter !== null &&
    facts.jobBefore.id === facts.jobAfter.id && facts.jobBefore.state === facts.jobAfter.state &&
    facts.jobBefore.version === facts.jobAfter.version && facts.jobBefore.updatedAt === facts.jobAfter.updatedAt,
  job_status_capability_observed: (facts) => facts.observedJobStatus !== null,
  unsupported_success_claim: (facts) => facts.finalizationRows.some((row) => row.state === "rejected" && row.rejectionCode === "high_impact_text_unclaimed"),
  unsupported_success_rejected: (facts) => facts.finalizationRows.some((row) => row.state === "rejected" && row.rejectionCode === "high_impact_text_unclaimed"),
  process_only_candidate_rejected: (facts) => facts.finalizationRows.some((row) => row.state === "rejected" && row.rejectionCode === "process_only"),
  finalization_rejection_observed: (facts) => facts.finalizationRows.some((row) => row.state === "rejected"),
  recovery_prompt_sent: (facts) => facts.sentTexts.length === 1,
  success_claim_not_delivered: (facts) => facts.turn?.responseText === null && outboxText(facts.reply) === "Hanoon is connecting…",
  deployment_success_delivered: (facts) => outboxText(facts.reply) === "The deployment is deployed.",
  generic_command_used_as_pipeline_proof: (facts) => facts.finalizationRows.some((row) => row.rejectionCode === "generic_command_used_as_pipeline_proof"),
  completion_continuation_once: (facts) => facts.turn?.completionContinuations === 1,
  raw_provider_text_not_delivered: (facts) => facts.turn?.responseText === null && outboxText(facts.reply) === "Hanoon is connecting…",
  process_only_reply_delivered: (facts) => facts.turn?.completionContinuations === 1 &&
    (facts.turn.responseText !== null || outboxText(facts.reply) !== "Hanoon is connecting…"),
  completion_continuation_twice: (facts) => (facts.turn?.completionContinuations ?? 0) > 1,
  job_created_once: (facts) => facts.jobSourceUpdateCount === 1,
  mutation_receipt_reused: (facts) => facts.receipts.length === 1 && facts.receipts[0]?.state === "completed" && facts.replaySameJob,
  replay_evidence_recorded: (facts) => facts.replayOutcome === "observed",
  start_job_capability_called_twice: (facts) => facts.observedToolCalls === 2,
  receipt_replay_observed: (facts) => facts.replayOutcome === "observed",
  duplicate_job_created: (facts) => facts.jobSourceUpdateCount > 1,
  mutation_executed_twice: (facts) => facts.receipts.length > 1 || facts.jobSourceUpdateCount > 1,
  stale_fence_denied: (facts) => facts.denialCode === "fence_lost",
  job_count_unchanged: (facts) => facts.jobCountBefore === facts.jobCountAfter,
  success_evidence_absent: (facts) => facts.evidence.length === 0,
  job_created: (facts) => facts.jobCountAfter > facts.jobCountBefore,
  success_envelope_returned: (facts) => facts.staleToolReturned,
  capability_denied_before_effect: (facts) => facts.denialCode === "fence_lost" &&
    facts.jobCountBefore === facts.jobCountAfter && facts.receipts.length === 0 && facts.evidence.length === 0,
  telegram_approval_rendered: (facts) => facts.telegramApprovalRendered,
  interaction_resolved_once: (facts) => facts.successfulResolutionCount === 1,
  provider_continued: (facts) => facts.providerContinued,
  session_wide_approval_offered: (facts) => !facts.telegramApprovalRendered,
  interaction_resolved_twice: (facts) => facts.successfulResolutionCount > 1,
  permission_interaction_observed: (facts) => facts.telegramApprovalRendered && facts.interactionRowState !== null,
  owner_tap_persisted_before_resolution: (facts) => facts.answeredBeforeResolution,
  owner_tap_survived_restart: (facts) => facts.survivedRestart,
  decision_lost_after_restart: (facts) => !facts.survivedRestart,
  service_reopened_before_resolution: (facts) => facts.serviceReopened,
  answered_interaction_replayed: (facts) => facts.serviceReopened && facts.secondDelivery,
  monitor_armed: (facts) => facts.monitor?.state === "armed" && facts.monitorId !== null,
  deferred_response_names_monitor: (facts) => facts.deferredAccepted && facts.monitorId !== null &&
    facts.acceptedObligationRefs.includes(`monitor:${facts.monitorId}`),
  unbound_follow_up_promise: (facts) => facts.unboundRejectionCode === null,
  watch_capability_observed: (facts) => facts.watchCapabilityObserved,
  obligation_validated: (facts) => facts.unboundRejectionCode === "obligation_not_live",
};

type ScenarioAnswerEvaluator = (facts: ScenarioAssertionFacts) => boolean;

/**
 * Required answer layers use only durable rows and literal expectations. The
 * scripted adapter's local response is diagnostic evidence, never the oracle.
 */
const CONTROLLER_ANSWER_REGISTRY: Readonly<Record<string, ScenarioAnswerEvaluator>> = {
  "plain-conversation": (facts) => facts.turn?.responseText === "Hello from Hanoon."
    && outboxText(facts.reply) === "Hello from Hanoon.",
  "current-job-status": (facts) => facts.turn?.responseText === "Job job_fixture_1 is currently awaiting_project."
    && outboxText(facts.reply) === "Job job_fixture_1 is currently awaiting_project."
    && facts.observedJobStatus?.id === "job_fixture_1"
    && facts.observedJobStatus.state === "awaiting_project",
  "duplicate-mutation-replay": (facts) => facts.turn?.responseText === "I created the fixed replay job once."
    && outboxText(facts.reply) === "I created the fixed replay job once.",
  "telegram-allow-once": (facts) => facts.interactionRowState === "delivered"
    && facts.interactionAnswer?.decision === "allow_once"
    && facts.interactionAnswer.grantedPermissions === null,
  "restart-after-owner-tap": (facts) => facts.interactionRowState === "delivered"
    && facts.interactionAnswer?.decision === "allow_once"
    && facts.interactionAnswer.grantedPermissions === null,
  "durable-deferred-monitor": (facts) => facts.turn?.responseText?.includes("get back to you") === true
    && facts.monitorId !== null
    && facts.turn.responseText?.includes(facts.monitorId) === true
    && facts.acceptedObligationRefs.includes(`monitor:${facts.monitorId}`),
};

function evaluateScenarioAnswer(
  scenarioCase: ScenarioCase,
  facts: ScenarioAssertionFacts | undefined,
): boolean {
  if (scenarioCase.answerGrader !== "required") return true;
  if (!facts) throw new Error(`scenario ${scenarioCase.id} has no durable answer facts`);
  const evaluator = CONTROLLER_ANSWER_REGISTRY[scenarioCase.id];
  if (!evaluator) throw new Error(`scenario ${scenarioCase.id} has no registered answer oracle`);
  return evaluator(facts);
}

function outboxText(reply: ReturnType<TelegramAgentStore["getOutbox"]>): string | null {
  const text = reply?.payload.text;
  return typeof text === "string" ? text : null;
}

function readScenarioAssertionFacts(
  store: TelegramAgentStore,
  db: Database.Database,
  turnId: string,
  overrides: Partial<ScenarioAssertionFacts> = {},
): ScenarioAssertionFacts {
  const turn = store.getControllerTurn(turnId);
  const replyKey = `controller:${turnId}:reply`;
  const reply = store.getOutbox(replyKey);
  const outboxRows = store.listOutbox(256).filter((row) => row.logicalKey === replyKey);
  const responseCount = store.listControllerTurns(CONTROLLER_KEY, 256).filter((row) => row.responseText !== null).length;
  const finalizationRows = db.prepare(
    "SELECT state, rejection_code AS rejectionCode FROM controller_finalizations WHERE turn_id = ? ORDER BY revision ASC",
  ).all(turnId) as { state: string; rejectionCode: string | null }[];
  const interactionRow = db.prepare(
    "SELECT state, answer_json AS answerJson FROM controller_interactions WHERE turn_id = ? ORDER BY asked_at DESC LIMIT 1",
  ).get(turnId) as { state?: string; answerJson?: string | null } | undefined;
  let interactionAnswer: Readonly<Record<string, unknown>> | null = null;
  if (interactionRow?.answerJson !== null && interactionRow?.answerJson !== undefined) {
    try {
      interactionAnswer = scenarioRecord(JSON.parse(interactionRow.answerJson));
    } catch {
      interactionAnswer = null;
    }
  }
  const jobs = store.listJobs(256);
  return {
    turn,
    reply,
    replyCount: outboxRows.length,
    responseCount,
    digestCount: store.readControllerDigest(CONTROLLER_KEY, 12).length,
    jobBefore: null,
    jobAfter: null,
    effectsBeforeCount: 0,
    effectsAfterCount: 0,
    jobCountBefore: 0,
    jobCountAfter: jobs.length,
    jobSourceUpdateCount: turn ? jobs.filter((job) => job.sourceUpdateId === turn.updateId).length : 0,
    observedJobStatus: null,
    finalizationRows,
    finalizationOutcome: finalizationRows.some((row) => row.state === "accepted") ? "accepted" : finalizationRows.some((row) => row.state === "rejected") ? "rejected" : null,
    denialCode: null,
    staleToolReturned: false,
    receipts: store.listToolReceipts(turnId),
    observedToolCalls: 0,
    replaySameJob: false,
    replayOutcome: null,
    evidence: store.listControllerEvidence(turnId, 256),
    sentTexts: [],
    telegramApprovalRendered: false,
    interactionRowState: interactionRow?.state ?? null,
    interactionAnswer,
    successfulResolutionCount: 0,
    answeredBeforeResolution: false,
    providerContinued: false,
    survivedRestart: false,
    serviceReopened: false,
    firstDelivery: false,
    secondDelivery: false,
    monitor: store.listMonitors(CONTROLLER_KEY, false)[0] ?? null,
    monitorId: null,
    deferredAccepted: false,
    acceptedObligationRefs: [],
    unboundRejectionCode: null,
    watchCapabilityObserved: false,
    ...overrides,
  };
}

function gradeWithAssertionFacts(
  store: TelegramAgentStore,
  db: Database.Database,
  turnId: string,
  grade: ScenarioGrade,
  overrides: Partial<ScenarioAssertionFacts> = {},
): ScenarioGrade {
  return {
    ...grade,
    assertionFacts: readScenarioAssertionFacts(store, db, turnId, overrides),
  };
}

export function validateControllerAssertionRegistry(corpus: ReturnType<typeof parseControllerScenarioCorpus>): void {
  const declared = new Set<string>();
  for (const scenarioCase of corpus.cases) {
    for (const id of [
      ...scenarioCase.requiredOutcomeAssertions,
      ...scenarioCase.forbiddenOutcomeAssertions,
      ...scenarioCase.requiredTraceAssertions,
    ]) declared.add(id);
  }
  for (const id of declared) {
    if (!(id in CONTROLLER_ASSERTION_REGISTRY)) throw new Error(`unknown controller assertion ${id}`);
  }
  for (const id of Object.keys(CONTROLLER_ASSERTION_REGISTRY)) {
    if (!declared.has(id)) throw new Error(`controller assertion registry entry is not declared: ${id}`);
  }
  const requiredAnswerCases = new Set(
    corpus.cases.filter((scenarioCase) => scenarioCase.answerGrader === "required").map((scenarioCase) => scenarioCase.id),
  );
  for (const scenarioCase of corpus.cases) {
    if (scenarioCase.answerGrader === "required" && !(scenarioCase.id in CONTROLLER_ANSWER_REGISTRY)) {
      throw new Error(`unknown controller answer oracle ${scenarioCase.id}`);
    }
  }
  for (const scenarioId of Object.keys(CONTROLLER_ANSWER_REGISTRY)) {
    if (!requiredAnswerCases.has(scenarioId)) {
      throw new Error(`controller answer oracle entry is not declared: ${scenarioId}`);
    }
  }
}

function evaluateDeclaredAssertions(
  scenarioCase: ScenarioCase,
  facts: ScenarioAssertionFacts,
): Readonly<Record<string, boolean>> {
  const ids = new Set([
    ...scenarioCase.requiredOutcomeAssertions,
    ...scenarioCase.forbiddenOutcomeAssertions,
    ...scenarioCase.requiredTraceAssertions,
  ]);
  return Object.fromEntries([...ids].map((id) => [id, CONTROLLER_ASSERTION_REGISTRY[id]!(facts)]));
}

function bindProofRef(scenarioId: string, proofRef: string): string {
  if (proofRef.includes(`:${scenarioId}:`)) return proofRef;
  return `proof:${scenarioId}:derived:sha256:${sha256(proofRef)}`;
}

function assertionProof(scenarioId: string, assertionId: string, observed: boolean): string {
  return `proof:${scenarioId}:assertion:${assertionId}:${observed}:sha256:${sha256(`${scenarioId}:${assertionId}:${observed}`)}`;
}

function harnessIdentity(
  scenarioCase: ScenarioCase,
  trial: number,
  seed: number,
  toolSurface: ReturnType<typeof registeredToolSurface>,
): ControllerScenarioTrial["harness"] {
  const fixture = `${scenarioCase.id}:${trial}:${seed}`;
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8" }).trim() !== "";
  const configuredCommit = process.env.HANOON_EVAL_COMMIT;
  const configuredDirty = process.env.HANOON_EVAL_DIRTY;
  if (configuredCommit !== undefined && configuredCommit !== commit) {
    throw new Error("configured Hanoon commit does not match the evaluated source tree");
  }
  if (configuredDirty !== undefined && configuredDirty !== String(dirty)) {
    throw new Error("configured dirty state does not match the evaluated source tree");
  }
  return {
    hanoonCommit: commit,
    dirty,
    provider: "fake-bb",
    model: "scripted-controller",
    reasoningLevel: "not_applicable",
    serviceTier: "not_applicable",
    permissionMode: "auto",
    instructionSha256: sha256("fixed-controller-scenario-instruction-v1"),
    overlaySha256: sha256(""),
    capabilityManifestSha256: toolSurface.capabilityManifestSha256,
    policySha256: sha256("baseline-no-project-policy"),
    contextSha256: sha256(fixture),
    outerTaskTools: [],
    advertisedTools: toolSurface.advertisedTools,
    parameterSchemaSha256: toolSurface.parameterSchemaSha256,
  };
}

async function runScenario(
  scenarioCase: ScenarioCase,
  trial: number,
  seed: number,
): Promise<ControllerScenarioTrial> {
  const startedAt = performance.now();
  if (scenarioCase.checkpoint !== "baseline") {
    return runExtendedScenario(scenarioCase, trial, seed, startedAt);
  }
  const fixtureId = `${scenarioCase.id}-${seed}-${trial}`;
  const { bb, harness } = createFakePluginHost({ pluginId: `telegram-controller-eval-${fixtureId}` });
  beginScenarioResources();
  try {
    const store = openStore(bb.storage, bb.storage.kv, () => FIXTURE_NOW);
  store.createPairingCode(hashSecret(`pair:${fixtureId}`), 1, 10_000);
  const paired = store.pairOwnerWithCode(hashSecret(`pair:${fixtureId}`), OWNER_ID, OWNER_ID, 2);
  if (!paired.ok) throw new Error("fixed scenario owner could not be paired");
  const executionOwnerId = `eval-${fixtureId}`;
  const lease = store.acquireExecutorLease(executionOwnerId, FIXTURE_NOW, 30_000);
  if (!lease.acquired) throw new Error("fixed scenario executor lease was unavailable");
  const signal = AbortSignal.timeout(2_000);
  harness.sdk.stub("threads.get", async () => ({
    id: "thr_fixed_controller",
    projectId: "proj_fixed",
    environmentId: "env_fixed_controller",
  }));
  harness.sdk.stub("environments.get", async () => ({
    id: "env_fixed_controller",
    projectId: "proj_fixed",
    hostId: "host_fixed",
    path: "/tmp/hanoon-controller-scenario",
    status: "ready",
    workspaceProvisionType: "personal",
  }));
  harness.sdk.stub("threads.timeline", async () => ({ maxSeq: 0 }));
  harness.sdk.stub("threads.events.list", async () => []);
  const evidenceProjector = new ControllerEvidenceProjector({
    sdk: bb.sdk,
    store,
    clock: { now: () => FIXTURE_NOW },
    hanoonToolNames: CONTROLLER_TOOL_NAMES,
  });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    evidenceProjector,
    threadOperations: { request: async () => { throw new Error("thread operations are not part of this baseline"); } },
    health: () => ({ status: "ok" }),
    notify: () => undefined,
    now: () => FIXTURE_NOW,
  });
  const toolSurface = registeredToolSurface(harness.registrations.agentTools);

  const queuedJob = scenarioCase.id === "current-job-status"
    ? store.createJob({ id: JOB_ID, sourceUpdateId: seed * 1_000 + trial, requestText: "fixed status fixture", now: 3 })
    : null;
  const jobBefore = queuedJob ? store.getJob(JOB_ID) : null;
  const effectsBefore = queuedJob ? store.listEffectsForJob(JOB_ID) : [];
  const jobCountBefore = store.listJobs(256).length;
  const observed = { jobStatus: null as JobStatusProjection | null };
  let response = "Hello from Hanoon.";
  let activeTurnId: string | null = null;
  let finalizationAccepted = false;
  const observeToolCall = async () => {
    if (!queuedJob) return false;
    observed.jobStatus = parseJobStatusProjection(await harness.behavior.callAgentTool(
      "telegram_agent_job_status",
      { jobId: JOB_ID },
      { threadId: "thr_fixed_controller", projectId: "proj_fixed" },
    ));
    response = `Job ${observed.jobStatus.id} is currently ${observed.jobStatus.state}.`;
    return true;
  };
  const finalizeTurn = async () => {
    if (finalizationAccepted) return;
    if (activeTurnId === null) throw new Error("fixed scenario turn was not created before finalization");
    const accepted = store.proposeControllerFinalization({
      ownerId: executionOwnerId,
      generation: lease.generation,
      now: FIXTURE_NOW,
      turnId: activeTurnId,
      controllerKey: CONTROLLER_KEY,
      candidate: {
        disposition: "answered",
        segments: [{ type: "text", text: response }],
        obligationRefs: [],
      },
    });
    if (accepted.outcome !== "accepted") throw new Error("fixed scenario finalization was not accepted");
    finalizationAccepted = true;
  };
  const adapter = scriptedAdapter(
    observeToolCall,
    finalizeTurn,
    (turnId) => store.reserveControllerSpawn({
      controllerKey: CONTROLLER_KEY,
      turnId,
      projectId: "proj_fixed",
      hostId: "host_fixed",
      now: FIXTURE_NOW,
    }),
  );
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock: { now: () => FIXTURE_NOW } });
  const turn = store.enqueueControllerTurn({
    controllerKey: CONTROLLER_KEY,
    telegramUserId: OWNER_ID,
    telegramChatId: OWNER_ID,
    updateId: seed * 10_000 + trial + (scenarioCase.id === "plain-conversation" ? 0 : 5_000),
    inputText: scenarioCase.ownerMessage,
    now: FIXTURE_NOW,
  });
  activeTurnId = turn.id;
  const fence = { ownerId: executionOwnerId, generation: lease.generation, signal };

  await service.processOne(fence, signal);
  await service.reconcile(fence, signal);

  const completed = store.getControllerTurn(turn.id);
  const reply = store.getOutbox(`controller:${turn.id}:reply`);
  const digest = store.readControllerDigest(CONTROLLER_KEY, 8);
  const turns = store.listControllerTurns(CONTROLLER_KEY, 8);
  const jobAfter = queuedJob ? store.getJob(JOB_ID) : null;
  const effectsAfter = queuedJob ? store.listEffectsForJob(JOB_ID) : [];

  const plainPassed = completed?.state === "completed" && turns.length === 1 && digest.length === 1 && reply !== null;
  const statusPassed = observed.jobStatus !== null && jobBefore !== null && jobAfter !== null
    && completed?.responseText?.includes(observed.jobStatus.state) === true
    && JSON.stringify(jobAfter) === JSON.stringify(jobBefore)
    && JSON.stringify(effectsAfter) === JSON.stringify(effectsBefore)
    && reply !== null;
  const outcomePassed = scenarioCase.id === "plain-conversation" ? plainPassed : statusPassed;
  const tracePassed = scenarioCase.id === "plain-conversation"
    ? completed?.submittedAt !== null
    : observed.jobStatus !== null;
  const outcomeProofs = scenarioCase.id === "plain-conversation"
    ? [proof(`${fixtureId}:completed:${completed?.state}`), proof(`${fixtureId}:digest:${digest.length}`), proof(`${fixtureId}:reply:${reply?.logicalKey ?? "missing"}`)]
    : [proof(`${fixtureId}:job:${jobAfter?.state ?? "missing"}`), proof(`${fixtureId}:effects:${effectsAfter.length}`), proof(`${fixtureId}:reply:${reply?.logicalKey ?? "missing"}`)];
  const traceProofs = observed.jobStatus === null
    ? [proof(`${fixtureId}:trace:${tracePassed ? "passed" : "failed"}`)]
    : [`tool-call:telegram_agent_job_status:1:${proof(observed.jobStatus.serialized)}`];

    const grade: ScenarioGrade = {
      responseText: response,
      outcomePassed,
      tracePassed,
      outcomeProofs,
      traceProofs,
      answerProofs: [proof(`${fixtureId}:answer:durable-oracle`)],
    };
    return scenarioTrial(
      scenarioCase,
      trial,
      seed,
      startedAt,
      toolSurface,
      gradeWithAssertionFacts(store, bb.storage.database(), turn.id, grade, {
        jobBefore,
        jobAfter,
        effectsBeforeCount: effectsBefore.length,
        effectsAfterCount: effectsAfter.length,
        jobCountBefore,
        jobCountAfter: store.listJobs(256).length,
        observedJobStatus: observed.jobStatus,
      }),
    );
  } finally {
    await disposeScenarioResources(harness);
  }
}

async function runExtendedScenario(
  scenarioCase: ScenarioCase,
  trial: number,
  seed: number,
  startedAt: number,
): Promise<ControllerScenarioTrial> {
  const fixtureId = `${scenarioCase.id}-${seed}-${trial}`;
  const { bb, harness } = createFakePluginHost({ pluginId: `telegram-controller-eval-${fixtureId}` });
  beginScenarioResources();
  try {
    const store = openStore(bb.storage, bb.storage.kv, () => FIXTURE_NOW);
  store.createPairingCode(hashSecret(`pair:${fixtureId}`), 1, 10_000);
  const paired = store.pairOwnerWithCode(hashSecret(`pair:${fixtureId}`), OWNER_ID, OWNER_ID, 2);
  if (!paired.ok) throw new Error("fixed scenario owner could not be paired");

  const executionOwnerId = `eval-${fixtureId}`;
  const lease = store.acquireExecutorLease(executionOwnerId, FIXTURE_NOW, 30_000);
  if (!lease.acquired) throw new Error("fixed scenario executor lease was unavailable");
  const signal = AbortSignal.timeout(2_000);
  const threadId = "thr_fixed_controller";
  const projectId = "proj_fixed";
  const toolContext = { threadId, projectId, signal };

  harness.sdk.stub("threads.get", async () => ({
    id: threadId,
    projectId,
    environmentId: "env_fixed_controller",
  }));
  harness.sdk.stub("environments.get", async () => ({
    id: "env_fixed_controller",
    projectId,
    hostId: "host_fixed",
    path: "/tmp/hanoon-controller-scenario",
    status: "ready",
    workspaceProvisionType: "personal",
  }));
  harness.sdk.stub("threads.timeline", async () => ({ maxSeq: 0 }));
  harness.sdk.stub("threads.events.list", async () => []);

  store.upsertProjectPolicy(fixedProjectPolicy(), FIXTURE_NOW);
  const evidenceProjector = new ControllerEvidenceProjector({
    sdk: bb.sdk,
    store,
    clock: { now: () => FIXTURE_NOW },
    hanoonToolNames: CONTROLLER_TOOL_NAMES,
  });
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
    evidenceProjector,
    threadOperations: { request: async () => { throw new Error("thread operations are not part of this fixed scenario"); } },
    health: () => ({ status: "ok" }),
    notify: () => undefined,
    now: () => FIXTURE_NOW,
  });
  const toolSurface = registeredToolSurface(harness.registrations.agentTools);

  let activeTurnId: string | null = null;
  let responseText = "";
  let finalizationAttempted = false;
  let finalizationOutcome: string | null = null;
  let finalizationCode: string | null = null;
  const sentTexts: string[] = [];
  const toolResults: Record<string, unknown>[] = [];
  let observedToolCalls = 0;

  const isInteractionScenario = scenarioCase.id === "telegram-allow-once" ||
    scenarioCase.id === "restart-after-owner-tap";
  const interactionId = `interaction_${scenarioCase.id.replaceAll("-", "_")}_${seed}_${trial}`;
  const approvalPayload = {
    kind: "approval",
    subject: { kind: "command", command: "npm test -- --run fixed", cwd: "/tmp/fixed-controller" },
    availableDecisions: ["allow_once", "deny"],
  };
  let interactionStatus: "pending" | "resolved" = "pending";
  const resolutionAttempts: Record<string, unknown>[] = [];
  let successfulResolutions = 0;
  let unboundRejectionCode: string | null = null;

  const observeToolCall = async (): Promise<boolean> => {
    if (scenarioCase.id === "duplicate-mutation-replay") {
      const params = { projectId: "proj_1", task: "Create the fixed replay job." };
      const first = parseScenarioToolResult(await harness.behavior.callAgentTool(
        "telegram_agent_start_job",
        params,
        toolContext,
      ));
      const second = parseScenarioToolResult(await harness.behavior.callAgentTool(
        "telegram_agent_start_job",
        params,
        toolContext,
      ));
      toolResults.push(first, second);
      observedToolCalls = 2;
      responseText = "I created the fixed replay job once.";
      return true;
    }
    if (scenarioCase.id === "durable-deferred-monitor") {
      const result = parseScenarioToolResult(await harness.behavior.callAgentTool(
        "telegram_agent_watch",
        {
          kind: "schedule",
          cron: "0 1 * * *",
          instruction: "Check whether thread_fixture_1 has finished.",
        },
        toolContext,
      ));
      toolResults.push(result);
      observedToolCalls = 1;
      const watching = scenarioRecord(result.watching);
      const monitorId = typeof watching?.id === "string" ? watching.id : null;
      if (!monitorId) throw new Error("fixed scenario watch returned no monitor id");
      responseText = `I'll get back to you when monitor ${monitorId} reports it finishes.`;
      return true;
    }
    return false;
  };

  const finalizeTurn = async (): Promise<void> => {
    if (finalizationAttempted) return;
    finalizationAttempted = true;
    if (activeTurnId === null) throw new Error("fixed scenario turn was not created before finalization");

    let candidate: unknown;
    if (scenarioCase.id === "process-only-finalization") {
      responseText = "I'll investigate.";
      candidate = {
        disposition: "answered",
        segments: [{ type: "text", text: responseText }],
        obligationRefs: [],
      };
    } else if (scenarioCase.id === "unsupported-success-claim") {
      responseText = "The deployment is deployed.";
      candidate = {
        disposition: "answered",
        segments: [{ type: "text", text: responseText }],
        obligationRefs: [],
      };
    } else if (scenarioCase.id === "duplicate-mutation-replay") {
      const firstResult = toolResults[0];
      const job = scenarioRecord(firstResult?.job);
      const jobId = typeof job?.id === "string" ? job.id : null;
      const evidence = scenarioRecord(firstResult?._hanoonEvidence);
      const evidenceRef = typeof evidence?.ref === "string" ? evidence.ref : null;
      if (!jobId || !evidenceRef) throw new Error("fixed mutation replay produced no bound evidence");
      candidate = {
        disposition: "answered",
        segments: [{
          type: "claim",
          text: responseText,
          kind: "observed_state",
          outcome: "succeeded",
          subjectRef: `job:${jobId}`,
          evidenceRefs: [evidenceRef],
        }],
        obligationRefs: [],
      };
    } else if (scenarioCase.id === "durable-deferred-monitor") {
      const watching = scenarioRecord(toolResults[0]?.watching);
      const monitorId = typeof watching?.id === "string" ? watching.id : null;
      if (!monitorId) throw new Error("fixed monitor result was not bound to a monitor");
      const unbound = store.proposeControllerFinalization({
        ownerId: executionOwnerId,
        generation: lease.generation,
        now: FIXTURE_NOW,
        turnId: activeTurnId,
        controllerKey: CONTROLLER_KEY,
        bbEventHighWaterSeq: 0,
        candidate: {
          disposition: "deferred",
          segments: [{ type: "text", text: responseText }],
          obligationRefs: ["monitor:not-a-real-monitor"],
        },
      });
      unboundRejectionCode = unbound.outcome === "rejected" ? unbound.code : null;
      candidate = {
        disposition: "deferred",
        segments: [{ type: "text", text: responseText }],
        obligationRefs: [`monitor:${monitorId}`],
      };
    } else {
      return;
    }

    const proposed = store.proposeControllerFinalization({
      ownerId: executionOwnerId,
      generation: lease.generation,
      now: FIXTURE_NOW,
      turnId: activeTurnId,
      controllerKey: CONTROLLER_KEY,
      bbEventHighWaterSeq: 0,
      candidate,
    });
    finalizationOutcome = proposed.outcome;
    finalizationCode = proposed.outcome === "rejected" ? proposed.code : null;
  };

  const adapter = scriptedAdapter(
    observeToolCall,
    finalizeTurn,
    (turnId) => store.reserveControllerSpawn({
      controllerKey: CONTROLLER_KEY,
      turnId,
      projectId,
      hostId: "host_fixed",
      now: FIXTURE_NOW,
    }),
    {
      finalizeOnEvents: !isInteractionScenario,
      eventSequence: () => 0,
      onSend: (text) => sentTexts.push(text),
      ...(isInteractionScenario ? {
        eventReferences: () => [{
          interactionId,
          kind: "approval" as const,
          status: interactionStatus,
        }],
        getInteraction: async (requestedThreadId, requestedInteractionId) => ({
          id: requestedInteractionId,
          threadId: requestedThreadId,
          status: interactionStatus,
          payload: approvalPayload,
        }),
      } : {}),
    },
  );

  const interactionService = isInteractionScenario
    ? new ControllerInteractionService({
      store: controllerInteractionStore(store),
      clock: { now: () => FIXTURE_NOW },
      interactions: {
        get: async (requestedThreadId, requestedInteractionId) => ({
          id: requestedInteractionId,
          threadId: requestedThreadId,
          status: interactionStatus,
        }),
        resolve: async (input) => {
          resolutionAttempts.push(JSON.parse(JSON.stringify(input.resolution)) as Record<string, unknown>);
          if (scenarioCase.id === "restart-after-owner-tap" && resolutionAttempts.length === 1) return null;
          interactionStatus = "resolved";
          successfulResolutions += 1;
          return { id: input.interactionId, threadId: input.threadId, status: "resolved" };
        },
      },
    })
    : undefined;
  const service = new LunaControllerService({
    store,
    adapter,
    ...(interactionService ? { interactionService } : {}),
    evidenceProjector,
    clock: { now: () => FIXTURE_NOW },
  });
  const turn = store.enqueueControllerTurn({
    controllerKey: CONTROLLER_KEY,
    telegramUserId: OWNER_ID,
    telegramChatId: OWNER_ID,
    updateId: seed * 10_000 + trial + 20_000,
    inputText: scenarioCase.ownerMessage,
    now: FIXTURE_NOW,
  });
  activeTurnId = turn.id;
  const fence = { ownerId: executionOwnerId, generation: lease.generation, signal };
  const interactionFence = { ownerId: executionOwnerId, generation: lease.generation, now: FIXTURE_NOW };

  await service.processOne(fence, signal);

  if (scenarioCase.id === "stale-capability-fence") {
    const jobsBefore = store.listJobs(100).length;
    if (!store.releaseExecutorLease(executionOwnerId, lease.generation, FIXTURE_NOW)) {
      throw new Error("fixed scenario lease could not be released");
    }
    let denialCode: string | null = null;
    try {
      await harness.behavior.callAgentTool(
        "telegram_agent_start_job",
        { projectId: "proj_1", task: "This mutation must be denied." },
        toolContext,
      );
    } catch (error) {
      denialCode = typeof scenarioRecord(error)?.code === "string"
        ? scenarioRecord(error)?.code as string
        : null;
    }
    const jobsAfter = store.listJobs(100).length;
    const grade: ScenarioGrade = {
      responseText: "",
      outcomePassed: denialCode === "fence_lost" && jobsAfter === jobsBefore && store.listToolReceipts(turn.id).length === 0 && store.listControllerEvidence(turn.id, 128).length === 0,
      tracePassed: denialCode === "fence_lost",
      outcomeProofs: [proof(`${fixtureId}:denial:${denialCode ?? "missing"}`), proof(`${fixtureId}:jobs:${jobsAfter}`), proof(`${fixtureId}:evidence:${store.listControllerEvidence(turn.id, 128).length}`)],
      traceProofs: [proof(`${fixtureId}:capability-denied-before-effect:${denialCode ?? "missing"}`)],
      answerProofs: [proof(`${fixtureId}:not-applicable`)],
    };
    return scenarioTrial(
      scenarioCase,
      trial,
      seed,
      startedAt,
      toolSurface,
      gradeWithAssertionFacts(store, bb.storage.database(), turn.id, grade, {
        jobCountBefore: jobsBefore,
        jobCountAfter: jobsAfter,
        denialCode,
        staleToolReturned: false,
      }),
    );
  }

  if (isInteractionScenario) {
    await service.reconcile(fence, signal);
    const pending = store.getPendingControllerInteraction(CONTROLLER_KEY);
    const rendered = pending ? renderControllerInteraction(pending.interaction) : null;
    const buttonLabels = rendered && "reply_markup" in rendered
      ? (rendered as RenderedQuestion).reply_markup.inline_keyboard
        .flatMap((row) => row.map((button) => button.text))
      : [];
    const telegramApprovalRendered = buttonLabels.join("|") === "Allow once|Deny";
    let nudgeCalls = 0;
    const ingress = new TelegramIngress({
      store,
      telegram: {
        sendMessage: async () => ({ message_id: 1 }),
        editMessage: async () => undefined,
        answerCallback: async () => undefined,
      },
      onWorkAvailable: () => { nudgeCalls += 1; },
    });
    const callbackData = encodeCallbackData({
      type: "controller_interaction",
      token: controllerInteractionToken(interactionId, "allow_once"),
    });
    const callback = (updateId: number, callbackId: string) => ({
      update_id: updateId,
      callback_query: {
        id: callbackId,
        from: { id: 7, is_bot: false },
        message: { message_id: 1, chat: { id: 7, type: "private" } },
        data: callbackData,
      },
    });
    await ingress.handleClaimed(callback(seed * 10_000 + trial + 30_000, `${fixtureId}-tap-1`), FIXTURE_NOW + 1);
    const answeredBeforeResolution = store.getAnsweredControllerInteraction(CONTROLLER_KEY) !== null;
    await ingress.handleClaimed(callback(seed * 10_000 + trial + 40_000, `${fixtureId}-tap-2`), FIXTURE_NOW + 2);
    const answeredAfterSecondTap = store.getAnsweredControllerInteraction(CONTROLLER_KEY) !== null;

    let firstDelivery = true;
    let secondDelivery = true;
    let survivedRestart = true;
    if (scenarioCase.id === "restart-after-owner-tap") {
      const restartedStore = openStore(bb.storage, bb.storage.kv, () => FIXTURE_NOW);
      const restartedService = new ControllerInteractionService({
        store: controllerInteractionStore(restartedStore),
        clock: { now: () => FIXTURE_NOW },
        interactions: {
          get: async (requestedThreadId, requestedInteractionId) => ({
            id: requestedInteractionId,
            threadId: requestedThreadId,
            status: interactionStatus,
          }),
          resolve: async (input) => {
            resolutionAttempts.push(JSON.parse(JSON.stringify(input.resolution)) as Record<string, unknown>);
            if (resolutionAttempts.length === 1) return null;
            interactionStatus = "resolved";
            successfulResolutions += 1;
            return { id: input.interactionId, threadId: input.threadId, status: "resolved" };
          },
        },
      });
      firstDelivery = await restartedService.deliverAnswered(CONTROLLER_KEY, interactionFence, signal);
      survivedRestart = restartedStore.getAnsweredControllerInteraction(CONTROLLER_KEY) !== null;
      secondDelivery = await restartedService.deliverAnswered(CONTROLLER_KEY, interactionFence, signal);
    } else {
      firstDelivery = await service.reconcile(fence, signal);
      await service.reconcile(fence, signal);
    }
    if (scenarioCase.id === "restart-after-owner-tap") await service.reconcile(fence, signal);

    const interactionRow = bb.storage.database().prepare(
      "SELECT state FROM controller_interactions WHERE interaction_id = ?",
    ).get(interactionId) as { state?: string } | undefined;
    const exactResolution = resolutionAttempts.length === (scenarioCase.id === "restart-after-owner-tap" ? 2 : 1) &&
      resolutionAttempts.every((resolution) => JSON.stringify(resolution) === JSON.stringify({ decision: "allow_once", grantedPermissions: null }));
    const providerContinued = sentTexts.length === 1 && sentTexts[0]?.includes("telegram_agent_turn_evidence") === true;
    const grade: ScenarioGrade = {
      responseText: "Allow once",
      outcomePassed: telegramApprovalRendered && answeredBeforeResolution &&
        answeredAfterSecondTap && exactResolution &&
        interactionRow?.state === "delivered" && providerContinued && nudgeCalls === 1 &&
        (scenarioCase.id === "telegram-allow-once" || survivedRestart),
      tracePassed: telegramApprovalRendered && answeredBeforeResolution && providerContinued &&
        (scenarioCase.id === "telegram-allow-once" || survivedRestart),
      outcomeProofs: [
        proof(`${fixtureId}:rendered:${telegramApprovalRendered}`),
        proof(`${fixtureId}:answer-state:${interactionRow?.state ?? "missing"}`),
        proof(`${fixtureId}:provider-continued:${providerContinued}`),
      ],
      traceProofs: [
        proof(`${fixtureId}:tap-persisted:${answeredBeforeResolution}`),
        proof(`${fixtureId}:tap-count:${resolutionAttempts.length}`),
        proof(`${fixtureId}:nudges:${nudgeCalls}`),
      ],
      answerProofs: [proof(`${fixtureId}:resolution:${JSON.stringify(resolutionAttempts)}`)],
    };
    return scenarioTrial(
      scenarioCase,
      trial,
      seed,
      startedAt,
      toolSurface,
      gradeWithAssertionFacts(store, bb.storage.database(), turn.id, grade, {
        telegramApprovalRendered,
        interactionRowState: interactionRow?.state ?? null,
        successfulResolutionCount: successfulResolutions,
        answeredBeforeResolution,
        providerContinued,
        survivedRestart,
        serviceReopened: scenarioCase.id === "restart-after-owner-tap",
        firstDelivery,
        secondDelivery,
      }),
    );
  }

  await service.reconcile(fence, signal);

  const completed = store.getControllerTurn(turn.id);
  const reply = store.getOutbox(`controller:${turn.id}:reply`);
  let grade: ScenarioGrade;
  if (scenarioCase.id === "process-only-finalization") {
    const exactContinuation = completed?.completionContinuations === 1;
    const safeStatusOnly = reply?.status === "pending" && reply.payload.text === "Hanoon is connecting…";
    const neverDelivered = completed?.state === "submitted" && completed.responseText === null &&
      completed.acceptedFinalizationId === null && safeStatusOnly;
    grade = {
      responseText: "",
      outcomePassed: exactContinuation && neverDelivered && sentTexts.length === 1,
      tracePassed: exactContinuation && sentTexts.length === 1,
      outcomeProofs: [proof(`${fixtureId}:continuations:${completed?.completionContinuations ?? "missing"}`), proof(`${fixtureId}:reply:${reply?.logicalKey ?? "none"}`), proof(`${fixtureId}:sent:${sentTexts.length}`)],
      traceProofs: [proof(`${fixtureId}:recovery:${sentTexts[0] ?? "missing"}`)],
      answerProofs: [proof(`${fixtureId}:not-applicable`)],
    };
  } else if (scenarioCase.id === "unsupported-success-claim") {
    const rejection = bb.storage.database().prepare(
      "SELECT rejection_code FROM controller_finalizations WHERE turn_id = ? AND state = 'rejected' ORDER BY revision DESC LIMIT 1",
    ).get(turn.id) as { rejection_code?: string } | undefined;
    const rejected = finalizationOutcome === "rejected" && finalizationCode === "high_impact_text_unclaimed" &&
      rejection?.rejection_code === "high_impact_text_unclaimed";
    const safeStatusOnly = reply?.status === "pending" && reply.payload.text === "Hanoon is connecting…";
    grade = {
      responseText: "",
      outcomePassed: rejected && completed?.state === "submitted" && completed.responseText === null && safeStatusOnly,
      tracePassed: rejected && sentTexts.length === 1,
      outcomeProofs: [proof(`${fixtureId}:rejection:${rejection?.rejection_code ?? "missing"}`), proof(`${fixtureId}:reply:${reply?.logicalKey ?? "none"}`)],
      traceProofs: [proof(`${fixtureId}:continuation:${completed?.completionContinuations ?? "missing"}`)],
      answerProofs: [proof(`${fixtureId}:not-applicable`)],
    };
  } else if (scenarioCase.id === "duplicate-mutation-replay") {
    const first = toolResults[0];
    const second = toolResults[1];
    const firstJob = scenarioRecord(first?.job);
    const secondJob = scenarioRecord(second?.job);
    const jobId = typeof firstJob?.id === "string" ? firstJob.id : null;
    const secondJobId = typeof secondJob?.id === "string" ? secondJob.id : null;
    const durableJob = jobId ? store.getJob(jobId) : null;
    const receipts = store.listToolReceipts(turn.id);
    const replayEvidence = scenarioRecord(second?._hanoonEvidence);
    const mutationOnce = jobId !== null && secondJobId === jobId && durableJob !== null &&
      store.listJobs(100).filter((job) => job.sourceUpdateId === turn.updateId).length === 1;
    const receiptReused = receipts.length === 1 && receipts[0]?.state === "completed";
    const replayObserved = replayEvidence?.outcome === "observed";
    const completedOnce = completed?.state === "completed" && reply?.payload.text === responseText;
    grade = {
      responseText,
      outcomePassed: mutationOnce && receiptReused && completedOnce && finalizationOutcome === "accepted",
      tracePassed: observedToolCalls === 2 && replayObserved,
      outcomeProofs: [proof(`${fixtureId}:job:${jobId ?? "missing"}`), proof(`${fixtureId}:same-job:${secondJobId === jobId}`), proof(`${fixtureId}:receipts:${receipts.length}`), proof(`${fixtureId}:finalization:${finalizationOutcome ?? "missing"}`)],
      traceProofs: [proof(`${fixtureId}:tool-calls:${observedToolCalls}`), proof(`${fixtureId}:replay:${replayObserved}`)],
      answerProofs: [proof(`${fixtureId}:answer:${completed?.responseText ?? "missing"}`)],
    };
  } else {
    const monitor = store.listMonitors(CONTROLLER_KEY, false)[0] ?? null;
    const watchEvidence = scenarioRecord(toolResults[0]?._hanoonEvidence);
    const monitorId = typeof monitor?.id === "string" ? monitor.id : null;
    const monitorProof = Array.isArray(watchEvidence?.proofKinds) && watchEvidence.proofKinds.includes("obligation");
    const deferredAccepted = finalizationOutcome === "accepted" && store.getAcceptedControllerFinalization(turn.id)?.consumedAt !== null;
    const exactReply = reply?.payload.text === responseText;
    grade = {
      responseText,
      outcomePassed: monitor?.state === "armed" && monitorId !== null && deferredAccepted && exactReply,
      tracePassed: observedToolCalls === 1 && monitorProof,
      outcomeProofs: [proof(`${fixtureId}:monitor:${monitorId ?? "missing"}`), proof(`${fixtureId}:monitor-state:${monitor?.state ?? "missing"}`), proof(`${fixtureId}:reply:${reply?.logicalKey ?? "missing"}`)],
      traceProofs: [proof(`${fixtureId}:watch-evidence:${monitorProof}`), proof(`${fixtureId}:obligation:monitor:${monitorId ?? "missing"}`)],
      answerProofs: [proof(`${fixtureId}:answer:${completed?.responseText ?? "missing"}`)],
    };
  }
    const finalMonitor = store.listMonitors(CONTROLLER_KEY, false)[0] ?? null;
    const accepted = store.getAcceptedControllerFinalization(turn.id);
    const finalWatchEvidence = scenarioRecord(toolResults[0]?._hanoonEvidence);
    const finalMonitorId = typeof finalMonitor?.id === "string" ? finalMonitor.id : null;
    const finalMonitorProof = Array.isArray(finalWatchEvidence?.proofKinds) && finalWatchEvidence.proofKinds.includes("obligation");
    const factfulGrade = gradeWithAssertionFacts(store, bb.storage.database(), turn.id, grade, {
      observedJobStatus: null,
      replaySameJob: scenarioCase.id === "duplicate-mutation-replay"
        ? (() => {
          const firstJob = scenarioRecord(toolResults[0]?.job);
          const secondJob = scenarioRecord(toolResults[1]?.job);
          return typeof firstJob?.id === "string" && firstJob.id === secondJob?.id;
        })()
        : false,
      replayOutcome: scenarioCase.id === "duplicate-mutation-replay"
        ? scenarioRecord(toolResults[1]?._hanoonEvidence)?.outcome as string | null ?? null
        : null,
      observedToolCalls,
      monitor: finalMonitor,
      monitorId: finalMonitorId,
      deferredAccepted: scenarioCase.id === "durable-deferred-monitor" && accepted?.consumedAt !== null,
      acceptedObligationRefs: accepted?.candidate.obligationRefs ?? [],
      watchCapabilityObserved: scenarioCase.id === "durable-deferred-monitor" && finalMonitorProof,
      unboundRejectionCode,
      ...(scenarioCase.id === "process-only-finalization" ? { sentTexts } : {}),
    });
    return scenarioTrial(
      scenarioCase,
      trial,
      seed,
      startedAt,
      toolSurface,
      factfulGrade,
    );
  } finally {
    await disposeScenarioResources(harness);
  }
}

export async function runControllerScenarioTrials(
  options: ControllerScenarioRunOptions,
): Promise<ControllerScenarioTrial[]> {
  if (!Number.isInteger(options.trials) || options.trials < 1 || options.trials > 512) {
    throw new TypeError("trials must be an integer between 1 and 512");
  }
  if (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 2_147_483_647) {
    throw new TypeError("seed must be a non-negative 32-bit integer");
  }
  const checkpointRank: Record<ControllerScenarioRunOptions["checkpoint"], number> = {
    baseline: 0,
    kernel: 1,
    cutover: 2,
  };
  const corpus = loadControllerScenarioCorpus();
  validateControllerAssertionRegistry(corpus);
  const compatible = corpus.cases.filter((scenarioCase) =>
    checkpointRank[scenarioCase.checkpoint] <= checkpointRank[options.checkpoint]);
  if (compatible.length === 0) throw new Error(`no compatible scenarios for checkpoint ${options.checkpoint}`);
  const trials: ControllerScenarioTrial[] = [];
  for (const scenarioCase of compatible) {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      trials.push(await runScenario(scenarioCase, trial, options.seed));
    }
  }
  return trials;
}
