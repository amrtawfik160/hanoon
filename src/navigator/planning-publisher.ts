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
  | "isWorkArtifactSnapshotValid"
>;

export type NavigatorPlanningPublication = Readonly<{
  artifactBindings: readonly NavigatorArtifactBinding[];
  reconciledArtifactIds: readonly string[];
}>;

export class NavigatorPublicationDriftError extends Error {
  public readonly reasonCode = "stale_artifact_snapshot";

  public constructor() {
    super("Navigator subject artifact changed during planning publication");
    this.name = "NavigatorPublicationDriftError";
  }
}

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

function bodySectionContent(content: string): string {
  const startMarker = "<!-- hanoon:owned:body:start -->";
  const endMarker = "<!-- hanoon:owned:body:end -->";
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (start < 0 || end <= start) throw new Error("Navigator map body section is unavailable");
  return content.slice(start + startMarker.length, end).trim();
}

function decisionIndexBody(body: string, entry: string, link: string): string {
  if (body.includes(`](${link}):`)) return body;
  const heading = /^## Decisions so far\s*$/mu.exec(body);
  if (!heading || heading.index === undefined) {
    throw new Error("Navigator map has no Decisions so far section");
  }
  const sectionStart = heading.index + heading[0].length;
  const nextHeading = /^##\s+/mu.exec(body.slice(sectionStart));
  const sectionEnd = nextHeading?.index === undefined
    ? body.length
    : sectionStart + nextHeading.index;
  const before = body.slice(0, sectionEnd).trimEnd();
  const after = body.slice(sectionEnd).trimStart();
  return after.length === 0 ? `${before}\n\n${entry}` : `${before}\n\n${entry}\n\n${after}`;
}

function oneLineGist(answer: string): string {
  const normalized = answer.replace(/\s+/gu, " ").trim();
  return normalized.length <= 512 ? normalized : `${normalized.slice(0, 509).trimEnd()}...`;
}

function decisionAnswer(
  skillId: string,
  skillOutcome: Record<string, unknown>,
  artifactId: string,
): string {
  if (skillId === "prototype" && typeof skillOutcome.verdict === "string") {
    return skillOutcome.verdict;
  }
  const evidence = Array.isArray(skillOutcome.artifactEvidence)
    ? skillOutcome.artifactEvidence.find((entry) =>
      typeof entry === "object" && entry !== null &&
      (entry as { artifactId?: unknown }).artifactId === artifactId)
    : undefined;
  if (typeof (evidence as { finding?: unknown } | undefined)?.finding !== "string") {
    throw new TypeError(`Decision ${artifactId} has no matched durable answer`);
  }
  return (evidence as { finding: string }).finding;
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
    this.assertAttemptBindingsCurrent(attempt, new Set());
    if (attempt.skillId === "research") {
      const reconciled = await this.resolveDecisionSubjects(attempt, rawResult as Record<string, unknown>, fence);
      return this.currentBindings(attempt.jobId, reconciled, reconciled.map((binding) => binding.artifactId));
    }
    const planningOutcome = navigatorPlanningResultSchema.parse(rawResult);
    if (planningOutcome.kind === "prototype_result") {
      const reconciled = await this.resolveDecisionSubjects(attempt, planningOutcome, fence);
      return this.currentBindings(attempt.jobId, reconciled, reconciled.map((binding) => binding.artifactId));
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
    return this.currentBindings(attempt.jobId, [], []);
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
    this.assertAttemptBindingsCurrent(attempt, new Set());
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
      this.assertAttemptBindingsCurrent(attempt, new Set());
    }
    return this.currentBindings(attempt.jobId, [
      artifactBinding(this.store, mapId),
      ...ticketIds.map((ticketId) => artifactBinding(this.store, ticketId)),
    ], []);
  }

  private async publishSpecification(
    attempt: NavigatorSkillAttempt,
    specificationOutcome: Extract<NavigatorPlanningResult, { kind: "to_spec_result" }>,
    fence: PublicationFence,
  ): Promise<NavigatorPlanningPublication> {
    const job = this.requireJob(attempt.jobId);
    const boundArtifacts = this.boundArtifacts(attempt);
    const existingSpecification = boundArtifacts.find((artifact) => artifact.kind === "specification");
    if (existingSpecification) {
      await this.coordinator.updateOwnedSection({
        artifactId: existingSpecification.id,
        sectionId: "body",
        content: specificationOutcome.specification.body,
        operationId: `${attempt.workflowStepId}:revise-specification:${existingSpecification.id}`,
        ...fence,
      });
      const reconciled = new Set([existingSpecification.id]);
      this.assertAttemptBindingsCurrent(attempt, reconciled);
      return this.currentBindings(attempt.jobId, [
        artifactBinding(this.store, existingSpecification.id),
      ], [...reconciled]);
    }
    const map = boundArtifacts.find((artifact) => artifact.kind === "map");
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
    this.assertAttemptBindingsCurrent(attempt, new Set());
    return this.currentBindings(attempt.jobId, [
      artifactBinding(this.store, specificationId),
    ], []);
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
      this.assertAttemptBindingsCurrent(attempt, new Set());
    }
    return this.currentBindings(attempt.jobId, [
      ...ticketIds.map((ticketId) => artifactBinding(this.store, ticketId)),
    ], []);
  }

  private async resolveDecisionSubjects(
    attempt: NavigatorSkillAttempt,
    skillOutcome: Record<string, unknown>,
    fence: PublicationFence,
  ): Promise<readonly NavigatorArtifactBinding[]> {
    const reconciled = new Set<string>();
    for (const artifact of this.boundArtifacts(attempt)) {
      if (artifact.kind !== "decision_ticket") continue;
      const answer = decisionAnswer(attempt.skillId, skillOutcome, artifact.id);
      if (artifact.status !== "resolved") {
        await this.coordinator.resolve({
          artifactId: artifact.id,
          evidenceRefs: [`navigator-result:${attempt.id}`],
          resolution: answer,
          operationId: `${attempt.workflowStepId}:resolve:${artifact.id}`,
          ...fence,
        });
        reconciled.add(artifact.id);
        this.assertAttemptBindingsCurrent(attempt, reconciled);
      }
      await this.indexDecision(attempt, artifact, answer, fence);
      this.assertAttemptBindingsCurrent(attempt, reconciled);
    }
    const affectedIds = new Set(reconciled);
    const map = this.boundMap(attempt.jobId);
    if (map) affectedIds.add(map.id);
    return [...affectedIds].map((artifactId) => artifactBinding(this.store, artifactId));
  }

  private async indexDecision(
    attempt: NavigatorSkillAttempt,
    decision: WorkArtifact,
    answer: string,
    fence: PublicationFence,
  ): Promise<void> {
    const map = this.boundMap(attempt.jobId);
    if (!map) return;
    const snapshot = this.store.getCurrentWorkArtifactSnapshot(map.id);
    if (!snapshot) throw new Error(`Navigator map ${map.id} has no current snapshot`);
    const link = decision.externalUrl ?? decision.externalId;
    const entry = `- [${decision.title}](${link}): ${oneLineGist(answer)}`;
    await this.coordinator.updateOwnedSection({
      artifactId: map.id,
      sectionId: "body",
      content: decisionIndexBody(bodySectionContent(snapshot.content), entry, link),
      operationId: `${attempt.workflowStepId}:map-index:${decision.id}`,
      ...fence,
    });
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
    replacementBindings: readonly NavigatorArtifactBinding[],
    reconciledArtifactIds: readonly string[],
  ): NavigatorPlanningPublication {
    const unique = new Map<string, NavigatorArtifactBinding>();
    const job = this.requireJob(jobId);
    for (const binding of job.artifactBindings) unique.set(binding.artifactId, binding);
    for (const binding of replacementBindings) unique.set(binding.artifactId, binding);
    return { artifactBindings: [...unique.values()], reconciledArtifactIds };
  }

  private assertAttemptBindingsCurrent(
    attempt: NavigatorSkillAttempt,
    reconciledArtifactIds: ReadonlySet<string>,
  ): void {
    for (const binding of attempt.artifactBindings) {
      const current = this.store.getCurrentWorkArtifactSnapshot(binding.artifactId);
      const exact = current?.id === binding.snapshotId && current.snapshotDigest === binding.snapshotDigest;
      const revisableSpecification = attempt.skillId === "to-spec" &&
        this.store.getWorkArtifact(binding.artifactId)?.kind === "specification";
      if (exact && (this.store.isWorkArtifactSnapshotValid(binding.snapshotId) || revisableSpecification)) continue;
      if (reconciledArtifactIds.has(binding.artifactId) && current && this.store.isWorkArtifactSnapshotValid(current.id)) {
        continue;
      }
      throw new NavigatorPublicationDriftError();
    }
  }

  private boundMap(jobId: string): WorkArtifact | null {
    return this.requireJob(jobId).artifactBindings
      .map((binding) => this.store.getWorkArtifact(binding.artifactId))
      .find((artifact): artifact is WorkArtifact => artifact?.kind === "map") ?? null;
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
