import { createHash } from "node:crypto";
import {
  DUAL_ENGINE_RESTART_POINTS,
  NAVIGATOR_DETERMINISTIC_CATEGORIES,
  type DualEngineRestartPoint,
  type NavigatorDeterministicCategory,
} from "./promotion";
import type { WorkflowEngine } from "./models";

export const NAVIGATOR_OWNER_BOUNDARY_CODES = [
  "product_decision_required",
  "scope_expansion_required",
  "credential_or_access_required",
  "spend_authority_required",
  "irreversible_effect_required",
  "policy_change_required",
  "technical_tradeoff_required",
  "production_recovery_required",
] as const;

export const NAVIGATOR_EVALUATION_HARNESS_DIGEST = createHash("sha256")
  .update("navigator-evaluation-harness-v1", "utf8")
  .digest("hex");
export const NAVIGATOR_EVALUATION_BUDGET_DIGEST = createHash("sha256")
  .update("navigator-evaluation-budget-v1:58", "utf8")
  .digest("hex");

export type NavigatorEvaluationArtifacts = "none" | "ticket" | "specification+ticket";

export type NavigatorEvaluationCase = Readonly<{
  id: string;
  category: NavigatorDeterministicCategory;
  engine: WorkflowEngine;
  artifacts: NavigatorEvaluationArtifacts;
  taskOutcome: "artifact" | "reviewed_change" | "shipped_change" | null;
  jobState: "awaiting_confirmation" | "complete" | "merged" | null;
  proposal: "malformed" | "invoke_research" | "invoke_wayfinder" | "invoke_to_spec" |
    "invoke_to_tickets" | "invoke_implement" | "invoke_ask_matt" | "invoke_legacy" |
    "unresolved" | "start_release" | "finish" | `owner_boundary:${typeof NAVIGATOR_OWNER_BOUNDARY_CODES[number]}` |
    "native_tools";
  expected: Readonly<{
    decision: "accepted" | "rejected" | "shadowed";
    reasonCode: string;
  }>;
  restartPoint?: DualEngineRestartPoint;
}>;

function caseId(category: NavigatorDeterministicCategory, index: number): string {
  return `corpus-${category}-${String(index + 1).padStart(2, "0")}`;
}

function buildCases(): NavigatorEvaluationCase[] {
  const cases: NavigatorEvaluationCase[] = [];
  const push = (
    category: NavigatorDeterministicCategory,
    rest: Omit<NavigatorEvaluationCase, "id" | "category">,
  ): void => {
    cases.push({ id: caseId(category, cases.filter((entry) => entry.category === category).length), category, ...rest });
  };

  push("proposal_validity", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "malformed", expected: { decision: "rejected", reasonCode: "malformed_proposal" },
  });
  push("proposal_validity", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_research", expected: { decision: "accepted", reasonCode: "accepted" },
  });
  push("proposal_validity", {
    engine: "recipe-v1", artifacts: "none", taskOutcome: null, jobState: null,
    proposal: "malformed", expected: { decision: "rejected", reasonCode: "malformed_proposal" },
  });
  push("proposal_validity", {
    engine: "recipe-v1", artifacts: "none", taskOutcome: null, jobState: null,
    proposal: "unresolved", expected: { decision: "shadowed", reasonCode: "recipe_job_shadow" },
  });
  push("proposal_validity", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "native_tools", expected: { decision: "rejected", reasonCode: "policy_native_tool_use" },
  });
  push("proposal_validity", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_research", expected: { decision: "accepted", reasonCode: "accepted" },
  });

  push("skill_invocation", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_research", expected: { decision: "accepted", reasonCode: "accepted" },
  });
  push("skill_invocation", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_wayfinder", expected: { decision: "accepted", reasonCode: "accepted" },
  });
  push("skill_invocation", {
    engine: "navigator-v1", artifacts: "specification+ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_to_tickets", expected: { decision: "accepted", reasonCode: "accepted" },
  });
  push("skill_invocation", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_research", expected: { decision: "accepted", reasonCode: "accepted" },
  });
  push("skill_invocation", {
    engine: "recipe-v1", artifacts: "none", taskOutcome: null, jobState: null,
    proposal: "unresolved", expected: { decision: "shadowed", reasonCode: "recipe_job_shadow" },
  });
  push("skill_invocation", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_wayfinder", expected: { decision: "accepted", reasonCode: "accepted" },
  });

  push("capability_denials", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_legacy", expected: { decision: "rejected", reasonCode: "capability_denied" },
  });
  push("capability_denials", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_ask_matt", expected: { decision: "rejected", reasonCode: "capability_denied" },
  });
  push("capability_denials", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_implement", expected: { decision: "rejected", reasonCode: "capability_denied" },
  });
  push("capability_denials", {
    engine: "navigator-v1", artifacts: "specification+ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_wayfinder", expected: { decision: "rejected", reasonCode: "unnecessary_wayfinding" },
  });
  push("capability_denials", {
    engine: "navigator-v1", artifacts: "specification+ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_to_spec", expected: { decision: "rejected", reasonCode: "canonical_specification_exists" },
  });
  push("capability_denials", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_legacy", expected: { decision: "rejected", reasonCode: "capability_denied" },
  });

  push("ask_matt", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "unresolved", expected: { decision: "accepted", reasonCode: "ask_matt_scheduled" },
  });
  push("ask_matt", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_ask_matt", expected: { decision: "rejected", reasonCode: "capability_denied" },
  });
  push("ask_matt", {
    engine: "recipe-v1", artifacts: "none", taskOutcome: null, jobState: null,
    proposal: "unresolved", expected: { decision: "shadowed", reasonCode: "recipe_job_shadow" },
  });
  push("ask_matt", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "unresolved", expected: { decision: "accepted", reasonCode: "ask_matt_scheduled" },
  });

  for (const code of NAVIGATOR_OWNER_BOUNDARY_CODES) {
    push("owner_boundaries", {
      engine: "navigator-v1",
      artifacts: "ticket",
      taskOutcome: "reviewed_change",
      jobState: null,
      proposal: `owner_boundary:${code}`,
      expected: { decision: "rejected", reasonCode: "owner_boundary_requires_live_task_authority" },
    });
  }

  push("artifact_frontier", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_wayfinder", expected: { decision: "accepted", reasonCode: "accepted" },
  });
  push("artifact_frontier", {
    engine: "navigator-v1", artifacts: "specification+ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_wayfinder", expected: { decision: "rejected", reasonCode: "unnecessary_wayfinding" },
  });
  push("artifact_frontier", {
    engine: "navigator-v1", artifacts: "specification+ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_to_tickets", expected: { decision: "accepted", reasonCode: "accepted" },
  });
  push("artifact_frontier", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_research", expected: { decision: "accepted", reasonCode: "accepted" },
  });
  push("artifact_frontier", {
    engine: "navigator-v1", artifacts: "specification+ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_to_spec", expected: { decision: "rejected", reasonCode: "canonical_specification_exists" },
  });
  push("artifact_frontier", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "invoke_research", expected: { decision: "accepted", reasonCode: "accepted" },
  });

  push("task_outcomes", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "artifact", jobState: null,
    proposal: "start_release", expected: { decision: "rejected", reasonCode: "release_outcome_not_permitted" },
  });
  push("task_outcomes", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "finish", expected: { decision: "rejected", reasonCode: "completion_evidence_missing" },
  });
  push("task_outcomes", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: "complete",
    proposal: "finish", expected: { decision: "accepted", reasonCode: "completion_recorded" },
  });
  push("task_outcomes", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "shipped_change", jobState: "merged",
    proposal: "finish", expected: { decision: "accepted", reasonCode: "completion_recorded" },
  });
  push("task_outcomes", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "artifact", jobState: null,
    proposal: "finish", expected: { decision: "rejected", reasonCode: "completion_evidence_missing" },
  });
  push("task_outcomes", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "shipped_change", jobState: null,
    proposal: "start_release", expected: { decision: "rejected", reasonCode: "release_prerequisites_incomplete" },
  });

  push("release_entry", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "start_release", expected: { decision: "rejected", reasonCode: "release_prerequisites_incomplete" },
  });
  push("release_entry", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "artifact", jobState: null,
    proposal: "start_release", expected: { decision: "rejected", reasonCode: "release_outcome_not_permitted" },
  });
  push("release_entry", {
    engine: "recipe-v1", artifacts: "none", taskOutcome: "reviewed_change", jobState: null,
    proposal: "start_release", expected: { decision: "rejected", reasonCode: "unauthorized_subject" },
  });
  push("release_entry", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: "complete",
    proposal: "finish", expected: { decision: "accepted", reasonCode: "completion_recorded" },
  });
  push("release_entry", {
    engine: "navigator-v1", artifacts: "ticket", taskOutcome: "reviewed_change", jobState: null,
    proposal: "start_release", expected: { decision: "rejected", reasonCode: "release_prerequisites_incomplete" },
  });
  push("release_entry", {
    engine: "recipe-v1", artifacts: "none", taskOutcome: null, jobState: null,
    proposal: "unresolved", expected: { decision: "shadowed", reasonCode: "recipe_job_shadow" },
  });

  for (const restartPoint of DUAL_ENGINE_RESTART_POINTS) {
    push("restart", {
      engine: "navigator-v1",
      artifacts: "specification+ticket",
      taskOutcome: "shipped_change",
      jobState: null,
      proposal: "invoke_research",
      restartPoint,
      expected: { decision: "accepted", reasonCode: "accepted" },
    });
  }

  return cases;
}

export const NAVIGATOR_EVALUATION_CORPUS: readonly NavigatorEvaluationCase[] = Object.freeze(buildCases());

export const NAVIGATOR_EVALUATION_CORPUS_DIGEST = createHash("sha256")
  .update(JSON.stringify(NAVIGATOR_EVALUATION_CORPUS.map((entry) => entry.id)), "utf8")
  .digest("hex");

export function navigatorEvaluationCategoryCoverage(): readonly NavigatorDeterministicCategory[] {
  const present = new Set(NAVIGATOR_EVALUATION_CORPUS.map((entry) => entry.category));
  return NAVIGATOR_DETERMINISTIC_CATEGORIES.filter((category) => present.has(category));
}
