import type { NavigatorEvaluationPersistence } from "./evaluation-persistence";
import type { NavigatorLiveScenario } from "./promotion";

export type NavigatorLiveScenarioRun = Readonly<{
  scenario: NavigatorLiveScenario;
  jobId: string;
  terminalState: "complete" | "merged" | "cancelled";
}>;

export function navigatorLiveScenarioHasRequiredEvidence(
  persistence: NavigatorEvaluationPersistence,
  run: NavigatorLiveScenarioRun,
): boolean {
  const job = persistence.getJob(run.jobId);
  if (!job || job.workflowEngine !== "navigator-v1" || job.state !== run.terminalState) {
    return false;
  }
  const effects = persistence.listEffectsForJob(run.jobId);
  switch (run.scenario) {
    case "happy_path":
      return run.terminalState === "complete" &&
        job.prNumber !== null &&
        effects.some((effect) => effect.kind === "deploy_production" && effect.status === "done") &&
        effects.some((effect) => effect.kind === "verify_production" && effect.status === "done");
    case "interrupted_tracker_create":
      return run.terminalState === "cancelled" &&
        persistence.countWorkArtifactCreateIntentsForEffort(run.jobId) > 0;
    case "stale_head":
      return persistence.countNavigatorGitObservationRejections(run.jobId) > 0;
    case "ambiguous_merge":
      return effects.filter((effect) => effect.kind === "merge_pr").length > 1;
    case "canary_failure":
      return persistence.countNavigatorReleaseIncidentsByPhase(run.jobId, "canary") > 0;
    case "successful_rollback":
      return persistence.countNavigatorSuccessfulRollbacks(run.jobId) > 0;
    case "repair":
      return persistence.countNavigatorRepairProposals(run.jobId) > 0;
    case "re_release":
      return effects.filter((effect) => effect.kind === "run_navigator_release").length >= 2 ||
        (persistence.countNavigatorReleaseFindings(run.jobId) > 0 &&
          effects.filter((effect) => effect.kind === "run_navigator_release").length >= 1);
    default:
      return false;
  }
}

export function assertNavigatorLiveScenarioEvidence(
  persistence: NavigatorEvaluationPersistence,
  run: NavigatorLiveScenarioRun,
): void {
  if (!navigatorLiveScenarioHasRequiredEvidence(persistence, run)) {
    throw new TypeError(
      `Navigator live evidence for ${run.scenario} is not an executed disposable run`,
    );
  }
}
