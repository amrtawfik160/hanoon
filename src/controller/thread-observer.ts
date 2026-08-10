import type { BbPluginApi } from "@bb/plugin-sdk";

type BbSdk = BbPluginApi["sdk"];
type ListedThread = Awaited<ReturnType<BbSdk["threads"]["list"]>>[number];
type Project = Awaited<ReturnType<BbSdk["projects"]["list"]>>[number];

export type ThreadStatusFilter = "active" | "idle" | "error" | "all";

type ThreadProjectionInput = Pick<ListedThread,
  "id" | "projectId" | "environmentId" | "providerId" | "title" | "titleFallback" |
  "status" | "parentThreadId" | "createdAt" | "updatedAt" | "runtime"
> & Partial<Pick<ListedThread,
  "activity" | "hasPendingInteraction" | "environmentHostId" | "environmentName" |
  "environmentBranchName" | "environmentWorkspaceDisplayKind"
>>;

const THREAD_SCAN_LIMIT = 100;
const ACTIVE_STATUSES = new Set(["active", "starting", "stopping"]);
const ACTIVE_RUNTIME_STATUSES = new Set(["active", "starting", "stopping", "provisioning", "host-reconnecting", "waiting-for-host"]);
const ETA_REASON = "BB does not expose a reliable completion estimate for provider turns";

function isActive(thread: ThreadProjectionInput): boolean {
  return ACTIVE_STATUSES.has(thread.status) || ACTIVE_RUNTIME_STATUSES.has(thread.runtime.displayStatus);
}

function matchesFilter(thread: ThreadProjectionInput, filter: ThreadStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return isActive(thread);
  return thread.status === filter || thread.runtime.displayStatus === filter;
}

function projectName(projects: Project[], projectId: string): string | null {
  return projects.find((project) => project.id === projectId)?.name ?? null;
}

function elapsed(now: number, timestamp: number): number {
  return Math.max(0, now - timestamp);
}

function projectThread(thread: ThreadProjectionInput, projects: Project[], now: number) {
  return {
    id: thread.id,
    title: thread.title ?? thread.titleFallback ?? "Untitled thread",
    project: { id: thread.projectId, name: projectName(projects, thread.projectId) },
    providerId: thread.providerId,
    status: thread.status,
    runtimeStatus: thread.runtime.displayStatus,
    parentThreadId: thread.parentThreadId,
    hasPendingInteraction: thread.hasPendingInteraction ?? null,
    activity: thread.activity ?? null,
    environment: {
      id: thread.environmentId,
      name: thread.environmentName ?? null,
      hostId: thread.environmentHostId ?? null,
      branch: thread.environmentBranchName ?? null,
      workspace: thread.environmentWorkspaceDisplayKind ?? null,
    },
    progress: {
      threadAgeMs: elapsed(now, thread.createdAt),
      lastActivityAgoMs: elapsed(now, thread.updatedAt),
      etaMs: null,
      etaReason: ETA_REASON,
    },
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

export type BbThreadProjection = ReturnType<typeof projectThread>;

export async function listVisibleThreads(input: {
  sdk: BbSdk;
  now: number;
  projectId?: string;
  status: ThreadStatusFilter;
  limit: number;
  signal: AbortSignal;
}) {
  const [threads, projects] = await Promise.all([
    input.sdk.threads.list({
      projectId: input.projectId,
      includeHidden: false,
      archived: false,
      limit: THREAD_SCAN_LIMIT,
      signal: input.signal,
    }),
    input.sdk.projects.list({ includePersonal: true, signal: input.signal }),
  ]);
  const matching = threads
    .filter((thread) => thread.visibility === "visible" && thread.archivedAt === null && thread.deletedAt === null)
    .filter((thread) => matchesFilter(thread, input.status))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return {
    observedAt: input.now,
    truncated: matching.length > input.limit || threads.length === THREAD_SCAN_LIMIT,
    threads: matching.slice(0, input.limit).map((thread) => projectThread(thread, projects, input.now)),
  };
}

export async function visibleThreadStatus(input: {
  sdk: BbSdk;
  now: number;
  threadId: string;
  signal: AbortSignal;
}) {
  const thread = await input.sdk.threads.get({ threadId: input.threadId, signal: input.signal });
  if (thread.visibility !== "visible" || thread.archivedAt !== null || thread.deletedAt !== null) {
    throw new Error("The requested BB thread is not visible");
  }
  const [listed, projects] = await Promise.all([
    input.sdk.threads.list({
      projectId: thread.projectId,
      includeHidden: false,
      archived: false,
      limit: THREAD_SCAN_LIMIT,
      signal: input.signal,
    }),
    input.sdk.projects.list({ includePersonal: true, signal: input.signal }),
  ]);
  const enriched = listed.find((candidate) => candidate.id === thread.id) ?? thread;
  return { observedAt: input.now, thread: projectThread(enriched, projects, input.now) };
}
