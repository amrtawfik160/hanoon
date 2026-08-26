import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type {
  Job,
  JobState,
  ProductionPolicy,
  WorkerLiveness,
} from "../src/domain/models";
import type { ProjectPolicy } from "../src/domain/models";
import type { TelegramAgentStore } from "../src/storage/store";
import { AutonomyRepository } from "../src/storage/autonomy-repository";
import { ALL_MIGRATIONS } from "../src/storage/migrations";
import { registerWorkArtifactRelationshipValidation } from "../src/work-artifacts/repository";
import { vi } from "vitest";

export type FileBackedAutonomyHarness = Readonly<{
  directory: string;
  databasePath: string;
  primary: Database.Database;
  secondary: Database.Database;
  primaryRepository: AutonomyRepository;
  secondaryRepository: AutonomyRepository;
  close(): void;
}>;

export function fileBackedAutonomyHarness(): FileBackedAutonomyHarness {
  const directory = mkdtempSync(join(tmpdir(), "telegram-autonomy-verification-"));
  const databasePath = join(directory, "autonomy.sqlite");
  const primary = new Database(databasePath);
  let secondary: Database.Database | null = null;
  try {
    primary.pragma("journal_mode = WAL");
    primary.pragma("foreign_keys = ON");
    registerWorkArtifactRelationshipValidation(primary);
    for (const migration of ALL_MIGRATIONS) primary.exec(migration);
    secondary = new Database(databasePath);
    secondary.pragma("journal_mode = WAL");
    secondary.pragma("foreign_keys = ON");
    registerWorkArtifactRelationshipValidation(secondary);
    let closed = false;
    return {
      directory,
      databasePath,
      primary,
      secondary,
      primaryRepository: new AutonomyRepository(primary),
      secondaryRepository: new AutonomyRepository(secondary),
      close: () => {
        if (closed) return;
        closed = true;
        secondary?.close();
        primary.close();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    secondary?.close();
    primary.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export type TelegramFixtureResponse =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error_code: number;
      description?: string;
      parameters?: { retry_after?: number };
      [key: string]: unknown;
    };

export type TelegramFetchCall = {
  method: string;
  body: string;
};

export function telegramFetch(
  responses: readonly TelegramFixtureResponse[],
): typeof fetch & { calls: TelegramFetchCall[] } {
  const queue = [...responses];
  const calls: TelegramFetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const rawBody = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.stringify(JSON.parse(rawBody));
    const next = queue.shift();
    if (!next) throw new Error(`No Telegram fixture response for ${method}`);
    calls.push({ method, body });
    return new Response(JSON.stringify(next), {
      status: next.ok ? 200 : next.error_code,
      headers: { "content-type": "application/json" },
    });
  });

  return Object.assign(fetchMock, { calls }) as typeof fetch & { calls: TelegramFetchCall[] };
}

export function privateMessage(
  text?: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    message_id: 1,
    from: { id: 7, is_bot: false },
    chat: { id: 70, type: "private" },
    ...(text === undefined ? {} : { text }),
    ...overrides,
  };
}

export function productionPolicyFixture(
  overrides: Partial<ProductionPolicy> = {},
): ProductionPolicy {
  return {
    deployCommands: [
      { name: "deploy", command: "./scripts/deploy-test.sh", timeoutMs: 60_000 },
    ],
    canaryCommands: [
      { name: "canary", command: "./scripts/canary-test.sh", timeoutMs: 60_000 },
    ],
    convexDeployRequired: false,
    ...overrides,
  };
}

export const immediateSleep = vi.fn(async (_ms: number, signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason;
});

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
    production: {
      deployCommands: [
        { name: "deploy", command: "./scripts/deploy-production.sh", timeoutMs: 1_800_000 },
      ],
      canaryCommands: [
        { name: "canary", command: "./scripts/verify-production.sh", timeoutMs: 300_000 },
      ],
      convexDeployRequired: false,
    },
    requiredChecks: ["test"],
    outputRedactionPatterns: [],
    workerStartGraceMs: 120_000,
    workerLivenessWatchdogMs: 300_000,
    workerRecoveryLimit: 2,
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
    documentationThreadId: null,
    prNumber: null,
    prUrl: null,
    prHeadSha: null,
    mergeMessage: null,
    mergeCommitSha: null,
    mergedAt: null,
    deploymentSummary: null,
    canarySummary: null,
    statusMessageId: null,
    deliveryMode: "full",
    taskRecipe: "architectural",
    recipeVersion: 1,
    recipePromotionCount: 0,
    routingMode: "legacy",
    taskTraits: [],
    taskReasonCodes: [],
    origin: "requested",
    autonomousOrigin: null,
    adoptedBranch: null,
    adoptedHeadSha: null,
    planCycle: 0,
    reviewCycle: 0,
    reviewBlockAt: 3,
    cancelRequestedAt: null,
    mergePreApprovedAt: null,
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

export function admitConfirmedJob(
  store: Pick<TelegramAgentStore, "queueAdmission" | "tryAdmit" | "acquireExecutorLease" | "releaseExecutorLease">,
  selected: Job,
  now: number,
): Job {
  if (!selected.projectId) throw new Error("selected job has no project identity");
  const ownerId = "test-admitter";
  const lease = store.acquireExecutorLease(ownerId, now, 30_000);
  if (!lease.acquired) throw new Error("test admission lease was not acquired");
  try {
    store.queueAdmission({
      jobId: selected.id,
      expectedVersion: selected.version,
      projectId: selected.projectId,
      resumeEvent: "CONFIRMED",
      now,
    });
    const attempt = store.tryAdmit({
      jobId: selected.id,
      maxConcurrentJobs: 8,
      ownerId,
      generation: lease.generation,
      now,
      leaseMs: 30_000,
    });
    if (attempt.outcome !== "admitted") throw new Error(`test admission failed: ${attempt.reason}`);
    return attempt.job;
  } finally {
    store.releaseExecutorLease(ownerId, lease.generation, now + 1);
  }
}
