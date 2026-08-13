import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { renderJobFinishNote } from "../src/telegram/finish-note";
import { openStore } from "../src/storage/store";
import { jobFixture, policyFixture } from "./helpers";

describe("job finish notes", () => {
  it("renders a reviewed-PR finish as two concrete sentences", () => {
    expect(renderJobFinishNote(jobFixture({
      state: "complete",
      requestText: "Fix checkout retry handling",
      prNumber: 17,
      prUrl: "https://github.com/acme/cyndra/pull/17",
      policy: policyFixture({ production: undefined }),
    }))).toBe(
      "Finished “Fix checkout retry handling”; validation and review passed. " +
      "PR #17 is ready for your decision: https://github.com/acme/cyndra/pull/17",
    );
  });

  it("distinguishes work verified in production", () => {
    expect(renderJobFinishNote(jobFixture({
      state: "complete",
      requestText: "Ship the safer checkout",
      prNumber: 18,
      prUrl: "https://github.com/acme/cyndra/pull/18",
      policy: policyFixture(),
      mergeCommitSha: "b".repeat(40),
      canarySummary: "production is healthy",
    }))).toBe(
      "Shipped “Ship the safer checkout” and verified it in production. " +
      "PR #18 has the final change: https://github.com/acme/cyndra/pull/18",
    );
  });

  it("enqueues one separate finish message when a job first completes", () => {
    const { bb } = createFakePluginHost({ pluginId: "telegram-finish-note" });
    const store = openStore(bb.storage);
    store.createPairingCode("a".repeat(64), 1_000, 3_000);
    expect(store.pairOwnerWithCode("a".repeat(64), "7", "7", 1_001)).toEqual({ ok: true });
    const job = store.createJob({ id: "finish_note_job_1234567", sourceUpdateId: 1, requestText: "Fix retry", now: 1_000 });
    const policy = policyFixture({ production: undefined });
    bb.storage.database().prepare(
      `UPDATE jobs SET state = 'reviewing', project_id = ?, policy_version = 1, policy_json = ?,
         delivery_mode = 'small_fix', pr_number = 17,
         pr_url = 'https://github.com/acme/cyndra/pull/17', pr_head_sha = ?, version = 2
       WHERE id = ?`,
    ).run(policy.projectId, JSON.stringify(policy), "a".repeat(40), job.id);

    expect(store.applyJobEvent(
      job.id,
      2,
      { type: "REVIEW_PASSED", headSha: "a".repeat(40) },
      2_000,
    )).toMatchObject({ state: "complete" });
    expect(store.getOutbox(`job:${job.id}:finish`)).toMatchObject({
      status: "pending",
      messageId: null,
      chatId: "7",
      payload: {
        text: "Finished “Fix retry”; validation and review passed. PR #17 is ready for your decision: https://github.com/acme/cyndra/pull/17",
        disable_web_page_preview: true,
      },
    });
    expect(store.getOutbox(`job:${job.id}:status`)).toBeNull();
  });
});
