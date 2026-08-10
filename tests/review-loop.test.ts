import { describe, expect, it } from "vitest";

import { ReviewHandler } from "../src/services/review-handler";

const EXPECTED_SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);

type ReviewOutput = {
  verdict: "pass" | "changes_requested" | "blocked";
  reviewedHeadSha: string;
  summary: string;
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low";
    file: string | null;
    line: number | null;
    title: string;
    details: string;
  }>;
  checks: Array<{
    name: string;
    command: string | null;
    outcome: "passed" | "failed" | "blocked";
    exitCode: number | null;
    summary: string;
  }>;
};

function output(verdict: Partial<ReviewOutput> = {}): string {
  return JSON.stringify({
    verdict: "pass",
    reviewedHeadSha: EXPECTED_SHA,
    summary: "No actionable findings",
    findings: [],
    checks: [],
    ...verdict,
  });
}

function finding(
  severity: "critical" | "high" | "medium" | "low",
  title: string,
  file: string,
  line: number,
) {
  return { severity, title, file, line, details: `${title} evidence` };
}

function makeHarness({
  reviewOutputs = [output()],
  headSha = EXPECTED_SHA,
  clean = true,
}: {
  reviewOutputs?: string[];
  headSha?: string;
  clean?: boolean;
} = {}) {
  const threads = {
    outputs: [...reviewOutputs],
    sent: [] as Array<{ threadId: string; prompt: string }>,
    created: [] as Array<{ parentThreadId: string; prompt: string }>,
    async output() {
      return threads.outputs.shift() ?? "";
    },
    async send(threadId: string, prompt: string) {
      threads.sent.push({ threadId, prompt });
    },
    async create(parentThreadId: string, prompt: string) {
      threads.created.push({ parentThreadId, prompt });
      return { id: `review-child-${threads.created.length}` };
    },
  };

  const environment = {
    async status() {
      return { available: true, clean, headSha };
    },
  };

  const attempts = {
    values: new Map<string, Record<string, unknown>>(),
    async get(attemptId: string) {
      return attempts.values.get(attemptId) ?? {};
    },
    async update(attemptId: string, patch: Record<string, unknown>) {
      attempts.values.set(attemptId, {
        ...attempts.values.get(attemptId),
        ...patch,
      });
    },
  };

  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const handler = new ReviewHandler({
    threads,
    environment,
    attempts,
    emit(event: { type: string; payload: Record<string, unknown> }) {
      events.push(event);
    },
  });

  return { handler, threads, environment, attempts, events };
}

async function idle(
  handler: ReviewHandler,
  overrides: Partial<{
    attemptId: string;
    reviewThreadId: string;
    implementationThreadId: string;
    expectedSha: string;
  }> = {},
) {
  return handler.handleThreadIdle({
    attemptId: "attempt-1",
    reviewThreadId: "review-thread-1",
    implementationThreadId: "implementation-thread-1",
    expectedSha: EXPECTED_SHA,
    ...overrides,
  });
}

describe("review remediation loop", () => {
  it("passes only an exact-head review with no findings and passed checks", async () => {
    const harness = makeHarness({
      reviewOutputs: [
        output({
          checks: [
            {
              name: "unit",
              command: "npm test",
              outcome: "passed",
              exitCode: 0,
              summary: "12 passed",
            },
          ],
        }),
      ],
    });

    const result = await idle(harness.handler);

    expect(result.outcome).toBe("pass");
    expect(harness.events.at(-1)?.type).toBe("REVIEW_PASSED");
  });

  it("requests changes with findings sorted by severity and location", async () => {
    const harness = makeHarness({
      reviewOutputs: [
        output({
          verdict: "changes_requested",
          summary: "Fix findings",
          findings: [
            finding("low", "later", "src/z.ts", 9),
            finding("critical", "first", "src/a.ts", 2),
            finding("high", "second", "src/b.ts", 1),
          ],
        }),
      ],
    });

    const result = await idle(harness.handler);

    expect(result.outcome).toBe("changes_requested");
    expect(result.findings?.map((item) => item.title)).toEqual([
      "first",
      "second",
      "later",
    ]);
    expect(harness.events.at(-1)?.type).toBe("REVIEW_CHANGES_REQUESTED");
  });

  it("blocks when a reported check is blocked", async () => {
    const harness = makeHarness({
      reviewOutputs: [
        output({
          verdict: "blocked",
          summary: "Runner unavailable",
          checks: [
            {
              name: "unit",
              command: "npm test",
              outcome: "blocked",
              exitCode: null,
              summary: "runner unavailable",
            },
          ],
        }),
      ],
    });

    const result = await idle(harness.handler);

    expect(result.outcome).toBe("blocked");
    expect(result.reasons[0]).toContain("check unit was blocked");
  });

  it.each([
    ["wrong SHA", { reviewOutputs: [output({ reviewedHeadSha: NEXT_SHA })] }],
    ["a reviewer worktree mutation", { clean: false }],
    ["an unavailable environment", {}],
  ])("blocks %s", async (name, options) => {
    const harness = makeHarness(options);
    if (name === "an unavailable environment") {
      harness.environment.status = async () => ({
        available: false,
        clean: false,
        headSha: EXPECTED_SHA,
      });
    }

    const result = await idle(harness.handler);

    expect(result.outcome).toBe("blocked");
  });

  it("sends one format correction to the same review thread and blocks a second invalid output", async () => {
    const harness = makeHarness({ reviewOutputs: ["not json", "still not json"] });

    const first = await idle(harness.handler);
    const second = await idle(harness.handler);

    expect(first.outcome).toBe("format_correction_sent");
    expect(harness.threads.sent).toHaveLength(1);
    expect(harness.threads.sent[0]?.threadId).toBe("review-thread-1");
    expect(second.outcome).toBe("blocked");
    expect(harness.events.at(-1)?.type).toBe("REVIEW_BLOCKED");
  });

  it("sends remediation to the original implementation thread", async () => {
    const harness = makeHarness({
      reviewOutputs: [
        output({
          verdict: "changes_requested",
          findings: [finding("high", "fix this", "src/a.ts", 1)],
        }),
      ],
    });

    await idle(harness.handler);

    expect(harness.threads.sent.at(-1)?.threadId).toBe(
      "implementation-thread-1",
    );
  });

  it("requires a new head before a later pass", async () => {
    const harness = makeHarness({
      reviewOutputs: [
        output({
          verdict: "changes_requested",
          findings: [finding("medium", "fix this", "src/a.ts", 1)],
        }),
        output({ reviewedHeadSha: NEXT_SHA }),
      ],
    });

    await idle(harness.handler);
    const oldHeadPass = await idle(harness.handler);
    harness.environment.status = async () => ({
      available: true,
      clean: true,
      headSha: NEXT_SHA,
    });
    const newHeadPass = await idle(harness.handler, { expectedSha: NEXT_SHA });

    expect(oldHeadPass.outcome).toBe("blocked");
    expect(newHeadPass.outcome).toBe("pass");
  });

  it("creates a fresh child thread for every review cycle", async () => {
    const harness = makeHarness();

    await harness.handler.startReviewCycle({
      implementationThreadId: "implementation-thread-1",
      expectedSha: EXPECTED_SHA,
    });
    await harness.handler.startReviewCycle({
      implementationThreadId: "implementation-thread-1",
      expectedSha: NEXT_SHA,
    });

    expect(harness.threads.created).toHaveLength(2);
    expect(harness.threads.created[0]?.parentThreadId).toBe(
      "implementation-thread-1",
    );
    expect(harness.threads.created[1]?.parentThreadId).toBe(
      "implementation-thread-1",
    );
    expect(harness.threads.created[0]).not.toEqual(harness.threads.created[1]);
  });
});
