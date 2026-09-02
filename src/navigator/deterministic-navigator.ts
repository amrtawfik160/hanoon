import { selectNavigatorPlanningRoute, type NavigatorRoutingSignals } from "./planning-contracts";
import type { NavigatorSnapshot } from "./models";
import type { WorkflowNavigator } from "./planning-service";

function signalsFromSnapshot(snapshot: NavigatorSnapshot): NavigatorRoutingSignals {
  const specificationReady = snapshot.artifactBindings.length > 1;
  return {
    trackerConfigured: true,
    specificationReady,
    hugeMultiSessionEffort: snapshot.artifactBindings.length === 0,
    routeToDestinationVisible: specificationReady,
    needsPrimarySourceFacts: !specificationReady && snapshot.artifactBindings.length > 0,
    runnableDesignQuestion: false,
    workingDirectoryAvailable: true,
    requirementsUnclear: snapshot.artifactBindings.length === 0,
  };
}

export class DeterministicWorkflowNavigator implements WorkflowNavigator {
  public async propose(snapshot: NavigatorSnapshot): Promise<unknown> {
    const route = selectNavigatorPlanningRoute(signalsFromSnapshot(snapshot));
    const subject = snapshot.artifactBindings[0]?.artifactId;
    const base = {
      basedOn: snapshot.identity,
      rationale: "Deterministic navigator-v1 selected the next admitted planning skill.",
      evidenceRefs: [...snapshot.evidenceRefs],
    };
    if (route === "research" && subject) {
      return {
        ...base,
        kind: "invoke_skill",
        skillId: "research",
        subjectArtifactIds: [subject],
        objective: "Collect the missing primary-source facts.",
      };
    }
    if (route === "wayfinder" && subject) {
      return {
        ...base,
        kind: "invoke_skill",
        skillId: "wayfinder",
        subjectArtifactIds: [subject],
        objective: "Map the effort before implementation.",
      };
    }
    if (route === "to-spec" && subject) {
      return {
        ...base,
        kind: "invoke_skill",
        skillId: "to-spec",
        subjectArtifactIds: [subject],
        objective: "Write the canonical specification.",
      };
    }
    if (route === "to-tickets" && subject) {
      return {
        ...base,
        kind: "invoke_skill",
        skillId: "to-tickets",
        subjectArtifactIds: [subject],
        objective: "File sequential implementation tickets.",
      };
    }
    return {
      ...base,
      kind: "unresolved_next_step",
      question: "Which admitted skill should resolve the remaining routing gap?",
      candidateSkillIds: ["research", "wayfinder"],
    };
  }
}
