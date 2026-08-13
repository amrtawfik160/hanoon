import { describe, expect, it } from "vitest";
import {
  encodeCallbackData,
  ephemeralTelegramPayload,
  parseCallbackData,
  persistableJobStatusPayload,
  renderJobStatus,
  renderJobStatusSummary,
  renderProjectPicker,
  type CallbackAction,
} from "../src/telegram/view";
import type { JobAdmission } from "../src/autonomy/models";
import { jobFixture, policyFixture } from "./helpers";

const telegramJobId = "abcdefghijklmnopqrstuv";
const mergeNonce = "N".repeat(32);

it("round-trips generic controller interaction callbacks within Telegram's limit", () => {
  const action: CallbackAction = { type: "controller_interaction", token: "T".repeat(32) };
  const encoded = encodeCallbackData(action);

  expect(encoded).toBe(`i:${"T".repeat(32)}`);
  expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(64);
  expect(parseCallbackData(encoded)).toEqual(action);
  expect(parseCallbackData(`q:${"T".repeat(32)}`)).toEqual({ type: "question", token: "T".repeat(32) });
  expect(() => encodeCallbackData({ type: "controller_interaction", token: "T".repeat(33) })).toThrow();
});

it("keeps the legacy q namespace parse-only", () => {
  const legacyQuestion = {
    type: "question",
    token: "T".repeat(32),
  } as unknown as CallbackAction;

  expect(() => encodeCallbackData(legacyQuestion)).toThrow();
});

function expectWellFormedTelegramHtml(text: string): void {
  const openTags: string[] = [];
  const tokenPattern = /<\/(b|code|a)>|<(b|code|a)(?:\s+href="[^"]*")?>|&(amp|lt|gt|quot|#39);/g;
  let cursor = 0;

  for (const match of text.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    expect(text.slice(cursor, index)).not.toMatch(/[<&]/);
    const token = match[0];
    if (token.startsWith("&")) {
      cursor = index + token.length;
      continue;
    }
    if (token.startsWith("</")) {
      expect(openTags.pop()).toBe(token.slice(2, -1));
    } else {
      openTags.push(token.slice(1).split(/[\s>]/, 1)[0]);
    }
    cursor = index + token.length;
  }

  expect(text.slice(cursor)).not.toMatch(/[<&]/);
  expect(openTags).toEqual([]);
}

describe("Telegram callback grammar", () => {
  it("encodes and parses the exact bounded callback forms", () => {
    const actions = [
      { type: "project", jobId: telegramJobId, alias: "cyndra" },
      { type: "start", jobId: telegramJobId },
      { type: "cancel", jobId: telegramJobId },
      { type: "retry", jobId: telegramJobId },
      { type: "review", jobId: telegramJobId },
      { type: "merge", nonce: mergeNonce },
    ] as const;

    expect(actions.map(encodeCallbackData)).toEqual([
      `p:${telegramJobId}:cyndra`,
      `s:${telegramJobId}`,
      `c:${telegramJobId}`,
      `r:${telegramJobId}`,
      `v:${telegramJobId}`,
      `m:${mergeNonce}`,
    ]);
    for (const action of actions) {
      const encoded = encodeCallbackData(action);
      expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(64);
      expect(parseCallbackData(encoded)).toEqual(action);
    }
  });

  it("rejects unanchored, oversized, and context-bearing callbacks", () => {
    expect(() => parseCallbackData(`s:${telegramJobId}:extra`)).toThrow();
    expect(() => parseCallbackData(`p:${telegramJobId}:BadAlias`)).toThrow();
    expect(() => parseCallbackData(`m:${mergeNonce}:job:${telegramJobId}`)).toThrow();
    expect(() => parseCallbackData(`s:${"a".repeat(21)}`)).toThrow();
    expect(() => parseCallbackData(`m:${"a".repeat(33)}`)).toThrow();
    expect(() => parseCallbackData("x:unknown")).toThrow();
  });

  it("keeps merge callbacks bound to only the approval nonce", () => {
    expect(encodeCallbackData({ type: "merge", nonce: mergeNonce })).toBe(`m:${mergeNonce}`);
    expect(encodeCallbackData({ type: "merge", nonce: mergeNonce })).not.toContain(telegramJobId);
  });

  it("keeps raw approval callbacks ephemeral and persists only hash metadata", () => {
    const nonce = mergeNonce;
    const rendered = renderJobStatus(jobFixture({
      id: telegramJobId,
      state: "awaiting_merge_approval",
      prHeadSha: "a".repeat(40),
    }), {
      mergeNonce: nonce,
      approvalExpiresAt: 1_770_000_000_000,
    });
    const raw = `m:${nonce}`;
    const ephemeral = ephemeralTelegramPayload(rendered);
    const persisted = JSON.stringify(persistableJobStatusPayload(rendered));

    expect(JSON.stringify(ephemeral)).toContain(raw);
    expect(persisted).not.toContain(raw);
    expect(persisted).toContain("approval_metadata");
    expect(persisted).toContain("nonceHash");
  });
});

describe("deterministic Telegram views", () => {
  it("renders bounded plural status groups with an exact remaining count", () => {
    const jobs = Array.from({ length: 10 }, (_, index) => ({
      job: jobFixture({
        id: `summary_job_${String(index).padStart(2, "0")}`,
        state: index === 0 ? "implementing" : index === 1 ? "awaiting_merge_approval" : index === 2 ? "failed" : "awaiting_confirmation",
        projectId: "proj_1",
        policy: policyFixture(),
        requestText: `summary ${index}`,
      }),
      admission: index === 3 || index === 4 ? {
        jobId: `summary_job_${String(index).padStart(2, "0")}`,
        projectId: "proj_1",
        queueSeq: index,
        state: index === 3 ? "queued" as const : "draining" as const,
        resumeEvent: "CONFIRMED" as const,
        queuedAt: 1_000,
        admittedAt: null,
        drainingAt: index === 4 ? 1_100 : null,
        releasedAt: null,
        releaseReason: null,
      } : null,
    }));

    const rendered = renderJobStatusSummary({ jobs, total: jobs.length });
    expect(rendered.text).toContain("Running");
    expect(rendered.text).toContain("Approval waiting");
    expect(rendered.text).toContain("Queued");
    expect(rendered.text).toContain("Draining");
    expect(rendered.text).toContain("Failed");
    expect(rendered.text).toContain("2 more jobs");
    expect(rendered.text.length).toBeLessThanOrEqual(4_096);
  });

  it("renders an escaped bounded project picker", () => {
    const job = jobFixture({ id: telegramJobId, requestText: "<fix & verify>" });
    const rendered = renderProjectPicker(job, [
      policyFixture({ alias: "cyndra" }),
      policyFixture({ projectId: "proj_2", alias: "other-project" }),
    ]);

    expect(rendered.parse_mode).toBe("HTML");
    expect(rendered.text).toContain("&lt;fix &amp; verify&gt;");
    expect(rendered.text).not.toContain("<fix & verify>");
    expect(rendered.reply_markup?.inline_keyboard.flat().map((button) => button.callback_data)).toEqual([
      `p:${telegramJobId}:cyndra`,
      `p:${telegramJobId}:other-project`,
      `c:${telegramJobId}`,
    ]);
  });

  it("renders a complete Ready card from exact supplied data without inventing thread links", () => {
    const policy = policyFixture({ alias: "cyndra" });
    const job = jobFixture({
      id: telegramJobId,
      state: "awaiting_merge_approval",
      projectId: policy.projectId,
      policyVersion: 4,
      policy,
      environmentId: "env_1",
      implementationThreadId: "thr_implementation",
      reviewThreadId: "thr_review",
      prNumber: 17,
      prUrl: "https://github.com/acme/cyndra/pull/17",
      prHeadSha: "a".repeat(40),
      requestText: "Review <this> & keep \"quotes\" escaped",
    });
    const evidence = "<provider evidence> & details".repeat(5_000);
    const rendered = renderJobStatus(job, {
      bbAppBaseUrl: "https://bb.example/app",
      prTitle: "Fix <redirect> & safety",
      changedFiles: 4,
      additions: 12,
      deletions: 3,
      review: { verdict: "pass", findings: [], summary: "No <actionable> findings" },
      validation: [
        { name: "unit", command: "npm test", outcome: "passed", summary: "42 passed" },
      ],
      checks: [{ name: "test", outcome: "passed", summary: "green" }],
      evidence,
      approvalExpiresAt: 1_770_000_000_000,
      mergeNonce,
    });

    expect(rendered.text).toContain("Ready");
    expect(rendered.text).toContain("cyndra");
    expect(rendered.text).toContain("main");
    expect(rendered.text).toContain("#17");
    expect(rendered.text).toContain("Fix &lt;redirect&gt; &amp; safety");
    expect(rendered.text).toContain("4 files, +12 / -3");
    expect(rendered.text).toContain("aaaaaaaaaaaaaaaa");
    expect(rendered.text).toContain("thr_implementation");
    expect(rendered.text).toContain("thr_review");
    expect(rendered.text).toContain("https://bb.example/app");
    expect(rendered.text).toContain("No &lt;actionable&gt; findings");
    expect(rendered.text).toContain("42 passed");
    expect(rendered.text).toContain("green");
    expect(rendered.text).not.toContain("<provider evidence>");
    expect(rendered.text.length).toBeLessThanOrEqual(4096);
    expect(rendered.reply_markup?.inline_keyboard.flat().map((button) => button.text)).toEqual([
      "View PR",
      "Open BB",
      "Re-run Review",
      "Merge + deploy aaaaaaaa",
      "Cancel",
    ]);
    const buttons = rendered.reply_markup?.inline_keyboard.flat() ?? [];
    expect(buttons.find((button) => button.text === "View PR")?.url).toBe(job.prUrl);
    expect(buttons.find((button) => button.text === "Open BB")?.url).toBe("https://bb.example/app");
    expect(buttons.find((button) => button.text === "Merge + deploy aaaaaaaa")?.callback_data).toBe(`m:${mergeNonce}`);
    expect(rendered.text).not.toContain("/threads/");
    expect(rendered.text).not.toContain("/environments/");
  });

  it("offers only the state-appropriate bounded controls", () => {
    const failed = jobFixture({ id: telegramJobId, state: "failed", lastError: "temporary failure" });
    const rendered = renderJobStatus(failed);
    const callbacks = rendered.reply_markup?.inline_keyboard.flat().map((button) => button.callback_data);

    expect(callbacks).toContain(`r:${telegramJobId}`);
    expect(callbacks).toContain(`c:${telegramJobId}`);
    expect(rendered.text).toContain("temporary failure");
  });

  it("distinguishes a queued confirmation from an old selected row without admission", () => {
    const job = jobFixture({ id: telegramJobId, state: "awaiting_confirmation" });
    const queuedAdmission: JobAdmission = {
      jobId: job.id,
      projectId: "proj_1",
      queueSeq: 4,
      state: "queued",
      resumeEvent: "CONFIRMED",
      queuedAt: 2_000,
      admittedAt: null,
      drainingAt: null,
      releasedAt: null,
      releaseReason: null,
    };

    // Already confirmed: it has no Start button because there is nothing to
    // approve, so the card must not read as though the owner is holding it up.
    const queued = renderJobStatus({ job, admission: queuedAdmission });
    const queuedButtons = queued.reply_markup?.inline_keyboard.flat().map((button) => button.text);
    expect(queued.text).toContain("<b>Job queued</b>");
    expect(queued.text).toContain("starts on its own, nothing to approve");
    expect(queued.text).not.toContain("awaiting_confirmation");
    expect(queued.text).not.toContain("Waiting for you to start it");
    expect(queuedButtons).not.toContain("Start");

    // Genuinely unconfirmed: it does need the owner, and says so with a button.
    const unqueued = renderJobStatus(job);
    const unqueuedButtons = unqueued.reply_markup?.inline_keyboard.flat().map((button) => button.text);
    expect(unqueued.text).toContain("Waiting for you to start it");
    expect(unqueued.text).not.toContain("nothing to approve");
    expect(unqueuedButtons).toContain("Start");
  });

  it("never shows a card that demands a tap it does not offer", () => {
    const job = jobFixture({ id: telegramJobId, state: "awaiting_confirmation" });
    const admission: JobAdmission = {
      jobId: job.id,
      projectId: "proj_1",
      queueSeq: 4,
      state: "queued",
      resumeEvent: "CONFIRMED",
      queuedAt: 2_000,
      admittedAt: null,
      drainingAt: null,
      releasedAt: null,
      releaseReason: null,
    };

    for (const rendered of [renderJobStatus(job), renderJobStatus({ job, admission })]) {
      const offersStart = (rendered.reply_markup?.inline_keyboard.flat() ?? [])
        .some((button) => button.text === "Start");
      const demandsStart = rendered.text.includes("Waiting for you to start it");
      expect(demandsStart).toBe(offersStart);
    }
  });

  it("shows one worker resource, liveness state, and source observation age", () => {
    const job = jobFixture({
      id: telegramJobId,
      state: "failed",
      lastError: "temporary failure",
      implementationThreadId: "thr_worker",
    });
    const staleWorker = {
        jobId: telegramJobId,
        workerKind: "implementation",
        resourceKind: "bb_thread",
        resourceId: "thr_worker",
        generation: 2,
        state: "stale",
        sourceUpdatedAt: 1_000,
        observedAt: 61_000,
        staleNotifiedAt: 61_000,
      } as const;
    const fresh = renderJobStatus(job, {
      workerLiveness: { ...staleWorker, state: "active", sourceUpdatedAt: 61_000 },
      now: 61_000,
    });
    const rendered = renderJobStatus(job, {
      workerLiveness: staleWorker,
      now: 61_000,
    });

    expect(rendered.text).toContain("Worker: thr_worker");
    expect(rendered.text).toContain("stale");
    expect(rendered.text).toContain("60s ago");
    expect(rendered.text).toContain("fresh BB observation");
    expect(fresh.reply_markup?.inline_keyboard.flat().map((button) => button.callback_data)).toContain(`r:${telegramJobId}`);
    expect(rendered.reply_markup?.inline_keyboard.flat().map((button) => button.text)).not.toContain("Retry");
  });

  it.each(["unknown", "stale"] as const)("does not expose a speculative diagnosis for %s liveness", (state) => {
    const rendered = renderJobStatus(jobFixture({
      id: telegramJobId,
      state: "failed",
      lastError: "temporary failure",
      implementationThreadId: "thr_worker",
    }), {
      workerLiveness: {
        jobId: telegramJobId,
        workerKind: "implementation",
        resourceKind: "bb_thread",
        resourceId: "thr_worker",
        generation: 2,
        state,
        sourceUpdatedAt: 1_000,
        observedAt: 2_000,
        staleNotifiedAt: null,
      },
    });

    expect(rendered.text).toContain(state === "unknown" ? "authoritative BB observation" : "fresh BB observation");
    expect(rendered.reply_markup?.inline_keyboard.flat().map((button) => button.text)).not.toContain("Retry");
    expect(rendered.text).not.toMatch(/crash|dead|stuck|provider|network/i);
  });

  it("does not turn credential-bearing URLs into Telegram links", () => {
    const policy = policyFixture();
    const job = jobFixture({
      id: telegramJobId,
      state: "awaiting_merge_approval",
      projectId: policy.projectId,
      policy,
      prNumber: 17,
      prUrl: "https://user:password@example.test/pull/17?token=secret",
    });
    const rendered = renderJobStatus(job, { bbAppBaseUrl: "https://bb.example/app?token=secret" });
    const buttons = rendered.reply_markup?.inline_keyboard.flat() ?? [];

    expect(buttons.some((button) => button.text === "View PR")).toBe(false);
    expect(buttons.some((button) => button.text === "Open BB")).toBe(false);
    expect(rendered.text).not.toContain("password@example.test");
    expect(rendered.text).not.toContain("token=secret");
  });

  it.each([
    `https://example.test/xm:m:${mergeNonce}suffix`,
    `https://example.test/redirect?next=m%3A${mergeNonce}`,
    `https://example.test/redirect?next=%6D%3A${mergeNonce}`,
    `https://example.test/%ZZ/%6D%3A${mergeNonce}`,
    "https://example.test/pull/17?%74oken=secret",
    "https://example.test/pull/17?%2574oken=secret",
    "https://example.test/pull/17?next=%73ecret",
    "https://example.test/pull/17?next=%2573ecret",
  ])("does not render unsafe external URL %s as a link", (url) => {
    const policy = policyFixture();
    const rendered = renderJobStatus(jobFixture({
      id: telegramJobId,
      state: "awaiting_merge_approval",
      projectId: policy.projectId,
      policy,
      prNumber: 17,
      prUrl: url,
    }));
    const buttons = rendered.reply_markup?.inline_keyboard.flat() ?? [];

    expect(buttons.find((button) => button.text === "View PR")).toBeUndefined();
    expect(rendered.text).not.toContain(url);
  });

  it.each([
    ["access_token", "access_token=secret"],
    ["access-token", "access-token=secret"],
    ["accessToken", "accessToken=secret"],
    ["client_secret", "client_secret=secret"],
    ["clientSecret", "clientSecret=secret"],
    ["refresh_token", "refresh_token=secret"],
  ] as const)("redacts %s assignments from every Ready-card text and link path", (_label, assignment) => {
    const policy = policyFixture({ baseBranch: assignment });
    const job = jobFixture({
      id: telegramJobId,
      state: "awaiting_merge_approval",
      projectId: policy.projectId,
      policyVersion: 1,
      policy,
      prNumber: 17,
      prUrl: `https://example.test/pull/17?${assignment}`,
      requestText: assignment,
      implementationThreadId: assignment,
      reviewThreadId: assignment,
      lastError: assignment,
    });
    const rendered = renderJobStatus(job, {
      bbAppBaseUrl: `https://bb.example/app?${assignment}`,
      prTitle: assignment,
      review: { verdict: assignment, summary: assignment },
      validation: [{ name: assignment, outcome: assignment, summary: assignment }],
      checks: [{ name: assignment, outcome: assignment, bucket: assignment, summary: assignment }],
      evidence: assignment,
      approvalExpiresAt: assignment,
      mergeNonce,
    });
    const buttons = rendered.reply_markup?.inline_keyboard.flat() ?? [];

    expect(rendered.text).not.toContain(assignment);
    expect(rendered.text).not.toContain("secret");
    expect(buttons.find((button) => button.text === "View PR")).toBeUndefined();
    expect(buttons.find((button) => button.text === "Open BB")).toBeUndefined();
  });

  it("bounds an oversized Ready card without splitting HTML tags or entities", () => {
    const longBaseUrl = `https://bb.example/app?scope=${"x".repeat(5_000)}&format=html`;
    const rendered = renderJobStatus(jobFixture({
      id: telegramJobId,
      state: "awaiting_merge_approval",
      projectId: "proj_1",
      policyVersion: 1,
      policy: policyFixture(),
      requestText: "&".repeat(200),
    }), {
      bbAppBaseUrl: longBaseUrl,
      evidence: "<provider evidence> & details".repeat(2_000),
    });

    expect(rendered.text.length).toBeLessThanOrEqual(4_096);
    expectWellFormedTelegramHtml(rendered.text);
  });
});
