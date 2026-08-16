import type { BbPluginApi } from "@bb/plugin-sdk";
import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { BbRunner } from "../src/bb/runner";
import { parseWorkerThreadTitle } from "../src/agent-skills/role-resolver";
import {
  CAPABILITY_GRAPH_DIGEST,
  CAPABILITY_REGISTRY_DIGEST,
} from "../src/capabilities/catalog";
import { selectCapabilityProfile } from "../src/capabilities/profiles";
import {
  buildCritiquePacket,
  buildPlanArtifact,
  parseCritiqueResult,
  parseDocsReport,
  parseVerificationPlan,
} from "../src/bb/pipeline-handoffs";
import { openStore } from "../src/storage/store";
import { settlePipelineStageOutput } from "../src/services/pipeline-stage-runner";
import { admitConfirmedJob, jobFixture, policyFixture } from "./helpers";

function pipelineSdk() {
  const spawns: Array<Record<string, unknown>> = [];
  const uploads: Array<{ filename: string; clientFile: Uint8Array }> = [];
  const sdk = {
    projects: {
      list: vi.fn(async () => [{
        id: "proj_1",
        kind: "standard",
        name: "Project One",
        sources: [{ id: "src_1", isDefault: true, hostId: "host_1", path: "/project" }],
      }]),
      attachments: {
        upload: vi.fn(async (input: { filename: string; clientFile: Uint8Array; mimeType: string }) => {
          uploads.push(input);
          return { type: "localFile", path: `attachments/${input.filename}`, name: input.filename };
        }),
      },
    },
    threads: {
      spawn: vi.fn(async (input: Record<string, unknown>) => {
        spawns.push(input);
        return { id: `thr_${spawns.length}`, environmentId: "env_plan" };
      }),
      output: vi.fn(async () => ({ output: "# Plan\n\n1. Add the regression.\n" })),
    },
    environments: {
      status: vi.fn(async () => ({
        outcome: "available",
        workspace: { checkout: { kind: "branch", branchName: "feature/test", headSha: "a".repeat(40) } },
      })),
      diff: vi.fn(async () => ({
        outcome: "available",
        diff: { diff: "diff --git a/src/a.ts b/src/a.ts\n+change", truncated: false },
      })),
      pullRequest: vi.fn(async () => ({
        outcome: "available",
        pullRequest: { number: 42, url: "https://github.com/acme/cyndra/pull/42" },
      })),
    },
  } as unknown as BbPluginApi["sdk"];
  return { runner: new BbRunner(sdk), spawns, uploads };
}

const plannedJob = jobFixture({
  state: "planning",
  projectId: "proj_1",
  policyVersion: 1,
  policy: policyFixture(),
});

function expectForbiddenClause(prompt: string, target: RegExp): void {
  const clause = prompt.split(/[.!?]/u).find((part) => target.test(part));
  expect(clause).toBeDefined();
  if (clause === undefined) return;
  expect(clause).toMatch(/\b(?:do not|must not|never|without|forbidden|prohibited|disallowed)\b/i);
  expect(clause).not.toMatch(/\b(?:allowed|permitted|acceptable|okay|optional)\b/i);
}

function expectCriticPromptContract(prompt: string): void {
  expect(prompt).toMatch(/\b(?:return|respond|output|requires?)\b[^.!?]{0,120}\bstrict JSON\b/i);
  expect(prompt).not.toMatch(/\bnon[-\s]?strict JSON\b/i);
  expect(prompt).not.toMatch(/\bstrict JSON\b[^.!?]{0,80}\b(?:optional|allowed|permitted)\b/i);
  expect(prompt).toMatch(/\b(?:assess|review|evaluate|inspect)\b[^.!?]{0,120}\bindependent(?:ly)?\b/i);
  expect(prompt).not.toMatch(/\b(?:do not|must not|never)\b[^.!?]{0,120}\b(?:assess|review|evaluate)\b[^.!?]{0,120}\bindependent(?:ly)?\b/i);
  expectForbiddenClause(prompt, /\b(?:inspect|read|use)\b[^.!?]{0,120}\bplanner conversation\b/i);
  expectForbiddenClause(prompt, /\bedit files?\b/i);
}

it("persists mandatory docs outcomes before an active docs transition", () => {
  const { bb } = createFakePluginHost({ pluginId: "pipeline-active-docs-outcome" });
  const store = openStore(bb.storage);
  const db = bb.storage.database();
  const policy = policyFixture({ production: undefined });
  const draft = store.createJob({ id: "job_active_docs", sourceUpdateId: 77, requestText: "document behavior", now: 1_000 });
  db.prepare(
    `UPDATE jobs SET state = 'documenting', project_id = ?, policy_version = 1, policy_json = ?,
       environment_id = 'env_docs', implementation_thread_id = 'thr_impl', documentation_thread_id = 'thr_docs',
       pr_number = 42, pr_url = 'https://github.com/acme/cyndra/pull/42', pr_head_sha = ?,
       routing_mode = 'active', task_recipe = 'bounded', task_traits_json = '[]',
       task_reason_codes_json = '[]', version = 2 WHERE id = ?`,
  ).run(policy.projectId, JSON.stringify(policy), "a".repeat(40), draft.id);
  const lease = store.acquireExecutorLease("docs-executor", 1_001, 30_000);
  if (!lease.acquired) throw new Error("executor lease missing");
  const fence = { ownerId: "docs-executor", generation: lease.generation };
  let attempt = store.createPipelineStageAttempt({
    id: "stage:job_active_docs:2:spawn_docs",
    jobId: draft.id,
    role: "DOCS",
    ordinal: 1,
    inputSha256: "b".repeat(64),
    ...fence,
    now: 1_002,
  });
  expect(store.bindPipelineStageThread({
    id: attempt.id,
    threadId: "thr_docs",
    environmentId: "env_docs",
    ...fence,
    now: 1_003,
  })).toBe(true);
  attempt = store.getPipelineStageAttempt(attempt.id)!;
  const selected = selectCapabilityProfile({
    role: "documentation",
    recipe: "bounded",
    stage: "documentation",
    traits: ["docs-changed", "strict-json"],
  });
  const profile = store.createCapabilityProfile({
    subjectKind: "worker_attempt",
    subjectId: attempt.id,
    threadId: null,
    recipeId: "bounded",
    recipeVersion: 1,
    registryDigest: CAPABILITY_REGISTRY_DIGEST,
    graphDigest: CAPABILITY_GRAPH_DIGEST,
    mode: "active",
    model: { pool: "standard", providerId: "codex", modelId: "model", reasoning: "high", serviceTier: "fast" },
    assignments: selected.assignments.map((assignment) => ({
      capabilityId: assignment.capabilityId,
      descriptorDigest: assignment.descriptorDigest,
      capabilityKind: "skill",
      mandatory: assignment.mandatory,
    })),
    reasonCodes: [],
    traits: ["docs-changed", "strict-json"],
    now: 1_003,
  });
  const job = store.getJob(draft.id);
  if (!job) throw new Error("docs job missing");
  const output = JSON.stringify({
    disposition: "changed",
    files: ["docs/usage.md"],
    checks: ["markdown check exited 0"],
    summary: "Documented the behavior.",
  });

  expect(settlePipelineStageOutput({
    store,
    job,
    attempt,
    output,
    docsObservation: {
      clean: false,
      diff: "diff --git a/docs/usage.md b/docs/usage.md\n+++ b/docs/usage.md",
    },
    fence,
    now: 1_004,
  })).toEqual({ outcome: "advanced", nextState: "resolving_docs_head" });
  expect(store.listSkillReceiptProjection(profile.id, 10)).toEqual(expect.arrayContaining([
    expect.objectContaining({ capabilityId: "docs-guard", outcome: "passed" }),
    expect.objectContaining({ capabilityId: "verification-before-completion", outcome: "passed" }),
  ]));
});

describe("pipeline handoffs", () => {
  it("accepts only the exact owner-authored verification commands with exit-zero expectations", () => {
    const policy = policyFixture({
      validationCommands: [
        { name: "unit", command: "npm test", timeoutMs: 600_000 },
        { name: "types", command: "npm run typecheck", timeoutMs: 600_000 },
      ],
    });
    const plan = [
      "# Plan",
      "",
      "Implement the bounded change.",
      "",
      "## Verification",
      "| Check | Command | Expected |",
      "| --- | --- | --- |",
      "| unit | `npm test` | exit code 0 |",
      "| types | `npm run typecheck` | exit code 0 |",
    ].join("\n");

    expect(parseVerificationPlan(plan, policy)).toEqual({
      disposition: "commands",
      checks: [
        { name: "unit", command: "npm test", expectedExitCode: 0 },
        { name: "types", command: "npm run typecheck", expectedExitCode: 0 },
      ],
    });
    expect(() => parseVerificationPlan(plan.replace("npm test", "npm test -- --update"), policy)).toThrow(/exact/i);
    expect(() => parseVerificationPlan(plan.replace("exit code 0", "looks good"), policy)).toThrow(/exit code 0/i);
    expect(() => parseVerificationPlan(plan.replace("| types | `npm run typecheck` | exit code 0 |", ""), policy)).toThrow(/exact/i);
  });

  it("requires an explicit skip when project policy has no validation commands", () => {
    const policy = policyFixture({ validationCommands: [] });
    expect(parseVerificationPlan([
      "# Plan",
      "",
      "## Verification",
      "Automated verification: skipped (project policy has no validation commands).",
    ].join("\n"), policy)).toEqual({ disposition: "skipped", checks: [] });
    expect(() => parseVerificationPlan("# Plan\n\nNo tests needed.\n", policy)).toThrow(/explicit/i);
  });

  it("binds docs reports to observed worktree evidence", () => {
    expect(parseDocsReport(JSON.stringify({
      disposition: "changed",
      files: ["README.md"],
      checks: ["npm test (exit code 0)"],
      summary: "Documented the new behavior.",
    }), {
      clean: false,
      diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n+new docs\n",
    })).toMatchObject({ disposition: "changed", files: ["README.md"] });
    expect(parseDocsReport(JSON.stringify({
      disposition: "skipped",
      files: [],
      checks: [],
      reason: "The public behavior and operator workflow are unchanged.",
    }), { clean: true, diff: "" })).toMatchObject({ disposition: "skipped" });
    expect(() => parseDocsReport(JSON.stringify({
      disposition: "skipped",
      files: [],
      checks: [],
      reason: "No docs needed.",
    }), { clean: false, diff: "diff --git a/README.md b/README.md\n" })).toThrow(/clean/i);
    expect(() => parseDocsReport(JSON.stringify({
      disposition: "changed",
      files: ["README.md"],
      checks: ["docs check (exit code 0)"],
      summary: "Updated docs.",
    }), { clean: false, diff: "diff --git a/docs/other.md b/docs/other.md\n" })).toThrow(/listed/i);
  });

  it("turns bounded planner output into a hashed plan attachment and validates strict critique JSON", () => {
    const plan = buildPlanArtifact("# Plan\n\n1. Add the regression.\n");
    const critique = buildCritiquePacket(plannedJob, plan);
    const critiquePacket = JSON.parse(new TextDecoder().decode(critique.bytes)) as {
      kind: string;
      planSha256: string;
      rules: Record<string, boolean>;
      outputContract: { format: string; schema: Record<string, string> };
    };

    expect(plan).toMatchObject({ filename: "plan.md", mimeType: "text/markdown" });
    expect(plan.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(critiquePacket).toMatchObject({
      kind: "telegram-plan-critique",
      planSha256: plan.sha256,
      rules: {
        editSource: false,
        commit: false,
        push: false,
        merge: false,
        inspectPlannerConversation: false,
      },
      blockingCriteria: [
        expect.stringMatching(/missing the required outcome/i),
        expect.stringMatching(/commit\/push\/pull-request/i),
      ],
      outputContract: { format: "strict-json" },
    });
    expect(Object.keys(critiquePacket.outputContract.schema)).toEqual(["verdict", "summary"]);
    expect(parseCritiqueResult('{"verdict":"pass","summary":"Complete and testable"}')).toEqual({
      verdict: "pass",
      summary: "Complete and testable",
    });
    expect(() => parseCritiqueResult("```json\n{}\n```")).toThrow(/strict JSON/i);
    expect(() => parseCritiqueResult('{"verdict":"pass","summary":"Complete and testable","extra":true}')).toThrow();
    expect(() => buildPlanArtifact("  \n")).toThrow(/non-empty/i);
    expect(() => buildPlanArtifact("x".repeat(65_537))).toThrow(/bounded/i);
  });
});

describe("fresh planner, critic, and builder conversations", () => {
  it("hands critique revisions to a fresh planner as a file in the same worktree", async () => {
    const { runner, spawns, uploads } = pipelineSdk();
    await runner.spawnPlanner(
      { ...plannedJob, environmentId: "env_plan", planCycle: 1 },
      { id: "stage:job_1:2:spawn_plan", role: "PLAN", ordinal: 2 },
      '{"verdict":"needs_revision","summary":"Add rollback evidence"}',
    );

    expect(spawns[0]).toMatchObject({
      environment: { type: "reuse", environmentId: "env_plan" },
      input: [
        { type: "text", text: expect.stringContaining("critique artifact") },
        { type: "localFile", path: "attachments/work-order.md" },
        { type: "localFile", path: "attachments/critique.json" },
      ],
    });
    expect(JSON.stringify(spawns[0])).not.toContain("Add rollback evidence");
    expect(uploads.map((upload) => upload.filename)).toEqual(["work-order.md", "critique.json"]);
  });

  it("uses the strong tier for fresh plan and critique spawns, then hands only files to the builder", async () => {
    const { runner, spawns, uploads } = pipelineSdk();
    const planAttempt = { id: "stage:job_1:1:spawn_plan", role: "PLAN" as const, ordinal: 1 };
    const planThread = await runner.spawnPlanner(plannedJob, planAttempt);
    const plan = buildPlanArtifact(await runner.getThreadOutput(planThread.id));
    const critiqueAttempt = { id: "stage:job_1:1:spawn_critique", role: "CRITIQUE" as const, ordinal: 1 };
    await runner.spawnCritic(
      { ...plannedJob, state: "critiquing", environmentId: "env_plan" },
      critiqueAttempt,
      { ...planAttempt, threadId: planThread.id, environmentId: "env_plan", outputText: new TextDecoder().decode(plan.bytes) },
    );
    await runner.spawnBuilderFromPlan(
      { ...plannedJob, state: "creating_implementation", environmentId: "env_plan" },
      { id: "attempt:job_1:1:spawn_implementation" },
      { ...planAttempt, threadId: planThread.id, environmentId: "env_plan", outputText: new TextDecoder().decode(plan.bytes) },
    );

    expect(spawns).toHaveLength(3);
    for (const spawn of spawns.slice(0, 2)) {
      expect(spawn).toMatchObject({
        providerId: "codex",
        model: "gpt-5.6-sol",
        reasoningLevel: "xhigh",
        serviceTier: "default",
        permissionMode: "auto",
      });
      expect(spawn).not.toHaveProperty("sourceThreadId");
    }
    expect(spawns[0]).toMatchObject({
      environment: {
        type: "host",
        hostId: "host_1",
        workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "main" } },
      },
    });
    expect(spawns[1]).toMatchObject({ environment: { type: "reuse", environmentId: "env_plan" } });
    expect(spawns[2]).toMatchObject({
      environment: { type: "reuse", environmentId: "env_plan" },
      model: "implementation-model",
      input: [
        { type: "text", text: expect.stringMatching(/read the attached.*work order.*plan/i) },
        { type: "localFile", path: "attachments/work-order.md" },
        { type: "localFile", path: "attachments/plan.md" },
      ],
    });
    const criticPrompt = (spawns[1].input as Array<{ type: string; text?: string }>)[0].text ?? "";
    expectCriticPromptContract(criticPrompt);
    expect(criticPrompt).not.toContain("```");
    expect(parseWorkerThreadTitle(String(spawns[0].title))).toEqual({
      jobId: "job_1",
      attemptId: "stage:job_1:1:spawn_plan",
      role: "planner",
    });
    expect(parseWorkerThreadTitle(String(spawns[1].title))).toEqual({
      jobId: "job_1",
      attemptId: "stage:job_1:1:spawn_critique",
      role: "critic",
    });
    expect(parseWorkerThreadTitle(String(spawns[2].title))).toEqual({
      jobId: "job_1",
      attemptId: "attempt:job_1:1:spawn_implementation",
      role: "implementation",
    });
    expect(uploads.map((upload) => upload.filename)).toEqual([
      "work-order.md",
      "work-order.md",
      "plan.md",
      "critique-packet.json",
      "work-order.md",
      "plan.md",
    ]);
  });

  it("spawns docs on the cheap tier and a post-docs reviewer as a fresh conversation", async () => {
    const { runner, spawns, uploads } = pipelineSdk();
    const job = {
      ...plannedJob,
      state: "documenting" as const,
      environmentId: "env_plan",
      implementationThreadId: "thr_builder",
      prNumber: 42,
      prUrl: "https://github.com/acme/cyndra/pull/42",
      prHeadSha: "a".repeat(40),
    };

    await runner.spawnDocs(job, { id: "stage:job_1:1:spawn_docs", role: "DOCS", ordinal: 1 });
    await runner.spawnFinalReview(
      { ...job, state: "final_reviewing" },
      { id: "attempt:job_1:1:spawn_final_review" },
    );

    expect(spawns[0]).toMatchObject({
      parentThreadId: "thr_builder",
      environment: { type: "reuse", environmentId: "env_plan" },
      providerId: "codex",
      model: "gpt-5.6-luna",
      reasoningLevel: "low",
      serviceTier: "default",
      permissionMode: "auto",
      input: [
        { type: "text", text: expect.stringContaining("docs-guard") },
        { type: "localFile", path: "attachments/work-order.md" },
        { type: "localFile", path: "attachments/docs-packet.json" },
      ],
    });
    expect((spawns[0].input as Array<{ type: string; text?: string }>)[0].text).toContain(
      "verification-before-completion",
    );
    expect((spawns[0].input as Array<{ type: string; text?: string }>)[0].text).not.toMatch(/Docs Guard|BB CLI|bb-cli/);
    const docsPacketUpload = uploads.find((upload) => upload.filename === "docs-packet.json");
    if (!docsPacketUpload) throw new Error("docs packet upload missing");
    const docsPacket = JSON.parse(new TextDecoder().decode(docsPacketUpload.clientFile)) as {
      requiredSkills: string[];
      rules: { commitAndPushChanges: boolean };
    };
    expect(docsPacket.requiredSkills).toEqual(["docs-guard", "verification-before-completion"]);
    expect(docsPacket.rules.commitAndPushChanges).toBe(false);
    expect((spawns[0].input as Array<{ type: string; text?: string }>)[0].text).toMatch(/do not commit, push/i);
    expect(parseWorkerThreadTitle(String(spawns[0].title))).toEqual({
      jobId: "job_1",
      attemptId: "stage:job_1:1:spawn_docs",
      role: "documentation",
    });
    expect(spawns[1]).toMatchObject({
      parentThreadId: "thr_builder",
      title: "Telegram job_1 final-review attempt:job_1:1:spawn_final_review",
      environment: { type: "reuse", environmentId: "env_plan" },
    });
    expect(spawns[1]).not.toHaveProperty("sourceThreadId");
    expect(parseWorkerThreadTitle(String(spawns[1].title))).toEqual({
      jobId: "job_1",
      attemptId: "attempt:job_1:1:spawn_final_review",
      role: "final-review",
    });
    expect(uploads.map((upload) => upload.filename)).toEqual([
      "work-order.md",
      "docs-packet.json",
      "review-packet.json",
    ]);
  });

  it("persists stage identity and output under an active executor fence", () => {
    const { bb } = createFakePluginHost({ pluginId: "telegram-agent-pipeline-storage" });
    const store = openStore(bb.storage);
    store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    const lease = store.acquireExecutorLease("executor", 1_001, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    const attempt = store.createPipelineStageAttempt({
      id: "stage_plan_1",
      jobId: "job_1",
      role: "PLAN",
      ordinal: 1,
      inputSha256: "a".repeat(64),
      now: 1_002,
      ownerId: "executor",
      generation: lease.generation,
    });

    expect(store.bindPipelineStageThread({
      id: attempt.id,
      threadId: "thr_plan",
      environmentId: "env_plan",
      now: 1_003,
      ownerId: "executor",
      generation: lease.generation,
    })).toBe(true);
    expect(store.completePipelineStageAttempt({
      id: attempt.id,
      outputText: "# Plan\n",
      outputSha256: "b".repeat(64),
      outcome: { verdict: "success" },
      now: 1_004,
      ownerId: "executor",
      generation: lease.generation,
    })).toBe(true);
    expect(store.getLatestPipelineStageAttempt("job_1", "PLAN")).toMatchObject({
      threadId: "thr_plan",
      environmentId: "env_plan",
      state: "completed",
      outputText: "# Plan\n",
      outputSha256: "b".repeat(64),
    });
    expect(store.findJobByThreadId("thr_plan")?.id).toBe("job_1");
  });

  it("settles durable plan and critique output into the canonical job transitions", () => {
    const { bb } = createFakePluginHost({ pluginId: "telegram-agent-pipeline-settlement" });
    const store = openStore(bb.storage);
    const draft = store.createJob({ id: "job_1", sourceUpdateId: 1, requestText: "work", now: 1_000 });
    store.applyJobEvent(draft.id, draft.version, {
      type: "PROJECT_SELECTED",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture(),
    }, 1_001);
    let job = admitConfirmedJob(store, store.getJob(draft.id)!, 1_002);
    const lease = store.acquireExecutorLease("executor", 1_003, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    const fence = { ownerId: "executor", generation: lease.generation };
    let attempt = store.createPipelineStageAttempt({
      id: "stage_plan_1",
      jobId: job.id,
      role: "PLAN",
      ordinal: 1,
      inputSha256: "a".repeat(64),
      ...fence,
      now: 1_004,
    });
    expect(store.bindPipelineStageThread({
      id: attempt.id,
      threadId: "thr_plan",
      environmentId: "env_plan",
      ...fence,
      now: 1_005,
    })).toBe(true);
    job = store.applyJobEvent(job.id, job.version, {
      type: "PLAN_CREATED",
      attemptId: attempt.id,
      threadId: "thr_plan",
      environmentId: "env_plan",
    }, 1_005);
    attempt = store.getPipelineStageAttempt(attempt.id)!;

    expect(settlePipelineStageOutput({
      store,
      job,
      attempt,
      output: [
        "# Plan",
        "",
        "1. Add a regression test.",
        "",
        "## Verification",
        "| Check | Command | Expected |",
        "| --- | --- | --- |",
        "| unit | `npm test` | exit code 0 |",
      ].join("\n"),
      fence,
      now: 1_006,
    })).toEqual({ outcome: "advanced", nextState: "critiquing" });
    expect(store.getLatestPipelineStageAttempt(job.id, "PLAN")?.outcome).toMatchObject({
      verdict: "success",
      verification: { disposition: "commands" },
    });

    job = store.getJob(job.id)!;
    let critique = store.createPipelineStageAttempt({
      id: "stage_critique_1",
      jobId: job.id,
      role: "CRITIQUE",
      ordinal: 1,
      inputSha256: "b".repeat(64),
      ...fence,
      now: 1_007,
    });
    expect(store.bindPipelineStageThread({
      id: critique.id,
      threadId: "thr_critique",
      environmentId: "env_plan",
      ...fence,
      now: 1_008,
    })).toBe(true);
    critique = store.getPipelineStageAttempt(critique.id)!;

    expect(settlePipelineStageOutput({
      store,
      job,
      attempt: critique,
      output: '{"verdict":"pass","summary":"Complete and testable"}',
      fence,
      now: 1_009,
    })).toEqual({ outcome: "advanced", nextState: "creating_implementation" });
    expect(store.getJob(job.id)?.state).toBe("creating_implementation");

    job = store.getJob(job.id)!;
    job = store.applyJobEvent(job.id, job.version, {
      type: "IMPLEMENTATION_CREATED",
      threadId: "thr_builder",
      environmentId: "env_plan",
    }, 1_010);
    job = store.applyJobEvent(job.id, job.version, { type: "IMPLEMENTATION_IDLE" }, 1_011);
    job = store.applyJobEvent(job.id, job.version, {
      type: "PR_LOCATED",
      number: 42,
      url: "https://github.com/acme/cyndra/pull/42",
    }, 1_012);
    job = store.applyJobEvent(job.id, job.version, { type: "PR_HEAD_RESOLVED", headSha: "c".repeat(40) }, 1_013);
    job = store.applyJobEvent(job.id, job.version, { type: "VALIDATION_PASSED", headSha: "c".repeat(40) }, 1_014);
    job = store.applyJobEvent(job.id, job.version, { type: "REVIEW_PASSED", headSha: "c".repeat(40) }, 1_015);
    let docs = store.createPipelineStageAttempt({
      id: "stage_docs_1",
      jobId: job.id,
      role: "DOCS",
      ordinal: 1,
      inputSha256: "d".repeat(64),
      ...fence,
      now: 1_016,
    });
    expect(store.bindPipelineStageThread({
      id: docs.id,
      threadId: "thr_docs",
      environmentId: "env_plan",
      ...fence,
      now: 1_017,
    })).toBe(true);
    job = store.applyJobEvent(job.id, job.version, {
      type: "DOCS_CREATED",
      attemptId: docs.id,
      threadId: "thr_docs",
      environmentId: "env_plan",
    }, 1_017);
    docs = store.getPipelineStageAttempt(docs.id)!;

    expect(settlePipelineStageOutput({
      store,
      job,
      attempt: docs,
      output: JSON.stringify({
        disposition: "skipped",
        files: [],
        checks: [],
        reason: "The public behavior and operator workflow are unchanged.",
      }),
      docsObservation: { clean: true, diff: "" },
      fence,
      now: 1_018,
    })).toEqual({ outcome: "advanced", nextState: "resolving_docs_head" });
    expect(store.getLatestPipelineStageAttempt(job.id, "DOCS")?.outcome).toMatchObject({
      verdict: "success",
      documentation: { disposition: "skipped" },
    });
    expect(store.getJob(job.id)).toMatchObject({ state: "resolving_docs_head", prHeadSha: null });
  });

  it("treats invalid critique JSON as a revision instead of killing the job", () => {
    const { bb } = createFakePluginHost({ pluginId: "telegram-agent-pipeline-invalid-critique" });
    const store = openStore(bb.storage);
    const draft = store.createJob({ id: "job_bad_critique", sourceUpdateId: 2, requestText: "work", now: 1_000 });
    store.applyJobEvent(draft.id, draft.version, {
      type: "PROJECT_SELECTED",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture(),
    }, 1_001);
    let job = admitConfirmedJob(store, store.getJob(draft.id)!, 1_002);
    const lease = store.acquireExecutorLease("executor", 1_003, 30_000);
    if (!lease.acquired) throw new Error("lease missing");
    const fence = { ownerId: "executor", generation: lease.generation };
    store.createPipelineStageAttempt({
      id: "stage_plan_bad",
      jobId: job.id,
      role: "PLAN",
      ordinal: 1,
      inputSha256: "a".repeat(64),
      ...fence,
      now: 1_004,
    });
    store.bindPipelineStageThread({
      id: "stage_plan_bad",
      threadId: "thr_plan",
      environmentId: "env_plan",
      ...fence,
      now: 1_005,
    });
    job = store.applyJobEvent(job.id, job.version, {
      type: "PLAN_CREATED",
      attemptId: "stage_plan_bad",
      threadId: "thr_plan",
      environmentId: "env_plan",
    }, 1_005);
    job = store.applyJobEvent(job.id, job.version, { type: "PLAN_READY", attemptId: "stage_plan_bad" }, 1_006);
    const critique = store.createPipelineStageAttempt({
      id: "stage_critique_bad",
      jobId: job.id,
      role: "CRITIQUE",
      ordinal: 1,
      inputSha256: "b".repeat(64),
      ...fence,
      now: 1_007,
    });
    store.bindPipelineStageThread({
      id: critique.id,
      threadId: "thr_critique",
      environmentId: "env_plan",
      ...fence,
      now: 1_008,
    });

    expect(settlePipelineStageOutput({
      store,
      job,
      attempt: store.getPipelineStageAttempt(critique.id)!,
      output: "```json\n{not valid}\n```",
      fence,
      now: 1_009,
    })).toEqual({ outcome: "advanced", nextState: "planning" });
    expect(store.getJob(job.id)).toMatchObject({
      state: "planning",
      planCycle: 1,
      lastError: null,
    });
  });
});
