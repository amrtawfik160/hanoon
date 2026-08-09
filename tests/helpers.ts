import type {
  Job,
  JobState,
  WorkerLiveness,
} from "../src/domain/models";
import type { ProjectPolicy } from "../src/domain/models";

export function policyFixture(
  overrides: Partial<ProjectPolicy> = {},
): ProjectPolicy {
  return {
    projectId: "proj_1",
    alias: "cyndra",
    enabled: true,
    githubRepository: "acme/cyndra",
    baseBranch: "main",
    implementation: { model: "implementation-model" },
    review: { model: "review-model" },
    validationCommands: [
      { name: "unit", command: "npm test", timeoutMs: 600_000 },
    ],
    requiredChecks: ["test"],
    outputRedactionPatterns: [],
    workerLivenessWatchdogMs: 300_000,
    maxReviewCycles: 3,
    mergeMethod: "squash",
    ...overrides,
  };
}

export function jobFixture(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    sourceUpdateId: 100,
    requestText: "implement the request",
    state: "awaiting_project",
    resumeState: null,
    projectId: null,
    policyVersion: null,
    policy: null,
    environmentId: null,
    implementationThreadId: null,
    reviewThreadId: null,
    prNumber: null,
    prUrl: null,
    prHeadSha: null,
    statusMessageId: null,
    reviewCycle: 0,
    reviewBlockAt: 3,
    cancelRequestedAt: null,
    blockedReason: null,
    lastError: null,
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

export function activeWorkerFixture(
  overrides: Partial<WorkerLiveness> = {},
): WorkerLiveness {
  return {
    jobId: "job_1",
    workerKind: "implementation",
    resourceKind: "bb_thread",
    resourceId: "thr_active",
    generation: 2,
    state: "active",
    sourceUpdatedAt: 1_000,
    observedAt: 1_100,
    staleNotifiedAt: null,
    ...overrides,
  };
}

export function sha(char = "a"): string {
  return char.repeat(40);
}

export function stateJob(state: JobState, overrides: Partial<Job> = {}): Job {
  return jobFixture({ state, ...overrides });
}
