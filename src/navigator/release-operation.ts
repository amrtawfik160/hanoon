import type { NavigatorPullRequestRecord } from "./implementation-contracts";

export type NavigatorReleaseOperationDependencies = Readonly<{
  publishPullRequest(input: Readonly<{ jobId: string; title: string; body: string }>): Promise<NavigatorPullRequestRecord>;
  integrationWorktreeId(jobId: string): string;
}>;

export function navigatorReleaseTitle(requestText: string): string {
  const trimmed = requestText.trim();
  if (trimmed.length === 0) return "Ship accepted navigator tickets";
  return trimmed.length <= 72 ? trimmed : `${trimmed.slice(0, 69).trimEnd()}...`;
}

export class NavigatorReleaseOperation {
  public constructor(private readonly dependencies: NavigatorReleaseOperationDependencies) {}

  public integrationEnvironmentId(jobId: string): string {
    return this.dependencies.integrationWorktreeId(jobId);
  }

  public executeEntry(
    input: Readonly<{ jobId: string; title: string; body: string }>,
    signal: AbortSignal,
  ): Promise<NavigatorPullRequestRecord> {
    return Promise.race([
      this.dependencies.publishPullRequest(input),
      abortWhenSignaled(signal),
    ]);
  }
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
