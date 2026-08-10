import type {
  Job,
  JobState,
  WorkerLiveness,
} from "../src/domain/models";
import type { ProjectPolicy } from "../src/domain/models";
import { vi } from "vitest";

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
    documentationThreadId: null,
    prNumber: null,
    prUrl: null,
    prHeadSha: null,
    statusMessageId: null,
    planCycle: 0,
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
