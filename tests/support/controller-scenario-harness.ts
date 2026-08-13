import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { BbControllerAdapter } from "../../src/controller/bb-controller";
import {
  CONTROLLER_COMPLETION_RECOVERY_PROMPT,
  LunaControllerService,
} from "../../src/controller/service";
import { ControllerEvidenceProjector } from "../../src/controller/evidence-projector";
import { ControllerInteractionService } from "../../src/controller/interaction-service";
import { ControllerInteractionRepository } from "../../src/storage/controller-interaction-repository";
import { DEFAULT_CONTROLLER_EXECUTION_PROFILE } from "../../src/controller/execution-profile";
import { threadDecisionToken } from "../../src/controller/questions";
import { composeControllerInstructions } from "../../src/controller/instructions";
import { CONTROLLER_TOOL_NAMES, registerControllerTools } from "../../src/controller/tools";
import { ControllerCapabilityAuthorizationError } from "../../src/controller/capability-executor";
import { TelegramIngress } from "../../src/telegram/ingress";
import type { SendMessagePayload, TelegramUpdate } from "../../src/telegram/types";
import {
  BUDGET_EXCEEDED,
  controllerCheckpointCases,
  parseControllerScenarioCorpus,
  parseControllerScenarioTrial,
  type ControllerCheckpoint,
  type ControllerScenarioTrial,
} from "../../src/eval/controller-scenario-contract";
import { hashSecret } from "../../src/crypto";
import { openStore, type TelegramAgentStore } from "../../src/storage/store";
import type { ProjectPolicy } from "../../src/domain/models";

const FIXTURE_NOW = 1_000;
const CONTROLLER_KEY = "owner-7-controller";
const OWNER_ID = "7";
const JOB_ID = "job_fixture_1";
const THREAD_ID = "thr_fixed_controller";
const PROJECT_ID = "proj_fixed";
const HOST_ID = "host_fixed";
const ENVIRONMENT_ID = "env_fixed";
const PROJECT_ROOT = "/fixed/project";
const INTERACTION_ID = "pint_fixed_approval";
const WATCHED_THREAD_ID = "thr_fixed_watched";

type ScenarioCase = ReturnType<typeof parseControllerScenarioCorpus>["cases"][number];

export type ControllerScenarioRunOptions = Readonly<{
  checkpoint: ControllerCheckpoint;
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

/**
 * The digest of the project policies actually in force for this trial, in a
 * canonical order so two runs over the same policies agree and a changed policy
 * cannot pass for the same conditions. Disabled policies are deliberately
 * absent: they govern nothing, so they are not part of what the trial ran under.
 */
function durablePolicySha256(store: TelegramAgentStore): string {
  const policies = store.listEnabledProjectPolicies()
    .map((record) => record.policy)
    .sort((left, right) => left.projectId.localeCompare(right.projectId));
  return sha256(canonicalJson(policies));
}

/**
 * Everything that varies the conditions of one trial. Its digest has to move
 * when any of them move, or two different runs would claim to be the same run.
 */
function contextSha256(input: {
  scenarioCase: ScenarioCase;
  trial: number;
  seed: number;
  phase: Partial<ThreadPhase>;
}): string {
  return sha256(canonicalJson({
    scenarioId: input.scenarioCase.id,
    scenarioVersion: input.scenarioCase.scenarioVersion,
    checkpoint: input.scenarioCase.checkpoint,
    ownerMessage: input.scenarioCase.ownerMessage,
    budget: input.scenarioCase.budget,
    trial: input.trial,
    seed: input.seed,
    phase: {
      status: input.phase.status ?? null,
      maxSeq: input.phase.maxSeq ?? null,
      events: (input.phase.events ?? []) as unknown,
      interaction: (input.phase.interaction ?? null) as unknown,
    },
  }));
}

/**
 * What this trial actually ran under. Every digest here is taken from the real
 * artefact rather than from a literal standing in for it: a changed instruction
 * block, overlay, policy, or execution profile moves the identity, which is the
 * only thing that stops two unlike runs from being compared as like for like.
 */
function harnessIdentity(input: {
  scenarioCase: ScenarioCase;
  trial: number;
  seed: number;
  toolSurface: ReturnType<typeof registeredToolSurface>;
  store: TelegramAgentStore;
  phase: Partial<ThreadPhase>;
}): ControllerScenarioTrial["harness"] {
  const overlay = input.store.getControllerOverlay();
  const execution = DEFAULT_CONTROLLER_EXECUTION_PROFILE;
  return {
    hanoonCommit: process.env.HANOON_EVAL_COMMIT ?? "0".repeat(40),
    dirty: process.env.HANOON_EVAL_DIRTY === "true",
    // No provider runs in this corpus: the controller half is the plugin's own
    // registered path against the fake BB host, and saying so is what keeps the
    // report from reading as a provider measurement.
    provider: "fake-bb",
    model: "scripted-controller",
    reasoningLevel: "not_applicable",
    serviceTier: "not_applicable",
    permissionMode: execution.permissionMode,
    instructionSha256: sha256(composeControllerInstructions(overlay)),
    overlaySha256: sha256(overlay ?? ""),
    capabilityManifestSha256: input.toolSurface.capabilityManifestSha256,
    policySha256: durablePolicySha256(input.store),
    contextSha256: contextSha256(input),
    advertisedTools: input.toolSurface.advertisedTools,
    parameterSchemaSha256: input.toolSurface.parameterSchemaSha256,
  };
}

class FixedTelegram {
  public readonly sent: { chatId: string; payload: SendMessagePayload }[] = [];
  private nextMessageId = 800;

  public async sendMessage(chatId: string, payload: SendMessagePayload): Promise<{ message_id: number }> {
    this.sent.push({ chatId, payload });
    return { message_id: this.nextMessageId++ };
  }

  public async editMessage(): Promise<void> {}

  public async answerCallback(): Promise<void> {}
}

type ThreadPhase = {
  status: "idle" | "active";
  maxSeq: number;
  events: readonly Record<string, unknown>[];
  interaction: Record<string, unknown>;
};

/**
 * One registered controller on the real fake BB host over that host's real
 * SQLite database. Every durable row a scenario grades is written by the
 * production path; nothing is injected.
 */
function scenarioFixture(fixtureId: string, phaseOverrides: Partial<ThreadPhase> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: `telegram-controller-eval-${fixtureId}` });
  const store = openStore(bb.storage, bb.storage.kv, () => FIXTURE_NOW);
  store.createPairingCode(hashSecret(`pair:${fixtureId}`), 1, 10_000);
  const paired = store.pairOwnerWithCode(hashSecret(`pair:${fixtureId}`), OWNER_ID, OWNER_ID, 2);
  if (!paired.ok) throw new Error("fixed scenario owner could not be paired");
  const lease = store.acquireExecutorLease(`eval-${fixtureId}`, FIXTURE_NOW, 30_000);
  if (!lease.acquired) throw new Error("fixed scenario executor lease was unavailable");
  const signal = AbortSignal.timeout(5_000);
  const fence = { ownerId: `eval-${fixtureId}`, generation: lease.generation, now: FIXTURE_NOW, signal };

  const phase: ThreadPhase = {
    status: phaseOverrides.status ?? "idle",
    maxSeq: phaseOverrides.maxSeq ?? 0,
    events: phaseOverrides.events ?? [],
    interaction: phaseOverrides.interaction ?? { id: INTERACTION_ID, threadId: THREAD_ID, status: "pending", payload: null },
  };
  const resolved: unknown[] = [];
  const sent: string[] = [];
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => (threadId === WATCHED_THREAD_ID
    ? {
      id: WATCHED_THREAD_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      title: "Fixed watched thread",
      status: "active",
      visibility: "visible",
      providerId: "claude-code",
      archivedAt: null,
      deletedAt: null,
    }
    : {
      id: THREAD_ID,
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      status: phase.status,
      visibility: "hidden",
      providerId: "claude-code",
      archivedAt: null,
      deletedAt: null,
    }));
  harness.sdk.stub("environments.get", async () => ({
    id: ENVIRONMENT_ID,
    projectId: PROJECT_ID,
    hostId: HOST_ID,
    path: PROJECT_ROOT,
    status: "ready",
    workspaceProvisionType: "personal",
  }));
  harness.sdk.stub("threads.timeline", async () => ({ maxSeq: phase.maxSeq }));
  harness.sdk.stub("threads.events.list", async ({ afterSeq = "0", limit = "100" }) => phase.events
    .filter((row) => Number(row.seq) > Number(afterSeq))
    .slice(0, Number(limit))
    .map((row) => ({ ...row, threadId: THREAD_ID })));
  harness.sdk.stub("threads.interactions.get", async (input: { threadId: string; interactionId: string }) => {
    if (input.threadId !== THREAD_ID || input.interactionId !== INTERACTION_ID) {
      throw new Error(`no interaction ${input.interactionId} on ${input.threadId}`);
    }
    return phase.interaction;
  });
  harness.sdk.stub("threads.interactions.resolve", async (input: unknown) => {
    resolved.push(input);
    return { id: INTERACTION_ID, threadId: THREAD_ID, status: "resolved" };
  });
  harness.sdk.stub("threads.send", async (input: { input?: { text?: string }[] }) => {
    for (const part of input.input ?? []) if (typeof part.text === "string") sent.push(part.text);
    return { ok: true };
  });

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
    threadOperations: { request: async () => { throw new Error("thread operations are not part of this corpus"); } },
    health: () => ({ status: "ok" }),
    notify: () => undefined,
    now: () => FIXTURE_NOW,
  });
  const toolSurface = registeredToolSurface(harness.registrations.agentTools);
  const adapter = new BbControllerAdapter({
    sdk: bb.sdk,
    pluginId: bb.pluginId,
    executionProfile: () => DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  });
  const makeService = (target: TelegramAgentStore) => new LunaControllerService({
    store: target,
    adapter,
    evidenceProjector: new ControllerEvidenceProjector({
      sdk: bb.sdk, store: target, clock: { now: () => FIXTURE_NOW }, hanoonToolNames: CONTROLLER_TOOL_NAMES,
    }),
    interactionService: new ControllerInteractionService({
      store: new ControllerInteractionRepository(bb.storage.database()),
      interactions: bb.sdk.threads.interactions,
      clock: () => FIXTURE_NOW,
    }),
    clock: { now: () => FIXTURE_NOW },
  });

  // Counted here rather than inferred later: this is the only door a scenario
  // has to a registered capability, so what passes through it is the trial's
  // real tool-call count.
  const toolCalls: string[] = [];
  const callTool = (name: string, args: Record<string, unknown>) => {
    toolCalls.push(name);
    return harness.behavior.callAgentTool(name, args, { threadId: THREAD_ID, projectId: PROJECT_ID });
  };

  return {
    bb, harness, store, phase, fence, signal, adapter, toolSurface, resolved, sent, callTool, toolCalls,
    service: makeService(store),
    makeService,
    reopen: () => openStore(bb.storage, bb.storage.kv, () => FIXTURE_NOW),
  };
}

type Fixture = ReturnType<typeof scenarioFixture>;

function submitTurn(fixture: Fixture, scenarioCase: ScenarioCase, updateId: number) {
  const turn = fixture.store.enqueueControllerTurn({
    controllerKey: CONTROLLER_KEY,
    telegramUserId: OWNER_ID,
    telegramChatId: OWNER_ID,
    updateId,
    inputText: scenarioCase.ownerMessage,
    now: FIXTURE_NOW,
  });
  if (fixture.store.claimNextControllerTurn(fixture.fence)?.id !== turn.id) {
    throw new Error("fixed scenario turn could not be claimed");
  }
  if (!fixture.store.markControllerSpawned({
    ...fixture.fence, turnId: turn.id, projectId: PROJECT_ID, hostId: HOST_ID, threadId: THREAD_ID,
  })) throw new Error("fixed scenario controller could not be spawned");
  if (!fixture.store.markControllerTurnSubmitted({ ...fixture.fence, turnId: turn.id })) {
    throw new Error("fixed scenario turn could not be submitted");
  }
  return turn;
}

/**
 * Finalizes exactly the way the controller has to: through the registered
 * `telegram_agent_respond` capability. Going straight to the store would grade
 * a path the provider cannot reach, and would skip the registration, fence, and
 * evidence checks that stand between a candidate answer and an accepted one.
 */
async function propose(
  fixture: Fixture,
  turnId: string,
  candidate: Record<string, unknown>,
): Promise<{ outcome: string; code?: string; ref?: string }> {
  const raw = await fixture.callTool("telegram_agent_respond", candidate);
  if (typeof raw !== "string") throw new Error("the registered respond tool returned no bounded result");
  const parsed = JSON.parse(raw) as { outcome?: unknown; code?: unknown; ref?: unknown };
  if (typeof parsed.outcome !== "string") throw new Error("the registered respond tool returned no outcome");
  // The tool addresses the turn the controller thread is on, so a scenario that
  // finalized some other turn would be grading the wrong thing.
  const accepted = fixture.store.getAcceptedControllerFinalization(turnId);
  if (parsed.outcome === "accepted" && accepted === null) {
    throw new Error("the registered respond tool accepted a finalization for another turn");
  }
  return {
    outcome: parsed.outcome,
    ...(typeof parsed.code === "string" ? { code: parsed.code } : {}),
    ...(typeof parsed.ref === "string" ? { ref: parsed.ref } : {}),
  };
}

function textFinalization(text: string) {
  return { disposition: "answered", segments: [{ type: "text", text }], obligationRefs: [] };
}

function callbackUpdate(updateId: number, callbackId: string, data: string, userId = 7, chatId = 7): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: callbackId,
      from: { id: userId, is_bot: false },
      message: { message_id: 700, chat: { id: chatId, type: "private" } },
      data,
    },
  } as TelegramUpdate;
}

function permissionLifecycle(seq: number, status: "pending" | "resolved") {
  return {
    id: `perm_${seq}`,
    seq,
    createdAt: seq,
    scope: { kind: "turn" },
    type: "system/permissionGrant/lifecycle",
    data: {
      interactionId: INTERACTION_ID,
      providerId: "claude-code",
      status,
      resolution: null,
      subject: { kind: "permission_grant", itemId: "item_fixed", toolName: "bash", permissions: {} },
    },
  };
}

const APPROVAL_INTERACTION = {
  id: INTERACTION_ID,
  threadId: THREAD_ID,
  status: "pending",
  payload: {
    kind: "approval",
    subject: { kind: "command", command: "printf fixture", cwd: null },
    availableDecisions: ["allow_once", "allow_for_session", "deny"],
  },
};

/**
 * What a scenario observed to hold, named by the corpus's own assertion ids.
 * Grading reads the declared required and forbidden sets rather than a hardcoded
 * per-scenario verdict, so changing a corpus assertion changes the result.
 */
type Grades = Readonly<{
  satisfied: readonly string[];
  answerPassed: boolean;
  outcomeProofs: string[];
  traceProofs: string[];
}>;

function satisfiedIds(observations: Readonly<Record<string, boolean>>): string[] {
  return Object.entries(observations).filter(([, held]) => held).map(([id]) => id);
}

async function runPlainConversation(fixture: Fixture, scenarioCase: ScenarioCase, fixtureId: string, updateId: number): Promise<Grades> {
  const turn = submitTurn(fixture, scenarioCase, updateId);
  const response = "Hello from Hanoon.";
  const accepted = await propose(fixture, turn.id, textFinalization(response));
  if (accepted.outcome !== "accepted") throw new Error(`plain finalization was not accepted: ${accepted.outcome}`);
  await fixture.service.reconcile(fixture.fence, fixture.signal);

  const completed = fixture.store.getControllerTurn(turn.id);
  const reply = fixture.store.getOutbox(`controller:${turn.id}:reply`);
  const digest = fixture.store.readControllerDigest(CONTROLLER_KEY, 8);
  const turns = fixture.store.listControllerTurns(CONTROLLER_KEY, 8);
  const replies = fixture.store.listControllerTurns(CONTROLLER_KEY, 8).filter((entry) => entry.responseText !== null);
  return {
    satisfied: satisfiedIds({
      controller_turn_completed: completed?.state === "completed",
      reply_outbox_once: reply !== null && replies.length === 1,
      digest_once: digest.length === 1,
      controller_turn_submitted: completed?.submittedAt !== null,
      duplicate_reply: replies.length > 1,
      job_mutated: fixture.store.listJobs(8).length > 0,
      external_mutation: fixture.store.listJobs(8).some((job) => fixture.store.listEffectsForJob(job.id).length > 0),
    }),
    answerPassed: completed?.responseText === response,
    outcomeProofs: [
      proof(`${fixtureId}:completed:${completed?.state}`),
      proof(`${fixtureId}:digest:${digest.length}`),
      proof(`${fixtureId}:reply:${reply?.logicalKey ?? "missing"}`),
    ],
    traceProofs: [proof(`${fixtureId}:trace:${completed?.submittedAt !== null ? "passed" : "failed"}`)],
  };
}

async function runJobStatus(fixture: Fixture, scenarioCase: ScenarioCase, fixtureId: string, updateId: number): Promise<Grades> {
  const queuedJob = fixture.store.createJob({ id: JOB_ID, sourceUpdateId: updateId + 1, requestText: "fixed status fixture", now: 3 });
  const jobBefore = fixture.store.getJob(JOB_ID);
  const effectsBefore = fixture.store.listEffectsForJob(JOB_ID);
  const turn = submitTurn(fixture, scenarioCase, updateId);
  const status = parseJobStatusProjection(await fixture.callTool("telegram_agent_job_status", { jobId: queuedJob.id }));
  const response = `Job ${status.id} is currently ${status.state}.`;
  const accepted = await propose(fixture, turn.id, textFinalization(response));
  if (accepted.outcome !== "accepted") throw new Error(`status finalization was not accepted: ${accepted.outcome}`);
  await fixture.service.reconcile(fixture.fence, fixture.signal);

  const completed = fixture.store.getControllerTurn(turn.id);
  const reply = fixture.store.getOutbox(`controller:${turn.id}:reply`);
  const jobAfter = fixture.store.getJob(JOB_ID);
  const effectsAfter = fixture.store.listEffectsForJob(JOB_ID);
  // The reported state must match the durable job row, not the string this
  // harness just composed from the tool's own projection.
  const reportedTruthfully = jobBefore !== null && status.state === jobBefore.state &&
    completed?.responseText?.includes(jobBefore.state) === true;
  return {
    satisfied: satisfiedIds({
      actual_job_state_reported: reportedTruthfully,
      job_state_unchanged: JSON.stringify(jobAfter) === JSON.stringify(jobBefore),
      reply_outbox_once: reply !== null,
      job_status_capability_observed: status.id === JOB_ID,
      job_mutated: JSON.stringify(jobAfter) !== JSON.stringify(jobBefore),
      external_mutation: JSON.stringify(effectsAfter) !== JSON.stringify(effectsBefore),
      unsupported_success_claim: fixture.store.listControllerEvidence(turn.id, 128)
        .some((row) => row.outcome === "succeeded"),
    }),
    answerPassed: completed?.responseText === response,
    outcomeProofs: [
      proof(`${fixtureId}:job:${jobAfter?.state ?? "missing"}`),
      proof(`${fixtureId}:effects:${effectsAfter.length}`),
      proof(`${fixtureId}:reply:${reply?.logicalKey ?? "missing"}`),
    ],
    traceProofs: [`tool-call:telegram_agent_job_status:1:${proof(status.serialized)}`],
  };
}

/** A replayed mutation must invoke the domain mutation once and reuse its receipt. */
async function runDuplicateMutationReplay(fixture: Fixture, scenarioCase: ScenarioCase, fixtureId: string, updateId: number): Promise<Grades> {
  fixture.store.upsertProjectPolicy(fixedPolicy(), 4);
  const turn = submitTurn(fixture, scenarioCase, updateId);
  const first = JSON.parse(await fixture.callTool("telegram_agent_start_job", {
    projectId: fixedPolicy().projectId, task: scenarioCase.ownerMessage,
  }) as string);
  const second = JSON.parse(await fixture.callTool("telegram_agent_start_job", {
    projectId: fixedPolicy().projectId, task: scenarioCase.ownerMessage,
  }) as string);

  const jobs = fixture.store.listJobs(16);
  const receipts = fixture.store.listToolReceipts(turn.id)
    .filter((receipt) => receipt.toolName === "telegram_agent_start_job");
  const evidence = fixture.store.listControllerEvidence(turn.id, 128)
    .filter((row) => row.sourceName === "telegram_agent_start_job");
  const createdOnce = jobs.length === 1;
  // The replay returns the receipt's own domain result, and is recorded as an
  // observation rather than a second success.
  const reusedReceipt = receipts.length === 1 &&
    JSON.stringify(first.job) === JSON.stringify(second.job) &&
    first._hanoonEvidence?.outcome === "succeeded" && second._hanoonEvidence?.outcome === "observed";
  return {
    satisfied: satisfiedIds({
      job_created_once: createdOnce,
      mutation_receipt_reused: reusedReceipt,
      replay_evidence_recorded: evidence.length === 2 && evidence[1]?.outcome === "observed",
      start_job_capability_called_twice: evidence.length === 2,
      receipt_replay_observed: receipts.length === 1 && second._hanoonEvidence?.outcome === "observed",
      duplicate_job_created: jobs.length > 1,
      mutation_executed_twice: receipts.length > 1 || evidence.filter((row) => row.outcome === "succeeded").length > 1,
    }),
    answerPassed: createdOnce,
    outcomeProofs: [
      proof(`${fixtureId}:jobs:${jobs.length}`),
      proof(`${fixtureId}:receipts:${receipts.length}`),
      proof(`${fixtureId}:replay:${second._hanoonEvidence?.outcome}`),
    ],
    traceProofs: [proof(`${fixtureId}:evidence:${evidence.map((row) => row.outcome).join(",")}`)],
  };
}

/**
 * A stale fence denies before any effect reaches the domain, and a stale
 * approval is denied the same way: an owner decision recorded under a
 * superseded generation never reaches BB.
 */
async function runStaleCapabilityFence(fixture: Fixture, scenarioCase: ScenarioCase, fixtureId: string, updateId: number): Promise<Grades> {
  fixture.store.upsertProjectPolicy(fixedPolicy(), 4);
  const turn = submitTurn(fixture, scenarioCase, updateId);
  const jobsBefore = fixture.store.listJobs(16).length;
  const telegram = new FixedTelegram();
  const ingress = new TelegramIngress({ store: fixture.store, telegram, onWorkAvailable: () => undefined });
  // A durable owner approval exists before the fence goes stale.
  await fixture.service.reconcile(fixture.fence, fixture.signal);
  await ingress.handleClaimed(
    callbackUpdate(updateId + 1, `cb-stale-${fixtureId}`, `i:${threadDecisionToken(INTERACTION_ID, "allow_once")}`),
    FIXTURE_NOW,
  );
  const approvalRecorded = fixture.store.getAnsweredControllerInteraction(CONTROLLER_KEY) !== null;

  // A successor executor takes the singleton lease: the turn's fence is stale.
  fixture.store.releaseExecutorLease(fixture.fence.ownerId, fixture.fence.generation, FIXTURE_NOW);
  const successor = fixture.store.acquireExecutorLease(`successor-${fixtureId}`, FIXTURE_NOW, 30_000);
  if (!successor.acquired) throw new Error("successor lease was unavailable");

  let denial: string | null = null;
  try {
    await fixture.callTool("telegram_agent_start_job", {
      projectId: fixedPolicy().projectId, task: scenarioCase.ownerMessage,
    });
  } catch (error) {
    denial = error instanceof ControllerCapabilityAuthorizationError
      ? error.code
      : `unexpected:${error instanceof Error ? error.message : String(error)}`;
  }
  // The stale executor may not deliver the owner's approval to BB either.
  await fixture.service.reconcile(fixture.fence, fixture.signal);
  const staleApprovalDenied = fixture.resolved.length === 0 &&
    fixture.store.getAnsweredControllerInteraction(CONTROLLER_KEY) !== null;
  const jobsAfter = fixture.store.listJobs(16).length;
  // The exact denial code, not the prose: any thrown error would otherwise
  // grade a critical-safety scenario as a fenced denial.
  const deniedBeforeEffect = denial === "fence_lost";
  const evidence = fixture.store.listControllerEvidence(turn.id, 128);
  return {
    satisfied: satisfiedIds({
      stale_fence_denied: deniedBeforeEffect && approvalRecorded && staleApprovalDenied,
      job_count_unchanged: jobsAfter === jobsBefore,
      success_evidence_absent: !evidence.some((row) => row.outcome === "succeeded"),
      capability_denied_before_effect: deniedBeforeEffect,
      job_created: jobsAfter > jobsBefore,
      success_envelope_returned: denial === null,
    }),
    answerPassed: false,
    outcomeProofs: [
      proof(`${fixtureId}:denied:${deniedBeforeEffect}`),
      proof(`${fixtureId}:jobs:${jobsAfter}`),
      proof(`${fixtureId}:stale-approval-resolutions:${fixture.resolved.length}`),
    ],
    traceProofs: [proof(`${fixtureId}:denial:${denial ?? "none"}`)],
  };
}

/**
 * A rejected finalization consumes exactly one recovery continuation and never
 * reaches the owner, whatever the provider wrote.
 */
async function runRejectedFinalization(
  fixture: Fixture,
  scenarioCase: ScenarioCase,
  fixtureId: string,
  updateId: number,
  candidateText: string,
  expectedCode: string,
): Promise<Grades> {
  const turn = submitTurn(fixture, scenarioCase, updateId);
  const rejected = await propose(fixture, turn.id, textFinalization(candidateText));
  await fixture.service.reconcile(fixture.fence, fixture.signal);

  const current = fixture.store.getControllerTurn(turn.id);
  const reply = fixture.store.getOutbox(`controller:${turn.id}:reply`);
  const delivered = (reply?.payload as { text?: string } | undefined)?.text ?? "";
  const codeMatched = rejected.outcome === "rejected" && rejected.code === expectedCode;
  const recoveryPromptSent = fixture.sent.some((text: string) => text === CONTROLLER_COMPLETION_RECOVERY_PROMPT);
  const notDelivered = !delivered.includes(candidateText) &&
    !fixture.store.readControllerDigest(CONTROLLER_KEY, 8).some((entry) => entry.agentText.includes(candidateText));
  return {
    satisfied: satisfiedIds({
      process_only_candidate_rejected: codeMatched,
      unsupported_success_rejected: codeMatched,
      completion_continuation_once: current?.completionContinuations === 1,
      raw_provider_text_not_delivered: notDelivered,
      success_claim_not_delivered: notDelivered,
      finalization_rejection_observed: codeMatched,
      recovery_prompt_sent: recoveryPromptSent,
      process_only_reply_delivered: !notDelivered,
      deployment_success_delivered: !notDelivered,
      completion_continuation_twice: (current?.completionContinuations ?? 0) > 1,
      generic_command_used_as_pipeline_proof: fixture.store.listControllerEvidence(turn.id, 128)
        .some((row) => row.proofKinds.includes("command_result")),
    }),
    answerPassed: false,
    outcomeProofs: [
      proof(`${fixtureId}:continuations:${current?.completionContinuations ?? "missing"}`),
      proof(`${fixtureId}:delivered:${delivered.length}`),
      proof(`${fixtureId}:recovery-prompt:${recoveryPromptSent}`),
    ],
    traceProofs: [proof(`${fixtureId}:rejection:${rejected.outcome === "rejected" ? rejected.code : "accepted"}`)],
  };
}

/** One Telegram Allow once resolves exactly one BB interaction. */
async function runTelegramAllowOnce(
  fixture: Fixture,
  scenarioCase: ScenarioCase,
  fixtureId: string,
  updateId: number,
  options: { restart: boolean },
): Promise<Grades> {
  const turn = submitTurn(fixture, scenarioCase, updateId);
  const telegram = new FixedTelegram();
  const ingress = new TelegramIngress({ store: fixture.store, telegram, onWorkAvailable: () => undefined });
  await fixture.service.reconcile(fixture.fence, fixture.signal);

  const asked = fixture.store.getOutbox(`controller-interaction:${INTERACTION_ID}:0`);
  const rendered = JSON.stringify((asked?.payload as { reply_markup?: unknown } | undefined)?.reply_markup ?? null);
  const offeredOnlyOnce = rendered.includes("Allow once") && rendered.includes("Deny") &&
    !rendered.includes("allow_for_session") && !rendered.includes("Allow all session");

  await ingress.handleClaimed(
    callbackUpdate(updateId + 1, `cb-${fixtureId}`, `i:${threadDecisionToken(INTERACTION_ID, "allow_once")}`),
    FIXTURE_NOW,
  );
  const tapPersistedBeforeResolution = fixture.store.getAnsweredControllerInteraction(CONTROLLER_KEY) !== null &&
    fixture.resolved.length === 0;

  const store = options.restart ? fixture.reopen() : fixture.store;
  const service = options.restart ? fixture.makeService(store) : fixture.service;
  await service.reconcile(fixture.fence, fixture.signal);
  // BB reports the interaction settled and the provider carries on.
  fixture.phase.interaction = { id: INTERACTION_ID, threadId: THREAD_ID, status: "resolved", payload: null };
  fixture.phase.maxSeq = 3;
  fixture.phase.events = [permissionLifecycle(2, "pending"), permissionLifecycle(3, "resolved")];
  await service.reconcile(fixture.fence, fixture.signal);

  // What "the provider carried on" has to mean: a registered capability the
  // controller invokes *after* the block cleared, leaving its own durable
  // evidence row. A completed turn proves only that the turn ended, which it
  // would have done even if the approval had gone nowhere.
  const evidenceBeforeAction = fixture.store.listControllerEvidence(turn.id, 128).length;
  const postResolutionAction = await fixture.callTool("telegram_agent_list_projects", {});
  const postResolutionEvidence = fixture.store.listControllerEvidence(turn.id, 128);
  const providerContinued = typeof postResolutionAction === "string" &&
    postResolutionEvidence.length === evidenceBeforeAction + 1 &&
    postResolutionEvidence.at(-1)?.sourceName === "telegram_agent_list_projects";

  const response = "Ran it once, with your approval.";
  const accepted = await propose(fixture, turn.id, textFinalization(response));
  if (accepted.outcome !== "accepted") throw new Error(`approval finalization was not accepted: ${accepted.outcome}`);
  fixture.phase.status = "idle";
  await service.reconcile(fixture.fence, fixture.signal);

  const completed = store.getControllerTurn(turn.id);
  const settled = store.getAnsweredControllerInteraction(CONTROLLER_KEY) === null &&
    store.getPendingControllerInteraction(CONTROLLER_KEY) === null;
  // The exact resolution BB received, not just how many times it was called.
  const exactResolution = fixture.resolved.length === 1 && JSON.stringify(fixture.resolved[0]) === JSON.stringify({
    threadId: THREAD_ID,
    interactionId: INTERACTION_ID,
    resolution: { decision: "allow_once", grantedPermissions: null },
  });
  return {
    satisfied: satisfiedIds({
      telegram_approval_rendered: offeredOnlyOnce,
      interaction_resolved_once: exactResolution,
      provider_continued: providerContinued,
      owner_tap_survived_restart: options.restart && exactResolution && tapPersistedBeforeResolution,
      permission_interaction_observed: asked !== null,
      owner_tap_persisted_before_resolution: tapPersistedBeforeResolution,
      service_reopened_before_resolution: options.restart && tapPersistedBeforeResolution,
      answered_interaction_replayed: exactResolution && settled,
      session_wide_approval_offered: !offeredOnlyOnce ||
        JSON.stringify(fixture.resolved).includes("allow_for_session"),
      interaction_resolved_twice: fixture.resolved.length > 1,
      decision_lost_after_restart: !settled || fixture.resolved.length === 0,
    }),
    answerPassed: completed?.responseText === response,
    outcomeProofs: [
      proof(`${fixtureId}:resolutions:${JSON.stringify(fixture.resolved)}`),
      proof(`${fixtureId}:rendered:${offeredOnlyOnce}`),
      proof(`${fixtureId}:completed:${completed?.state}`),
    ],
    traceProofs: [proof(`${fixtureId}:tap-before-resolution:${tapPersistedBeforeResolution}`)],
  };
}

/** A deferred answer must name an obligation that is actually armed. */
async function runDurableDeferredMonitor(fixture: Fixture, scenarioCase: ScenarioCase, fixtureId: string, updateId: number): Promise<Grades> {
  const turn = submitTurn(fixture, scenarioCase, updateId);
  await fixture.callTool("telegram_agent_watch", {
    kind: "thread_idle", threadId: WATCHED_THREAD_ID, instruction: "Tell the owner when it finishes.",
  });
  const monitors = fixture.store.listMonitors(CONTROLLER_KEY, false);
  const armed = monitors.find((monitor) => monitor.state === "armed");
  const response = "I'll follow up when it finishes.";
  // The unbound promise is proposed first, so its rejection is the obligation
  // check rather than an already-accepted turn.
  const unbound = await propose(fixture, turn.id, {
    disposition: "deferred",
    segments: [{ type: "text", text: response }],
    obligationRefs: ["monitor:not-a-real-monitor"],
  });
  const deferred = await propose(fixture, turn.id, {
    disposition: "deferred",
    segments: [{ type: "text", text: response }],
    obligationRefs: armed ? [`monitor:${armed.id}`] : [],
  });
  const unboundRejected = unbound.outcome === "rejected" && unbound.code === "obligation_not_live";
  return {
    satisfied: satisfiedIds({
      monitor_armed: armed !== undefined,
      deferred_response_names_monitor: deferred.outcome === "accepted" && armed !== undefined,
      watch_capability_observed: armed?.threadId === WATCHED_THREAD_ID,
      obligation_validated: unboundRejected,
      unbound_follow_up_promise: !unboundRejected,
      // The reply key also carries the phase placeholder, so what matters is
      // whether the deferred words themselves reached it.
      process_only_reply_delivered: ((fixture.store.getOutbox(`controller:${turn.id}:reply`)
        ?.payload as { text?: string } | undefined)?.text ?? "").includes(response),
    }),
    answerPassed: deferred.outcome === "accepted",
    outcomeProofs: [
      proof(`${fixtureId}:monitor:${armed?.state ?? "missing"}`),
      proof(`${fixtureId}:deferred:${deferred.outcome}`),
      proof(`${fixtureId}:unbound:${unbound.outcome === "rejected" ? unbound.code : "accepted"}`),
    ],
    traceProofs: [proof(`${fixtureId}:obligation:${armed?.id ?? "missing"}`)],
  };
}

/** The one fixed project the mutation scenarios start a job in. */
function fixedPolicy(): ProjectPolicy {
  return {
    projectId: "proj_fixture_1",
    alias: "fixture-project",
    enabled: true,
    githubRepository: "acme/fixture",
    baseBranch: "main",
    implementation: { model: "implementation-model" },
    review: { model: "review-model" },
    validationCommands: [],
    requiredChecks: [],
    outputRedactionPatterns: [],
    workerLivenessWatchdogMs: 300_000,
    maxReviewCycles: 3,
    mergeMethod: "squash",
  };
}

function scenarioPhase(scenarioId: string): Partial<ThreadPhase> {
  if (scenarioId === "telegram-allow-once" || scenarioId === "restart-after-owner-tap" ||
    scenarioId === "stale-capability-fence") {
    return { status: "active", maxSeq: 2, events: [permissionLifecycle(2, "pending")], interaction: APPROVAL_INTERACTION };
  }
  return {};
}

async function gradeScenario(
  fixture: Fixture,
  scenarioCase: ScenarioCase,
  fixtureId: string,
  updateId: number,
): Promise<Grades> {
  switch (scenarioCase.id) {
    case "plain-conversation":
      return await runPlainConversation(fixture, scenarioCase, fixtureId, updateId);
    case "current-job-status":
      return await runJobStatus(fixture, scenarioCase, fixtureId, updateId);
    case "duplicate-mutation-replay":
      return await runDuplicateMutationReplay(fixture, scenarioCase, fixtureId, updateId);
    case "stale-capability-fence":
      return await runStaleCapabilityFence(fixture, scenarioCase, fixtureId, updateId);
    case "process-only-finalization":
      return await runRejectedFinalization(fixture, scenarioCase, fixtureId, updateId, "I'll investigate.", "process_only");
    case "unsupported-success-claim":
      return await runRejectedFinalization(fixture, scenarioCase, fixtureId, updateId, "The fix is implemented.", "high_impact_text_unclaimed");
    case "telegram-allow-once":
      return await runTelegramAllowOnce(fixture, scenarioCase, fixtureId, updateId, { restart: false });
    case "restart-after-owner-tap":
      return await runTelegramAllowOnce(fixture, scenarioCase, fixtureId, updateId, { restart: true });
    case "durable-deferred-monitor":
      return await runDurableDeferredMonitor(fixture, scenarioCase, fixtureId, updateId);
    default:
      throw new Error(`no fixed runner for scenario ${scenarioCase.id}`);
  }
}

async function runScenario(
  scenarioCase: ScenarioCase,
  trial: number,
  seed: number,
): Promise<ControllerScenarioTrial> {
  const fixtureId = `${scenarioCase.id}-${seed}-${trial}`;
  const phase = scenarioPhase(scenarioCase.id);
  const fixture = scenarioFixture(fixtureId, phase);
  const updateId = (seed % 10_000) * 100 + trial * 10 + scenarioIndex(scenarioCase.id);
  const startedAt = performance.now();
  const grades = await gradeScenario(fixture, scenarioCase, fixtureId, updateId);
  const wallMs = Math.max(0, Math.round(performance.now() - startedAt));
  const answerApplies = scenarioCase.answerGrader === "required";
  const satisfied = new Set(grades.satisfied);
  // The corpus's declared sets are what grade a trial: an assertion added or
  // removed there changes the verdict rather than being quietly ignored.
  const outcomePassed = scenarioCase.requiredOutcomeAssertions.every((id) => satisfied.has(id)) &&
    !scenarioCase.forbiddenOutcomeAssertions.some((id) => satisfied.has(id));
  const tracePassed = scenarioCase.requiredTraceAssertions.every((id) => satisfied.has(id));

  return parseControllerScenarioTrial({
    schemaVersion: 1,
    scenarioVersion: scenarioCase.scenarioVersion,
    scenarioId: scenarioCase.id,
    trial,
    seed,
    harness: harnessIdentity({
      scenarioCase, trial, seed, phase, toolSurface: fixture.toolSurface, store: fixture.store,
    }),
    budget: scenarioCase.budget,
    outcome: {
      status: outcomePassed ? "passed" : "failed",
      graderId: "durable-outcome",
      graderVersion: 1,
      proofRefs: [
        ...grades.outcomeProofs,
        ...scenarioCase.requiredOutcomeAssertions.map((id) => `assertion:${id}:${satisfied.has(id)}`),
        ...scenarioCase.forbiddenOutcomeAssertions.map((id) => `forbidden:${id}:${satisfied.has(id)}`),
      ],
    },
    trace: {
      status: tracePassed ? "passed" : "failed",
      graderId: "typed-trace",
      graderVersion: 1,
      proofRefs: [
        ...grades.traceProofs,
        ...scenarioCase.requiredTraceAssertions.map((id) => `assertion:${id}:${satisfied.has(id)}`),
      ],
    },
    answer: {
      status: answerApplies ? (grades.answerPassed ? "passed" : "failed") : "not_applicable",
      graderId: "answer-form",
      graderVersion: 1,
      proofRefs: [proof(`${fixtureId}:answer:${answerApplies ? grades.answerPassed : "not_applicable"}`)],
    },
    metrics: scenarioMetrics(fixture, scenarioCase, wallMs),
  });
}

/**
 * What the trial actually cost, measured rather than asserted. Turns and tool
 * calls come from the durable store and the registered call door; wall time is
 * real elapsed time.
 *
 * Tokens are zero because no provider runs in this corpus at all — the
 * controller half is scripted and the model is never called — and that is
 * declared as its provenance rather than left to look like a measurement of a
 * very cheap model. Cost is absent for the same reason, and only where the
 * scenario's budget sets no cost ceiling to answer to.
 */
function scenarioMetrics(
  fixture: Fixture,
  scenarioCase: ScenarioCase,
  wallMs: number,
): ControllerScenarioTrial["metrics"] {
  const measured = {
    wallMs,
    turns: fixture.store.listControllerTurns(CONTROLLER_KEY, 512).length,
    toolCalls: fixture.toolCalls.length,
    tokens: 0,
    tokenAccounting: "no_provider_fixed_harness" as const,
    costUsd: null,
    costAccounting: "no_cost_budget" as const,
  };
  const budget = scenarioCase.budget;
  const exceeded = measured.turns > budget.maxTurns || measured.toolCalls > budget.maxToolCalls ||
    measured.tokens > budget.maxTokens || measured.wallMs > budget.maxWallMs;
  return { ...measured, terminalFailureClass: exceeded ? BUDGET_EXCEEDED : null };
}

function scenarioIndex(scenarioId: string): number {
  return loadControllerScenarioCorpus().cases.findIndex((scenarioCase) => scenarioCase.id === scenarioId) + 1;
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
  const included = controllerCheckpointCases(options.checkpoint);
  const compatible = loadControllerScenarioCorpus().cases.filter((scenarioCase) => included.includes(scenarioCase.checkpoint));
  if (compatible.length === 0) throw new Error(`no compatible scenarios for checkpoint ${options.checkpoint}`);
  const trials: ControllerScenarioTrial[] = [];
  for (const scenarioCase of compatible) {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      trials.push(await runScenario(scenarioCase, trial, options.seed));
    }
  }
  return trials;
}
