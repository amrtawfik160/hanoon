import type { ModelRoute } from "../capabilities/models";
import type {
  NavigatorInferenceObservation,
  NavigatorProposalDecision,
  NavigatorSnapshot,
} from "./models";

export interface WorkflowNavigator {
  propose(snapshot: NavigatorSnapshot): Promise<unknown>;
}

/** Persistence for proposal construction only. Effect execution is owned by
 * NavigatorEffectProtocol and is intentionally absent from this contract. */
export interface NavigatorPlanningPersistence {
  createNavigatorSnapshot(input: Readonly<{
    jobId: string;
    externalStateDigest: string;
    evidenceRefs: readonly string[];
    now: number;
  }>): NavigatorSnapshot;
  recordNavigatorProposal(input: Readonly<{
    snapshotId: string;
    rawProposal: unknown;
    observation: NavigatorInferenceObservation;
    selectModelRoute(): ModelRoute;
    now: number;
  }>): NavigatorProposalDecision;
}

export type NavigatorPlanningServiceDependencies = Readonly<{
  persistence: NavigatorPlanningPersistence;
  navigator: WorkflowNavigator;
  observeInference(snapshot: NavigatorSnapshot): Promise<NavigatorInferenceObservation>;
  modelRoute(): ModelRoute;
  clock: { now(): number };
}>;

export class NavigatorPlanningService {
  public constructor(private readonly dependencies: NavigatorPlanningServiceDependencies) {}

  public async proposeNext(input: Readonly<{
    jobId: string;
    externalStateDigest: string;
    evidenceRefs: readonly string[];
  }>): Promise<NavigatorProposalDecision> {
    const snapshot = this.dependencies.persistence.createNavigatorSnapshot({
      ...input,
      now: this.dependencies.clock.now(),
    });
    const rawProposal = await this.dependencies.navigator.propose(snapshot);
    const observation = await this.dependencies.observeInference(snapshot);
    return this.dependencies.persistence.recordNavigatorProposal({
      snapshotId: snapshot.snapshotId,
      rawProposal,
      observation,
      selectModelRoute: this.dependencies.modelRoute,
      now: this.dependencies.clock.now(),
    });
  }
}
