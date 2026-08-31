import type { NavigatorPullRequestRecord } from "./implementation-contracts";
import type { NavigatorReleaseEntryRequest } from "./release-contracts";

export type NavigatorReleaseExecutorDependencies = Readonly<{
  publishPullRequest(input: NavigatorReleaseEntryRequest): Promise<NavigatorPullRequestRecord>;
  integrationWorktreeId(jobId: string): string;
}>;

export function navigatorReleaseTitle(requestText: string): string {
  const trimmed = requestText.trim();
  if (trimmed.length === 0) return "Ship accepted navigator tickets";
  return trimmed.length <= 72 ? trimmed : `${trimmed.slice(0, 69).trimEnd()}...`;
}

function abortWhenSignaled(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("navigator release was aborted"));
      return;
    }
    signal.addEventListener("abort", () => {
      reject(signal.reason ?? new Error("navigator release was aborted"));
    }, { once: true });
  });
}

export class NavigatorReleaseExecutor {
  public constructor(private readonly dependencies: NavigatorReleaseExecutorDependencies) {}

  public integrationEnvironmentId(jobId: string): string {
    return this.dependencies.integrationWorktreeId(jobId);
  }

  public async executeEntry(
    input: NavigatorReleaseEntryRequest,
    signal: AbortSignal,
  ): Promise<NavigatorPullRequestRecord> {
    return Promise.race([
      this.dependencies.publishPullRequest(input),
      abortWhenSignaled(signal),
    ]);
  }

  public async reconcileEntry(
    input: NavigatorReleaseEntryRequest,
    signal: AbortSignal,
  ): Promise<NavigatorPullRequestRecord> {
    return this.executeEntry(input, signal);
  }
}
