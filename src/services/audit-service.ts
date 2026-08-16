import { auditDigest, type AuditResult } from "../autonomy/audit-contract";
import { analyseBugBacklog, type BacklogIssue } from "../autonomy/audits/bug-backlog";
import { analyseDocsStaleness, type DocObservation } from "../autonomy/audits/docs-staleness";
import { analysePrReviewFindings, type ReviewThread } from "../autonomy/audits/pr-review-findings";
import { analyseTechDebt, DEBT_SCAN_SCOPE, type DebtMarker } from "../autonomy/audits/tech-debt";
import { redactError } from "../errors";
import type { TelegramAgentStore } from "../storage/store";

/** Daily. Every one of these accrues over days. */
export const AUDIT_SCAN_INTERVAL_MS = 24 * 60 * 60_000;

/** Long enough that the executor's first ticks belong to the owner's work. */
export const AUDIT_STARTUP_DELAY_MS = 15 * 60_000;

/** A day, so a finding that persists is mentioned tomorrow, not every tick. */
export const AUDIT_NOTICE_DEDUP_MS = 24 * 60 * 60_000;

export type AuditProject = { projectId: string; label: string };

/**
 * Everything the audits need from outside. One seam, so every rule above it is
 * testable without a repository, a network, or the `gh` CLI.
 */
export type AuditAccess = {
  listProjects(): Promise<readonly AuditProject[]>;
  readDocs(project: AuditProject): Promise<{
    docs: readonly DocObservation[];
    trackedPaths: ReadonlySet<string>;
  }>;
  readDebtMarkers(project: AuditProject): Promise<readonly DebtMarker[]>;
  readBugBacklog(project: AuditProject): Promise<readonly BacklogIssue[]>;
  readReviewThreads(project: AuditProject): Promise<readonly ReviewThread[]>;
};

export type AuditDependencies = {
  store: Pick<
    TelegramAgentStore,
    "getOwner" | "getControllerForOwner" | "enqueueControllerTurn" | "claimHousekeepingNotice"
  >;
  audits: AuditAccess;
  clock: { now(): number };
  issueUpdateId(now: number): number;
  auditsArmed(): boolean;
  warn?: (message: string) => void;
};

export type AuditSweepOutcome = Readonly<{
  results: readonly AuditResult[];
  notified: boolean;
}>;

/**
 * The daily read-only pass over each project.
 *
 * Four checks, each self-contained, each able to fail on its own. An audit that
 * throws becomes a reported error rather than a silent absence, because "found
 * nothing" and "could not look" mean opposite things to whoever reads the
 * message. One digest goes out for the whole pass, capped, and a clean day says
 * nothing at all.
 */
export class AuditService {
  private nextScanAt: number | null = null;

  public constructor(private readonly dependencies: AuditDependencies) {}

  /** Synchronous, so a tick that owes nothing costs nothing. */
  public due(now: number): boolean {
    if (this.nextScanAt === null) {
      this.nextScanAt = now + AUDIT_STARTUP_DELAY_MS;
      return false;
    }
    return now >= this.nextScanAt;
  }

  public async processDue(): Promise<boolean> {
    const now = this.dependencies.clock.now();
    if (!this.due(now)) return false;
    this.nextScanAt = now + AUDIT_SCAN_INTERVAL_MS;
    try {
      return (await this.sweep(now)).notified;
    } catch (error) {
      this.dependencies.warn?.(`Audits did not complete: ${redactError(error).slice(0, 200)}`);
      return false;
    }
  }

  /** Exposed for tests and for a deliberate one-off; `processDue` paces it. */
  public async sweep(now: number): Promise<AuditSweepOutcome> {
    if (!this.dependencies.auditsArmed()) return { results: [], notified: false };

    let projects: readonly AuditProject[] = [];
    try {
      projects = await this.dependencies.audits.listProjects();
    } catch (error) {
      this.dependencies.warn?.(`Audit projects could not be listed: ${redactError(error).slice(0, 160)}`);
      return { results: [], notified: false };
    }

    const results: AuditResult[] = [];
    let notified = false;
    for (const project of projects) {
      const projectResults = await this.auditProject(project, now);
      results.push(...projectResults);
      const digest = auditDigest({ project: project.label, results: projectResults });
      if (digest !== null && this.notify(project, digest, now)) notified = true;
    }
    return { results, notified };
  }

  private async auditProject(project: AuditProject, now: number): Promise<AuditResult[]> {
    // Each audit is run through the same wrapper so one throwing is one error
    // in the report rather than the loss of the whole pass.
    return [
      await this.run("docs-staleness", async () => {
        const { docs, trackedPaths } = await this.dependencies.audits.readDocs(project);
        return analyseDocsStaleness({ docs, trackedPaths });
      }),
      await this.run(
        "tech-debt",
        async () => analyseTechDebt({
          markers: await this.dependencies.audits.readDebtMarkers(project),
        }),
        DEBT_SCAN_SCOPE,
      ),
      await this.run("bug-backlog", async () => analyseBugBacklog({
        issues: await this.dependencies.audits.readBugBacklog(project),
        now,
      })),
      await this.run("pr-review-findings", async () => analysePrReviewFindings({
        threads: await this.dependencies.audits.readReviewThreads(project),
      })),
    ];
  }

  private async run(
    auditId: string,
    body: () => Promise<readonly AuditResult["findings"][number][]>,
    scope?: string,
  ): Promise<AuditResult> {
    try {
      const findings = await body();
      return findings.length === 0
        ? { auditId, status: "ok", findings: [], ...(scope === undefined ? {} : { scope }) }
        : { auditId, status: "findings", findings, ...(scope === undefined ? {} : { scope }) };
    } catch (error) {
      return {
        auditId,
        status: "error",
        findings: [],
        error: redactError(error).slice(0, 120),
        ...(scope === undefined ? {} : { scope }),
      };
    }
  }

  private notify(project: AuditProject, digest: string, now: number): boolean {
    const owner = this.dependencies.store.getOwner();
    if (!owner) return false;
    const controller = this.dependencies.store.getControllerForOwner(owner.userId, owner.chatId);
    if (!controller) return false;
    if (!this.dependencies.store.claimHousekeepingNotice({
      key: `audits:${project.projectId}`,
      detail: digest.slice(0, 200),
      now,
      dedupMs: AUDIT_NOTICE_DEDUP_MS,
    })) return false;
    this.dependencies.store.enqueueControllerTurn({
      controllerKey: controller.controllerKey,
      telegramUserId: owner.userId,
      telegramChatId: owner.chatId,
      updateId: this.dependencies.issueUpdateId(now),
      inputText: digest,
      // Not the owner speaking; this must never read as their verdict on the
      // previous answer.
      origin: "system",
      now,
    });
    return true;
  }
}
