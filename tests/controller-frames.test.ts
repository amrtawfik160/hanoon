import { expect, it } from "vitest";
import { frameTimestamps, motionContextPrefix } from "../src/controller/frames";

it("samples more frames from longer clips and stays inside the duration", () => {
  expect(frameTimestamps(0)).toEqual([0]);
  expect(frameTimestamps(1)).toEqual([0]);
  expect(frameTimestamps(4)).toHaveLength(3);
  expect(frameTimestamps(20)).toHaveLength(6);
  expect(Math.max(...frameTimestamps(20))).toBeLessThan(20);
});

it("tells the model whether it is looking at sampled frames or only a preview", () => {
  expect(motionContextPrefix("video", 4, "sampled")).toContain("sampled in order");
  expect(motionContextPrefix("animation", 1, "preview")).toContain("preview still");
  expect(motionContextPrefix("animation", 1, "original")).toBe("The owner sent a GIF.");
});
