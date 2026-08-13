import type { BbPluginApi } from "@bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import { parseWorkerThreadTitle } from "../src/agent-skills/role-resolver";
import { BbRunner } from "../src/bb/runner";
import { activeWorkerFixture, jobFixture, policyFixture } from "./helpers";

type SdkCalls = {
  attachments: unknown[];
  projectLists: unknown[];
  spawns: unknown[];
  forks: unknown[];
  sends: unknown[];
  stops: unknown[];
  gets: unknown[];
  statuses: unknown[];
  diffs: unknown[];
  pullRequests: unknown[];
  terminalCreates: unknown[];
};

function projectSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj_1",
    kind: "standard",
    name: "Project One",
    gitRemoteUrl: "https://github.com/acme/cyndra.git",
    createdAt: 1,
    updatedAt: 1,
    sources: [
      {
        id: "src_1",
        projectId: "proj_1",
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
        type: "local_path",
        hostId: "host_project",
        path: "/projects/one",
      },
    ],
    ...overrides,
  };
}

function runnerFixture(options: {
  projects?: unknown[];
  pullRequest?: unknown;
  statusHeadSha?: string;
} = {}) {
  const calls: SdkCalls = {
    attachments: [],
    projectLists: [],
    spawns: [],
    forks: [],
    sends: [],
    stops: [],
    gets: [],
    statuses: [],
    diffs: [],
    pullRequests: [],
    terminalCreates: [],
  };
  let terminalMarker: string | null = null;
  let terminalReads = 0;
  const sdk = {
    projects: {
      list: vi.fn(async (args?: unknown) => {
        calls.projectLists.push(args);
        return options.projects ?? [projectSnapshot()];
      }),
      attachments: {
        upload: vi.fn(async (args: unknown) => {
          calls.attachments.push(args);
          const filename = (args as { filename: string }).filename;
          return {
            type: "localFile",
            path: `attachments/${filename}`,
            name: filename,
            sizeBytes: 100,
            mimeType: "text/markdown",
          };
        }),
      },
    },
    threads: {
      spawn: vi.fn(async (args: unknown) => {
        calls.spawns.push(args);
        return { id: "thr_created", environmentId: "env_1" };
      }),
      fork: vi.fn(async (args: unknown) => {
        calls.forks.push(args);
        return { id: "thr_forked" };
      }),
      send: vi.fn(async (args: unknown) => {
        calls.sends.push(args);
        return { ok: true };
      }),
      stop: vi.fn(async (args: unknown) => {
        calls.stops.push(args);
        return { ok: true };
      }),
      get: vi.fn(async (args: unknown) => {
        calls.gets.push(args);
        return { id: "thr_i", status: "idle" };
      }),
    },
    environments: {
      status: vi.fn(async (args: unknown) => {
        calls.statuses.push(args);
        return {
          outcome: "available",
          workspace: { checkout: { kind: "detached", headSha: options.statusHeadSha ?? "a".repeat(40) } },
        };
      }),
      diff: vi.fn(async (args: unknown) => {
        calls.diffs.push(args);
        return { outcome: "available", diff: { diff: "diff --git a/src/a.ts b/src/a.ts", truncated: false } };
      }),
      pullRequest: vi.fn(async (args: unknown) => {
        calls.pullRequests.push(args);
        return options.pullRequest ?? {
          outcome: "available",
          pullRequest: { number: 42, url: "https://github.com/acme/cyndra/pull/42" },
        };
      }),
    },
    terminals: {
      create: vi.fn(async (input: { start: { command: string } }) => {
        calls.terminalCreates.push(input);
        const { start } = input;
        terminalMarker = start.command.match(/__BB_TELEGRAM_AGENT_RESULT_[0-9a-f]+__/)?.[0] ?? null;
        return { id: "term_review_diff" };
      }),
      get: vi.fn(async () => {
        terminalReads += 1;
        return terminalReads === 1
          ? { status: "running", exitCode: null }
          : { status: "exited", exitCode: 0 };
      }),
      output: vi.fn(async () => ({
        chunks: [{
          seq: 0,
          dataBase64: Buffer.from(
            `diff --git a/src/a.ts b/src/a.ts\n+fallback\n${terminalMarker ?? "__missing__"}:0\n`,
            "utf8",
          ).toString("base64"),
        }],
        nextSeq: 1,
      })),
      close: vi.fn(async () => undefined),
    },
  } as unknown as BbPluginApi["sdk"];
  return { calls, runner: new BbRunner(sdk) };
}

function attempt(id: string) {
  return { id, handoffPath: null as string | null, handoffSha256: null as string | null };
}

const selectedJob = jobFixture({
  projectId: "proj_1",
  policy: policyFixture(),
  environmentId: "env_1",
  implementationThreadId: "thr_i",
  prNumber: 42,
  prUrl: "https://github.com/acme/cyndra/pull/42",
  prHeadSha: "a".repeat(40),
});

it("spawns implementation in a hidden managed worktree and records the immutable handoff", async () => {
  const { calls, runner } = runnerFixture();
  const implementationAttempt = attempt("attempt:job_1:1:spawn_implementation");

  await runner.spawnImplementation(selectedJob, implementationAttempt, policyFixture({ baseBranch: "wrong" }));

  expect(calls.spawns[0]).toMatchObject({
    projectId: "proj_1",
    title: "Telegram job_1 implementation attempt:job_1:1:spawn_implementation",
    visibility: "hidden",
    environment: {
      type: "host",
      hostId: "host_project",
      workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "main" } },
    },
    input: [
      { type: "text", text: expect.stringContaining("Read the attached immutable work order") },
      { type: "localFile", path: "attachments/work-order.md" },
    ],
    model: "implementation-model",
    executionInputSources: { model: "explicit" },
  });
  expect(calls.attachments).toHaveLength(1);
  expect(calls.forks).toHaveLength(0);
  expect(implementationAttempt.handoffPath).toBe("attachments/work-order.md");
  expect(implementationAttempt.handoffSha256).toMatch(/^[0-9a-f]{64}$/);
  expect((calls.spawns[0] as { input: Array<{ text?: string }> }).input[0].text).toContain("PROGRESS.md");
  expect(parseWorkerThreadTitle(String((calls.spawns[0] as { title: string }).title))).toEqual({
    jobId: "job_1",
    attemptId: "attempt:job_1:1:spawn_implementation",
    role: "implementation",
  });
});

it("spawns an adopted pull request from its verified branch without asking for edits", async () => {
  const { calls, runner } = runnerFixture();
  const job = jobFixture({
    projectId: "proj_1",
    policy: policyFixture(),
    origin: "adopted_pr",
    adoptedBranch: "telegram-agent/adopt-pr-17-aaaaaaaaaaaa",
    adoptedHeadSha: "a".repeat(40),
    prNumber: 17,
    prUrl: "https://github.com/acme/cyndra/pull/17",
    prHeadSha: "a".repeat(40),
  });

  await runner.spawnImplementation(job, attempt("attempt:job_1:1:adopt_pr"));

  expect(calls.spawns[0]).toMatchObject({
    environment: {
      type: "host",
      hostId: "host_project",
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "named", name: "telegram-agent/adopt-pr-17-aaaaaaaaaaaa" },
      },
    },
  });
  const prompt = (calls.spawns[0] as { input: Array<{ text?: string }> }).input[0].text ?? "";
  expect(prompt).toMatch(/do not edit/i);
  expect(prompt).toContain("aaaaaaaaaaaa");
});

it("creates a gitignored progress scratchpad inside the implementation worktree", async () => {
  const { calls, runner } = runnerFixture();

  await runner.prepareProgressScratchpad("env_1");

  expect(calls.terminalCreates).toHaveLength(1);
  const command = (calls.terminalCreates[0] as { start: { command: string } }).start.command;
  expect(command).toContain("/PROGRESS.md");
  expect(command).toContain("git check-ignore");
  expect(command).toContain("PROGRESS.md");
});

it.each([
  ["missing project", []],
  ["personal project", [projectSnapshot({ kind: "personal", sources: [] })]],
  [
    "missing source host",
    [
      projectSnapshot({
        sources: [
          {
            id: "src_1",
            projectId: "proj_1",
            isDefault: true,
            createdAt: 1,
            updatedAt: 1,
            type: "local_path",
            hostId: "",
            path: "/projects/one",
          },
        ],
      }),
    ],
  ],
])("fails before upload when implementation project routing has a %s", async (_caseName, projects) => {
  const { calls, runner } = runnerFixture({ projects });

  await expect(
    runner.spawnImplementation(selectedJob, attempt("attempt_impl_invalid_host")),
  ).rejects.toThrow(/project|source|host/i);

  expect(calls.attachments).toHaveLength(0);
  expect(calls.spawns).toHaveLength(0);
});

it("requires an immutable job policy snapshot even when a caller supplies a policy", async () => {
  const { calls, runner } = runnerFixture();

  await expect(
    runner.spawnImplementation(
      jobFixture({ projectId: "proj_1", policy: null }),
      attempt("attempt_impl_without_snapshot"),
      policyFixture(),
    ),
  ).rejects.toThrow(/immutable policy snapshot/i);

  expect(calls.attachments).toHaveLength(0);
  expect(calls.spawns).toHaveLength(0);
});

it("spawns review as a hidden child in the exact implementation environment", async () => {
  const { calls, runner } = runnerFixture();
  const reviewAttempt = attempt("attempt:job_1:1:spawn_review");

  await runner.spawnReview(selectedJob, reviewAttempt, policyFixture({ baseBranch: "wrong" }));

  expect(calls.spawns[0]).toMatchObject({
    projectId: "proj_1",
    parentThreadId: "thr_i",
    title: "Telegram job_1 review attempt:job_1:1:spawn_review",
    visibility: "hidden",
    environment: { type: "reuse", environmentId: "env_1" },
    input: [
      { type: "text", text: expect.stringContaining("Read the attached immutable review packet") },
      { type: "localFile", path: "attachments/review-packet.json" },
    ],
    model: "review-model",
    executionInputSources: { model: "explicit" },
  });
  expect(calls.statuses[0]).toEqual({ environmentId: "env_1", mergeBaseBranch: "main" });
  expect(calls.diffs[0]).toEqual({ environmentId: "env_1", target: "all", mergeBaseBranch: "main" });
  expect(calls.pullRequests[0]).toEqual({ environmentId: "env_1" });
  expect(calls.forks).toHaveLength(0);
  expect(parseWorkerThreadTitle(String((calls.spawns[0] as { title: string }).title))).toEqual({
    jobId: "job_1",
    attemptId: "attempt:job_1:1:spawn_review",
    role: "review",
  });
});

it("falls back to the GitHub pull-request diff when the environment snapshot is truncated", async () => {
  const { calls, runner } = runnerFixture();
  const reviewAttempt = attempt("attempt_review_truncated");

  (runner as unknown as { sdk: { environments: { diff: ReturnType<typeof vi.fn> } } }).sdk.environments.diff = vi.fn(async () => ({
    outcome: "available",
    diff: { diff: "partial", truncated: true },
  }));

  await runner.spawnReview(selectedJob, reviewAttempt, policyFixture());
  expect(calls.attachments).toHaveLength(1);
  expect(calls.spawns).toHaveLength(1);
  const uploaded = calls.attachments[0] as { clientFile: Uint8Array };
  expect(new TextDecoder().decode(uploaded.clientFile)).toContain("fallback");
});

it.each([
  ["absent PR", selectedJob, { outcome: "absent" }],
  [
    "wrong PR identity",
    selectedJob,
    {
      outcome: "available",
      pullRequest: { number: 99, url: "https://github.com/acme/cyndra/pull/99" },
    },
  ],
  [
    "missing authoritative head",
    jobFixture({
        projectId: "proj_1",
        policy: policyFixture(),
        environmentId: "env_1",
        implementationThreadId: "thr_i",
        prNumber: 42,
        prUrl: "https://github.com/acme/cyndra/pull/42",
        prHeadSha: null,
      }),
    {
      outcome: "available",
      pullRequest: { number: 42, url: "https://github.com/acme/cyndra/pull/42" },
    },
  ],
])("requires a matching available PR and an authoritative job head before review (%s)", async (_caseName, job, pullRequest) => {
  const { calls, runner } = runnerFixture({ pullRequest, statusHeadSha: "b".repeat(40) });

  await expect(runner.spawnReview(job, attempt("attempt_review_pr"), policyFixture())).rejects.toThrow(
    /pull-request|authoritative|head|snapshot/i,
  );
  expect(calls.attachments).toHaveLength(0);
  expect(calls.spawns).toHaveLength(0);
});

it("uses exact send, stop, thread, environment, and pull-request SDK calls", async () => {
  const { calls, runner } = runnerFixture();

  await runner.sendSteering("thr_i", "Continue with the bounded check.");
  await runner.sendRemediation(selectedJob, [
    { severity: "high", file: "src/a.ts", line: 1, title: "Fix it", details: "Evidence" },
  ]);
  await runner.stopWorker(activeWorkerFixture({ resourceId: "thr_i" }));
  await runner.getThread("thr_i");
  await runner.getEnvironmentSnapshot("env_1", "main");
  await runner.getPullRequestSnapshot("env_1");

  expect(calls.sends).toEqual([
    { threadId: "thr_i", mode: "auto", input: [{ type: "text", text: "Continue with the bounded check.", mentions: [] }] },
    { threadId: "thr_i", mode: "auto", input: [{ type: "text", text: expect.stringContaining("Fix it"), mentions: [] }] },
  ]);
  expect(calls.stops).toEqual([{ threadId: "thr_i" }]);
  expect(calls.gets).toEqual([{ threadId: "thr_i" }]);
  expect(calls.statuses).toContainEqual({ environmentId: "env_1", mergeBaseBranch: "main" });
  expect(calls.diffs).toContainEqual({ environmentId: "env_1", target: "all", mergeBaseBranch: "main" });
  expect(calls.pullRequests).toEqual([{ environmentId: "env_1" }]);
});

it.each([
  ["unproven string", "thr_unproven"],
  ["idle", activeWorkerFixture({ state: "idle" })],
  ["failed", activeWorkerFixture({ state: "failed" })],
  ["unknown", activeWorkerFixture({ state: "unknown" })],
  ["stale", activeWorkerFixture({ state: "stale" })],
  [
    "terminal",
    { ...activeWorkerFixture(), state: "terminal" } as unknown as ReturnType<typeof activeWorkerFixture>,
  ],
])("rejects stop requests without fresh starting, active, or stopping BB-thread evidence (%s)", async (_caseName, worker) => {
  const { calls, runner } = runnerFixture();

  await expect(runner.stopWorker(worker)).rejects.toThrow(/starting|active|stopping|evidence|BB thread/i);

  expect(calls.stops).toHaveLength(0);
});
