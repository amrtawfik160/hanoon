export const WORKFLOW_SKILL_STAGES = [
  "planner",
  "implementation",
  "architecture",
  "documentation",
  "review",
] as const;

export type WorkflowSkillStage = (typeof WORKFLOW_SKILL_STAGES)[number];

export const WORKFLOW_SKILL_TASK_EVIDENCE = [
  "reproducible-bug",
  "behavioral-change",
  "interface-design",
  "merge-conflict",
  "agent-instructions",
  "architectural-change",
  "ui-surface",
] as const;

export type WorkflowSkillTaskEvidence = (typeof WORKFLOW_SKILL_TASK_EVIDENCE)[number];
export type ImplementationDisciplineEvidence = Exclude<WorkflowSkillTaskEvidence, "ui-surface">;

export const IMPLEMENTATION_DISCIPLINE_BY_EVIDENCE: Readonly<Record<ImplementationDisciplineEvidence, string>> = {
  "reproducible-bug": "diagnosing-bugs",
  "behavioral-change": "tdd",
  "interface-design": "codebase-design",
  "merge-conflict": "resolving-merge-conflicts",
  "agent-instructions": "writing-for-agents",
  "architectural-change": "improve-codebase-architecture",
};

export const UI_SURFACE_SKILLS = ["better-ui", "emil-design-eng"] as const;

export type WorkflowSkillFacts = Readonly<{
  stage: WorkflowSkillStage;
  specificationReady?: boolean;
  multiStep?: boolean;
  taskEvidence?: readonly string[];
}>;

export type WorkflowSkillSchedule = Readonly<{
  skillIds: readonly string[];
  reasonCodes: readonly string[];
}>;

const ARCHITECTURE_TASK_PATTERN =
  /\b(?:new\s+(?:system|subsystem|service|project)|greenfield|public\s+(?:api|contract)|(?:database\s+)?schema(?:\s+change)?|architectural(?:\s+change)?)\b/iu;
const UI_SURFACE_PATTERN =
  /\b(?:ui(?:[\s-](?:kit|polish|surface|review))?|css|scss|tsx|jsx|frontend|front-end|stylesheet|animations?|visual polish|design engineering)\b/iu;
const MAXIMUM_TASK_EVIDENCE = 8;

function isDisciplineEvidence(value: string): value is ImplementationDisciplineEvidence {
  return value in IMPLEMENTATION_DISCIPLINE_BY_EVIDENCE;
}

function isUiSurfacePath(path: string): boolean {
  return /\.(?:css|scss|sass|less|tsx|jsx|vue|svelte|html)$/iu.test(path)
    || /(?:^|\/)(?:ui|components|frontend)\//iu.test(path);
}

function uiSurfaceSkills(taskEvidence: readonly string[] | undefined): readonly string[] {
  return taskEvidence?.includes("ui-surface") === true ? UI_SURFACE_SKILLS : [];
}

export function attachedWorkflowTaskEvidence(
  declared: readonly string[],
  ticketText: string,
  changedPaths: readonly string[] = [],
): string[] {
  const attached = [...new Set(declared)];
  const attach = (evidence: WorkflowSkillTaskEvidence) => {
    if (!attached.includes(evidence) && attached.length < MAXIMUM_TASK_EVIDENCE) {
      attached.push(evidence);
    }
  };
  if (ARCHITECTURE_TASK_PATTERN.test(ticketText)) attach("architectural-change");
  if (UI_SURFACE_PATTERN.test(ticketText) || changedPaths.some(isUiSurfacePath)) attach("ui-surface");
  return attached;
}

export function scheduleWorkflowSkills(facts: WorkflowSkillFacts): WorkflowSkillSchedule {
  switch (facts.stage) {
    case "planner":
      if (facts.specificationReady === true && facts.multiStep === true) {
        return { skillIds: ["to-tickets"], reasonCodes: ["planner_to_tickets"] };
      }
      return { skillIds: ["to-spec"], reasonCodes: ["planner_to_spec"] };
    case "implementation": {
      const attached = [...new Set(
        (facts.taskEvidence ?? []).filter(isDisciplineEvidence)
          .map((evidence) => IMPLEMENTATION_DISCIPLINE_BY_EVIDENCE[evidence]),
      )];
      const skillIds = [...new Set(["implement", ...attached, ...uiSurfaceSkills(facts.taskEvidence)])]
        .sort((left, right) => left.localeCompare(right));
      return {
        skillIds,
        reasonCodes: skillIds.map((skillId) => `implementation_${skillId.replaceAll("-", "_")}`),
      };
    }
    case "architecture":
      return {
        skillIds: ["improve-codebase-architecture"],
        reasonCodes: ["architecture_improve_codebase_architecture"],
      };
    case "documentation":
      return {
        skillIds: ["technical-writing"],
        reasonCodes: ["documentation_technical_writing"],
      };
    case "review": {
      const skillIds = [...uiSurfaceSkills(facts.taskEvidence)];
      return {
        skillIds,
        reasonCodes: skillIds.map((skillId) => `review_${skillId.replaceAll("-", "_")}`),
      };
    }
  }
}
