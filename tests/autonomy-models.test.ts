import { describe, expect, it } from "vitest";
import {
  admissionAllowsEffect,
  isReleaseCandidate,
  isSafeControlEffect,
  productionResourceKey,
  projectResourceKey,
  repositoryMergeResourceKey,
  type AdmissionState,
  type JobAdmission,
} from "../src/autonomy/models";
import {
  projectPolicySchema,
  type JobEffect,
  type JobState,
} from "../src/domain/models";
import { activeWorkerFixture, policyFixture, productionPolicyFixture } from "./helpers";

function admissionFor(state: AdmissionState): JobAdmission {
  return {
    jobId: "job_1",
    projectId: "proj_1",
    queueSeq: 1,
    state,
    resumeEvent: "CONFIRMED",
    queuedAt: 1_000,
    admittedAt: state === "queued" ? null : 1_100,
    drainingAt: state === "draining" ? 2_000 : null,
    releasedAt: state === "released" ? 3_000 : null,
    releaseReason: state === "released" ? "complete" : null,
  };
}

function effectOf(kind: JobEffect["kind"], payload: Record<string, unknown> = {}): JobEffect {
  return {
    idempotencyKey: `job_1:${kind}`,
    jobId: "job_1",
    kind,
    payload,
  };
}

describe("autonomy resource keys", () => {
  it("uses stable project and case-folded repository keys", () => {
    expect(projectResourceKey("proj_1")).toBe("project:proj_1:pipeline");
    expect(repositoryMergeResourceKey("Cyndra-AI/Cyndra-SaaS")).toBe(
      "repository:cyndra-ai/cyndra-saas:merge",
    );
  });

  it("uses an explicit shared production target when configured", () => {
    const policy = policyFixture({
      production: productionPolicyFixture({ targetKey: "shared.prod" }),
    });

    expect(productionResourceKey(policy)).toBe("production:shared.prod");
  });

  it("falls back to the immutable project id for production isolation", () => {
    expect(productionResourceKey(policyFixture())).toBe("production:proj_1");
  });

  it("accepts the one- and 64-character target key boundaries", () => {
    for (const targetKey of ["a", "a".repeat(64)]) {
      const parsed = projectPolicySchema.safeParse(
        policyFixture({ production: { ...productionPolicyFixture(), targetKey } }),
      );

      expect(parsed.success).toBe(true);
    }
  });

  it.each([
    "Shared.prod",
    "../prod",
    "-prod",
    ".prod",
    "prod/key",
    "a".repeat(65),
  ])("rejects unsafe production target key %s", (targetKey) => {
    const parsed = projectPolicySchema.safeParse(
      policyFixture({ production: { ...productionPolicyFixture(), targetKey } }),
    );

    expect(parsed.success).toBe(false);
  });
});

describe("autonomy admission predicates", () => {
  it.each([
    "complete",
    "blocked",
    "cancelled",
    "merged",
    "production_failed",
  ] as JobState[]) ("recognizes %s as a release candidate", (state) => {
    expect(isReleaseCandidate(state)).toBe(true);
  });

  it("keeps failed work admitted for retry", () => {
    expect(isReleaseCandidate("failed")).toBe(false);
  });

  it.each([
    "awaiting_project",
    "planning",
    "implementing",
    "deploying",
    "verifying_production",
  ] as JobState[]) ("does not release an active %s job", (state) => {
    expect(isReleaseCandidate(state)).toBe(false);
  });

  it("identifies only the two safe control effects", () => {
    expect(isSafeControlEffect("render_status")).toBe(true);
    expect(isSafeControlEffect("revoke_approvals")).toBe(true);
    expect(isSafeControlEffect("spawn_plan")).toBe(false);
    expect(isSafeControlEffect("stop_thread")).toBe(false);
  });

  it("allows only safe controls while queued", () => {
    const admission = admissionFor("queued");

    expect(admissionAllowsEffect(admission, effectOf("render_status"), null)).toBe(true);
    expect(admissionAllowsEffect(admission, effectOf("revoke_approvals"), null)).toBe(true);
    expect(admissionAllowsEffect(admission, effectOf("spawn_plan"), null)).toBe(false);
    expect(admissionAllowsEffect(admission, effectOf("stop_thread"), activeWorkerFixture())).toBe(false);
  });

  it("allows every existing effect kind while admitted", () => {
    const effectKinds: JobEffect["kind"][] = [
      "render_status",
      "spawn_plan",
      "spawn_critique",
      "spawn_implementation",
      "inspect_implementation",
      "resolve_pr_head",
      "spawn_review",
      "send_remediation",
      "run_validation",
      "spawn_docs",
      "run_final_validation",
      "spawn_final_review",
      "spawn_consensus_review",
      "issue_approval",
      "revoke_approvals",
      "merge_pr",
      "deploy_production",
      "verify_production",
      "stop_thread",
      "steer_implementation",
      "reconcile_job",
    ];

    for (const kind of effectKinds) {
      expect(admissionAllowsEffect(admissionFor("admitted"), effectOf(kind), null)).toBe(true);
    }
  });

  it("rejects an effect owned by another job", () => {
    const foreignJobEffect = {
      ...effectOf("render_status"),
      jobId: "job_other",
    };

    expect(admissionAllowsEffect(admissionFor("admitted"), foreignJobEffect, null)).toBe(false);
  });

  it("allows draining controls and an exact durable worker stop only", () => {
    const worker = activeWorkerFixture({
      resourceKind: "bb_thread",
      resourceId: "thr_active",
      generation: 2,
    });
    const admission = admissionFor("draining");
    const stop = effectOf("stop_thread", {
      generation: worker.generation,
      resourceId: worker.resourceId,
      resourceKind: worker.resourceKind,
      workerKind: worker.workerKind,
    });

    expect(admissionAllowsEffect(admission, effectOf("render_status"), null)).toBe(true);
    expect(admissionAllowsEffect(admission, effectOf("revoke_approvals"), null)).toBe(true);
    expect(admissionAllowsEffect(admission, stop, worker)).toBe(true);
    expect(admissionAllowsEffect(admission, stop, null)).toBe(false);
    expect(admissionAllowsEffect(
      admission,
      effectOf("stop_thread", { ...stop.payload, generation: worker.generation + 1 }),
      worker,
    )).toBe(false);
    expect(admissionAllowsEffect(
      admission,
      effectOf("stop_thread", { ...stop.payload, resourceId: "thr_other" }),
      worker,
    )).toBe(false);
    expect(admissionAllowsEffect(
      admission,
      stop,
      { ...worker, jobId: "job_other" },
    )).toBe(false);
    expect(admissionAllowsEffect(admission, effectOf("spawn_plan"), worker)).toBe(false);
  });

  it("does not allow effects after release", () => {
    expect(admissionAllowsEffect(admissionFor("released"), effectOf("render_status"), null)).toBe(false);
    expect(admissionAllowsEffect(admissionFor("released"), effectOf("revoke_approvals"), null)).toBe(false);
    expect(admissionAllowsEffect(admissionFor("released"), effectOf("stop_thread"), activeWorkerFixture())).toBe(false);
  });
});
