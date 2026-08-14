import { describe, expect, it } from "vitest";
import {
  detectFailureClusters,
  failureFingerprint,
  FAILURE_CLUSTER_THRESHOLD,
  type FailedJobObservation,
} from "../src/autonomy/failure-loop";

function failure(overrides: Partial<FailedJobObservation> & { jobId: string }): FailedJobObservation {
  return {
    projectId: "proj_alpha",
    reason: "npm install failed: ETIMEDOUT registry.npmjs.org",
    failedAt: 1_000,
    ...overrides,
  };
}

describe("failure fingerprints", () => {
  it("treats the same fault as the same cause despite differing ids and numbers", () => {
    const first = failureFingerprint("proj_alpha", "job 12 failed at 2026-01-01T10:00:00Z on abc1234def5678");
    const second = failureFingerprint("proj_alpha", "job 99 failed at 2026-02-14T22:31:05Z on 9f8e7d6c5b4a3");

    expect(first).toBe(second);
  });

  it("keeps genuinely different faults apart", () => {
    expect(failureFingerprint("proj_alpha", "the test suite failed"))
      .not.toBe(failureFingerprint("proj_alpha", "the deploy token expired"));
  });

  it("keeps the same fault on different projects apart", () => {
    expect(failureFingerprint("proj_alpha", "the test suite failed"))
      .not.toBe(failureFingerprint("proj_beta", "the test suite failed"));
  });

  it("gives a missing reason a stable fingerprint rather than throwing", () => {
    expect(failureFingerprint("proj_alpha", null)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("failure loop detection", () => {
  it("says nothing when failures are unrelated to each other", () => {
    const clusters = detectFailureClusters({
      failures: [
        failure({ jobId: "job_1", reason: "the test suite failed" }),
        failure({ jobId: "job_2", reason: "the deploy token expired" }),
        failure({ jobId: "job_3", reason: "the reviewer found a blocking problem" }),
      ],
    });

    expect(clusters).toEqual([]);
  });

  it("flags the same failure repeating across separate jobs", () => {
    const clusters = detectFailureClusters({
      failures: [
        failure({ jobId: "job_1" }),
        failure({ jobId: "job_2" }),
        failure({ jobId: "job_3" }),
      ],
    });

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ size: 3, projectId: "proj_alpha" });
    expect(clusters[0].jobIds).toEqual(["job_1", "job_2", "job_3"]);
  });

  it("stays quiet one failure below the threshold", () => {
    const failures = Array.from({ length: FAILURE_CLUSTER_THRESHOLD - 1 }, (_, index) =>
      failure({ jobId: `job_${index}` }));

    expect(detectFailureClusters({ failures })).toEqual([]);
  });

  it("counts one job once however many times it is listed", () => {
    const clusters = detectFailureClusters({
      failures: [failure({ jobId: "job_1" }), failure({ jobId: "job_1" }), failure({ jobId: "job_1" })],
    });

    expect(clusters).toEqual([]);
  });

  it("reports the largest cluster first", () => {
    const clusters = detectFailureClusters({
      failures: [
        ...Array.from({ length: 3 }, (_, index) => failure({ jobId: `small_${index}`, reason: "token expired" })),
        ...Array.from({ length: 5 }, (_, index) => failure({ jobId: `big_${index}`, reason: "suite failed" })),
      ],
    });

    expect(clusters.map((cluster) => cluster.size)).toEqual([5, 3]);
  });

  it("refuses a threshold that would fire on a single failure", () => {
    expect(() => detectFailureClusters({ failures: [], threshold: 1 })).toThrow();
  });
});
