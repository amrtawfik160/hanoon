import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { PluginAgentConfigurationContext } from "@bb/plugin-sdk";
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
import { CONTROLLER_CAPABILITIES } from "../../src/controller/capability-policy";
import { ControllerEvidenceProjector } from "../../src/controller/evidence-projector";
import { buildTurnContext } from "../../src/controller/context";
import { composeControllerInstructions } from "../../src/controller/instructions";
import type {
  ControllerInteraction,
  ControllerInteractionStore,
} from "../../src/storage/controller-interaction-repository";
import {
  parseControllerScenarioCorpus,
  parseControllerScenarioTrial,
  controllerScenarioDefinitionSha256,
  validateControllerScenarioTrialBudget,
  validateControllerScenarioTrialEvidence,
  type ControllerScenarioEvidenceRecord,
  type ControllerScenarioTrial,
} from "../../src/eval/controller-scenario-contract";
import {
  evaluateControllerScenarioAnswer,
  isExpectedControllerRecoveryPrompt,
  parseControllerScenarioAnswerFixture,
  type ControllerScenarioAnswerFixture,
} from "../../src/eval/controller-scenario-answer-contract";
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
let scenarioLifecycleReloads = 0;

export function controllerScenarioResourceStats(): Readonly<{
  created: number;
  disposed: number;
  active: number;
  lifecycleReloads: number;
}> {
  return {
    created: scenarioResourcesCreated,
    disposed: scenarioResourcesDisposed,
    active: scenarioResourcesActive,
    lifecycleReloads: scenarioLifecycleReloads,
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

export function loadControllerScenarioAnswerFixture(): ControllerScenarioAnswerFixture {
  const path = fileURLToPath(new URL("../../evals/controller-scenario-answers.json", import.meta.url));
  return parseControllerScenarioAnswerFixture(JSON.parse(readFileSync(path, "utf8")));
}

const CONTROLLER_SCENARIO_ANSWER_FIXTURE = loadControllerScenarioAnswerFixture();

type ScenarioGrade = Readonly<{
  assertionFacts?: ScenarioAssertionFacts;
}>;

type ScenarioTrialInput = Readonly<{
  scenarioCase: ScenarioCase;
  trial: number;
  seed: number;
  startedAt: number;
  toolSurface: ReturnType<typeof registeredToolSurface>;
  trustInputs: ScenarioTrustInputs;
  grade: ScenarioGrade;
  executionCounters: ScenarioExecutionCounters;
  effectivePolicy?: unknown | null;
}>;

type ScenarioTrustInputs = Readonly<{
  instructionText: string;
  overlayText: string | null;
  contextCapsule: string | null;
}>;

function controllerConfigurationContext(pluginId: string): PluginAgentConfigurationContext {
  return {
    thread: {
      id: "thr_fixed_controller",
      title: `Telegram Codex controller ${CONTROLLER_KEY}`,
      parentThreadId: null,
      sourceThreadId: null,
    },
    project: {
      id: "proj_fixed",
      kind: "personal",
      name: "Fixed controller project",
      gitRemoteUrl: null,
    },
    environment: {
      id: "env_fixed_controller",
      name: "Fixed controller environment",
      path: "/tmp/hanoon-controller-scenario",
      workspaceProvisionType: "personal",
      branchName: null,
    },
    host: { id: "host_fixed", name: "Fixed controller host" },
    provider: { id: "codex", model: "scripted-controller" },
    origin: { kind: null, pluginId },
  };
}

async function captureScenarioTrustInputs(
  input: Readonly<{
    bb: ReturnType<typeof createFakePluginHost>["bb"];
    harness: ReturnType<typeof createFakePluginHost>["harness"];
    store: TelegramAgentStore;
    contextCapsule: string | null;
    toolSurface: ReturnType<typeof registeredToolSurface>;
  }>,
): Promise<ScenarioTrustInputs> {
  const { bb, harness, store, contextCapsule, toolSurface } = input;
  const configuration = await harness.behavior.resolveAgentConfiguration(controllerConfigurationContext(bb.pluginId));
  if (configuration.instructions === null) throw new Error("production controller configuration returned no instructions");
  const expectedInstructions = composeControllerInstructions(store.getControllerOverlay());
  if (configuration.instructions !== expectedInstructions) {
    throw new Error("production controller configuration instructions are not the composed controller instructions");
  }
  const configuredToolNames = configuration.tools.map((tool) => typeof tool === "string" ? tool : tool.name).sort();
  const registeredToolNames = [...toolSurface.advertisedTools].sort();
  if (JSON.stringify(configuredToolNames) !== JSON.stringify(registeredToolNames)) {
    throw new Error("production controller configuration tool selection is not the registered tool surface");
  }
  return {
    instructionText: configuration.instructions,
    overlayText: store.getControllerOverlay(),
    contextCapsule,
  };
}

function scenarioFactRef(
  scenarioId: string,
  layer: ControllerScenarioEvidenceRecord["layer"],
  assertion: string,
): string {
  return `fact:${scenarioId}:${layer}:${assertion}`;
}

function scenarioEvidenceRecords(
  scenarioCase: ScenarioCase,
  facts: ScenarioAssertionFacts,
  answerStatus: "passed" | "failed" | "not_applicable",
): ControllerScenarioEvidenceRecord[] {
  const records: ControllerScenarioEvidenceRecord[] = [];
  for (const assertion of scenarioCase.requiredOutcomeAssertions) {
    records.push({
      ref: scenarioFactRef(scenarioCase.id, "outcome", assertion),
      subject: scenarioCase.id,
      layer: "outcome",
      assertion,
      observed: CONTROLLER_ASSERTION_REGISTRY[assertion]!(facts),
      facts: redactedAssertionFacts(facts),
    });
  }
  for (const assertion of scenarioCase.forbiddenOutcomeAssertions) {
    records.push({
      ref: scenarioFactRef(scenarioCase.id, "outcome", assertion),
      subject: scenarioCase.id,
      layer: "outcome",
      assertion,
      observed: CONTROLLER_ASSERTION_REGISTRY[assertion]!(facts),
      facts: redactedAssertionFacts(facts),
    });
  }
  for (const assertion of scenarioCase.requiredTraceAssertions) {
    records.push({
      ref: scenarioFactRef(scenarioCase.id, "trace", assertion),
      subject: scenarioCase.id,
      layer: "trace",
      assertion,
      observed: CONTROLLER_ASSERTION_REGISTRY[assertion]!(facts),
      facts: redactedAssertionFacts(facts),
    });
  }
  if (scenarioCase.answerGrader === "required") {
    records.push({
      ref: scenarioFactRef(scenarioCase.id, "answer", "answer_grader"),
      subject: scenarioCase.id,
      layer: "answer",
      assertion: "answer_grader",
      observed: answerStatus === "passed",
      facts: redactedAssertionFacts(facts),
    });
  }
  return records;
}

function scenarioTrial(input: ScenarioTrialInput): ControllerScenarioTrial {
  const {
    scenarioCase,
    trial,
    seed,
    startedAt,
    toolSurface,
    trustInputs,
    grade,
    executionCounters,
    effectivePolicy = null,
  } = input;
  if (!grade.assertionFacts) throw new Error(`scenario ${scenarioCase.id} has no durable assertion facts`);
  const assertions = evaluateDeclaredAssertions(scenarioCase, grade.assertionFacts);
  const outcomePassed = scenarioCase.requiredOutcomeAssertions.every((id) => assertions[id] === true) &&
    !scenarioCase.forbiddenOutcomeAssertions.some((id) => assertions[id] === true);
  const tracePassed = scenarioCase.requiredTraceAssertions.every((id) => assertions[id] === true);
  const answerStatus: "passed" | "failed" | "not_applicable" = scenarioCase.answerGrader === "required"
    ? evaluateScenarioAnswer(scenarioCase, grade.assertionFacts) ? "passed" : "failed"
    : "not_applicable";
  const evidenceRecords = scenarioEvidenceRecords(scenarioCase, grade.assertionFacts, answerStatus);
  const parsed = parseControllerScenarioTrial({
    schemaVersion: 1,
    scenarioVersion: scenarioCase.scenarioVersion,
    scenarioDefinitionSha256: controllerScenarioDefinitionSha256(scenarioCase),
    scenarioId: scenarioCase.id,
    trial,
    seed,
    harness: harnessIdentity(toolSurface, trustInputs, effectivePolicy),
    budget: scenarioCase.budget,
    outcome: {
      status: outcomePassed ? "passed" : "failed",
      graderId: "durable-outcome",
      graderVersion: 1,
      proofRefs: [
        ...scenarioCase.requiredOutcomeAssertions.map((id) => scenarioFactRef(scenarioCase.id, "outcome", id)),
        ...scenarioCase.forbiddenOutcomeAssertions.map((id) => scenarioFactRef(scenarioCase.id, "outcome", id)),
      ],
    },
    trace: {
      status: tracePassed ? "passed" : "failed",
      graderId: "typed-trace",
      graderVersion: 1,
      proofRefs: [
        ...scenarioCase.requiredTraceAssertions.map((id) => scenarioFactRef(scenarioCase.id, "trace", id)),
      ],
    },
    answer: {
      status: answerStatus,
      graderId: "answer-form",
      graderVersion: 1,
      proofRefs: [
        ...(scenarioCase.answerGrader === "required"
          ? [scenarioFactRef(scenarioCase.id, "answer", "answer_grader")]
          : []),
      ],
    },
    metrics: {
      wallMs: Math.max(0, Math.ceil(performance.now() - startedAt)),
      turns: executionCounters.turns,
      toolCalls: executionCounters.toolCalls,
      tokens: null,
      costUsd: null,
      terminalFailureClass: null,
    },
    evidenceRecords,
  });
  const evidenceValidated = validateControllerScenarioTrialEvidence(parsed);
  return validateControllerScenarioTrialBudget(evidenceValidated);
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

function registeredToolSurface(agentTools: ReadonlyArray<{
  name: string;
  description: string;
  inputSchema: unknown;
  experimentalStatusLabels: unknown;
  instructions: string | null;
}>) {
  const tools = [...agentTools]
    .map(({ name, description, inputSchema, experimentalStatusLabels, instructions }) => ({
      name,
      description,
      inputSchema,
      experimentalStatusLabels,
      instructions,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const expectedToolNames = [...CONTROLLER_TOOL_NAMES].sort();
  const actualToolNames = tools.map((tool) => tool.name);
  if (JSON.stringify(actualToolNames) !== JSON.stringify(expectedToolNames)) {
    throw new Error("registered controller tool surface is incomplete or contains an unknown tool");
  }
  const capabilities = tools.map((tool) => {
    const descriptor = CONTROLLER_CAPABILITIES[tool.name as keyof typeof CONTROLLER_CAPABILITIES];
    if (!descriptor) throw new Error(`registered controller tool ${tool.name} is missing from the capability manifest`);
    return descriptor;
  });
  const parameterSchemaSha256 = Object.fromEntries(
    tools.map((tool) => [tool.name, sha256(canonicalJson(tool.inputSchema))]),
  );
  return {
    advertisedTools: tools.map((tool) => tool.name),
    parameterSchemaSha256,
    capabilityManifestSha256: sha256(canonicalJson({
      toolNames: expectedToolNames,
      capabilities,
      tools,
    })),
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
  onSpawn?: () => void;
  onEvents?: (observation: Readonly<{ toolCalls: number; totalTokens: number | null }>) => void;
}>;

function scriptedAdapter(
  observeToolCall: () => Promise<number>,
  finalizeTurn: () => Promise<void>,
  reserveSpawn: (turnId: string) => boolean,
  options: ScriptedAdapterOptions = {},
): ControllerAdapter {
  return {
    spawn: async (turn) => {
      if (!reserveSpawn(turn.id)) throw new Error("fixed scenario spawn reservation failed");
      options.onSpawn?.();
      return { threadId: "thr_fixed_controller", projectId: "proj_fixed", hostId: "host_fixed", spawnToken: turn.id };
    },
    send: async (_threadId, text) => options.onSend?.(text),
    steer: async () => undefined,
    answerQuestion: async () => undefined,
    status: async () => "idle",
    latestSeq: async () => options.eventSequence?.() ?? 0,
    events: async (): Promise<ControllerEventResult> => {
      const toolCalls = await observeToolCall();
      if (options.finalizeOnEvents !== false) await finalizeTurn();
      options.onEvents?.({ toolCalls, totalTokens: null });
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
  recoveryPromptTexts: readonly string[];
  providerContinuationTexts: readonly string[];
  staleApprovalSettlementDenied: boolean;
  staleApprovalStateBefore: string | null;
  staleApprovalStateAfter: string | null;
  staleApprovalExternalCalls: number;
  staleApprovalResolutionAttempts: number;
  staleApprovalOutboxCountBefore: number;
  staleApprovalOutboxCountAfter: number;
  telegramApprovalRendered: boolean;
  interactionRowState: string | null;
  interactionAnswer: Readonly<Record<string, unknown>> | null;
  successfulResolutionCount: number;
  answeredBeforeResolution: boolean;
  providerContinued: boolean;
  survivedRestart: boolean;
  serviceReopened: boolean;
  lifecycleHostsChanged: boolean;
  firstDelivery: boolean;
  secondDelivery: boolean;
  monitor: ReturnType<TelegramAgentStore["listMonitors"]>[number] | null;
  monitorId: string | null;
  deferredAccepted: boolean;
  acceptedObligationRefs: readonly string[];
  unboundRejectionCode: string | null;
  watchCapabilityObserved: boolean;
}>;

type ScenarioExecutionCounters = Readonly<{
  turns: number;
  toolCalls: number;
  tokens: number | null;
  costUsd: number | null;
}>;

function redactedAssertionFacts(
  facts: ScenarioAssertionFacts,
): ControllerScenarioEvidenceRecord["facts"] {
  const responseText = facts.turn?.responseText;
  const outboxPayload = facts.reply?.payload.text;
  return {
    turnState: facts.turn?.state ?? null,
    responsePresent: responseText !== null && responseText !== undefined,
    responseLength: typeof responseText === "string" ? Array.from(responseText).length : null,
    replyExists: facts.reply !== null,
    replyCount: facts.replyCount,
    responseCount: facts.responseCount,
    digestCount: facts.digestCount,
    outboxTextLength: typeof outboxPayload === "string" ? Array.from(outboxPayload).length : null,
    jobCountBefore: facts.jobCountBefore,
    jobCountAfter: facts.jobCountAfter,
    effectsBeforeCount: facts.effectsBeforeCount,
    effectsAfterCount: facts.effectsAfterCount,
    observedJobStatusId: facts.observedJobStatus?.id ?? null,
    observedJobStatusState: facts.observedJobStatus?.state ?? null,
    finalizationOutcome: facts.finalizationOutcome,
    finalizationRejectionCount: facts.finalizationRows.filter((row) => row.state === "rejected").length,
    denialCode: facts.denialCode,
    observedToolCalls: facts.observedToolCalls,
    replaySameJob: facts.replaySameJob,
    replayOutcome: facts.replayOutcome,
    recoveryPromptCount: facts.recoveryPromptTexts.length,
    providerContinuationCount: facts.providerContinuationTexts.length,
    telegramApprovalRendered: facts.telegramApprovalRendered,
    interactionRowState: facts.interactionRowState,
    successfulResolutionCount: facts.successfulResolutionCount,
    answeredBeforeResolution: facts.answeredBeforeResolution,
    survivedRestart: facts.survivedRestart,
    serviceReopened: facts.serviceReopened,
    lifecycleHostsChanged: facts.lifecycleHostsChanged,
    firstDelivery: facts.firstDelivery,
    secondDelivery: facts.secondDelivery,
    monitorState: facts.monitor?.state ?? null,
    monitorIdPresent: facts.monitorId !== null,
    deferredAccepted: facts.deferredAccepted,
    obligationRefCount: facts.acceptedObligationRefs.length,
    unboundRejectionCode: facts.unboundRejectionCode,
    watchCapabilityObserved: facts.watchCapabilityObserved,
  };
}

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
  recovery_prompt_sent: (facts) => facts.recoveryPromptTexts.length === 1,
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
  stale_approval_denied: (facts) => facts.staleApprovalSettlementDenied,
  stale_approval_no_effect: (facts) => facts.staleApprovalStateBefore === "answered"
    && facts.staleApprovalStateAfter === "answered"
    && facts.staleApprovalExternalCalls === 0
    && facts.staleApprovalResolutionAttempts === 0
    && facts.staleApprovalOutboxCountBefore === facts.staleApprovalOutboxCountAfter,
  job_count_unchanged: (facts) => facts.jobCountBefore === facts.jobCountAfter,
  success_evidence_absent: (facts) => facts.evidence.length === 0,
  job_created: (facts) => facts.jobCountAfter > facts.jobCountBefore,
  success_envelope_returned: (facts) => facts.staleToolReturned,
  capability_denied_before_effect: (facts) => facts.denialCode === "fence_lost" &&
    facts.jobCountBefore === facts.jobCountAfter && facts.receipts.length === 0 && facts.evidence.length === 0,
  stale_approval_denied_before_effect: (facts) => facts.staleApprovalSettlementDenied
    && facts.staleApprovalExternalCalls === 0
    && facts.staleApprovalResolutionAttempts === 0
    && facts.staleApprovalStateBefore === facts.staleApprovalStateAfter,
  telegram_approval_rendered: (facts) => facts.telegramApprovalRendered,
  interaction_resolved_once: (facts) => facts.successfulResolutionCount === 1,
  provider_continued: (facts) => facts.providerContinuationTexts.length === 1,
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

function evaluateScenarioAnswer(
  scenarioCase: ScenarioCase,
  facts: ScenarioAssertionFacts | undefined,
): boolean {
  if (scenarioCase.answerGrader !== "required") return true;
  if (!facts) throw new Error(`scenario ${scenarioCase.id} has no durable answer facts`);
  const expectation = CONTROLLER_SCENARIO_ANSWER_FIXTURE.cases.find(
    (candidate) => candidate.scenarioId === scenarioCase.id,
  );
  if (!expectation) throw new Error(`scenario ${scenarioCase.id} has no independent answer expectation`);
  return evaluateControllerScenarioAnswer(expectation, {
    responseText: facts.turn?.responseText ?? null,
    outboxText: outboxText(facts.reply),
    observedJobStatus: facts.observedJobStatus,
    interactionRowState: facts.interactionRowState,
    interactionAnswer: facts.interactionAnswer,
    monitorId: facts.monitorId,
    acceptedObligationRefs: facts.acceptedObligationRefs,
  });
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
    recoveryPromptTexts: [],
    providerContinuationTexts: [],
    staleApprovalSettlementDenied: false,
    staleApprovalStateBefore: null,
    staleApprovalStateAfter: null,
    staleApprovalExternalCalls: 0,
    staleApprovalResolutionAttempts: 0,
    staleApprovalOutboxCountBefore: 0,
    staleApprovalOutboxCountAfter: 0,
    telegramApprovalRendered: false,
    interactionRowState: interactionRow?.state ?? null,
    interactionAnswer,
    successfulResolutionCount: 0,
    answeredBeforeResolution: false,
    providerContinued: false,
    survivedRestart: false,
    serviceReopened: false,
    lifecycleHostsChanged: false,
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
  const fixtureAnswerCases = new Set(CONTROLLER_SCENARIO_ANSWER_FIXTURE.cases.map((candidate) => candidate.scenarioId));
  for (const scenarioId of requiredAnswerCases) {
    if (!fixtureAnswerCases.has(scenarioId)) {
      throw new Error(`unknown independent controller answer expectation ${scenarioId}`);
    }
  }
  for (const scenarioId of fixtureAnswerCases) {
    if (!requiredAnswerCases.has(scenarioId)) {
      throw new Error(`controller answer expectation is not declared: ${scenarioId}`);
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

function harnessIdentity(
  toolSurface: ReturnType<typeof registeredToolSurface>,
  trustInputs: ScenarioTrustInputs,
  effectivePolicy: unknown | null,
): ControllerScenarioTrial["harness"] {
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
    instructionSha256: sha256(trustInputs.instructionText),
    overlaySha256: sha256(trustInputs.overlayText ?? ""),
    capabilityManifestSha256: toolSurface.capabilityManifestSha256,
    policySha256: controllerScenarioPolicySha256(effectivePolicy),
    contextSha256: sha256(trustInputs.contextCapsule ?? ""),
    outerTaskTools: [],
    advertisedTools: toolSurface.advertisedTools,
    parameterSchemaSha256: toolSurface.parameterSchemaSha256,
  };
}

export function controllerScenarioPolicySha256(effectivePolicy: unknown | null): string {
  return sha256(effectivePolicy === null ? "baseline-no-project-policy" : canonicalJson(effectivePolicy));
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
    controllerProviderId: () => "codex",
  });
  const toolSurface = registeredToolSurface(harness.registrations.agentTools);

  const queuedJob = scenarioCase.id === "current-job-status"
    ? store.createJob({ id: JOB_ID, sourceUpdateId: seed * 1_000 + trial, requestText: "fixed status fixture", now: 3 })
    : null;
  const jobBefore = queuedJob ? store.getJob(JOB_ID) : null;
  const effectsBefore = queuedJob ? store.listEffectsForJob(JOB_ID) : [];
  const jobCountBefore = store.listJobs(256).length;
  const observed = { jobStatus: null as JobStatusProjection | null };
  const executionCounters = { turns: 0, toolCalls: 0, tokens: null, costUsd: null } satisfies ScenarioExecutionCounters;
  let response = "Hello from Hanoon.";
  let activeTurnId: string | null = null;
  let finalizationAccepted = false;
  const observeToolCall = async () => {
    if (!queuedJob) return 0;
    observed.jobStatus = parseJobStatusProjection(await harness.behavior.callAgentTool(
      "telegram_agent_job_status",
      { jobId: JOB_ID },
      { threadId: "thr_fixed_controller", projectId: "proj_fixed" },
    ));
    response = `Job ${observed.jobStatus.id} is currently ${observed.jobStatus.state}.`;
    return 1;
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
    {
      onSpawn: () => { executionCounters.turns += 1; },
      onEvents: ({ toolCalls }) => { executionCounters.toolCalls += toolCalls; },
    },
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
  const contextCapsule = buildTurnContext({
    store,
    controllerKey: CONTROLLER_KEY,
    inputText: turn.inputText,
    includeDigest: true,
    turnId: turn.id,
    now: FIXTURE_NOW,
  });

  await service.processOne(fence, signal);
  await service.reconcile(fence, signal);

  const jobAfter = queuedJob ? store.getJob(JOB_ID) : null;
  const effectsAfter = queuedJob ? store.listEffectsForJob(JOB_ID) : [];

  const trustInputs = await captureScenarioTrustInputs({ bb, harness, store, contextCapsule, toolSurface });

    const grade: ScenarioGrade = {
    };
    return scenarioTrial({
      scenarioCase,
      trial,
      seed,
      startedAt,
      toolSurface,
      trustInputs,
      grade: gradeWithAssertionFacts(store, bb.storage.database(), turn.id, grade, {
        jobBefore,
        jobAfter,
        effectsBeforeCount: effectsBefore.length,
        effectsAfterCount: effectsAfter.length,
        jobCountBefore,
        jobCountAfter: store.listJobs(256).length,
        observedJobStatus: observed.jobStatus,
      }),
      executionCounters,
    });
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
  let activeHarness = harness;
  beginScenarioResources();
  try {
    const store = openStore(bb.storage, bb.storage.kv, () => FIXTURE_NOW);
  let activeBb = bb;
  let observationStore = store;
  let observationBb = bb;
  let lifecycleHostsChanged = false;
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

  const effectivePolicy = fixedProjectPolicy();
  store.upsertProjectPolicy(effectivePolicy, FIXTURE_NOW);
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
    controllerProviderId: () => "codex",
  });
  const toolSurface = registeredToolSurface(harness.registrations.agentTools);

  let activeTurnId: string | null = null;
  let responseText = "";
  let finalizationAttempted = false;
  const sentTexts: string[] = [];
  const recoveryPromptTexts: string[] = [];
  const providerContinuationTexts: string[] = [];
  const executionCounters = { turns: 0, toolCalls: 0, tokens: null, costUsd: null } satisfies ScenarioExecutionCounters;
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
  let interactionResolution: Record<string, unknown> | null = null;
  const resolutionAttempts: Record<string, unknown>[] = [];
  let successfulResolutions = 0;
  let unboundRejectionCode: string | null = null;

  const observeToolCall = async (): Promise<number> => {
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
      return 2;
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
      return 1;
    }
    return 0;
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

    store.proposeControllerFinalization({
      ownerId: executionOwnerId,
      generation: lease.generation,
      now: FIXTURE_NOW,
      turnId: activeTurnId,
      controllerKey: CONTROLLER_KEY,
      bbEventHighWaterSeq: 0,
      candidate,
    });
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
      onSend: (text) => {
        sentTexts.push(text);
        if (isExpectedControllerRecoveryPrompt(CONTROLLER_SCENARIO_ANSWER_FIXTURE.recoveryPrompt, text)) {
          recoveryPromptTexts.push(text);
        }
        if (text.includes("telegram_agent_turn_evidence")) providerContinuationTexts.push(text);
      },
      onSpawn: () => { executionCounters.turns += 1; },
      onEvents: ({ toolCalls }) => { executionCounters.toolCalls += toolCalls; },
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
          resolution: interactionResolution,
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
          resolution: interactionResolution,
        }),
        resolve: async (input) => {
          const resolution = JSON.parse(JSON.stringify(input.resolution)) as Record<string, unknown>;
          resolutionAttempts.push(resolution);
          if (scenarioCase.id === "restart-after-owner-tap" && resolutionAttempts.length === 1) return null;
          interactionStatus = "resolved";
          interactionResolution = resolution;
          successfulResolutions += 1;
          return { id: input.interactionId, threadId: input.threadId, status: "resolved", resolution };
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
  const contextCapsule = buildTurnContext({
    store,
    controllerKey: CONTROLLER_KEY,
    inputText: turn.inputText,
    includeDigest: true,
    turnId: turn.id,
    now: FIXTURE_NOW,
  });

  await service.processOne(fence, signal);

  if (scenarioCase.id === "stale-capability-fence") {
    const jobsBefore = store.listJobs(100).length;
    const controllerGeneration = store.listControllerGenerations(CONTROLLER_KEY, 1)[0];
    if (!controllerGeneration) throw new Error("fixed stale scenario has no controller generation");
    const staleApprovalId = `stale_approval_${seed}_${trial}`;
    const recordedApproval = store.recordControllerInteraction({
      ownerId: executionOwnerId,
      generation: lease.generation,
      now: FIXTURE_NOW,
      turnId: turn.id,
      controllerKey: CONTROLLER_KEY,
      bbThreadId: threadId,
      controllerGenerationId: controllerGeneration.id,
      interaction: {
        kind: "approval",
        interactionId: staleApprovalId,
        summary: "Run the fixture command once.",
        decisions: ["allow_once", "deny"],
      },
    });
    if (recordedApproval !== "recorded") throw new Error("fixed stale scenario approval could not be recorded");
    const answeredApproval = store.answerControllerInteractionByToken({
      token: controllerInteractionToken(staleApprovalId, "allow_once"),
      userId: OWNER_ID,
      chatId: OWNER_ID,
      now: FIXTURE_NOW + 1,
    });
    if (!answeredApproval.ok) throw new Error("fixed stale scenario approval could not be answered");
    const staleApprovalStateBefore = store.getAnsweredControllerInteraction(CONTROLLER_KEY) ? "answered" : null;
    const staleApprovalOutboxCountBefore = store.listOutbox(256).length;
    let staleApprovalExternalCalls = 0;
    let staleApprovalResolutionAttempts = 0;
    const staleApprovalService = new ControllerInteractionService({
      store: controllerInteractionStore(store),
      clock: { now: () => FIXTURE_NOW },
      interactions: {
        get: async () => {
          staleApprovalExternalCalls += 1;
          return { id: staleApprovalId, threadId, status: "pending" };
        },
        resolve: async () => {
          staleApprovalExternalCalls += 1;
          staleApprovalResolutionAttempts += 1;
          return { id: staleApprovalId, threadId, status: "resolved" };
        },
      },
    });
    if (!store.releaseExecutorLease(executionOwnerId, lease.generation, FIXTURE_NOW)) {
      throw new Error("fixed scenario lease could not be released");
    }
    const staleApprovalSettlementDenied = !(await staleApprovalService.deliverAnswered(
      CONTROLLER_KEY,
      { ownerId: executionOwnerId, generation: lease.generation, now: FIXTURE_NOW },
      signal,
    ));
    const staleApprovalStateAfter = store.getAnsweredControllerInteraction(CONTROLLER_KEY) ? "answered" : null;
    const staleApprovalOutboxCountAfter = store.listOutbox(256).length;
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
    };
    const trustInputs = await captureScenarioTrustInputs({ bb, harness, store, contextCapsule, toolSurface });
    return scenarioTrial({
      scenarioCase,
      trial,
      seed,
      startedAt,
      toolSurface,
      trustInputs,
      grade: gradeWithAssertionFacts(store, bb.storage.database(), turn.id, grade, {
        jobCountBefore: jobsBefore,
        jobCountAfter: jobsAfter,
        denialCode,
        staleToolReturned: false,
        staleApprovalSettlementDenied,
        staleApprovalStateBefore,
        staleApprovalStateAfter,
        staleApprovalExternalCalls,
        staleApprovalResolutionAttempts,
        staleApprovalOutboxCountBefore,
        staleApprovalOutboxCountAfter,
      }),
      executionCounters,
      effectivePolicy,
    });
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
    const ingress = new TelegramIngress({
      store,
      telegram: {
        sendMessage: async () => ({ message_id: 1 }),
        editMessage: async () => undefined,
        answerCallback: async () => undefined,
      },
      onWorkAvailable: () => undefined,
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

    let firstDelivery = true;
    let secondDelivery = true;
    let survivedRestart = true;
    let serviceReopened = false;
    if (scenarioCase.id === "restart-after-owner-tap") {
      let reloadedStore: TelegramAgentStore | null = null;
      const reloadedHost = await harness.lifecycle.reload(async (restartedBb) => {
        const reopenedStore = openStore(restartedBb.storage, restartedBb.storage.kv, () => FIXTURE_NOW);
        reloadedStore = reopenedStore;
        const reloadedEvidenceProjector = new ControllerEvidenceProjector({
          sdk: restartedBb.sdk,
          store: reopenedStore,
          clock: { now: () => FIXTURE_NOW },
          hanoonToolNames: CONTROLLER_TOOL_NAMES,
        });
        registerControllerTools(restartedBb, {
          store: reopenedStore,
          sdk: restartedBb.sdk,
          evidenceProjector: reloadedEvidenceProjector,
          threadOperations: { request: async () => { throw new Error("thread operations are not part of this fixed scenario"); } },
          health: () => ({ status: "ok" }),
          notify: () => undefined,
          now: () => FIXTURE_NOW,
          controllerProviderId: () => "codex",
        });
      });
      const reopenedStore: TelegramAgentStore | null = reloadedStore as TelegramAgentStore | null;
      if (reopenedStore === null) throw new Error("controller scenario lifecycle reload did not reopen its store");
      activeHarness = reloadedHost.harness;
      activeBb = reloadedHost.bb;
      observationStore = reopenedStore;
      observationBb = reloadedHost.bb;
      lifecycleHostsChanged = activeBb !== bb && activeHarness !== harness;
      scenarioLifecycleReloads += 1;
      activeHarness.sdk.stub("threads.get", async () => ({
        id: threadId,
        projectId,
        environmentId: "env_fixed_controller",
      }));
      activeHarness.sdk.stub("environments.get", async () => ({
        id: "env_fixed_controller",
        projectId,
        hostId: "host_fixed",
        path: "/tmp/hanoon-controller-scenario",
        status: "ready",
        workspaceProvisionType: "personal",
      }));
      activeHarness.sdk.stub("threads.timeline", async () => ({ maxSeq: 0 }));
      activeHarness.sdk.stub("threads.events.list", async () => []);
      const reloadedEvidenceProjector = new ControllerEvidenceProjector({
        sdk: activeBb.sdk,
        store: reopenedStore,
        clock: { now: () => FIXTURE_NOW },
        hanoonToolNames: CONTROLLER_TOOL_NAMES,
      });
      const reloadedInteractionService = new ControllerInteractionService({
        store: controllerInteractionStore(reopenedStore),
        clock: { now: () => FIXTURE_NOW },
        interactions: {
          get: async (requestedThreadId, requestedInteractionId) => ({
            id: requestedInteractionId,
            threadId: requestedThreadId,
            status: interactionStatus,
            resolution: interactionResolution,
          }),
          resolve: async (input) => {
            const resolution = JSON.parse(JSON.stringify(input.resolution)) as Record<string, unknown>;
            resolutionAttempts.push(resolution);
            if (resolutionAttempts.length === 1) return null;
            interactionStatus = "resolved";
            interactionResolution = resolution;
            successfulResolutions += 1;
            return { id: input.interactionId, threadId: input.threadId, status: "resolved", resolution };
          },
        },
      });
      const reloadedService = new LunaControllerService({
        store: reopenedStore,
        adapter,
        interactionService: reloadedInteractionService,
        evidenceProjector: reloadedEvidenceProjector,
        clock: { now: () => FIXTURE_NOW },
      });
      serviceReopened = lifecycleHostsChanged && resolutionAttempts.length === 0;
      firstDelivery = await reloadedInteractionService.deliverAnswered(CONTROLLER_KEY, interactionFence, signal);
      survivedRestart = reopenedStore.getAnsweredControllerInteraction(CONTROLLER_KEY) !== null;
      secondDelivery = await reloadedInteractionService.deliverAnswered(CONTROLLER_KEY, interactionFence, signal);
      await reloadedService.reconcile(fence, signal);
    } else {
      firstDelivery = await service.reconcile(fence, signal);
      await service.reconcile(fence, signal);
    }

    const interactionRow = observationBb.storage.database().prepare(
      "SELECT state FROM controller_interactions WHERE interaction_id = ?",
    ).get(interactionId) as { state?: string } | undefined;
    const providerContinued = providerContinuationTexts.length === 1;
    const trustInputs = await captureScenarioTrustInputs({
      bb: activeBb,
      harness: activeHarness,
      store: observationStore,
      contextCapsule,
      toolSurface,
    });
    const grade: ScenarioGrade = {
    };
    return scenarioTrial({
      scenarioCase,
      trial,
      seed,
      startedAt,
      toolSurface,
      trustInputs,
      grade: gradeWithAssertionFacts(observationStore, observationBb.storage.database(), turn.id, grade, {
        telegramApprovalRendered,
        interactionRowState: interactionRow?.state ?? null,
        successfulResolutionCount: successfulResolutions,
        answeredBeforeResolution,
        providerContinued,
        survivedRestart,
        serviceReopened,
        lifecycleHostsChanged,
        firstDelivery,
        secondDelivery,
        sentTexts,
        recoveryPromptTexts,
        providerContinuationTexts,
      }),
      executionCounters,
      effectivePolicy,
    });
  }

  await service.reconcile(fence, signal);

  const grade: ScenarioGrade = {};
  const finalMonitor = store.listMonitors(CONTROLLER_KEY, false)[0] ?? null;
  const accepted = store.getAcceptedControllerFinalization(turn.id);
  const finalWatchEvidence = scenarioRecord(toolResults[0]?._hanoonEvidence);
  const finalMonitorId = typeof finalMonitor?.id === "string" ? finalMonitor.id : null;
  const finalMonitorProof = Array.isArray(finalWatchEvidence?.proofKinds) && finalWatchEvidence.proofKinds.includes("obligation");
  const trustInputs = await captureScenarioTrustInputs({ bb, harness, store, contextCapsule, toolSurface });
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
      sentTexts,
      recoveryPromptTexts,
      providerContinuationTexts,
  });
  return scenarioTrial({
    scenarioCase,
    trial,
    seed,
    startedAt,
    toolSurface,
    trustInputs,
    grade: factfulGrade,
    executionCounters,
    effectivePolicy,
  });
  } finally {
    await disposeScenarioResources(activeHarness);
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
