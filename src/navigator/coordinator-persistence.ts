import type { TelegramAgentStore } from "../storage/store";

export type NavigatorCoordinatorPersistence = Pick<TelegramAgentStore,
  | "listNonterminalRecipeJobs"
  | "getCurrentWorkerLiveness"
  | "applyJobEvent"
  | "contractRecipeEngine"
  | "recordNavigatorDeterministicEvidence"
  | "recordNavigatorCorpusEvidence"
  | "recordNavigatorLiveEvidence"
  | "recordNavigatorModelTrialEvidence"
  | "recordNavigatorSafetyEvidence"
  | "publishNavigatorPromotionManifest"
>;

export function createNavigatorCoordinatorPersistence(
  store: TelegramAgentStore,
): NavigatorCoordinatorPersistence {
  return {
    listNonterminalRecipeJobs: () => store.listNonterminalRecipeJobs(),
    getCurrentWorkerLiveness: (jobId) => store.getCurrentWorkerLiveness(jobId),
    applyJobEvent: (jobId, expectedVersion, event, now) =>
      store.applyJobEvent(jobId, expectedVersion, event, now),
    contractRecipeEngine: (now) => store.contractRecipeEngine(now),
    recordNavigatorDeterministicEvidence: (input) => store.recordNavigatorDeterministicEvidence(input),
    recordNavigatorCorpusEvidence: (input) => store.recordNavigatorCorpusEvidence(input),
    recordNavigatorLiveEvidence: (input) => store.recordNavigatorLiveEvidence(input),
    recordNavigatorModelTrialEvidence: (input) => store.recordNavigatorModelTrialEvidence(input),
    recordNavigatorSafetyEvidence: (input) => store.recordNavigatorSafetyEvidence(input),
    publishNavigatorPromotionManifest: (input) => store.publishNavigatorPromotionManifest(input),
  };
}
