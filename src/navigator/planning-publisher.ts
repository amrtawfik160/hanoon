import type { Job } from "../domain/models";
import type { TelegramAgentStore } from "../storage/store";
import {
  WorkArtifactCoordinator,
  type CreateCoordinatedArtifactInput,
} from "../work-artifacts/coordinator";
import type { WorkArtifact, WorkArtifactRelationship } from "../work-artifacts/models";
import { stableWorkArtifactId } from "../work-artifacts/repository";
import type { NavigatorArtifactBinding, NavigatorSkillAttempt } from "./models";
import {
  navigatorPlanningResultSchema,
  type NavigatorPlanningResult,
} from "./planning-contracts";

type PlanningPublisherStore = Pick<TelegramAgentStore,
  | "getJob"
  | "getWorkArtifact"
  | "getCurrentWorkArtifactSnapshot"
>;

export type NavigatorPlanningPublication = Readonly<{
  artifactBindings: readonly NavigatorArtifactBinding[];
}>;

type PublicationFence = Readonly<{
  ownerId: string;
  generation: number;
  now: number;
}>;

function artifactBinding(
  store: PlanningPublisherStore,
  artifactId: string,
): NavigatorArtifactBinding {
  const snapshot = store.getCurrentWorkArtifactSnapshot(artifactId);
  if (!snapshot) throw new Error(`Navigator artifact ${artifactId} has no current snapshot`);
  return {
    artifactId,
    snapshotId: snapshot.id,
    snapshotDigest: snapshot.snapshotDigest,
  };
}

function parentRelationship(childId: string, parentId: string): WorkArtifactRelationship {
  return {
    kind: "parent",
    sourceArtifactId: childId,
    sourceRef: `artifact:${childId}`,
    targetArtifactId: parentId,
    targetRef: `artifact:${parentId}`,
  };
}

function derivedRelationship(childId: string, sourceId: string): WorkArtifactRelationship {
  return {
    kind: "derived_from",
    sourceArtifactId: childId,
    sourceRef: `artifact:${childId}`,
    targetArtifactId: sourceId,
    targetRef: `artifact:${sourceId}`,
  };
}

function blockerRelationship(ticketId: string, blockerId: string): WorkArtifactRelationship {
  return {
    kind: "blocks",
    sourceArtifactId: blockerId,
    sourceRef: `artifact:${blockerId}`,
    targetArtifactId: ticketId,
    targetRef: `artifact:${ticketId}`,
  };
}

export class NavigatorPlanningPublisher {
  public constructor(
    private readonly store: PlanningPublisherStore,
    private readonly coordinator: WorkArtifactCoordinator,
  ) {}

  public async publish(
    attempt: NavigatorSkillAttempt,
    rawResult: unknown,
    fence: PublicationFence,
  ): Promise<NavigatorPlanningPublication> {
    if (attempt.skillId === "research") {
      await this.resolveDecisionSubjects(attempt, rawResult as Record<string, unknown>, fence);
      return this.currentBindings(attempt.jobId, attempt.artifactBindings);
    }
    const planningOutcome = navigatorPlanningResultSchema.parse(rawResult);
    if (planningOutcome.kind === "prototype_result") {
      await this.resolveDecisionSubjects(attempt, planningOutcome, fence);
      return this.currentBindings(attempt.jobId, attempt.artifactBindings);
    }
    if (planningOutcome.kind === "wayfinder_result") {
      return this.publishWayfinder(attempt, planningOutcome, fence);
    }
    if (planningOutcome.kind === "to_spec_result") {
      return this.publishSpecification(attempt, planningOutcome, fence);
    }
    if (planningOutcome.kind === "to_tickets_result") {
      return this.publishTickets(attempt, planningOutcome, fence);
    }
    return this.currentBindings(attempt.jobId, attempt.artifactBindings);
  }

  private async publishWayfinder(
    attempt: NavigatorSkillAttempt,
    wayfinderOutcome: Extract<NavigatorPlanningResult, { kind: "wayfinder_result" }>,
    fence: PublicationFence,
  ): Promise<NavigatorPlanningPublication> {
    const job = this.requireJob(attempt.jobId);
    this.assertNoBoundKind(attempt, "map");
    const mapOperationId = `${attempt.workflowStepId}:map`;
    const mapId = stableWorkArtifactId(job.projectId!, mapOperationId);
    await this.createArtifact(job, {
      operationId: mapOperationId,
      kind: "map",
      status: "open",
      ...wayfinderOutcome.map,
      relationships: [],
      trackerOrder: 0,
    }, fence);
    const ticketIds = wayfinderOutcome.decisionTickets.map((_ticket, index) =>
      stableWorkArtifactId(job.projectId!, `${attempt.workflowStepId}:decision:${index}`));
    for (const [index, ticket] of wayfinderOutcome.decisionTickets.entries()) {
      const ticketId = ticketIds[index]!;
      const relationships = [
        parentRelationship(ticketId, mapId),
        ...ticket.blockedBy.map((blockerIndex) => blockerRelationship(ticketId, ticketIds[blockerIndex]!)),
      ];
      await this.createArtifact(job, {
        operationId: `${attempt.workflowStepId}:decision:${index}`,
        kind: "decision_ticket",
        status: "ready",
        title: ticket.title,
        body: ticket.body,
        acceptanceCriteria: ticket.acceptanceCriteria,
        relationships,
        trackerOrder: index + 1,
      }, fence);
    }
    return this.currentBindings(attempt.jobId, [
      ...attempt.artifactBindings,
      artifactBinding(this.store, mapId),
      ...ticketIds.map((ticketId) => artifactBinding(this.store, ticketId)),
    ]);
  }

  private async publishSpecification(
    attempt: NavigatorSkillAttempt,
    specificationOutcome: Extract<NavigatorPlanningResult, { kind: "to_spec_result" }>,
    fence: PublicationFence,
  ): Promise<NavigatorPlanningPublication> {
    const job = this.requireJob(attempt.jobId);
    this.assertNoBoundKind(attempt, "specification");
    const map = this.boundArtifacts(attempt).find((artifact) => artifact.kind === "map");
    const operationId = `${attempt.workflowStepId}:specification`;
    const specificationId = stableWorkArtifactId(job.projectId!, operationId);
    await this.createArtifact(job, {
      operationId,
      kind: "specification",
      status: "ready",
      ...specificationOutcome.specification,
      relationships: map ? [derivedRelationship(specificationId, map.id)] : [],
      trackerOrder: 0,
    }, fence);
    return this.currentBindings(attempt.jobId, [
      ...attempt.artifactBindings,
      artifactBinding(this.store, specificationId),
    ]);
  }

  private async publishTickets(
    attempt: NavigatorSkillAttempt,
    ticketsOutcome: Extract<NavigatorPlanningResult, { kind: "to_tickets_result" }>,
    fence: PublicationFence,
  ): Promise<NavigatorPlanningPublication> {
    const job = this.requireJob(attempt.jobId);
    const specification = this.boundArtifacts(attempt).find((artifact) => artifact.kind === "specification");
    if (!specification) throw new TypeError("to-tickets requires one bound specification");
    const ticketIds = ticketsOutcome.tickets.map((_ticket, index) =>
      stableWorkArtifactId(job.projectId!, `${attempt.workflowStepId}:ticket:${index}`));
    for (const [index, ticket] of ticketsOutcome.tickets.entries()) {
      const ticketId = ticketIds[index]!;
      const relationships = [
        parentRelationship(ticketId, specification.id),
        derivedRelationship(ticketId, specification.id),
        ...ticket.blockedBy.map((blockerIndex) => blockerRelationship(ticketId, ticketIds[blockerIndex]!)),
      ];
      await this.createArtifact(job, {
        operationId: `${attempt.workflowStepId}:ticket:${index}`,
        kind: "implementation_ticket",
        status: "ready",
        title: ticket.title,
        body: ticket.body,
        acceptanceCriteria: ticket.acceptanceCriteria,
        relationships,
        trackerOrder: index + 1,
      }, fence);
    }
    return this.currentBindings(attempt.jobId, [
      ...attempt.artifactBindings,
      ...ticketIds.map((ticketId) => artifactBinding(this.store, ticketId)),
    ]);
  }

  private async resolveDecisionSubjects(
    attempt: NavigatorSkillAttempt,
    skillOutcome: Record<string, unknown>,
    fence: PublicationFence,
  ): Promise<void> {
    const summary = typeof skillOutcome.summary === "string"
      ? skillOutcome.summary
      : "Decision evidence recorded.";
    for (const artifact of this.boundArtifacts(attempt)) {
      if (artifact.kind !== "decision_ticket" || artifact.status === "resolved") continue;
      await this.coordinator.resolve({
        artifactId: artifact.id,
        evidenceRefs: [`navigator-result:${attempt.id}`],
        resolution: summary,
        operationId: `${attempt.workflowStepId}:resolve:${artifact.id}`,
        ...fence,
      });
    }
  }

  private async createArtifact(
    job: Job,
    input: Omit<CreateCoordinatedArtifactInput,
      "projectId" | "effortId" | "ownerId" | "generation" | "now">,
    fence: PublicationFence,
  ): Promise<void> {
    await this.coordinator.create({
      ...input,
      projectId: job.projectId!,
      effortId: job.id,
      ...fence,
    });
  }

  private currentBindings(
    jobId: string,
    additionalBindings: readonly NavigatorArtifactBinding[],
  ): NavigatorPlanningPublication {
    const unique = new Map<string, NavigatorArtifactBinding>();
    const job = this.requireJob(jobId);
    for (const bindingValue of [...job.artifactBindings, ...additionalBindings]) {
      unique.set(bindingValue.artifactId, artifactBinding(this.store, bindingValue.artifactId));
    }
    return { artifactBindings: [...unique.values()] };
  }

  private boundArtifacts(attempt: NavigatorSkillAttempt): readonly WorkArtifact[] {
    return attempt.artifactBindings.map((bindingValue) => {
      const artifact = this.store.getWorkArtifact(bindingValue.artifactId);
      if (!artifact) throw new Error(`Navigator artifact ${bindingValue.artifactId} disappeared`);
      return artifact;
    });
  }

  private assertNoBoundKind(attempt: NavigatorSkillAttempt, kind: WorkArtifact["kind"]): void {
    if (this.boundArtifacts(attempt).some((artifact) => artifact.kind === kind)) {
      throw new TypeError(`navigator effort already has a canonical ${kind}`);
    }
  }

  private requireJob(jobId: string): Job {
    const job = this.store.getJob(jobId);
    if (!job?.projectId) throw new Error(`Navigator job ${jobId} has no selected project`);
    return job;
  }
}
