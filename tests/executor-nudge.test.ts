import { expect, it, vi } from "vitest";
import { ExecutorNudge } from "../src/services/executor-nudge";

it("wakes one pending executor wait and consumes the nudge", async () => {
  vi.useFakeTimers();
  const nudge = new ExecutorNudge();
  const pending = nudge.wait(60_000, AbortSignal.timeout(1_000));

  nudge.notify();

  await expect(pending).resolves.toBeUndefined();
  const second = nudge.wait(50, AbortSignal.timeout(1_000));
  await vi.advanceTimersByTimeAsync(49);
  let resolved = false;
  void second.then(() => { resolved = true; });
  await Promise.resolve();
  expect(resolved).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(second).resolves.toBeUndefined();
  vi.useRealTimers();
});

it("cleans up an aborted wait without consuming a later nudge", async () => {
  const nudge = new ExecutorNudge();
  const abort = new AbortController();
  const pending = nudge.wait(60_000, abort.signal);
  abort.abort(new Error("stop"));
  await expect(pending).rejects.toThrow("stop");

  nudge.notify();
  await expect(nudge.wait(60_000, AbortSignal.timeout(1_000))).resolves.toBeUndefined();
});
