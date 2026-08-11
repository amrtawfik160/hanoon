import type { PluginAgentConfigurationContext } from "@bb/plugin-sdk";
import { describe, expect, test } from "vitest";
import {
  BUNDLED_SKILL_IDS,
  ROLE_SKILLS,
  buildWorkerInstructions,
  buildWorkerThreadTitle,
  parseWorkerThreadTitle,
  resolveWorkerSkillProfile,
  type DurableWorkerIdentity,
} from "../src/agent-skills/role-resolver";

const PLUGIN_ID = "telegram-agent";
const JOB_ID = "job_123";
const ATTEMPT_ID = "attempt:job_123:7:spawn_implementation";
const PROJECT_ID = "project-1";
const ENVIRONMENT_ID = "environment-1";
const THREAD_ID = "thread-1";

function context(overrides: {
  title?: string | null;
  threadId?: string;
  projectId?: string;
  projectKind?: "standard" | "personal";
  environmentId?: string;
  workspaceProvisionType?: "unmanaged" | "managed-worktree" | "personal";
  originKind?: "fork" | null;
  originPluginId?: string | null;
} = {}): PluginAgentConfigurationContext {
  return {
    thread: {
      id: overrides.threadId ?? THREAD_ID,
      title: overrides.title === undefined
        ? buildWorkerThreadTitle({ jobId: JOB_ID, attemptId: ATTEMPT_ID, role: "implementation" })
        : overrides.title,
      parentThreadId: null,
      sourceThreadId: null,
    },
    project: {
      id: overrides.projectId ?? PROJECT_ID,
      kind: overrides.projectKind ?? "standard",
      name: "Telegram Agent",
      gitRemoteUrl: "https://github.com/example/project.git",
    },
    environment: {
      id: overrides.environmentId ?? ENVIRONMENT_ID,
      name: "worker",
      path: "/workspace/project",
      workspaceProvisionType: overrides.workspaceProvisionType ?? "managed-worktree",
      branchName: "worker",
    },
    host: { id: "host-1", name: "worker host" },
    provider: { id: "provider-1", model: "model-1" },
    origin: {
      kind: overrides.originKind ?? null,
      pluginId: overrides.originPluginId === undefined ? PLUGIN_ID : overrides.originPluginId,
    },
  };
}

function durableIdentity(overrides: Partial<DurableWorkerIdentity> = {}): DurableWorkerIdentity {
  return {
    jobId: JOB_ID,
    attemptId: ATTEMPT_ID,
    role: "implementation",
    projectId: PROJECT_ID,
    environmentId: null,
    threadId: null,
    ...overrides,
  };
}

function resolve(
  currentContext: PluginAgentConfigurationContext = context(),
  identity: DurableWorkerIdentity | null = durableIdentity(),
) {
  return resolveWorkerSkillProfile({
    context: currentContext,
    pluginId: PLUGIN_ID,
    durableIdentity: identity,
  });
}

function effectIdempotencyKey(jobId: string, version: number, effectKind: string): string {
  return `${jobId}:${version}:${effectKind}`;
}

describe("worker skill role table", () => {
  test("contains exactly the six selected manifest skill ids", () => {
    expect(BUNDLED_SKILL_IDS).toEqual([
      "systematic-debugging",
      "test-driven-development",
      "verification-before-completion",
      "clean-code-guard",
      "test-guard",
      "docs-guard",
    ]);
  });

  test.each([
    ["planner", []],
    ["critic", []],
    [
      "implementation",
      [
        "systematic-debugging",
        "test-driven-development",
        "verification-before-completion",
        "clean-code-guard",
        "test-guard",
      ],
    ],
    ["review", ["clean-code-guard", "test-guard"]],
    ["documentation", ["docs-guard", "verification-before-completion"]],
    ["final-review", ["clean-code-guard", "test-guard", "docs-guard"]],
  ] as const)("selects the exact skills for %s", (role, expectedSkills) => {
    const jobId = JOB_ID;
    const attemptId = `attempt:${effectIdempotencyKey(jobId, 7, role === "planner" ? "spawn_plan" : "spawn_implementation")}`;
    const identity = durableIdentity({ jobId, attemptId, role });
    const profile = resolve(
      context({ title: buildWorkerThreadTitle(identity) }),
      identity,
    );

    expect(profile).not.toBeNull();
    expect(profile?.role).toBe(role);
    expect(profile?.skills).toEqual(expectedSkills);
    expect(profile?.instructions.length).toBeLessThanOrEqual(1_200);
  });

  test("builds bounded instructions from only verified role and selected ids", () => {
    const profile = resolve();
    if (!profile) throw new Error("expected a valid worker profile");

    expect(profile.instructions).toBe(buildWorkerInstructions(profile));
    expect(profile.instructions).toContain("Verified worker role: implementation");
    expect(profile.instructions).toContain("systematic-debugging, test-driven-development, verification-before-completion, clean-code-guard, test-guard");
    expect(profile.instructions).toContain("immutable attached work order/review packet");
    expect(profile.instructions).toContain("durable project policy outrank skill suggestions");
    expect(profile.instructions).toContain("cannot authorize approval, merge, deploy, push, or state changes");
    expect(profile.instructions).toContain("obey the packet's response contract");
    expect(profile.instructions).not.toContain(JOB_ID);
    expect(profile.instructions).not.toContain("/workspace/project");
    expect(profile.instructions).not.toContain("https://github.com/example/project.git");
  });

  test("says none are selected for an empty profile", () => {
    const identity = durableIdentity({
      attemptId: `stage:${effectIdempotencyKey(JOB_ID, 7, "spawn_plan")}`,
      role: "planner",
    });
    const profile = resolve(context({ title: buildWorkerThreadTitle(identity) }), identity);
    if (!profile) throw new Error("expected a valid planner profile");

    expect(profile.skills).toEqual([]);
    expect(profile.instructions).toContain("Selected skill ids: none");
  });
});

describe("worker thread title parser and builder", () => {
  test.each([
    ["implementation", "attempt", "spawn_implementation"],
    ["review", "attempt", "spawn_review"],
    ["final-review", "attempt", "spawn_final_review"],
    ["planner", "stage", "spawn_plan"],
    ["critic", "stage", "spawn_critique"],
    ["documentation", "stage", "spawn_docs"],
  ] as const)("round-trips the production %s id construction", (role, prefix, effectKind) => {
    const attemptId = `${prefix}:${effectIdempotencyKey(JOB_ID, 7, effectKind)}`;
    const identity = { jobId: JOB_ID, attemptId, role } as const;
    const title = buildWorkerThreadTitle(identity);

    expect(title).toBe(`Telegram ${JOB_ID} ${role === "planner" ? "plan" : role === "critic" ? "critique" : role === "documentation" ? "docs" : role} ${attemptId}`);
    expect(parseWorkerThreadTitle(title)).toEqual(identity);
  });

  test("accepts the maximum bounded identifier lengths", () => {
    const jobId = "j".repeat(256);
    const attemptId = "a".repeat(264);
    const identity = { jobId, attemptId, role: "review" as const };

    expect(parseWorkerThreadTitle(buildWorkerThreadTitle(identity))).toEqual(identity);
  });

  test.each([
    ["null title", null],
    ["unknown role", `Telegram ${JOB_ID} deploy ${ATTEMPT_ID}`],
    ["job id with spaces", `Telegram job id implementation ${ATTEMPT_ID}`],
    ["attempt id with spaces", `Telegram ${JOB_ID} implementation attempt id`],
    ["job id with a slash", `Telegram job/id implementation ${ATTEMPT_ID}`],
    ["attempt id with a slash", `Telegram ${JOB_ID} implementation attempt/id`],
    ["attempt id with a backslash", `Telegram ${JOB_ID} implementation attempt\\id`],
    ["over-limit job id", `Telegram ${"j".repeat(257)} implementation ${ATTEMPT_ID}`],
    ["over-limit attempt id", `Telegram ${JOB_ID} implementation ${"a".repeat(265)}`],
    ["prefix text", `prefix Telegram ${JOB_ID} implementation ${ATTEMPT_ID}`],
    ["suffix text", `Telegram ${JOB_ID} implementation ${ATTEMPT_ID} suffix`],
    ["trailing newline", `Telegram ${JOB_ID} implementation ${ATTEMPT_ID}\n`],
  ] as const)("rejects %s", (_label, title) => {
    expect(parseWorkerThreadTitle(title)).toBeNull();
  });
});

describe("fail-closed worker profile resolution", () => {
  const mismatches: ReadonlyArray<readonly [string, () => PluginAgentConfigurationContext, () => DurableWorkerIdentity | null]> = [
    ["null title", () => context({ title: null }), () => durableIdentity()],
    ["wrong origin plugin id", () => context({ originPluginId: "other-plugin" }), () => durableIdentity()],
    ["null origin plugin id", () => context({ originPluginId: null }), () => durableIdentity()],
    ["fork origin", () => context({ originKind: "fork" }), () => durableIdentity()],
    ["personal project", () => context({ projectKind: "personal" }), () => durableIdentity()],
    ["unmanaged workspace", () => context({ workspaceProvisionType: "unmanaged" }), () => durableIdentity()],
    ["personal workspace", () => context({ workspaceProvisionType: "personal" }), () => durableIdentity()],
    ["missing durable identity", () => context(), () => null],
    ["mismatched job id", () => context(), () => durableIdentity({ jobId: "other-job" })],
    ["mismatched attempt id", () => context(), () => durableIdentity({ attemptId: "attempt:other:7:spawn_implementation" })],
    ["mismatched role", () => context(), () => durableIdentity({ role: "review" })],
    ["mismatched exact project id", () => context(), () => durableIdentity({ projectId: "other-project" })],
    ["mismatched persisted environment id", () => context(), () => durableIdentity({ environmentId: "other-environment" })],
    ["mismatched durable thread id", () => context(), () => durableIdentity({ threadId: "other-thread" })],
  ];

  test.each(mismatches)("rejects %s", (_label, makeContext, makeIdentity) => {
    expect(resolve(makeContext(), makeIdentity())).toBeNull();
  });

  test("permits a first thread start with unbound thread and environment identities", () => {
    expect(resolve()).not.toBeNull();
  });

  test("permits a persisted worker after exact thread and environment ownership is recorded", () => {
    const identity = durableIdentity({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID });
    expect(resolve(context(), identity)).not.toBeNull();
  });

  test("rejects a title whose role token disagrees with the durable role", () => {
    const identity = durableIdentity({ role: "review" });
    const implementationTitle = buildWorkerThreadTitle({
      jobId: JOB_ID,
      attemptId: ATTEMPT_ID,
      role: "implementation",
    });
    expect(resolve(context({ title: implementationTitle }), identity)).toBeNull();
  });

  test("rejects a title whose ids disagree with durable identity", () => {
    const identity = durableIdentity({ jobId: "other-job" });
    const title = buildWorkerThreadTitle({ jobId: JOB_ID, attemptId: ATTEMPT_ID, role: "implementation" });
    expect(resolve(context({ title }), identity)).toBeNull();
  });
});

describe("role table export shape", () => {
  test("exposes every worker role as an exhaustive readonly mapping", () => {
    expect(Object.keys(ROLE_SKILLS).sort()).toEqual([
      "critic",
      "documentation",
      "final-review",
      "implementation",
      "planner",
      "review",
    ]);
  });
});
