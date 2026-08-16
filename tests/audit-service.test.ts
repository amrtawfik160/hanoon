import { expect, it, vi } from "vitest";
import {
  AUDIT_SCAN_INTERVAL_MS,
  AUDIT_STARTUP_DELAY_MS,
  AuditService,
  type AuditAccess,
  type AuditProject,
} from "../src/services/audit-service";

const NOW = 1_786_850_000_000;
const PROJECT: AuditProject = { projectId: "proj_1", label: "demo" };

const CLEAN: AuditAccess = {
  listProjects: async () => [PROJECT],
  readDocs: async () => ({ docs: [], trackedPaths: new Set<string>() }),
  readDebtMarkers: async () => [],
  readBugBacklog: async () => [],
  readReviewThreads: async () => [],
};

function storeFake() {
  return {
    getOwner: () => ({ userId: 7, chatId: 9 }),
    getControllerForOwner: () => ({ controllerKey: "ck" }),
    claimHousekeepingNotice: vi.fn(() => true),
    enqueueControllerTurn: vi.fn(),
  };
}

function service(access: Partial<AuditAccess> = {}, store = storeFake(), armed = true, now = NOW) {
  const svc = new AuditService({
    store: store as never,
    audits: { ...CLEAN, ...access },
    clock: { now: () => now },
    issueUpdateId: () => 1,
    auditsArmed: () => armed,
    warn: () => {},
  });
  return { svc, store };
}

it("stays quiet on a clean day", async () => {
  const { svc, store } = service();
  const outcome = await svc.sweep(NOW);
  expect(outcome.notified).toBe(false);
  expect(store.enqueueControllerTurn).not.toHaveBeenCalled();
});

it("reports one digest when an audit finds something", async () => {
  const { svc, store } = service({
    readDebtMarkers: async () => [{ path: "src/a.ts", line: 1, kind: "TODO", text: "TODO: x" }],
  });
  const outcome = await svc.sweep(NOW);
  expect(outcome.notified).toBe(true);
  expect(store.enqueueControllerTurn).toHaveBeenCalledOnce();
  const enqueued = store.enqueueControllerTurn.mock.calls[0]?.[0] as { inputText: string; origin: string };
  expect(enqueued.origin).toBe("system");
  expect(enqueued.inputText).toContain("src/a.ts");
});

it("keeps the other audits when one of them throws", async () => {
  const { svc } = service({
    readDebtMarkers: async () => {
      throw new Error("grep exploded");
    },
    readBugBacklog: async () => [
      { number: 4, title: "old bug", createdAt: 0, updatedAt: 0 },
    ],
  });
  const outcome = await svc.sweep(NOW);
  const ids = outcome.results.map((r) => r.auditId);
  expect(ids).toContain("tech-debt");
  expect(ids).toContain("bug-backlog");
  expect(outcome.results.find((r) => r.auditId === "tech-debt")?.status).toBe("error");
  expect(outcome.results.find((r) => r.auditId === "bug-backlog")?.status).toBe("findings");
});

it("names a failed audit in the message rather than dropping it", async () => {
  const { svc, store } = service({
    readDebtMarkers: async () => {
      throw new Error("grep exploded");
    },
  });
  await svc.sweep(NOW);
  const enqueued = store.enqueueControllerTurn.mock.calls[0]?.[0] as { inputText: string };
  expect(enqueued.inputText).toContain("tech-debt");
  expect(enqueued.inputText).toMatch(/could not run/i);
});

it("keeps auditing other projects when one project fails outright", async () => {
  const second: AuditProject = { projectId: "proj_2", label: "second" };
  const { svc } = service({
    listProjects: async () => [PROJECT, second],
    readDebtMarkers: async (project) => {
      if (project.projectId === "proj_1") throw new Error("nope");
      return [{ path: "src/b.ts", line: 1, kind: "TODO", text: "TODO" }];
    },
  });
  const outcome = await svc.sweep(NOW);
  expect(outcome.results.some((r) => r.status === "findings")).toBe(true);
});

it("changes nothing and says nothing when audits are not armed", async () => {
  const { svc, store } = service({
    readDebtMarkers: async () => [{ path: "src/a.ts", line: 1, kind: "TODO", text: "TODO" }],
  }, storeFake(), false);
  const outcome = await svc.sweep(NOW);
  expect(outcome.notified).toBe(false);
  expect(store.enqueueControllerTurn).not.toHaveBeenCalled();
});

it("answers whether it is due without doing any work", () => {
  const listProjects = vi.fn(async () => [PROJECT]);
  const svc = new AuditService({
    store: storeFake() as never,
    audits: { ...CLEAN, listProjects },
    clock: { now: () => NOW },
    issueUpdateId: () => 1,
    auditsArmed: () => true,
    warn: () => {},
  });
  expect(svc.due(NOW)).toBe(false);
  expect(svc.due(NOW + AUDIT_STARTUP_DELAY_MS + 1)).toBe(true);
  expect(listProjects).not.toHaveBeenCalled();
});

it("paces itself after a sweep", async () => {
  let clock = NOW;
  const svc = new AuditService({
    store: storeFake() as never,
    audits: CLEAN,
    clock: { now: () => clock },
    issueUpdateId: () => 1,
    auditsArmed: () => true,
    warn: () => {},
  });
  expect(await svc.processDue()).toBe(false);
  clock = NOW + AUDIT_STARTUP_DELAY_MS + 1;
  await svc.processDue();
  expect(svc.due(clock)).toBe(false);
  expect(svc.due(clock + AUDIT_SCAN_INTERVAL_MS + 1)).toBe(true);
});
