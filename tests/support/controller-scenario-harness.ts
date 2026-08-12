import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { ControllerAdapter } from "../../src/controller/bb-controller";
import { LunaControllerService } from "../../src/controller/service";
import { registerControllerTools } from "../../src/controller/tools";
import {
  parseControllerScenarioCorpus,
  parseControllerScenarioTrial,
  type ControllerScenarioTrial,
} from "../../src/eval/controller-scenario-contract";
import { hashSecret } from "../../src/crypto";
import { openStore } from "../../src/storage/store";

const FIXTURE_NOW = 1_000;
const CONTROLLER_KEY = "owner-7-controller";
const OWNER_ID = "7";
const JOB_ID = "job_fixture_1";

type ScenarioCase = ReturnType<typeof parseControllerScenarioCorpus>["cases"][number];

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

function scriptedAdapter(
  observeToolCall: () => Promise<boolean>,
  reply: () => Promise<string>,
): ControllerAdapter {
  return {
    spawn: async () => ({ threadId: "thr_fixed_controller", projectId: "proj_fixed", hostId: "host_fixed" }),
    send: async () => undefined,
    steer: async () => undefined,
    answerQuestion: async () => undefined,
    status: async () => "idle",
    output: reply,
    latestSeq: async () => 0,
    events: async () => {
      const toolCalls = await observeToolCall() ? 1 : 0;
      return {
        latestSeq: 1,
        inputAccepted: true,
        assistantDelta: "",
        completed: true,
        error: null,
        pendingQuestion: null,
        toolCalls,
        commandFailures: 0,
        totalTokens: 0,
      };
    },
    findSpawnCandidate: async () => null,
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

function harnessIdentity(
  scenarioCase: ScenarioCase,
  trial: number,
  seed: number,
  toolSurface: ReturnType<typeof registeredToolSurface>,
): ControllerScenarioTrial["harness"] {
  const fixture = `${scenarioCase.id}:${trial}:${seed}`;
  return {
    hanoonCommit: process.env.HANOON_EVAL_COMMIT ?? "0".repeat(40),
    dirty: process.env.HANOON_EVAL_DIRTY === "true",
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
    advertisedTools: toolSurface.advertisedTools,
    parameterSchemaSha256: toolSurface.parameterSchemaSha256,
  };
}

async function runScenario(
  scenarioCase: ScenarioCase,
  trial: number,
  seed: number,
): Promise<ControllerScenarioTrial> {
  const fixtureId = `${scenarioCase.id}-${seed}-${trial}`;
  const { bb, harness } = createFakePluginHost({ pluginId: `telegram-controller-eval-${fixtureId}` });
  const store = openStore(bb.storage, bb.storage.kv, () => FIXTURE_NOW);
  store.createPairingCode(hashSecret(`pair:${fixtureId}`), 1, 10_000);
  const paired = store.pairOwnerWithCode(hashSecret(`pair:${fixtureId}`), OWNER_ID, OWNER_ID, 2);
  if (!paired.ok) throw new Error("fixed scenario owner could not be paired");
  const lease = store.acquireExecutorLease(`eval-${fixtureId}`, FIXTURE_NOW, 30_000);
  if (!lease.acquired) throw new Error("fixed scenario executor lease was unavailable");
  const signal = AbortSignal.timeout(2_000);
  registerControllerTools(bb, {
    store,
    sdk: bb.sdk,
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
  const observed = { jobStatus: null as JobStatusProjection | null };
  let response = "Hello from Hanoon.";
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
  const adapter = scriptedAdapter(observeToolCall, async () => response);
  const service = new LunaControllerService({ store, adapter, clock: { now: () => FIXTURE_NOW } });
  const turn = store.enqueueControllerTurn({
    controllerKey: CONTROLLER_KEY,
    telegramUserId: OWNER_ID,
    telegramChatId: OWNER_ID,
    updateId: seed * 10_000 + trial + (scenarioCase.id === "plain-conversation" ? 0 : 5_000),
    inputText: scenarioCase.ownerMessage,
    now: FIXTURE_NOW,
  });
  const fence = { ownerId: `eval-${fixtureId}`, generation: lease.generation, signal };

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
  const answerPassed = completed?.responseText === response;
  const outcomeProofs = scenarioCase.id === "plain-conversation"
    ? [proof(`${fixtureId}:completed:${completed?.state}`), proof(`${fixtureId}:digest:${digest.length}`), proof(`${fixtureId}:reply:${reply?.logicalKey ?? "missing"}`)]
    : [proof(`${fixtureId}:job:${jobAfter?.state ?? "missing"}`), proof(`${fixtureId}:effects:${effectsAfter.length}`), proof(`${fixtureId}:reply:${reply?.logicalKey ?? "missing"}`)];
  const traceProofs = observed.jobStatus === null
    ? [proof(`${fixtureId}:trace:${tracePassed ? "passed" : "failed"}`)]
    : [`tool-call:telegram_agent_job_status:1:${proof(observed.jobStatus.serialized)}`];

  return parseControllerScenarioTrial({
    schemaVersion: 1,
    scenarioVersion: scenarioCase.scenarioVersion,
    scenarioId: scenarioCase.id,
    trial,
    seed,
    harness: harnessIdentity(scenarioCase, trial, seed, toolSurface),
    budget: scenarioCase.budget,
    outcome: {
      status: outcomePassed ? "passed" : "failed",
      graderId: "durable-outcome",
      graderVersion: 1,
      proofRefs: outcomeProofs,
    },
    trace: {
      status: tracePassed ? "passed" : "failed",
      graderId: "typed-trace",
      graderVersion: 1,
      proofRefs: traceProofs,
    },
    answer: {
      status: answerPassed ? "passed" : "failed",
      graderId: "answer-form",
      graderVersion: 1,
      proofRefs: [proof(`${fixtureId}:answer:${answerPassed ? "passed" : "failed"}`)],
    },
    metrics: { wallMs: 1, tokens: 0, costUsd: null, terminalFailureClass: null },
  });
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
  if (options.checkpoint !== "baseline") {
    throw new Error(`checkpoint ${options.checkpoint} is not supported by the Task 2 harness`);
  }
  const compatible = loadControllerScenarioCorpus().cases.filter((scenarioCase) => scenarioCase.checkpoint === options.checkpoint);
  if (compatible.length === 0) throw new Error(`no compatible scenarios for checkpoint ${options.checkpoint}`);
  const trials: ControllerScenarioTrial[] = [];
  for (const scenarioCase of compatible) {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      trials.push(await runScenario(scenarioCase, trial, options.seed));
    }
  }
  return trials;
}
