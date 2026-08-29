import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import type { AuditResult } from "../src/autonomy/audit-contract";
import { INTAKE_SUPPRESSION_MS } from "../src/autonomy/audit-intake";
import { analyseBugBacklog } from "../src/autonomy/audits/bug-backlog";
import { analyseDocsStaleness } from "../src/autonomy/audits/docs-staleness";
import { hashSecret } from "../src/crypto";
import { AuditIntakeService } from "../src/services/audit-intake-service";
import { openStore, type TelegramAgentStore } from "../src/storage/store";
import { policyFixture } from "./helpers";

let fixtureNumber = 0;
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60_000;
const PROJECT = "proj_alpha";

function storeWithProject(intake?: { maxJobsPerDay: number }): {
  store: TelegramAgentStore;
  database: ReturnType<ReturnType<typeof createFakePluginHost>["bb"]["storage"]["database"]>;
} {
  const { bb } = createFakePluginHost({ pluginId: `telegram-audit-intake-${fixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => NOW);
  store.createPairingCode(hashSecret("pair"), NOW - 10_000, NOW + 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", NOW - 5_000)).toEqual({ ok: true });
  // A paired owner with a controller thread, which is what a notice needs.
  store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 1,
    inputText: "hello",
    now: NOW - 1_000,
  });
  store.upsertProjectPolicy(policyFixture({
    projectId: PROJECT,
    alias: "alpha",
    enabled: true,
    ...(intake === undefined ? {} : { autonomy: { unattendedMerge: false, mergeWithoutProduction: false, intake } }),
  }), NOW);
  return { store, database: bb.storage.database() };
}

/** A finished job no longer occupies its project, exactly as the executor leaves it. */
function finishJob(
  database: ReturnType<typeof storeWithProject>["database"],
  jobId: string,
  state: string,
  updatedAt: number,
): void {
  database.prepare("UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?").run(state, updatedAt, jobId);
  database.prepare(
    "UPDATE job_admissions SET state = 'released', released_at = ?, release_reason = 'test' WHERE job_id = ?",
  ).run(updatedAt, jobId);
}

function docsResults(reference: string): readonly AuditResult[] {
  return [{
    auditId: "docs-staleness",
    status: "findings",
    findings: analyseDocsStaleness({
      docs: [{ path: "docs/guide.md", text: `See \`${reference}\` for details.` }],
      trackedPaths: new Set(["docs/guide.md", "src/here.ts"]),
    }),
  }];
}

function bugResults(number: number): readonly AuditResult[] {
  return [{
    auditId: "bug-backlog",
    status: "findings",
    findings: analyseBugBacklog({
      issues: [{ number, title: `stale bug ${number}`, createdAt: NOW - 200 * DAY, updatedAt: NOW - 100 * DAY }],
      now: NOW,
    }),
  }];
}

function service(store: TelegramAgentStore) {
  const enqueueControllerTurn = vi.spyOn(store, "enqueueControllerTurn");
  let updateId = 9_000_000_000;
  const intake = new AuditIntakeService({
    store,
    clock: { now: () => NOW },
    issueUpdateId: () => (updateId += 1),
    warn: () => {},
  });
  return { intake, enqueueControllerTurn };
}

const AUDITED = { projectId: PROJECT, label: "alpha" };

it("starts nothing for a project whose policy never asked for it", () => {
  const { store } = storeWithProject();
  const { intake, enqueueControllerTurn } = service(store);

  expect(intake.consider(AUDITED, docsResults("src/gone.ts"), NOW)).toEqual([]);
  expect(enqueueControllerTurn).not.toHaveBeenCalled();
});

it("starts one ordinary pipeline job from a finding, and says who started it", () => {
  const { store } = storeWithProject({ maxJobsPerDay: 2 });
  const { intake, enqueueControllerTurn } = service(store);

  const [started] = intake.consider(AUDITED, docsResults("src/gone.ts"), NOW);
  expect(started).toBeDefined();

  const job = store.getJob(started!.jobId);
  expect(job).toMatchObject({
    projectId: PROJECT,
    state: "awaiting_confirmation",
    autonomousOrigin: "audit_intake",
  });
  expect(job?.requestText).toContain("docs/guide.md");
  // Queued through the ordinary admission path, not started out of band.
  expect(store.getAdmission(started!.jobId)?.state).toBe("queued");
  expect(enqueueControllerTurn).toHaveBeenCalledOnce();
  expect(enqueueControllerTurn.mock.calls[0]?.[0]).toMatchObject({ origin: "system" });
});

it("stops at the project's daily allowance however many findings there were", () => {
  const { store, database } = storeWithProject({ maxJobsPerDay: 2 });
  const { intake } = service(store);

  const first = intake.consider(AUDITED, bugResults(1), NOW);
  expect(first).toHaveLength(1);
  finishJob(database, first[0]!.jobId, "merged", NOW + 1);

  const second = intake.consider(AUDITED, bugResults(2), NOW + 2);
  expect(second).toHaveLength(1);
  finishJob(database, second[0]!.jobId, "merged", NOW + 3);

  // Two distinct jobs and no third: the allowance was spent exactly once each.
  expect(intake.consider(AUDITED, bugResults(3), NOW + 4)).toEqual([]);
  expect(new Set([first[0]!.jobId, second[0]!.jobId]).size).toBe(2);
});

it("gives the allowance back on the next UTC day", () => {
  const { store, database } = storeWithProject({ maxJobsPerDay: 1 });
  const { intake } = service(store);

  const first = intake.consider(AUDITED, bugResults(1), NOW);
  expect(first).toHaveLength(1);
  finishJob(database, first[0]!.jobId, "merged", NOW + 1);
  expect(intake.consider(AUDITED, bugResults(2), NOW + 2)).toEqual([]);

  expect(intake.consider(AUDITED, bugResults(2), NOW + DAY)).toHaveLength(1);
});

it("starts nothing while the failure brake holds the project", () => {
  const { store } = storeWithProject({ maxJobsPerDay: 4 });
  const { intake } = service(store);
  expect(store.pauseProjectAdmission({
    projectId: PROJECT,
    reason: "the same failure repeated 3 times",
    fingerprint: "abc",
    now: NOW,
  })).toBe(true);

  expect(intake.consider(AUDITED, bugResults(1), NOW)).toEqual([]);
  // The day's allowance was not spent on the refusal: once the owner lifts the
  // brake, the finding can still start its work.
  expect(store.clearProjectAdmissionPause({ projectId: PROJECT, now: NOW + 1 })).toBe(1);
  expect(intake.consider(AUDITED, bugResults(1), NOW + 2)).toHaveLength(1);
});

it("starts nothing while the project already has work of its own", () => {
  const { store } = storeWithProject({ maxJobsPerDay: 4 });
  const { intake } = service(store);
  expect(intake.consider(AUDITED, bugResults(1), NOW)).toHaveLength(1);

  // A different finding entirely: the bound is the project, not the finding.
  expect(intake.consider(AUDITED, bugResults(2), NOW)).toEqual([]);
});

it("will not start the same finding a second time while its job is still open", () => {
  const { store, database } = storeWithProject({ maxJobsPerDay: 4 });
  const { intake } = service(store);
  const [first] = intake.consider(AUDITED, bugResults(1), NOW);

  // Only the admission is released; the job itself is still running.
  database.prepare(
    "UPDATE job_admissions SET state = 'released', released_at = ?, release_reason = 'test' WHERE job_id = ?",
  ).run(NOW + 1, first!.jobId);

  expect(intake.consider(AUDITED, bugResults(1), NOW + 2)).toEqual([]);
});

it("keeps a finished finding quiet for a fortnight, then lets it come back", () => {
  const { store, database } = storeWithProject({ maxJobsPerDay: 4 });
  const { intake } = service(store);
  const [first] = intake.consider(AUDITED, bugResults(1), NOW);
  finishJob(database, first!.jobId, "merged", NOW + 1);

  expect(intake.consider(AUDITED, bugResults(1), NOW + INTAKE_SUPPRESSION_MS - 1)).toEqual([]);
  expect(intake.consider(AUDITED, bugResults(1), NOW + INTAKE_SUPPRESSION_MS + DAY)).toHaveLength(1);
});

it("does not let a blocked job hold its finding open forever", () => {
  // Nothing will move a blocked job on by itself, so the finding is settled
  // rather than pending, and the fortnight applies from there.
  const { store, database } = storeWithProject({ maxJobsPerDay: 4 });
  const { intake } = service(store);
  const [first] = intake.consider(AUDITED, bugResults(1), NOW);
  finishJob(database, first!.jobId, "blocked", NOW + 1);

  expect(intake.consider(AUDITED, bugResults(1), NOW + INTAKE_SUPPRESSION_MS + DAY)).toHaveLength(1);
});

it("starts nothing at all when the durable bounds cannot be read", () => {
  const { store } = storeWithProject({ maxJobsPerDay: 4 });
  const unreadable: TelegramAgentStore = Object.create(store, {
    listEnabledProjectPolicies: {
      value: () => {
        throw new Error("database is locked");
      },
    },
  }) as TelegramAgentStore;
  const intake = new AuditIntakeService({
    store: unreadable,
    clock: { now: () => NOW },
    issueUpdateId: () => 1,
    warn: () => {},
  });

  expect(intake.consider(AUDITED, bugResults(1), NOW)).toEqual([]);
});

it("files a diagnosed failure against the same allowance the audit spends", () => {
  const { store, database } = storeWithProject({ maxJobsPerDay: 1 });
  const { intake, enqueueControllerTurn } = service(store);

  const filed = intake.file({
    projectId: PROJECT,
    task: "Fix a failure this agent diagnosed in its own controller.",
    auditId: "self-diagnosis",
    subject: "failed_turn",
    fingerprint: "f".repeat(32),
    now: NOW,
  });
  expect(filed).toMatchObject({ origin: "self_diagnosis" });
  if ("refused" in filed) throw new Error("the diagnosis should have been filed");

  expect(store.getJob(filed.jobId)).toMatchObject({
    autonomousOrigin: "self_diagnosis",
    workflowEngine: "navigator-v1",
    routingMode: "legacy",
  });
  expect(store.getJob(filed.jobId)?.taskRecipe).not.toBe("bug");
  expect(enqueueControllerTurn.mock.calls[0]?.[0]).toMatchObject({ origin: "system" });

  // The allowance was one job a day, and the diagnosis just spent it.
  finishJob(database, filed.jobId, "merged", NOW + 1);
  expect(intake.consider(AUDITED, bugResults(1), NOW + 2)).toEqual([]);
});

it("refuses to file a diagnosis for a project that never asked for unattended work", () => {
  const { store } = storeWithProject();
  const { intake } = service(store);

  expect(intake.file({
    projectId: PROJECT,
    task: "Fix a diagnosed failure.",
    auditId: "self-diagnosis",
    subject: "failed_turn",
    fingerprint: "f".repeat(32),
    now: NOW,
  })).toEqual({ refused: "the project has no audit intake allowance" });
});

it("refuses to file a diagnosis while the project already has work", () => {
  const { store } = storeWithProject({ maxJobsPerDay: 4 });
  const { intake } = service(store);
  expect(intake.consider(AUDITED, bugResults(1), NOW)).toHaveLength(1);

  expect(intake.file({
    projectId: PROJECT,
    task: "Fix a diagnosed failure.",
    auditId: "self-diagnosis",
    subject: "failed_turn",
    fingerprint: "f".repeat(32),
    now: NOW,
  })).toMatchObject({ refused: expect.stringContaining("cannot take unattended work") });
});
