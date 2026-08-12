import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { ControllerAdapter } from "../../src/controller/bb-controller";
import { LunaControllerService } from "../../src/controller/service";
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

function corpus(): ReturnType<typeof parseControllerScenarioCorpus> {
  const path = fileURLToPath(new URL("../../evals/controller-scenarios.json", import.meta.url));
  return parseControllerScenarioCorpus(JSON.parse(readFileSync(path, "utf8")));
}

function scriptedAdapter(response: string): ControllerAdapter {
  return {
    spawn: async () => ({ threadId: "thr_fixed_controller", projectId: "proj_fixed", hostId: "host_fixed" }),
    send: async () => undefined,
    steer: async () => undefined,
    answerQuestion: async () => undefined,
    status: async () => "idle",
    output: async () => response,
    latestSeq: async () => 0,
    events: async () => ({
      latestSeq: 1,
      inputAccepted: true,
      assistantDelta: "",
      completed: true,
      error: null,
      pendingQuestion: null,
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    }),
    findSpawnCandidate: async () => null,
  };
}

function harnessIdentity(scenarioCase: ScenarioCase, trial: number, seed: number): ControllerScenarioTrial["harness"] {
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
    capabilityManifestSha256: sha256("baseline-no-controller-tools"),
    policySha256: sha256("baseline-no-project-policy"),
    contextSha256: sha256(fixture),
    advertisedTools: [],
    parameterSchemaSha256: {},
  };
}

async function runScenario(
  scenarioCase: ScenarioCase,
  trial: number,
  seed: number,
): Promise<ControllerScenarioTrial> {
  const fixtureId = `${scenarioCase.id}-${seed}-${trial}`;
  const { bb } = createFakePluginHost({ pluginId: `telegram-controller-eval-${fixtureId}` });
  const store = openStore(bb.storage, bb.storage.kv, () => FIXTURE_NOW);
  store.createPairingCode(hashSecret(`pair:${fixtureId}`), 1, 10_000);
  const paired = store.pairOwnerWithCode(hashSecret(`pair:${fixtureId}`), OWNER_ID, OWNER_ID, 2);
  if (!paired.ok) throw new Error("fixed scenario owner could not be paired");
  const lease = store.acquireExecutorLease(`eval-${fixtureId}`, FIXTURE_NOW, 30_000);
  if (!lease.acquired) throw new Error("fixed scenario executor lease was unavailable");
  const signal = AbortSignal.timeout(2_000);

  const queuedJob = scenarioCase.id === "current-job-status"
    ? store.createJob({ id: JOB_ID, sourceUpdateId: seed * 1_000 + trial, requestText: "fixed status fixture", now: 3 })
    : null;
  const jobBefore = queuedJob ? store.getJob(JOB_ID) : null;
  const effectsBefore = queuedJob ? store.listEffectsForJob(JOB_ID) : [];
  const jobProjection = queuedJob ? store.getJob(JOB_ID) : null;
  const response = jobProjection
    ? `Job ${JOB_ID} is currently ${jobProjection.state}.`
    : "Hello from Hanoon.";
  const adapter = scriptedAdapter(response);
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
  const statusPassed = jobProjection !== null && jobBefore !== null && jobAfter !== null
    && completed?.responseText?.includes(jobProjection.state) === true
    && JSON.stringify(jobAfter) === JSON.stringify(jobBefore)
    && JSON.stringify(effectsAfter) === JSON.stringify(effectsBefore)
    && reply !== null;
  const outcomePassed = scenarioCase.id === "plain-conversation" ? plainPassed : statusPassed;
  const tracePassed = scenarioCase.id === "plain-conversation"
    ? completed?.submittedAt !== null
    : jobProjection !== null;
  const answerPassed = completed?.responseText === response;
  const outcomeProofs = scenarioCase.id === "plain-conversation"
    ? [proof(`${fixtureId}:completed:${completed?.state}`), proof(`${fixtureId}:digest:${digest.length}`), proof(`${fixtureId}:reply:${reply?.logicalKey ?? "missing"}`)]
    : [proof(`${fixtureId}:job:${jobAfter?.state ?? "missing"}`), proof(`${fixtureId}:effects:${effectsAfter.length}`), proof(`${fixtureId}:reply:${reply?.logicalKey ?? "missing"}`)];

  return parseControllerScenarioTrial({
    schemaVersion: 1,
    scenarioVersion: scenarioCase.scenarioVersion,
    scenarioId: scenarioCase.id,
    trial,
    seed,
    harness: harnessIdentity(scenarioCase, trial, seed),
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
      proofRefs: [proof(`${fixtureId}:trace:${tracePassed ? "passed" : "failed"}`)],
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
  const compatible = corpus().cases.filter((scenarioCase) => scenarioCase.checkpoint === options.checkpoint);
  if (compatible.length === 0) throw new Error(`no compatible scenarios for checkpoint ${options.checkpoint}`);
  const trials: ControllerScenarioTrial[] = [];
  for (const scenarioCase of compatible) {
    for (let trial = 1; trial <= options.trials; trial += 1) {
      trials.push(await runScenario(scenarioCase, trial, options.seed));
    }
  }
  return trials;
}
