export const WORKFLOW_SKILL_STAGES = [
  "planner",
  "implementation",
  "architecture",
  "documentation",
] as const;

export type WorkflowSkillStage = (typeof WORKFLOW_SKILL_STAGES)[number];

export const WORKFLOW_SKILL_TASK_EVIDENCE = [
  "reproducible-bug",
  "behavioral-change",
  "interface-design",
  "merge-conflict",
  "agent-instructions",
  "architectural-change",
] as const;

export type WorkflowSkillTaskEvidence = (typeof WORKFLOW_SKILL_TASK_EVIDENCE)[number];

export const IMPLEMENTATION_DISCIPLINE_BY_EVIDENCE: Readonly<Record<WorkflowSkillTaskEvidence, string>> = {
  "reproducible-bug": "diagnosing-bugs",
  "behavioral-change": "tdd",
  "interface-design": "codebase-design",
  "merge-conflict": "resolving-merge-conflicts",
  "agent-instructions": "writing-for-agents",
  "architectural-change": "improve-codebase-architecture",
};

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

function isTaskEvidence(value: string): value is WorkflowSkillTaskEvidence {
  return (WORKFLOW_SKILL_TASK_EVIDENCE as readonly string[]).includes(value);
}

export function attachedWorkflowTaskEvidence(
  declared: readonly string[],
  ticketText: string,
): string[] {
  const attached = [...new Set(declared)];
  if (
    ARCHITECTURE_TASK_PATTERN.test(ticketText) &&
    !attached.includes("architectural-change") &&
    attached.length < 6
  ) {
    attached.push("architectural-change");
  }
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
        (facts.taskEvidence ?? []).filter(isTaskEvidence)
          .map((evidence) => IMPLEMENTATION_DISCIPLINE_BY_EVIDENCE[evidence]),
      )];
      const skillIds = [...new Set(["implement", ...attached])]
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
  }
}
