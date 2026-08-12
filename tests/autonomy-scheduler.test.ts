import { describe, expect, it } from "vitest";
import { projectResourceKey } from "../src/autonomy/models";
import { selectOldestEligibleAdmissions } from "../src/autonomy/scheduler";

const candidate = (jobId: string, projectId: string, queueSeq: number) => ({
  jobId,
  projectId,
  queueSeq,
});

describe("oldest eligible admission selection", () => {
  it("skips held projects without blocking another project's head", () => {
    expect(selectOldestEligibleAdmissions({
      candidates: [
        candidate("job_a", "proj_busy", 1),
        candidate("job_b", "proj_free", 2),
        candidate("job_c", "proj_other", 3),
      ],
      heldProjectKeys: new Set([projectResourceKey("proj_busy")]),
      availableSlots: 1,
    })).toEqual([
      candidate("job_b", "proj_free", 2),
    ]);
  });

  it("orders by queue sequence and then job id without mutating input", () => {
    const candidates = [
      candidate("job_z", "proj_z", 2),
      candidate("job_b", "proj_b", 1),
      candidate("job_a", "proj_a", 1),
    ];

    expect(selectOldestEligibleAdmissions({
      candidates,
      heldProjectKeys: new Set(),
      availableSlots: 3,
    })).toEqual([
      candidate("job_a", "proj_a", 1),
      candidate("job_b", "proj_b", 1),
      candidate("job_z", "proj_z", 2),
    ]);
    expect(candidates).toEqual([
      candidate("job_z", "proj_z", 2),
      candidate("job_b", "proj_b", 1),
      candidate("job_a", "proj_a", 1),
    ]);
  });

  it("keeps only the first candidate for a project after deterministic ordering", () => {
    expect(selectOldestEligibleAdmissions({
      candidates: [
        candidate("job_later", "proj_duplicate", 4),
        candidate("job_earlier", "proj_duplicate", 2),
        candidate("job_other", "proj_other", 3),
      ],
      heldProjectKeys: new Set(),
      availableSlots: 8,
    })).toEqual([
      candidate("job_earlier", "proj_duplicate", 2),
      candidate("job_other", "proj_other", 3),
    ]);
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])(
    "returns no more than %s available slots",
    (availableSlots) => {
      const candidates = Array.from({ length: 8 }, (_, index) =>
        candidate(`job_${index + 1}`, `proj_${index + 1}`, index + 1));

      expect(selectOldestEligibleAdmissions({
        candidates,
        heldProjectKeys: new Set(),
        availableSlots,
      })).toHaveLength(availableSlots);
    },
  );

  it.each([-1, 9, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects availableSlots=%s",
    (availableSlots) => {
      expect(() => selectOldestEligibleAdmissions({
        candidates: [],
        heldProjectKeys: new Set(),
        availableSlots,
      })).toThrow("availableSlots must be an integer from 0 through 8");
    },
  );
});
