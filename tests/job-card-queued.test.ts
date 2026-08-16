import { expect, it } from "vitest";
import { renderJobStatus } from "../src/telegram/view";

const job = {
  id: "0xkpZ5Kk5gwW-ZNsedMV3Q", state: "awaiting_confirmation", requestText: "Review and finish the existing pull request",
  projectId: "proj_1", prNumber: 895, prUrl: null, prHeadSha: null, cancelRequestedAt: null,
  policy: null, reviewCycle: 0, blockedReason: null, resumeState: null, version: 3,
  implementationThreadId: null, deliveryMode: "full",
} as never;

it("does not ask the owner to start a job that is already queued to start itself", () => {
  const queued = renderJobStatus(job, {
    admission: { jobId: "0xkpZ5Kk5gwW-ZNsedMV3Q", state: "queued" },
    now: 1_000,
  } as never);
  expect(JSON.stringify(queued)).toContain("starts on its own");
  expect(JSON.stringify(queued)).not.toContain('"Start"');
});

it("still offers Start when nothing has queued the job", () => {
  const unqueued = renderJobStatus(job, { now: 1_000 } as never);
  expect(JSON.stringify(unqueued)).toContain('"Start"');
  expect(JSON.stringify(unqueued)).toContain("Waiting for you to start it");
});
