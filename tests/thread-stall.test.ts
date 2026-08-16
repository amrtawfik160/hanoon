import { expect, it } from "vitest";
import {
  classifyThreadStall,
  NEVER_STARTED_GRACE_MS,
  NO_PROGRESS_STALL_MS,
  NO_PROGRESS_SUSPECT_MS,
  threadStallNotice,
  type DelegatedThreadObservation,
} from "../src/autonomy/thread-stall";

const NOW = 1_800_000_000_000;

function observed(overrides: Partial<DelegatedThreadObservation> = {}): DelegatedThreadObservation {
  return {
    status: "active",
    runtimeStatus: "active",
    startedAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    hasPendingInteraction: false,
    hostReconnectGraceExpiresAt: null,
    ...overrides,
  };
}

function classify(overrides: Partial<DelegatedThreadObservation> = {}) {
  return classifyThreadStall({ observation: observed(overrides), now: NOW });
}

it("leaves a working thread alone", () => {
  expect(classify()).toMatchObject({ level: "healthy", reason: "recent_activity" });
});

it("says nothing about a thread that has already finished", () => {
  // Settling is the join's business, not the detector's.
  for (const status of ["idle", "error"]) {
    expect(classify({ status, updatedAt: NOW - NO_PROGRESS_STALL_MS * 10 }))
      .toMatchObject({ level: "healthy", reason: "settled" });
  }
});

it("never calls a thread waiting on a person stalled", () => {
  // Someone's thinking time is not a stall, however long they take. A detector
  // that fires against it is a detector people learn to ignore.
  expect(classify({
    hasPendingInteraction: true,
    updatedAt: NOW - NO_PROGRESS_STALL_MS * 10,
  })).toMatchObject({ level: "healthy", reason: "waiting_on_owner" });
});

it("watches a thread that has gone quiet before saying anything", () => {
  expect(classify({ updatedAt: NOW - NO_PROGRESS_SUSPECT_MS }))
    .toMatchObject({ level: "suspect", reason: "no_progress" });
});

it("calls a thread stalled once it has been quiet long enough", () => {
  expect(classify({ updatedAt: NOW - NO_PROGRESS_STALL_MS }))
    .toMatchObject({ level: "stalled", reason: "no_progress" });
});

it("checks both quiet thresholds from below", () => {
  expect(classify({ updatedAt: NOW - NO_PROGRESS_SUSPECT_MS + 1 })).toMatchObject({ level: "healthy" });
  expect(classify({ updatedAt: NOW - NO_PROGRESS_STALL_MS + 1 })).toMatchObject({ level: "suspect" });
});

it("gives a thread time to start before calling it never started", () => {
  expect(classify({ status: "starting", startedAt: NOW - NEVER_STARTED_GRACE_MS }))
    .toMatchObject({ level: "healthy" });
  expect(classify({ status: "starting", startedAt: NOW - NEVER_STARTED_GRACE_MS - 1 }))
    .toMatchObject({ level: "stalled", reason: "never_started" });
});

it("judges never-started on the thread's whole life, not its last twitch", () => {
  // A thread stuck provisioning keeps touching itself without ever working, so
  // reading its last activity would call it healthy forever.
  expect(classify({
    runtimeStatus: "provisioning",
    startedAt: NOW - NEVER_STARTED_GRACE_MS * 2,
    updatedAt: NOW - 1_000,
  })).toMatchObject({ level: "stalled", reason: "never_started" });
});

it("waits out a host reconnect before blaming it", () => {
  expect(classify({
    runtimeStatus: "host-reconnecting",
    hostReconnectGraceExpiresAt: NOW + 60_000,
    updatedAt: NOW - NO_PROGRESS_STALL_MS * 2,
  })).toMatchObject({ level: "healthy", reason: "host_reconnecting" });
});

it("reports a host that never came back", () => {
  expect(classify({
    runtimeStatus: "host-reconnecting",
    hostReconnectGraceExpiresAt: NOW - 1,
  })).toMatchObject({ level: "stalled", reason: "host_unreachable" });
});

it("treats an absent grace window on a reconnecting host as expired", () => {
  expect(classify({ runtimeStatus: "waiting-for-host", hostReconnectGraceExpiresAt: null }))
    .toMatchObject({ level: "stalled", reason: "host_unreachable" });
});

it("says healthy rather than guessing when it cannot read the thread", () => {
  // An unreadable observation is not evidence of a problem.
  expect(classifyThreadStall({ observation: null, now: NOW }))
    .toMatchObject({ level: "healthy", reason: "unreadable" });
  expect(classify({ updatedAt: Number.NaN })).toMatchObject({ level: "healthy", reason: "unreadable" });
  expect(classifyThreadStall({ observation: observed(), now: Number.NaN }))
    .toMatchObject({ level: "healthy", reason: "unreadable" });
});

it("is pure: the same observation always gives the same verdict", () => {
  const input = { observation: observed({ updatedAt: NOW - NO_PROGRESS_STALL_MS }), now: NOW } as const;
  expect(classifyThreadStall(input)).toEqual(classifyThreadStall(input));
});

it("asks the agent to look before it decides anything", () => {
  const notice = threadStallNotice({
    threadId: "thr_9",
    title: "invoice retry",
    instruction: "fix the failing retry test",
    verdict: classify({ updatedAt: NOW - NO_PROGRESS_STALL_MS }),
    quietForMs: NO_PROGRESS_STALL_MS,
  });

  expect(notice).toContain("thr_9");
  expect(notice).toContain("invoice retry");
  expect(notice).toContain("fix the failing retry test");
  expect(notice).toContain("45 minutes");
  // Revive or escalate, chosen after reading — never a fixed remedy from out here.
  expect(notice).toContain("Read the thread before you decide");
  expect(notice).toContain("tell the owner");
});
