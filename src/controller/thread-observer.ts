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
const LIST_THREADS_RESULT_BUDGET_BYTES = 5_000;
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

export async function assertVisibleThreadScope(input: {
  sdk: BbSdk;
  threadId: string;
  signal: AbortSignal;
}) {
  const thread = await input.sdk.threads.get({ threadId: input.threadId, signal: input.signal });
  if (thread.visibility !== "visible" || thread.archivedAt !== null || thread.deletedAt !== null) {
    throw new Error("The requested BB thread is not visible");
  }
  return thread;
}

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
  const projectedThreads: BbThreadProjection[] = [];
  let byteLimitReached = false;
  for (const thread of matching.slice(0, input.limit)) {
    const nextProjection = projectThread(thread, projects, input.now);
    const candidateProjection = {
      observedAt: input.now,
      truncated: true,
      threads: [...projectedThreads, nextProjection],
    };
    if (Buffer.byteLength(JSON.stringify(candidateProjection), "utf8") > LIST_THREADS_RESULT_BUDGET_BYTES) {
      byteLimitReached = true;
      break;
    }
    projectedThreads.push(nextProjection);
  }
  return {
    observedAt: input.now,
    truncated: byteLimitReached || matching.length > input.limit || threads.length === THREAD_SCAN_LIMIT,
    threads: projectedThreads,
  };
}

const MAX_ACTIVITY_ITEMS = 8;
const MAX_TRANSCRIPT_CHARS = 1_500;

function tail(value: string | null | undefined, limit: number): string | null {
  const text = value?.trim();
  if (!text) return null;
  return text.length <= limit ? text : `…${text.slice(text.length - limit)}`;
}

/**
 * What the thread is doing right now — its current step, running commands, and
 * latest message. Thread metadata alone cannot answer "why is this slow".
 */
export async function readThreadActivity(input: {
  sdk: BbSdk;
  now: number;
  threadId: string;
  signal: AbortSignal;
}) {
  const thread = await assertVisibleThreadScope(input);
  const [timeline, output, interactions] = await Promise.all([
    input.sdk.threads.timeline({ threadId: input.threadId, summaryOnly: "true", signal: input.signal }),
    input.sdk.threads.output({ threadId: input.threadId, signal: input.signal }),
    input.sdk.threads.interactions.list({ threadId: input.threadId, signal: input.signal }),
  ]);
  const thinking = timeline.activeThinking;
  return {
    observedAt: input.now,
    thread: {
      id: thread.id,
      title: thread.title ?? thread.titleFallback ?? "Untitled thread",
      status: thread.status,
      runtimeStatus: thread.runtime.displayStatus,
      ageMs: elapsed(input.now, thread.createdAt),
      lastActivityAgoMs: elapsed(input.now, thread.updatedAt),
      waitingOnOwner: interactions.some((interaction) => interaction.status === "pending"),
    },
    currentStep: thinking === null ? null : {
      text: tail(thinking.text, 300),
      runningForMs: elapsed(input.now, thinking.startedAt),
      idleForMs: elapsed(input.now, thinking.updatedAt),
    },
    goal: timeline.goal === null ? null : {
      objective: tail(timeline.goal.objective, 300),
      status: timeline.goal.status,
    },
    todos: (timeline.pendingTodos?.items ?? []).slice(0, MAX_ACTIVITY_ITEMS).map((todo) => ({
      text: tail(todo.text, 120),
      status: todo.status,
    })),
    runningCommands: timeline.activeBackgroundCommands.slice(0, MAX_ACTIVITY_ITEMS).map((command) => ({
      description: tail(command.description, 160),
      taskStatus: command.taskStatus,
      runningForMs: elapsed(input.now, command.startedAt),
    })),
    runningWorkflows: timeline.activeWorkflows.slice(0, MAX_ACTIVITY_ITEMS).map((workflow) => ({
      name: workflow.workflowName ?? workflow.taskType,
      taskStatus: workflow.taskStatus,
      runningForMs: elapsed(input.now, workflow.startedAt),
    })),
    latestMessage: tail(output.output, MAX_TRANSCRIPT_CHARS),
    etaReason: ETA_REASON,
  };
}

export async function assertProjectHostScope(input: {
  sdk: BbSdk;
  projectId: string;
  signal: AbortSignal;
}): Promise<string> {
  const projects = await input.sdk.projects.list({ includePersonal: true, signal: input.signal });
  const project = projects.find((candidate) => candidate.id === input.projectId);
  if (!project) throw new Error("That BB project is unavailable");
  const source = project.sources.find((candidate) => candidate.isDefault) ??
    (project.sources.length === 1 ? project.sources[0] : undefined);
  if (!source?.hostId) throw new Error("That BB project has no unambiguous workspace source");
  return source.hostId;
}

export type ThreadImage = {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
};

type ThreadPromptPart =
  | { type: "text"; text: string; mentions: [] }
  | { type: "localImage"; path: string };

async function promptWithImages(
  sdk: BbSdk,
  projectId: string,
  text: string,
  images: readonly ThreadImage[],
): Promise<ThreadPromptPart[]> {
  const input: ThreadPromptPart[] = [{ type: "text", text, mentions: [] }];
  for (const image of images) {
    const uploaded = await sdk.projects.attachments.upload({
      projectId,
      clientFile: image.bytes,
      filename: image.fileName,
      mimeType: image.mimeType,
    });
    if (uploaded.type !== "localImage") {
      throw new Error("BB did not accept the image attachment for that project");
    }
    input.push({ type: "localImage", path: uploaded.path });
  }
  return input;
}

/** Opens a working thread the owner can watch in BB, on its own worktree. */
export async function createProjectThread(input: {
  sdk: BbSdk;
  projectId: string;
  hostId: string;
  title: string;
  prompt: string;
  images?: readonly ThreadImage[];
  signal: AbortSignal;
}) {
  const thread = await input.sdk.threads.spawn({
    projectId: input.projectId,
    title: input.title,
    visibility: "visible",
    input: await promptWithImages(input.sdk, input.projectId, input.prompt, input.images ?? []),
    environment: {
      type: "host",
      hostId: input.hostId,
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    },
  });
  return {
    thread: {
      id: thread.id,
      title: input.title,
      projectId: input.projectId,
      imageCount: input.images?.length ?? 0,
    },
  };
}

/** Continues a thread the owner can see; hidden threads stay off limits. */
export async function sendToVisibleThread(input: {
  sdk: BbSdk;
  threadId: string;
  text: string;
  images?: readonly ThreadImage[];
  signal: AbortSignal;
  assertCanSend?(thread: Awaited<ReturnType<BbSdk["threads"]["get"]>>): void;
}) {
  const thread = await assertVisibleThreadScope(input);
  input.assertCanSend?.(thread);
  await input.sdk.threads.send({
    threadId: input.threadId,
    mode: "auto",
    input: await promptWithImages(input.sdk, thread.projectId, input.text, input.images ?? []),
  });
  return {
    sent: {
      threadId: input.threadId,
      threadName: thread.title,
      status: thread.status,
      imageCount: input.images?.length ?? 0,
    },
  };
}

export async function visibleThreadStatus(input: {
  sdk: BbSdk;
  now: number;
  threadId: string;
  signal: AbortSignal;
}) {
  const thread = await assertVisibleThreadScope(input);
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
