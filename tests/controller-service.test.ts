import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import {
  BbControllerAdapter,
  ControllerAttachmentPreparationError,
  controllerSpawnTitle,
  type ControllerAdapter,
} from "../src/controller/bb-controller";
import {
  DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  type ControllerExecutionProfile,
} from "../src/controller/execution-profile";
import {
  CONTROLLER_BUSY_NOTICE_MS,
  CONTROLLER_BUSY_ROLLOVER_MS,
  CONTROLLER_STALL_MS,
  LunaControllerService,
} from "../src/controller/service";
import { completeAcceptedControllerTurn, validEvidenceInput } from "./support/controller-trust-fixtures";

const evidenceProjector = {
  reconcile: vi.fn(async (...args: unknown[]) => ({
    outcome: "reconciled" as const,
    reconciliationIncomplete: null,
    fromSeq: 0,
    throughSeq: Number(args[1] && typeof args[1] === "object" && "evidenceEventSeq" in args[1]
      ? (args[1] as { evidenceEventSeq: number }).evidenceEventSeq
      : 0),
    targetSeq: typeof args[4] === "number" ? args[4] : 0,
  })),
};

function personalProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj_personal",
    kind: "personal",
    name: "Personal",
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    sources: [{
      id: "src_personal",
      projectId: "proj_personal",
      isDefault: true,
      createdAt: 1,
      updatedAt: 1,
      type: "local_path",
      hostId: "host_personal",
      path: "/personal",
    }],
    ...overrides,
  };
}

function controllerRecord(overrides: Record<string, unknown> = {}) {
  return {
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    projectId: null,
    hostId: null,
    threadId: null,
    state: "pending_spawn",
    pendingSpawnToken: "controller-turn-1",
    capabilitySubjectId: null,
    capabilityProfileId: null,
    capabilityProfileRevision: 0,
    lastError: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as const;
}

function turnRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "controller-turn-1",
    updateId: 1,
    controllerKey: "owner-7-controller",
    ordinal: 1,
    inputText: "What projects can you work on?",
    image: null,
    document: null,
    source: null,
    burstLeaderTurnId: null,
    state: "dispatching",
    leaseOwner: "executor",
    leaseGeneration: 1,
    dispatchAfterSeq: 0,
    deliveryState: "none",
    dispatchKind: null,
    dispatchCorrelationId: null,
    dispatchRetryCount: 0,
    deliveryReconcileAttempts: 0,
    busyWaitNotifiedAt: null,
    nextDispatchAt: 0,
    retryCount: 0,
    modelFallbackIndex: 0,
    bbEventSeq: 0,
    evidenceEventSeq: 0,
    completionContinuations: 0,
    acceptedFinalizationId: null,
    inputAccepted: false,
    privateDraftItemId: null,
    privateDraftText: "",
    recoverySourceTurnId: null,
    evidenceLimitExceededAt: null,
    streamText: "",
    telegramMessageId: null,
    streamPhase: "queued",
    responseText: null,
    lastError: null,
    submittedAt: null,
    completedAt: null,
    awaitingInteractionId: null,
    toolCalls: 0,
    commandFailures: 0,
    totalTokens: 0,
    tokenBaseline: null,
    origin: "owner",
    capabilityProfileId: null,
    capabilityProfileRevision: 0,
    capabilityConfiguredRevision: 0,
    capabilityContinuationCount: 0,
    capabilityContinuationState: null,
    supervisorSteers: 0,
    supervisorReasons: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as const;
}

function sdkFixture(options: {
  projects?: unknown[];
  threads?: unknown[];
  hosts?: unknown[];
  events?: unknown[];
  eventPages?: unknown[][];
  maxSeq?: number;
  threadProvider?: string;
  executionProfile?: ControllerExecutionProfile;
  executionProfiles?: readonly ControllerExecutionProfile[];
  downloadFile?: (fileId: string, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array>;
} = {}) {
  const spawn = vi.fn(async () => ({ id: "thr_controller", environmentId: "env_personal" }));
  const send = vi.fn(async () => ({ ok: true }));
  const upload = vi.fn(async (input: {
    clientFile: Uint8Array;
    filename: string;
    mimeType?: string;
  }) => ({
    // BB files an image as an image and anything else as a plain file.
    type: input.mimeType?.startsWith("image/") ? "localImage" as const : "localFile" as const,
    path: `/attachments/${input.filename}`,
    name: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.clientFile.byteLength,
  }));
  const list = vi.fn(async () => options.threads ?? []);
  const get = vi.fn(async (_input?: { signal?: AbortSignal }) => ({
    id: "thr_controller",
    status: "idle",
    providerId: options.threadProvider ?? "claude-code",
    archivedAt: null,
    deletedAt: null,
  }));
  const output = vi.fn(async () => ({ output: "Hello from Luna." }));
  const pages = options.eventPages ?? [options.events ?? []];
  let page = 0;
  const eventsList = vi.fn(async (_input: {
    threadId: string;
    afterSeq?: string;
    limit?: string;
    signal?: AbortSignal;
  }) => pages[page++] ?? []);
  const timeline = vi.fn(async () => ({ maxSeq: options.maxSeq ?? 0 }));
  const sdk = {
    projects: {
      list: vi.fn(async () => options.projects ?? [personalProject()]),
      attachments: { upload },
    },
    hosts: { list: vi.fn(async () => options.hosts ?? [{ id: "host_personal", status: "connected" }]) },
    threads: { spawn, send, list, get, output, timeline, events: { list: eventsList } },
  } as unknown as BbPluginApi["sdk"];
  const dependencies = {
    sdk,
    pluginId: "telegram-agent",
    executionProfile: () => options.executionProfile ?? DEFAULT_CONTROLLER_EXECUTION_PROFILE,
    executionProfiles: () => options.executionProfiles ?? [options.executionProfile ?? DEFAULT_CONTROLLER_EXECUTION_PROFILE],
    now: () => 2_000,
    reserveSpawn: () => true,
    downloadFile: options.downloadFile,
  };
  return { adapter: new BbControllerAdapter(dependencies), spawn, send, upload, list, get, eventsList, timeline };
}

function agentDelta(seq: number, delta: string) {
  return {
    id: `e${seq}`,
    threadId: "thr_controller",
    seq,
    createdAt: seq,
    scope: { kind: "thread" },
    type: "item/agentMessage/delta",
    data: { delta },
  };
}

it("spawns the hidden personal controller on the configured model and provider", async () => {
  const { adapter, spawn } = sdkFixture();
  const turn = turnRecord();

  await adapter.spawn(turn, controllerRecord(), AbortSignal.timeout(1_000));

  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
    projectId: "proj_personal",
    providerId: "claude-code",
    model: "claude-opus-5[1m]",
    reasoningLevel: "xhigh",
    permissionMode: "auto",
    visibility: "hidden",
    environment: {
      type: "host",
      hostId: "host_personal",
      workspace: { type: "personal" },
    },
    executionInputSources: {
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
      permissionMode: "explicit",
    },
    input: [{ type: "text", text: turn.inputText, mentions: [] }],
  }));
});

it("keeps the configured execution tuple on later controller turns", async () => {
  const { adapter, send } = sdkFixture();

  await adapter.send("thr_controller", "Show active threads", AbortSignal.timeout(1_000));

  expect(send).toHaveBeenCalledWith({
    threadId: "thr_controller",
    mode: "start",
    model: "claude-opus-5[1m]",
    reasoningLevel: "xhigh",
    permissionMode: "auto",
    executionInputSources: {
      model: "explicit",
      reasoningLevel: "explicit",
      permissionMode: "explicit",
    },
    input: [{ type: "text", text: "Show active threads", mentions: [] }],
  });
});

it("uploads and attaches a Telegram image to a controller turn", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const downloadFile = vi.fn(async () => bytes);
  const { adapter, send, upload } = sdkFixture({ downloadFile });
  const signal = AbortSignal.timeout(1_000);

  await adapter.send("thr_controller", "Fix this overlap", signal, [{
    fileId: "telegram-file-id",
    fileName: "telegram-screenshot.png",
    mimeType: "image/png",
    sizeBytes: 4,
    kind: "image",
  }]);

  expect(downloadFile).toHaveBeenCalledWith("telegram-file-id", 10 * 1024 * 1024, signal);
  expect(upload).toHaveBeenCalledWith(expect.objectContaining({
    projectId: "proj_personal",
    clientFile: bytes,
    filename: "telegram-screenshot.png",
    mimeType: "image/png",
  }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    input: [
      { type: "text", text: "Fix this overlap", mentions: [] },
      { type: "localImage", path: "/attachments/telegram-screenshot.png" },
    ],
  }));
});

it("attaches a document from the bytes it was handed without downloading it again", async () => {
  const bytes = new TextEncoder().encode("# The brief\nShip on Friday.");
  const downloadFile = vi.fn(async () => { throw new Error("must not be called"); });
  const { adapter, send, upload } = sdkFixture({ downloadFile });

  await adapter.send("thr_controller", "Please read this file.", AbortSignal.timeout(1_000), [{
    fileId: "md-file",
    fileName: "brief.md",
    mimeType: "text/markdown",
    sizeBytes: bytes.byteLength,
    kind: "document",
    bytes,
  }]);

  expect(downloadFile).not.toHaveBeenCalled();
  expect(upload).toHaveBeenCalledWith(expect.objectContaining({
    clientFile: bytes,
    filename: "brief.md",
    mimeType: "text/markdown",
  }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    input: [
      { type: "text", text: "Please read this file.", mentions: [] },
      { type: "localFile", path: "/attachments/brief.md", name: "brief.md", mimeType: "text/markdown", sizeBytes: bytes.byteLength },
    ],
  }));
});

it("classifies a document download failure by its own kind", async () => {
  const downloadFile = vi.fn(async () => { throw new Error("temporary Telegram outage"); });
  const { adapter, send } = sdkFixture({ downloadFile });

  await expect(adapter.send("thr_controller", "Please read this file.", AbortSignal.timeout(1_000), [{
    fileId: "pdf-file",
    fileName: "review.pdf",
    mimeType: "application/pdf",
    sizeBytes: null,
    kind: "document",
  }])).rejects.toMatchObject({ name: "ControllerAttachmentPreparationError", retryable: true, kind: "document" });
  expect(send).not.toHaveBeenCalled();
});

it("uses BB's active-steer mode for a text correction", async () => {
  const { adapter, send } = sdkFixture();

  await adapter.steer("thr_controller", "Use the second option instead", AbortSignal.timeout(1_000));

  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    threadId: "thr_controller",
    mode: "steer-if-active",
  }));
});

it("bounds one provider status RPC with the caller abort signal and a hard deadline", async () => {
  vi.useFakeTimers();
  const callerAbort = new AbortController();
  const { adapter, get } = sdkFixture();
  let providerSignal: AbortSignal | undefined;
  get.mockImplementation(async (input?: { signal?: AbortSignal }) => {
    providerSignal = input?.signal;
    await new Promise<void>((_resolve, reject) => {
      input?.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
    });
    throw new Error("unreachable");
  });
  let outcome: "pending" | "resolved" | "rejected" = "pending";
  const status = adapter.status("thr_controller", callerAbort.signal).then(
    () => { outcome = "resolved"; },
    () => { outcome = "rejected"; },
  );

  try {
    await vi.advanceTimersByTimeAsync(30_001);

    expect(outcome).toBe("rejected");
    expect(providerSignal).toBeDefined();
    expect(providerSignal).not.toBe(callerAbort.signal);
    expect(providerSignal?.aborted).toBe(true);
  } finally {
    callerAbort.abort();
    await status;
    vi.useRealTimers();
  }
});

it("allows only one abandoned provider mutation to remain in flight", async () => {
  vi.useFakeTimers();
  let releaseFirst!: () => void;
  const firstProviderCall = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const { adapter, send } = sdkFixture();
  send.mockImplementationOnce(async () => {
    await firstProviderCall;
    return { ok: true };
  });
  const first = adapter.send("thr_controller", "first", new AbortController().signal);
  const firstOutcome = first.then(
    () => null,
    (error: unknown) => error,
  );

  try {
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await firstOutcome).toBeInstanceOf(Error);
    expect((await firstOutcome as Error).message).toMatch(/30000ms/);

    await expect(adapter.send(
      "thr_controller",
      "second",
      new AbortController().signal,
    )).rejects.toThrow(/previous controller mutation/i);
    expect(send).toHaveBeenCalledOnce();

    releaseFirst();
    for (let microtask = 0; microtask < 20 && adapter.hasPendingMutation(); microtask += 1) {
      await Promise.resolve();
    }
    expect(adapter.hasPendingMutation()).toBe(false);
    await expect(adapter.send(
      "thr_controller",
      "third",
      new AbortController().signal,
    )).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    releaseFirst();
    vi.useRealTimers();
  }
});

it("classifies a pre-submit image download failure as retryable", async () => {
  const downloadFile = vi.fn(async () => { throw new Error("temporary Telegram outage"); });
  const { adapter, send } = sdkFixture({ downloadFile });

  await expect(adapter.send("thr_controller", "Inspect this", AbortSignal.timeout(1_000), [{
    fileId: "telegram-file-id",
    fileName: "telegram-screenshot.png",
    mimeType: "image/png",
    sizeBytes: null,
    kind: "image",
  }])).rejects.toMatchObject({ name: "ControllerAttachmentPreparationError", retryable: true, kind: "image" });
  expect(send).not.toHaveBeenCalled();
});

it("reduces BB controller events after the durable sequence without exposing reasoning", async () => {
  const events = [
    { id: "e11", threadId: "thr_controller", seq: 11, createdAt: 11, scope: { kind: "thread" }, type: "turn/input/accepted", data: {} },
    { id: "e12", threadId: "thr_controller", seq: 12, createdAt: 12, scope: { kind: "thread" }, type: "item/reasoning/textDelta", data: { delta: "private chain" } },
    { id: "e13", threadId: "thr_controller", seq: 13, createdAt: 13, scope: { kind: "thread" }, type: "item/agentMessage/delta", data: { delta: "Hello" } },
    { id: "e14", threadId: "thr_controller", seq: 14, createdAt: 14, scope: { kind: "thread" }, type: "turn/completed", data: {} },
  ];
  const { adapter, eventsList } = sdkFixture({ events });
  const signal = AbortSignal.timeout(1_000);

  await expect(adapter.events("thr_controller", 10, signal)).resolves.toEqual({
    latestSeq: 14,
    inputAccepted: true,
    assistantOutputObserved: true,
    toolActivityObserved: false,
    completed: true,
    failure: null,
    assistantDraft: { itemId: null, text: "Hello" },
    interactionReferences: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
  });
  expect(eventsList).toHaveBeenCalledOnce();
  const eventRequest = eventsList.mock.calls[0]?.[0];
  expect(eventRequest).toMatchObject({
    threadId: "thr_controller",
    afterSeq: "10",
    limit: "100",
  });
  if (!eventRequest?.signal) throw new Error("event request did not receive a cancellation signal");
  expect(eventRequest.signal).not.toBe(signal);
  expect(eventRequest.signal.aborted).toBe(false);
});

it.each([
  ["startup timeout", { type: "system/error", data: { code: "provider_initialization_timeout", message: "Provider initialization timed out" } }, "startup_timeout", true],
  ["process exit", { type: "system/error", data: { code: "provider_process_exit", message: "Provider process exited with code 143" } }, "process_exit", true],
  ["expired OAuth", { type: "provider/error", data: { message: "OAuth token expired", errorInfo: { category: "unauthorized", providerCode: "oauth_expired", httpStatusCode: 401 } } }, "oauth_expired", false],
  ["host disconnect", { type: "system/error", data: { code: "host_daemon_disconnected", message: "Host daemon disconnected" } }, "host_disconnected", true],
  ["RPC timeout", { type: "system/error", data: { code: "json_rpc_timeout", message: "JSON-RPC request timed out" } }, "rpc_timeout", true],
  ["hard provider rejection", { type: "provider/error", data: { message: "bad request bearer sk-live-secret", errorInfo: { category: "bad-request", providerCode: "invalid_request", httpStatusCode: 400 } } }, "provider_rejected", false],
  ["unknown", { type: "system/error", data: { code: "unclassified", message: "bearer sk-live-secret" } }, "unknown", true],
] as const)("classifies %s without retaining provider prose", async (_label, errorEvent, code, retryable) => {
  const events = [
    { id: "accepted", threadId: "thr_controller", seq: 1, createdAt: 1, scope: { kind: "turn" }, type: "turn/input/accepted", data: {} },
    { id: "failure", threadId: "thr_controller", seq: 2, createdAt: 2, scope: { kind: "turn" }, ...errorEvent },
  ];
  const { adapter } = sdkFixture({ events });

  const observation = await adapter.events("thr_controller", 0, AbortSignal.timeout(1_000));

  expect(observation).toMatchObject({
    inputAccepted: true,
    failure: { code, retryable, willRetry: false, inputAccepted: true },
  });
  expect(JSON.stringify(observation)).not.toContain("sk-live-secret");
  expect(observation).not.toHaveProperty("error");
});

it("preserves a provider-owned retry signal and a bounded private assistant draft", async () => {
  const events = [
    { id: "accepted", threadId: "thr_controller", seq: 1, createdAt: 1, scope: { kind: "turn" }, type: "turn/input/accepted", data: {} },
    { id: "draft-1", threadId: "thr_controller", seq: 2, createdAt: 2, scope: { kind: "turn" }, type: "item/agentMessage/delta", data: { itemId: "message-1", delta: "A private partial answer" } },
    { id: "retry", threadId: "thr_controller", seq: 3, createdAt: 3, scope: { kind: "turn" }, type: "provider/error", data: { message: "temporary overload", willRetry: true, errorInfo: { category: "overloaded", providerCode: null, httpStatusCode: 529 } } },
  ];
  const { adapter } = sdkFixture({ events });

  await expect(adapter.events("thr_controller", 0, AbortSignal.timeout(1_000))).resolves.toMatchObject({
    assistantDraft: { itemId: "message-1", text: "A private partial answer" },
    failure: { retryable: true, willRetry: true, inputAccepted: true },
  });
});

it("reads every page of BB controller events rather than the first hundred", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => agentDelta(index + 1, "a"));
  const { adapter, eventsList } = sdkFixture({
    eventPages: [firstPage, [agentDelta(101, "b"), { ...agentDelta(102, "" ), type: "turn/completed", data: {} }]],
  });

  await expect(adapter.events("thr_controller", 0, AbortSignal.timeout(1_000))).resolves.toMatchObject({
    latestSeq: 102,
    assistantOutputObserved: true,
    completed: true,
  });
  expect(eventsList).toHaveBeenCalledTimes(2);
  expect(eventsList).toHaveBeenLastCalledWith(expect.objectContaining({ afterSeq: "100" }));
});

it("takes a new turn's baseline from the thread high-water sequence", async () => {
  const { adapter, timeline } = sdkFixture({ maxSeq: 4_211 });

  await expect(adapter.latestSeq("thr_controller", AbortSignal.timeout(1_000))).resolves.toBe(4_211);
  expect(timeline).toHaveBeenCalledWith(expect.objectContaining({
    threadId: "thr_controller",
    summaryOnly: "true",
  }));
});

it("uses the only connected host when the personal project has no source binding", async () => {
  const { adapter, spawn } = sdkFixture({
    projects: [personalProject({ sources: [] })],
    hosts: [
      { id: "host_offline", status: "disconnected" },
      { id: "host_connected", status: "connected" },
    ],
  });

  await adapter.spawn(turnRecord(), controllerRecord(), AbortSignal.timeout(1_000));

  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
    projectId: "proj_personal",
    environment: {
      type: "host",
      hostId: "host_connected",
      workspace: { type: "personal" },
    },
  }));
});

it("uses the configured execution profile for initial and later controller turns", async () => {
  const executionProfile: ControllerExecutionProfile = {
    model: "gpt-5.6-terra",
    reasoningLevel: "high",
    serviceTier: "default",
    permissionMode: "accept-edits",
  };
  const { adapter, spawn, send } = sdkFixture({ executionProfile });

  await adapter.spawn(turnRecord(), controllerRecord(), AbortSignal.timeout(1_000));
  await adapter.send("thr_controller", "Show active threads", AbortSignal.timeout(1_000));

  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
    providerId: "codex",
    title: controllerSpawnTitle("owner-7-controller", "controller-turn-1", "proj_personal", "host_personal", "codex"),
    ...executionProfile,
    executionInputSources: {
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
      serviceTier: "explicit",
      permissionMode: "explicit",
    },
  }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    threadId: "thr_controller",
    ...executionProfile,
    executionInputSources: {
      model: "explicit",
      reasoningLevel: "explicit",
      serviceTier: "explicit",
      permissionMode: "explicit",
    },
  }));
});

it("selects the durable execution-profile index for spawn, send, status, and adoption", async () => {
  const fallback: ControllerExecutionProfile = {
    model: "gpt-5.6-terra",
    reasoningLevel: "high",
    serviceTier: "default",
    permissionMode: "accept-edits",
  };
  const { adapter, spawn, send } = sdkFixture({
    executionProfiles: [DEFAULT_CONTROLLER_EXECUTION_PROFILE, fallback],
    threadProvider: "codex",
  });

  await adapter.spawn(turnRecord({ modelFallbackIndex: 1 }), controllerRecord(), AbortSignal.timeout(1_000));
  await adapter.send("thr_controller", "fallback send", AbortSignal.timeout(1_000), null, 1);

  expect(adapter.configuredProfileCount?.()).toBe(2);
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ model: fallback.model }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ model: fallback.model }));
  await expect(adapter.status("thr_controller", AbortSignal.timeout(1_000), 1)).resolves.toBe("idle");
});

it("preserves an explicitly configured full permission mode on spawn and send", async () => {
  const executionProfile: ControllerExecutionProfile = {
    model: "claude-opus-5[1m]",
    reasoningLevel: "xhigh",
    serviceTier: "default",
    permissionMode: "full",
  };
  const { adapter, spawn, send } = sdkFixture({ executionProfile });

  await adapter.spawn(turnRecord(), controllerRecord(), AbortSignal.timeout(1_000));
  await adapter.send("thr_controller", "Show active threads", AbortSignal.timeout(1_000));

  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "full" }));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: "full" }));
});

it("fails closed when an unbound personal project has multiple connected hosts", async () => {
  const { adapter, spawn } = sdkFixture({
    projects: [personalProject({ sources: [] })],
    hosts: [
      { id: "host_one", status: "connected" },
      { id: "host_two", status: "connected" },
    ],
  });

  await expect(adapter.spawn(turnRecord(), controllerRecord(), AbortSignal.timeout(1_000)))
    .rejects.toThrow(/connected host|ambiguous/i);
  expect(spawn).not.toHaveBeenCalled();
});

it.each([
  ["missing personal project", []],
  ["missing default host", [personalProject({ sources: [{ ...personalProject().sources[0], hostId: "" }] })]],
  ["ambiguous personal source", [personalProject({ sources: [
    { ...personalProject().sources[0], isDefault: false, id: "one" },
    { ...personalProject().sources[0], isDefault: false, id: "two" },
  ] })]],
])("fails closed for %s", async (_label, projects) => {
  const { adapter, spawn } = sdkFixture({ projects });
  await expect(adapter.spawn(turnRecord(), controllerRecord(), AbortSignal.timeout(1_000))).rejects.toThrow(/personal|source|host/i);
  expect(spawn).not.toHaveBeenCalled();
});

it("adopts only one exact plugin-origin hidden spawn candidate", async () => {
  const candidate = {
    id: "thr_candidate",
    projectId: "proj_personal",
    providerId: "claude-code",
    status: "idle",
    title: controllerSpawnTitle("owner-7-controller", "controller-turn-1", "proj_personal", "host_personal", "claude-code"),
    visibility: "hidden",
    originPluginId: "telegram-agent",
    environmentHostId: "host_personal",
    archivedAt: null,
    deletedAt: null,
  };
  const one = sdkFixture({ threads: [candidate] });
  await expect(one.adapter.findSpawnCandidate("owner-7-controller", "controller-turn-1", AbortSignal.timeout(1_000))).resolves.toMatchObject({
    threadId: "thr_candidate",
    projectId: "proj_personal",
    hostId: "host_personal",
  });

  const ambiguous = sdkFixture({ threads: [candidate, { ...candidate, id: "thr_other" }] });
  await expect(ambiguous.adapter.findSpawnCandidate("owner-7-controller", "controller-turn-1", AbortSignal.timeout(1_000))).rejects.toThrow(/multiple|ambiguous/i);
});

it("does not re-adopt the errored production controller during recovery", async () => {
  const poisoned = {
    id: "thr_n2uyc2p445",
    projectId: "proj_personal",
    providerId: "codex",
    status: "error",
    title: "Telegram Luna controller owner-7-controller",
    visibility: "hidden",
    originPluginId: "telegram-agent",
    archivedAt: null,
    deletedAt: null,
  };
  const { adapter } = sdkFixture({ threads: [poisoned] });

  await expect(adapter.findSpawnCandidate("owner-7-controller", "controller-turn-1", AbortSignal.timeout(1_000))).resolves.toBeNull();
});

it("passes the current pending token to adoption so a stale title yields a fresh spawn", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 77, inputText: "start fresh" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const findSpawnCandidate = vi.fn(async (controllerKey: string, pendingSpawnToken: string) => {
    expect(controllerKey).toBe("owner-7-controller");
    expect(pendingSpawnToken).toBe(turn.id);
    // The adapter has already ignored a stale T1 title; only the current T2
    // token may participate in adoption.
    return null;
  });
  const spawn = vi.fn(async (spawnTurn: { id: string }) => {
    expect(store.reserveControllerSpawn({
      controllerKey: "owner-7-controller",
      turnId: spawnTurn.id,
      projectId: "proj_personal",
      hostId: "host_personal",
      now: 0,
    })).toBe(true);
    return {
      threadId: "thr_fresh_token",
      projectId: "proj_personal",
      hostId: "host_personal",
      spawnToken: spawnTurn.id,
    };
  });
  const adapter: ControllerAdapter = {
    spawn,
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantOutputObserved: false, toolActivityObserved: false, completed: false, error: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate,
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(findSpawnCandidate).toHaveBeenCalledWith("owner-7-controller", turn.id, fence.signal, 0);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ threadId: "thr_fresh_token", state: "active" });
});

it("adopts an exact image spawn candidate before preparing the image again", async () => {
  const { store, fence, clock } = serviceFixture();
  const image = {
    fileId: "telegram-image-before-map",
    fileName: "telegram-screenshot.png",
    mimeType: "image/png" as const,
    sizeBytes: 12,
  };
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 78, inputText: "Read this screenshot", image }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const findSpawnCandidate = vi.fn(async (controllerKey: string, pendingSpawnToken: string) => {
    expect(controllerKey).toBe("owner-7-controller");
    expect(pendingSpawnToken).toBe(turn.id);
    return {
      threadId: "thr_image_recovered",
      projectId: "proj_personal",
      hostId: "host_personal",
      spawnToken: turn.id,
    };
  });
  const spawn = vi.fn(async () => {
    throw new Error("image spawn should not be repeated after adoption");
  });
  const adapter: ControllerAdapter = {
    spawn,
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: false,
      assistantOutputObserved: false,
      toolActivityObserved: false,
      completed: false,
      error: null,
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate,
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  expect(findSpawnCandidate).toHaveBeenCalledTimes(1);
  expect(spawn).not.toHaveBeenCalled();
  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    threadId: "thr_image_recovered",
    state: "active",
  });
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "submitted", image });
});

let serviceFixtureNumber = 0;
function serviceFixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-controller-service-${serviceFixtureNumber++}` });
  // The clock is mutable: a burst must go quiet before the executor claims it,
  // so tests advance time past the quiet gap instead of claiming instantly.
  const clock = { now: () => 2_000 } as { now(): number; tick(ms: number): void };
  let time = 2_000;
  clock.now = () => time;
  clock.tick = (ms: number) => { time += ms; };
  const store = openStore(bb.storage, bb.storage.kv, clock.now);
  store.createPairingCode(hashSecret("pair"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001)).toEqual({ ok: true });
  const lease = store.acquireExecutorLease("executor", 2_000, 30_000);
  if (!lease.acquired) throw new Error("missing lease");
  const fence = { ownerId: "executor", generation: lease.generation, signal: AbortSignal.timeout(2_000) };
  return { db: bb.storage.database(), store, fence, clock, reopen: () => openStore(bb.storage, bb.storage.kv, clock.now) };
}

function reserveControllerSpawnForTest(
  store: ReturnType<typeof serviceFixture>["store"],
  turnId: string,
  now = 2_000,
  projectId = "proj_personal",
  hostId = "host_personal",
): void {
  const turn = store.getControllerTurn(turnId);
  if (!turn) throw new Error("missing controller turn for spawn reservation");
  if (!store.reserveControllerSpawn({
    controllerKey: turn.controllerKey,
    turnId,
    projectId,
    hostId,
    now,
  })) {
    throw new Error("controller spawn reservation failed");
  }
}

function activateControllerForServiceTest(
  store: ReturnType<typeof serviceFixture>["store"],
  fence: ReturnType<typeof serviceFixture>["fence"],
  updateId: number,
  threadId: string,
  now = 2_000,
): void {
  const setup = store.enqueueControllerTurn({
    ...turnRecord({ updateId, inputText: "controller setup" }),
    telegramUserId: "7",
    telegramChatId: "7",
    // Received before the quiet gap, so the executor claims it at `now`.
    now: Math.max(0, now - 3_000),
  });
  expect(store.claimNextControllerTurn({ ...fence, now })?.id).toBe(setup.id);
  reserveControllerSpawnForTest(store, setup.id, now);
  expect(store.markControllerSpawned({
    ...fence,
    now,
    turnId: setup.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId,
    spawnToken: setup.id,
  })).toBe(true);
  expect(store.failControllerTurn({
    ...fence,
    now,
    turnId: setup.id,
    error: "controller test setup completed",
  })).toBe(true);
}

function recordServiceQuestion(
  store: ReturnType<typeof serviceFixture>["store"],
  fence: { ownerId: string; generation: number; now?: number },
  turnId: string,
  interactionId: string,
): string {
  const turn = store.getControllerTurn(turnId);
  if (!turn) throw new Error("missing service turn");
  const generation = store.listControllerGenerations(turn.controllerKey, 1)[0];
  if (!generation) throw new Error("missing service generation");
  return store.recordControllerInteraction({
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: fence.now ?? 2_000,
    turnId,
    controllerKey: turn.controllerKey,
    bbThreadId: generation.threadId,
    controllerGenerationId: generation.id,
    interaction: {
      kind: "user_question",
      interactionId,
      questions: [{
        id: "question-needs-owner-restart",
        prompt: "Should I continue?",
        shortLabel: "Continue",
        multiSelect: false,
        allowFreeText: true,
        options: [{ value: "yes", label: "Yes", description: "Continue" }],
      }],
    },
  });
}

function acceptControllerFinalization(
  store: ReturnType<typeof serviceFixture>["store"],
  turnId: string,
  text = "Durable accepted answer.",
  bbEventHighWaterSeq = 0,
) {
  const current = store.getControllerTurn(turnId);
  if (!current) throw new Error("controller finalization fixture turn disappeared");
  if (bbEventHighWaterSeq > current.evidenceEventSeq) {
    expect(store.recordControllerNativeEvidence({
      ownerId: "executor",
      generation: 1,
      now: 0,
      turnId,
      controllerKey: current.controllerKey,
      fromSeq: current.evidenceEventSeq,
      throughSeq: bbEventHighWaterSeq,
      items: [],
    })).toBe("recorded");
  }
  const accepted = store.proposeControllerFinalization({
    ownerId: "executor",
    generation: 1,
    now: 0,
    turnId,
    controllerKey: "owner-7-controller",
    bbEventHighWaterSeq,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text }],
      obligationRefs: [],
    },
  });
  if (accepted.outcome !== "accepted") throw new Error("controller finalization fixture was not accepted");
  return accepted.finalization;
}

function acceptNeedsOwnerFinalization(
  store: ReturnType<typeof serviceFixture>["store"],
  turnId: string,
) {
  const accepted = store.proposeControllerFinalization({
    ownerId: "executor",
    generation: 1,
    now: 2_000,
    turnId,
    controllerKey: "owner-7-controller",
    bbEventHighWaterSeq: 0,
    candidate: {
      disposition: "needs_owner",
      segments: [{ type: "text", text: "Please choose one option." }],
      obligationRefs: [],
    },
  });
  if (accepted.outcome !== "accepted") throw new Error("needs-owner finalization fixture was not accepted");
  return accepted.finalization;
}

function submittedServiceTurn(
  store: ReturnType<typeof serviceFixture>["store"],
  fence: ReturnType<typeof serviceFixture>["fence"],
  input: { updateId: number; threadId: string; inputText?: string },
) {
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: input.updateId, inputText: input.inputText ?? "recover this turn" }),
    telegramUserId: "7",
    telegramChatId: "7",
    // Received before the quiet gap, so the executor claims it at 5_000 and
    // every later service pass is quiet too.
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ...fence, now: 5_000 })?.id).toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: input.threadId,
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, now: 2_000, turnId: turn.id })).toBe(true);
  return turn;
}

it("ignores raw provider output and completes only from the accepted finalization", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 66, inputText: "answer from evidence" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id)
    .toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_accepted_only",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
  })).toBe(true);
  const accepted = acceptControllerFinalization(store, turn.id);
  const rawOutput = vi.fn(async () => "RAW PROVIDER OUTPUT MUST NOT SHIP");
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 1,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: true,
      error: null,
      pendingQuestion: null,
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "completed",
    responseText: accepted.renderedMessage,
    streamText: "Hanoon finished.",
  });
  expect(rawOutput).not.toHaveBeenCalled();
  expect(store.readControllerDigest("owner-7-controller", 10)[0]?.agentText)
    .toBe(accepted.renderedMessage);
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toBe(accepted.renderedMessage);
});

it("delivers an accepted finalization while the provider is still active", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 67, inputText: "wait for terminal" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id).toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000,
    projectId: "proj_personal", hostId: "host_personal", threadId: "thr_active_accepted", spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })).toBe(true);
  const accepted = acceptControllerFinalization(store, turn.id);
  expect(store.renewExecutorLease(
    fence.ownerId,
    fence.generation,
    2_001,
    CONTROLLER_STALL_MS + 10_000,
  )).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 1, inputAccepted: true, assistantOutputObserved: true, toolActivityObserved: false, completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "completed",
    responseText: accepted.renderedMessage,
  });
  expect(store.getAcceptedControllerFinalization(turn.id)?.consumedAt).toBe(2_000);
  expect(store.readControllerDigest("owner-7-controller", 10)[0]?.agentText).toBe(accepted.renderedMessage);
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toBe(accepted.renderedMessage);
});

it("retires a turn when a legacy accepted envelope fails evidence revalidation", async () => {
  const { db, store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 68, inputText: "revalidate the accepted answer" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id)
    .toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000,
    projectId: "proj_personal", hostId: "host_personal", threadId: "thr_legacy_envelope", spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })).toBe(true);
  const evidence = store.recordControllerEvidence({ ...validEvidenceInput(turn), ...fence, now: 2_000 });
  if (evidence.outcome !== "recorded") throw new Error("legacy envelope evidence fixture was not recorded");
  const accepted = store.proposeControllerFinalization({
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    bbEventHighWaterSeq: 0,
    candidate: {
      disposition: "answered",
      segments: [{
        type: "claim",
        text: "The project is available.",
        kind: "observed_state",
        outcome: "observed",
        subjectRef: "project:proj_1",
        evidenceRefs: [evidence.evidence.ref],
      }],
      obligationRefs: [],
    },
  });
  if (accepted.outcome !== "accepted") throw new Error("legacy envelope finalization fixture was not accepted");
  db.prepare(
    "UPDATE controller_finalizations SET envelope_version = 1, payload_json = ?, rendered_message = ? WHERE id = ?",
  ).run(JSON.stringify({
    _hanoonControllerFinalization: accepted.finalization.candidate,
    bbEventHighWaterSeq: 0,
  }), accepted.finalization.renderedMessage, accepted.finalization.id);
  db.prepare(
    "UPDATE controller_evidence SET proof_kinds_json = '[\"command_result\"]' WHERE id = ?",
  ).run(evidence.evidence.id);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: true, assistantOutputObserved: false, toolActivityObserved: false, completed: true, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(adapter.steer).not.toHaveBeenCalled();
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "failed",
    lastError: "Accepted controller finalization failed semantic revalidation",
  });
});

it.each(["source_gap", "page_cap"] as const)(
  "delivers an accepted turn despite transient evidence %s",
  async (reconciliationIncomplete) => {
    const { store, fence, clock } = serviceFixture();
    const turn = store.enqueueControllerTurn({
      ...turnRecord({ updateId: 670, inputText: "retry evidence safely" }),
      telegramUserId: "7",
      telegramChatId: "7",
      now: 2_000,
    });
    expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id)
      .toBe(turn.id);
    reserveControllerSpawnForTest(store, turn.id);
    expect(store.markControllerSpawned({
      turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000,
      projectId: "proj_personal", hostId: "host_personal", threadId: `thr_gap_${reconciliationIncomplete}`,
      spawnToken: turn.id,
    })).toBe(true);
    expect(store.markControllerTurnSubmitted({ turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })).toBe(true);
    const accepted = acceptControllerFinalization(store, turn.id);
    const projector = {
      reconcile: vi.fn(async () => ({
        outcome: "reconciled" as const,
        reconciliationIncomplete,
        fromSeq: 0,
        throughSeq: 0,
        targetSeq: 0,
      })),
    };
    const adapter: ControllerAdapter = {
      spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
      send: vi.fn(async () => undefined),
      status: vi.fn(async () => "active" as const),
      latestSeq: vi.fn(async () => 0),
      events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: true, assistantOutputObserved: true, toolActivityObserved: false, completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
      steer: vi.fn(async () => undefined),
      answerQuestion: vi.fn(async () => undefined),
      findSpawnCandidate: vi.fn(async () => null),
    };
    const service = new LunaControllerService({
      store,
      adapter,
      evidenceProjector: projector,
      clock,
    });

    await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
    expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "completed", responseText: accepted.renderedMessage });
    expect(store.getAcceptedControllerFinalization(turn.id)).toMatchObject({ id: accepted.id, consumedAt: 2_000 });
  },
);

// Turn 326 was the owner typing "what do you mean": no tool needed, no
// evidence of its own. Its first native batch crossed the evidence cap, and a
// cap crossing was fatal, so the turn died 249ms after arrival and took the
// whole controller thread with it. Saturating the budget must cost the turn
// further ingestion, never the turn itself or the conversation.
it("keeps a saturated turn and its controller alive instead of retiring them", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 671, inputText: "what do you mean" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id)
    .toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000,
    projectId: "proj_personal", hostId: "host_personal", threadId: "thr_evidence_saturated",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000,
  })).toBe(true);
  const projector = {
    reconcile: vi.fn(async () => ({
      outcome: "limit_exceeded" as const,
      reconciliationIncomplete: null,
      fromSeq: 0,
      throughSeq: 0,
      targetSeq: 0,
    })),
  };
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: true, assistantOutputObserved: true, toolActivityObserved: false, completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({
    store,
    adapter,
    evidenceProjector: projector,
    clock,
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "submitted" });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    state: "active",
    threadId: "thr_evidence_saturated",
  });
  // Whatever is queued for the owner is the live stream placeholder, never a
  // failure notice about a turn that is still running.
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text ?? "")
    .not.toMatch(/couldn't complete/i);
});

it("completes an active accepted turn without budget steering", async () => {
  const { store, fence, db, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 674, inputText: "keep accepted answer alive" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id).toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000,
    projectId: "proj_personal", hostId: "host_personal", threadId: "thr_accepted_budget", spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })).toBe(true);
  const accepted = acceptControllerFinalization(store, turn.id);
  db.prepare(
    "UPDATE controller_turns SET tool_calls = 120, total_tokens = 600000, command_failures = 5 WHERE id = ?",
  ).run(turn.id);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: true, assistantOutputObserved: true, toolActivityObserved: false, completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(adapter.steer).not.toHaveBeenCalled();
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "completed", responseText: accepted.renderedMessage });
  expect(store.getAcceptedControllerFinalization(turn.id)).toMatchObject({ id: accepted.id, consumedAt: 2_000 });
});

it("delivers an accepted active turn after the stall boundary", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 671, inputText: "bound the accepted turn" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id).toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000,
    projectId: "proj_personal", hostId: "host_personal", threadId: "thr_active_accepted_stalled", spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })).toBe(true);
  const accepted = acceptControllerFinalization(store, turn.id);
  expect(store.renewExecutorLease(
    fence.ownerId,
    fence.generation,
    2_001,
    CONTROLLER_STALL_MS + 10_000,
  )).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: true, assistantOutputObserved: false, toolActivityObserved: false, completed: false, error: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({
    store,
    adapter,
    evidenceProjector,
    clock: { now: () => 2_000 + CONTROLLER_STALL_MS + 1 },
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "completed", responseText: accepted.renderedMessage });
  expect(store.getAcceptedControllerFinalization(turn.id)).toMatchObject({ id: accepted.id, consumedAt: 2_000 + CONTROLLER_STALL_MS + 1 });
});

it("accepts finalizer completion and ordinary lifecycle events after acceptance", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 672, inputText: "finish after the finalizer" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id).toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000,
    projectId: "proj_personal", hostId: "host_personal", threadId: "thr_finalizer_lifecycle", spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })).toBe(true);
  const accepted = acceptControllerFinalization(store, turn.id);
  expect(store.recordControllerNativeEvidence({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 4,
    items: [],
  })).toBe("recorded");
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 4),
    events: vi.fn(async () => ({
      latestSeq: 4,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: true,
      completed: true,
      error: null,
      interactionReferences: [],
      toolCalls: 1,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "completed", responseText: accepted.renderedMessage });
  expect(store.getAcceptedControllerFinalization(turn.id)?.consumedAt).toBe(2_000);
});

it("delivers an accepted answer after evidence advances past its seal", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 673, inputText: "project before completing" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id).toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000,
    projectId: "proj_personal", hostId: "host_personal", threadId: "thr_project_gap", spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })).toBe(true);
  const accepted = acceptControllerFinalization(store, turn.id);
  const projectedEvidence = {
    sourceName: "commandExecution",
    sourceItemId: "late-native",
    outcome: "succeeded" as const,
    argsSha256: "c".repeat(64),
    resultSha256: "d".repeat(64),
    proofKinds: ["command_result"] as const,
    subjectRefs: ["bb-item:late-native"] as const,
  };
  expect(store.recordControllerNativeEvidence({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [projectedEvidence],
  })).toBe("recorded");
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "error" as const),
    latestSeq: vi.fn(async () => { throw new Error("provider disappeared after finalization"); }),
    events: vi.fn(async () => ({
      latestSeq: 1,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: true,
      completed: true,
      error: null,
      interactionReferences: [],
      toolCalls: 1,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({
    store,
    adapter,
    evidenceProjector,
    clock,
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "completed", responseText: accepted.renderedMessage });
  expect(store.getAcceptedControllerFinalization(turn.id)).toMatchObject({ id: accepted.id, consumedAt: 2_000 });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toBe(accepted.renderedMessage);
  expect(store.listControllerEvidence(turn.id, 10)).toMatchObject([
    { sourceKind: "bb_item", sourceItemId: "late-native" },
  ]);
});

it("does not continue from a stale provider cursor", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 68, inputText: "wait for cursor repair" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id).toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000,
    projectId: "proj_personal", hostId: "host_personal", threadId: "thr_stale_cursor", spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })).toBe(true);
  expect(store.updateControllerStream({
    ...fence, now: 2_000, turnId: turn.id, cursor: 5, phase: "thinking",
  })).toBe(true);
  const highWater = 4;
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => highWater),
    events: vi.fn(async () => ({ latestSeq: highWater, inputAccepted: true, assistantOutputObserved: false, toolActivityObserved: false, completed: true, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(adapter.send).not.toHaveBeenCalled();
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "submitted", completionContinuations: 0 });

});

it("dispatches FIFO, waits for idle output, and then sends the next turn with mode start", async () => {
  evidenceProjector.reconcile.mockClear();
  const { store, fence, clock } = serviceFixture();
  store.enqueueControllerTurn({ ...turnRecord({ updateId: 11, inputText: "first" }), telegramUserId: "7", telegramChatId: "7", now: 0 });
  // Sent after the burst went quiet, so it forms its own burst.
  store.enqueueControllerTurn({ ...turnRecord({ updateId: 12, inputText: "second" }), telegramUserId: "7", telegramChatId: "7", now: 4_500 });
  let status: "active" | "idle" = "active";
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => {
      expect(store.reserveControllerSpawn({
        controllerKey: "owner-7-controller",
        turnId: spawnTurn.id,
        projectId: "proj_personal",
        hostId: "host_personal",
        now: 2_000,
      })).toBe(true);
      return { threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id };
    }),
    send: vi.fn(async () => undefined),
    status: async () => status,
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(false);
  expect(store.listControllerTurns("owner-7-controller", 10).map((turn) => turn.state)).toEqual(["submitted", "queued"]);

  status = "idle";
  acceptControllerFinalization(store, "controller-turn-11");
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  // The second message's burst must go quiet before the executor claims it.
  clock.tick(6_000);
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(adapter.send).toHaveBeenCalledWith("thr_controller", "second", fence.signal, null, 0);
  expect(store.listControllerTurns("owner-7-controller", 10).map((turn) => turn.state)).toEqual(["completed", "submitted"]);
});

it("reserves a steer before the provider call so finalization cannot win the race", async () => {
  const { store, fence, clock } = serviceFixture();
  const running = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 68, inputText: "first" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const waiting = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 69, inputText: "second" }),
    telegramUserId: "7",
    telegramChatId: "7",
    // Received after the leader's claim, so it stays queued to be steered.
    now: 5_500,
  });
  expect(store.claimNextControllerTurn({ ...fence, now: 5_000 })?.id).toBe(running.id);
  reserveControllerSpawnForTest(store, running.id);
  expect(store.markControllerSpawned({
    ...fence,
    now: 2_000,
    turnId: running.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_steer_race",
    spawnToken: running.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, now: 2_000, turnId: running.id })).toBe(true);

  let finalizationDuringSteer: ReturnType<typeof store.proposeControllerFinalization> | null = null;
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({
      threadId: "unused",
      projectId: "proj_personal",
      hostId: "host_personal",
      spawnToken: spawnTurn.id,
    })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: false,
      error: null,
      pendingQuestion: null,
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => {
      finalizationDuringSteer = store.proposeControllerFinalization({
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: 2_003,
        turnId: running.id,
        controllerKey: running.controllerKey,
        candidate: {
          disposition: "answered",
          segments: [{ type: "text", text: "A raced final answer." }],
          obligationRefs: [],
        },
      });
    }),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  // The waiting burst must go quiet before the answer steers it in.
  clock.tick(6_000);
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(finalizationDuringSteer).toMatchObject({ outcome: "stale" });
  expect(store.getAcceptedControllerFinalization(running.id)).toBeNull();
  expect(adapter.steer).toHaveBeenCalledWith("thr_steer_race", "second", fence.signal);
  expect(store.getControllerTurn(waiting.id)).toMatchObject({ state: "completed" });
  expect(store.proposeControllerFinalization({
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_004,
    turnId: running.id,
    controllerKey: running.controllerKey,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: "The steer was folded." }],
      obligationRefs: [],
    },
  })).toMatchObject({ outcome: "accepted" });
});

it("does not steer a queued owner message after the executor lease is lost", async () => {
  const { store, fence, clock } = serviceFixture();
  const running = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 70, inputText: "first" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const waiting = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 71, inputText: "second" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 5_500,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id)
    .toBe(running.id);
  reserveControllerSpawnForTest(store, running.id);
  expect(store.markControllerSpawned({
    ...fence,
    now: 2_000,
    turnId: running.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_lease_fence",
    spawnToken: running.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, now: 2_000, turnId: running.id })).toBe(true);

  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => {
      expect(store.releaseExecutorLease(fence.ownerId, fence.generation, 2_003)).toBe(true);
      return "active" as const;
    }),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: false,
      error: null,
      pendingQuestion: null,
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  clock.tick(6_000);

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(adapter.steer).not.toHaveBeenCalled();
  expect(store.getControllerTurn(waiting.id)?.state).toBe("queued");
});

it("does not replay a reserved steer after a SQLite restart with no provider authority", async () => {
  const fixture = serviceFixture();
  const { store, fence, clock } = fixture;
  const running = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 170, inputText: "first" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const waiting = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 171, inputText: "second" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 5_500,
  });
  expect(store.claimNextControllerTurn({ ...fence, now: 5_000 })?.id).toBe(running.id);
  reserveControllerSpawnForTest(store, running.id);
  expect(store.markControllerSpawned({
    ...fence,
    now: 5_500,
    turnId: running.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_steer_restart",
    spawnToken: running.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, now: 5_500, turnId: running.id })).toBe(true);
  expect(store.reserveControllerSteer({
    ...fence,
    now: 2_002,
    runningTurnId: running.id,
    waitingTurnId: waiting.id,
    controllerKey: running.controllerKey,
    expectedThreadId: "thr_steer_restart",
  })).toBe(true);

  const restarted = fixture.reopen();
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: false,
      error: null,
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store: restarted, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(adapter.steer).not.toHaveBeenCalled();
  expect(restarted.getControllerTurn(waiting.id)).toMatchObject({
    state: "queued",
    recoverySourceTurnId: running.id,
  });
  expect(restarted.getOutbox(`controller:${waiting.id}:reply`)).toBeNull();
  expect(fixture.db.prepare("SELECT steer_reservation_turn_id FROM controller_turns WHERE id = ?")
    .get(running.id)).toEqual({ steer_reservation_turn_id: null });
});

it.each([
  ["authoritative application", "applied", "completed", 0],
  ["authoritative non-application", "not_applied", "queued", 1],
] as const)("settles a restart reservation from %s without replay", async (_label, outcome, state, retryCount) => {
  const fixture = serviceFixture();
  const { store, fence, clock } = fixture;
  const running = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 174, inputText: "first" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  const waiting = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 175, inputText: "second" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 5_500,
  });
  expect(store.claimNextControllerTurn({ ...fence, now: 5_000 })?.id).toBe(running.id);
  reserveControllerSpawnForTest(store, running.id);
  expect(store.markControllerSpawned({
    ...fence,
    now: 2_000,
    turnId: running.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_steer_authority",
    spawnToken: running.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, now: 2_000, turnId: running.id })).toBe(true);
  expect(store.reserveControllerSteer({
    ...fence,
    now: 2_002,
    runningTurnId: running.id,
    waitingTurnId: waiting.id,
    controllerKey: running.controllerKey,
    expectedThreadId: "thr_steer_authority",
  })).toBe(true);

  const reconcileSteer = vi.fn(async (input: {
    threadId: string;
    text: string;
    idempotencyKey: string;
    signal: AbortSignal;
  }) => {
    expect(input).toMatchObject({
      threadId: "thr_steer_authority",
      text: "second",
      idempotencyKey: `controller-steer:${running.id}:${waiting.id}`,
    });
    return outcome;
  });
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: false,
      error: null,
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    reconcileSteer,
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(reconcileSteer).toHaveBeenCalledTimes(1);
  expect(adapter.steer).not.toHaveBeenCalled();
  expect(store.getControllerTurn(waiting.id)).toMatchObject({ state, retryCount });
  expect(fixture.db.prepare("SELECT steer_reservation_turn_id FROM controller_turns WHERE id = ?")
    .get(running.id)).toEqual({ steer_reservation_turn_id: null });
});

it("does not replay a steer whose provider result became ambiguous during lease loss", async () => {
  const fixture = serviceFixture();
  const { store, fence, clock } = fixture;
  const running = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 172, inputText: "first" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  const waiting = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 173, inputText: "second" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 5_500,
  });
  expect(store.claimNextControllerTurn({ ...fence, now: 5_000 })?.id).toBe(running.id);
  reserveControllerSpawnForTest(store, running.id);
  expect(store.markControllerSpawned({
    ...fence,
    now: 2_000,
    turnId: running.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_steer_ambiguous",
    spawnToken: running.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, now: 2_000, turnId: running.id })).toBe(true);

  const firstAdapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: false,
      error: null,
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => {
      expect(store.releaseExecutorLease(fence.ownerId, fence.generation, 2_003)).toBe(true);
      throw new Error("provider result is ambiguous");
    }),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const firstService = new LunaControllerService({ store, adapter: firstAdapter, evidenceProjector, clock });
  // The waiting burst must be quiet before the reconcile steers it in.
  clock.tick(6_000);
  await expect(firstService.reconcile(fence, fence.signal)).resolves.toBe(true);

  const restarted = fixture.reopen();
  const successorLease = restarted.acquireExecutorLease("successor", 2_010, 30_000);
  if (!successorLease.acquired) throw new Error("successor lease was not acquired");
  const successorFence = { ownerId: "successor", generation: successorLease.generation, signal: AbortSignal.timeout(2_000) };
  const successorAdapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: false,
      error: null,
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const successorService = new LunaControllerService({
    store: restarted,
    adapter: successorAdapter,
    evidenceProjector,
    clock,
  });

  await expect(successorService.reconcile(successorFence, successorFence.signal)).resolves.toBe(true);

  expect(successorAdapter.steer).not.toHaveBeenCalled();
  expect(restarted.getControllerTurn(waiting.id)).toMatchObject({
    state: "queued",
    recoverySourceTurnId: running.id,
  });
  expect(restarted.getOutbox(`controller:${waiting.id}:reply`)).toBeNull();
  expect(fixture.db.prepare("SELECT steer_reservation_turn_id FROM controller_turns WHERE id = ?")
    .get(running.id)).toEqual({ steer_reservation_turn_id: null });
});

it("moves an aborted post-claim correction into fresh recovery", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 72, inputText: "recover" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ...fence, now: 5_000 })?.id).toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_continuation_abort",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, now: 2_000, turnId: turn.id })).toBe(true);
  const aborted = new AbortController();
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => {
      aborted.abort();
      throw new Error("send outcome is ambiguous");
    }),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: true,
      assistantOutputObserved: false,
      toolActivityObserved: false,
      completed: true,
      error: null,
      pendingQuestion: null,
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile({ ...fence, signal: aborted.signal }, aborted.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "queued",
    completionContinuations: 2,
  });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ threadId: null, state: "pending_spawn" });
});

it("moves a fenced-off correction into durable fresh recovery", async () => {
  const fixture = serviceFixture();
  const { store, fence, clock } = fixture;
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 73, inputText: "recover after the claim" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ...fence, now: 5_000 })?.id).toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_continuation_refence",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, now: 2_000, turnId: turn.id })).toBe(true);
  const aborted = new AbortController();
  fixture.db.function("task9_abort_after_continuation_claim", () => { aborted.abort(); });
  fixture.db.exec(`
    CREATE TRIGGER abort_after_continuation_claim
    AFTER UPDATE OF completion_continuations ON controller_turns
    WHEN NEW.id = '${turn.id}' AND NEW.completion_continuations = 1
    BEGIN
      SELECT task9_abort_after_continuation_claim();
    END
  `);
  const send = vi.fn(async () => undefined);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send,
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: true,
      assistantOutputObserved: false,
      toolActivityObserved: false,
      completed: true,
      error: null,
      pendingQuestion: null,
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile({ ...fence, signal: aborted.signal }, aborted.signal)).resolves.toBe(true);

  expect(send).not.toHaveBeenCalled();
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "queued", completionContinuations: 2 });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ threadId: null, state: "pending_spawn" });
});

it("keeps a needs-owner finalization parked and answerable across restart", async () => {
  const fixture = serviceFixture();
  const { store, fence, clock } = fixture;
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 74, inputText: "ask me before proceeding" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ...fence, now: 5_000 })?.id).toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_needs_owner_restart",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, now: 2_000, turnId: turn.id })).toBe(true);
  expect(recordServiceQuestion(store, fence, turn.id, "interaction_needs_owner_restart")).toBe("recorded");
  const accepted = acceptNeedsOwnerFinalization(store, turn.id);
  const restarted = fixture.reopen();
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: true,
      assistantOutputObserved: false,
      toolActivityObserved: false,
      completed: true,
      error: null,
      pendingQuestion: null,
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    getInteraction: vi.fn(async () => ({
      id: "interaction_needs_owner_restart",
      threadId: "thr_needs_owner_restart",
      status: "resolved",
      payload: null,
      resolution: restarted.getAnsweredControllerInteraction(turn.controllerKey)?.resolution ?? null,
    })),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({
    store: restarted,
    adapter,
    evidenceProjector,
    clock,
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(restarted.getControllerTurn(turn.id)).toMatchObject({ state: "submitted", awaitingInteractionId: "interaction_needs_owner_restart" });
  expect(restarted.getAcceptedControllerFinalization(turn.id)).toMatchObject({ id: accepted.id, consumedAt: null });
  expect(adapter.answerQuestion).not.toHaveBeenCalled();

  expect(restarted.answerControllerInteractionWithText({
    controllerKey: turn.controllerKey,
    userId: "7",
    chatId: "7",
    text: "Yes, continue.",
    now: 2_003,
  })).toMatchObject({ ok: true, complete: true, turnId: turn.id });
  expect(restarted.getAnsweredControllerInteraction(turn.controllerKey)).toMatchObject({
    interactionId: "interaction_needs_owner_restart",
    turnId: turn.id,
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(adapter.answerQuestion).toHaveBeenCalledTimes(1);
  expect(fixture.db.prepare(
    "SELECT state FROM controller_interactions WHERE interaction_id = ?",
  ).get("interaction_needs_owner_restart")).toEqual({ state: "delivered" });
  expect(restarted.getControllerTurn(turn.id)?.state).toBe("submitted");
  expect(restarted.getAcceptedControllerFinalization(turn.id)?.consumedAt).toBeNull();

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(restarted.getControllerTurn(turn.id)).toMatchObject({ state: "completed", responseText: accepted.renderedMessage });
  expect(restarted.getAcceptedControllerFinalization(turn.id)?.consumedAt).not.toBeNull();
});

it("keeps a queued image durable until the active turn finishes", async () => {
  const { store, fence, clock } = serviceFixture();
  const running = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 15, inputText: "first request" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const leaseFence = { ownerId: fence.ownerId, generation: fence.generation, now: 2_000 };
  expect(store.claimNextControllerTurn(leaseFence)?.id).toBe(running.id);
  reserveControllerSpawnForTest(store, running.id, leaseFence.now);
  expect(store.markControllerSpawned({
    ...leaseFence,
    turnId: running.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
    spawnToken: running.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...leaseFence, turnId: running.id })).toBe(true);
  const image = {
    fileId: "replacement-file-id",
    fileName: "telegram-replacement.webp",
    mimeType: "image/webp" as const,
    sizeBytes: 8,
    kind: "image" as const,
    durationSeconds: null,
    thumbnail: null,
  };
  const waiting = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 16, inputText: "Use this screenshot instead", image }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  let status: "active" | "idle" = "active";
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => status),
    latestSeq: vi.fn(async () => 1),
    events: vi.fn(async () => ({ latestSeq: 1, inputAccepted: true, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(adapter.steer).not.toHaveBeenCalled();
  expect(store.getControllerTurn(waiting.id)).toMatchObject({ state: "queued", image });

  status = "idle";
  acceptControllerFinalization(store, running.id, "Durable accepted answer.", 1);
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(adapter.send).toHaveBeenCalledWith("thr_controller", "Use this screenshot instead", fence.signal, [{
    fileId: image.fileId,
    fileName: image.fileName,
    mimeType: image.mimeType,
    sizeBytes: image.sizeBytes,
    kind: "image",
  }], 0);
});

it("requeues a transient image preparation failure when no exact candidate exists", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({
      updateId: 17,
      inputText: "Read this",
      image: {
        fileId: "telegram-file-id",
        fileName: "telegram-screenshot.jpg",
        mimeType: "image/jpeg" as const,
        sizeBytes: null,
      },
    }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const findSpawnCandidate = vi.fn(async () => null);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => { throw new ControllerAttachmentPreparationError(true); }),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate,
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  expect(findSpawnCandidate).toHaveBeenCalledTimes(2);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "queued", retryCount: 2 });
  expect(store.getControllerForOwner("7", "7")?.threadId).toBeNull();
});

it("tells the owner a document could not be read, rather than blaming an image", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({
      updateId: 19,
      inputText: "Please read this file.",
      document: {
        fileId: "pdf-file",
        fileName: "review.pdf",
        mimeType: "application/pdf" as const,
        sizeBytes: 4_000,
      },
    }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => { throw new ControllerAttachmentPreparationError(false, "document"); }),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed" });
  const text = store.getOutbox(`controller:${turn.id}:reply`)?.payload.text;
  expect(text).toMatch(/PDF, Markdown, or plain-text/i);
  expect(text).not.toMatch(/JPEG/i);
});

it("requeues an aborted image preparation without consuming a retry", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({
      updateId: 18,
      inputText: "Read this",
      image: {
        fileId: "telegram-file-id",
        fileName: "telegram-screenshot.jpg",
        mimeType: "image/jpeg" as const,
        sizeBytes: null,
      },
    }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const aborted = new AbortController();
  aborted.abort();
  const findSpawnCandidate = vi.fn(async () => ({
    threadId: "thr_unrelated",
    projectId: "proj_personal",
    hostId: "host_personal",
    spawnToken: turn.id,
  }));
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => { throw new ControllerAttachmentPreparationError(true); }),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate,
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.processOne(fence, aborted.signal)).resolves.toBe(true);
  await expect(service.processOne(fence, aborted.signal)).resolves.toBe(true);

  expect(findSpawnCandidate).not.toHaveBeenCalled();
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "queued", retryCount: 0 });
});

it("retires a thread whose provider no longer matches the configured model", async () => {
  const { adapter } = sdkFixture({
    executionProfile: {
      model: "gpt-5.6-luna",
      reasoningLevel: "max",
      serviceTier: "fast",
      permissionMode: "full",
    },
  });

  // sdkFixture's threads.get answers with a claude-code controller thread.
  await expect(adapter.status("thr_controller", AbortSignal.timeout(1_000))).resolves.toBe("incompatible");
});

it.each([
  ["status", "Controller status could not be verified"],
  ["timeline baseline", "Controller event baseline could not be verified"],
  ["invalid timeline baseline", "Controller event baseline was invalid"],
] as const)("requeues a transient %s read with capped dispatch backoff", async (failedRead, expectedError) => {
  const { db, store, fence, clock } = serviceFixture();
  const updateOffset = failedRead === "status" ? 0 : failedRead === "timeline baseline" ? 1 : 2;
  activateControllerForServiceTest(store, fence, 60_101 + updateOffset * 2, "thr_transient_read");
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 60_102 + updateOffset * 2, inputText: "preserve this request" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const adapter: ControllerAdapter = {
    spawn: vi.fn(),
    send: vi.fn(),
    status: vi.fn(async () => {
      if (failedRead === "status") throw new Error("temporary status outage");
      return "idle" as const;
    }),
    latestSeq: vi.fn(async () => {
      if (failedRead === "timeline baseline") throw new Error("temporary timeline outage");
      if (failedRead === "invalid timeline baseline") return -1;
      return 7;
    }),
    events: vi.fn(),
    steer: vi.fn(),
    answerQuestion: vi.fn(),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "queued",
    inputText: "preserve this request",
    lastError: expectedError,
  });
  expect(db.prepare(
    `SELECT delivery_state, dispatch_retry_count, delivery_reconcile_attempts, next_dispatch_at
       FROM controller_turns WHERE id = ?`,
  ).get(turn.id)).toEqual({
    delivery_state: "none",
    dispatch_retry_count: 1,
    delivery_reconcile_attempts: 0,
    next_dispatch_at: 3_000,
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toBe("Queued…");
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(false);
  expect(adapter.send).not.toHaveBeenCalled();
});

it("requeues a transient spawn-candidate read before any spawn intent exists", async () => {
  const { db, store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 60_105, inputText: "start a fresh controller" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const adapter: ControllerAdapter = {
    spawn: vi.fn(),
    send: vi.fn(),
    status: vi.fn(),
    latestSeq: vi.fn(),
    events: vi.fn(),
    steer: vi.fn(),
    answerQuestion: vi.fn(),
    findSpawnCandidate: vi.fn(async () => { throw new Error("temporary candidate read outage"); }),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "queued",
    inputText: "start a fresh controller",
    lastError: "Controller spawn candidates could not be read",
  });
  expect(db.prepare(
    "SELECT delivery_state, dispatch_retry_count, next_dispatch_at FROM controller_turns WHERE id = ?",
  ).get(turn.id)).toEqual({ delivery_state: "none", dispatch_retry_count: 1, next_dispatch_at: 3_000 });
  expect(adapter.spawn).not.toHaveBeenCalled();
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toBe("Queued…");
});

it("adopts an uncertain spawn after restart without spawning the owner input twice", async () => {
  const fixture = serviceFixture();
  const { db, store, fence, clock } = fixture;
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 60_106, inputText: "spawn this exactly once" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const firstFind = vi.fn()
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error("candidate timeline unavailable"));
  const firstSpawn = vi.fn(async () => {
    expect(db.prepare(
      "SELECT delivery_state, dispatch_kind, dispatch_correlation_id FROM controller_turns WHERE id = ?",
    ).get(turn.id)).toEqual({
      delivery_state: "intent",
      dispatch_kind: "spawn",
      dispatch_correlation_id: turn.id,
    });
    throw new Error("spawn response was lost");
  });
  const firstAdapter: ControllerAdapter = {
    spawn: firstSpawn,
    send: vi.fn(),
    status: vi.fn(),
    latestSeq: vi.fn(),
    events: vi.fn(),
    steer: vi.fn(),
    answerQuestion: vi.fn(),
    findSpawnCandidate: firstFind,
  };
  const firstService = new LunaControllerService({
    store,
    adapter: firstAdapter,
    evidenceProjector,
    clock,
  });

  await expect(firstService.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(firstSpawn).toHaveBeenCalledTimes(1);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "dispatching", inputText: "spawn this exactly once" });
  expect(db.prepare(
    "SELECT delivery_state, dispatch_kind, dispatch_correlation_id FROM controller_turns WHERE id = ?",
  ).get(turn.id)).toEqual({
    delivery_state: "delivery_unknown",
    dispatch_kind: "spawn",
    dispatch_correlation_id: turn.id,
  });

  expect(store.releaseExecutorLease(fence.ownerId, fence.generation, 2_002)).toBe(true);
  const restarted = fixture.reopen();
  const successorLease = restarted.acquireExecutorLease("spawn-successor", 3_100, 30_000);
  if (!successorLease.acquired) throw new Error("missing spawn successor lease");
  const successorFence = {
    ownerId: "spawn-successor",
    generation: successorLease.generation,
    signal: AbortSignal.timeout(2_000),
  };
  const successorSpawn = vi.fn();
  const successorAdapter: ControllerAdapter = {
    spawn: successorSpawn,
    send: vi.fn(),
    status: vi.fn(),
    latestSeq: vi.fn(),
    events: vi.fn(),
    steer: vi.fn(),
    answerQuestion: vi.fn(),
    findSpawnCandidate: vi.fn(async () => ({
      threadId: "thr_spawn_reconciled",
      projectId: "proj_personal",
      hostId: "host_personal",
      spawnToken: turn.id,
    })),
  };
  const successorService = new LunaControllerService({
    store: restarted,
    adapter: successorAdapter,
    evidenceProjector,
    clock: { now: () => 3_100 },
  });

  await expect(successorService.reconcile(successorFence, successorFence.signal)).resolves.toBe(true);

  expect(successorSpawn).not.toHaveBeenCalled();
  expect(restarted.getControllerForOwner("7", "7")).toMatchObject({
    state: "active",
    threadId: "thr_spawn_reconciled",
  });
  expect(restarted.getControllerTurn(turn.id)).toMatchObject({ state: "submitted", inputText: "spawn this exactly once" });
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM controller_turns WHERE telegram_update_id = ? AND input_text = ?",
  ).get(turn.updateId, turn.inputText)).toEqual({ count: 1 });
});

it("requeues a turn while the controller thread is still busy instead of failing it", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 61, inputText: "answer me" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id)
    .toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 0,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_busy",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.failControllerTurn({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 0,
    error: "setup",
  })).toBe(true);
  const pending = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 62, inputText: "second question" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  let status: "active" | "idle" = "active";
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => status),
    latestSeq: vi.fn(async () => 4),
    events: vi.fn(async () => ({ latestSeq: 4, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(pending.id)).toMatchObject({ state: "queued", lastError: null });
  expect(adapter.send).not.toHaveBeenCalled();

  status = "idle";
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(adapter.send).toHaveBeenCalledWith("thr_busy", "second question", fence.signal, null, 0);
  expect(store.getControllerTurn(pending.id)).toMatchObject({ state: "submitted", dispatchAfterSeq: 4 });
});

it("notifies once and rolls a persistently busy queued turn onto a fresh generation", async () => {
  const { db, store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 63, inputText: "answer me" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id)
    .toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 0,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_wedged",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.failControllerTurn({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 0,
    error: "setup",
  })).toBe(true);
  const stranded = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 64, inputText: "second question" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  let now = 2_001 + CONTROLLER_BUSY_NOTICE_MS;
  const spawn = vi.fn(async (spawnTurn: { id: string }) => {
    if (!store.reserveControllerSpawn({
      controllerKey: stranded.controllerKey,
      turnId: spawnTurn.id,
      projectId: "proj_personal",
      hostId: "host_personal",
      now,
    })) throw new Error("fresh generation reservation failed");
    return {
      threadId: "thr_after_busy_rollover",
      projectId: "proj_personal",
      hostId: "host_personal",
      spawnToken: spawnTurn.id,
    };
  });
  const adapter: ControllerAdapter = {
    spawn,
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  expect(store.renewExecutorLease(
    fence.ownerId,
    fence.generation,
    2_100,
    CONTROLLER_BUSY_ROLLOVER_MS + 30_000,
  )).toBe(true);
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock: { now: () => now } });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(stranded.id)).toMatchObject({
    state: "queued",
    inputText: "second question",
    busyWaitNotifiedAt: now,
    lastError: null,
  });
  const noticeKey = `controller:${stranded.id}:busy-wait`;
  expect(store.getOutbox(noticeKey)).toMatchObject({
    status: "pending",
    payload: { text: expect.stringMatching(/kept.*message queued.*fresh conversation/i) },
  });
  const firstNotice = db.prepare(
    "SELECT payload_json, updated_at FROM outbox WHERE logical_key = ?",
  ).get(noticeKey);

  now += 1;
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(db.prepare(
    "SELECT payload_json, updated_at FROM outbox WHERE logical_key = ?",
  ).get(noticeKey)).toEqual(firstNotice);

  now = 2_001 + CONTROLLER_BUSY_ROLLOVER_MS;
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  expect(spawn).toHaveBeenCalledTimes(1);
  expect(store.getControllerTurn(stranded.id)).toMatchObject({
    state: "submitted",
    inputText: "second question",
    busyWaitNotifiedAt: 2_001 + CONTROLLER_BUSY_NOTICE_MS,
  });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    state: "active",
    threadId: "thr_after_busy_rollover",
  });
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM controller_turns WHERE telegram_update_id = ? AND input_text = ?",
  ).get(stranded.updateId, stranded.inputText)).toEqual({ count: 1 });
  expect(adapter.send).not.toHaveBeenCalled();
});

it("persists a fresh stalled-turn recovery across reload before draining later input", async () => {
  const fixture = serviceFixture();
  const { store, fence, clock } = fixture;
  const stalled = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 641, inputText: "this turn will stall" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const queued = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 642, inputText: "the queue should continue" }),
    telegramUserId: "7",
    telegramChatId: "7",
    // Received after the stalled turn's claim, so it stays queued behind it.
    now: 5_500,
  });
  expect(store.claimNextControllerTurn({ ...fence, now: 5_000 })?.id).toBe(stalled.id);
  reserveControllerSpawnForTest(store, stalled.id);
  expect(store.markControllerSpawned({
    ...fence,
    now: 2_000,
    turnId: stalled.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_stalled_after_reload",
    spawnToken: stalled.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...fence, now: 2_000, turnId: stalled.id })).toBe(true);

  const stalledAt = 2_000 + CONTROLLER_STALL_MS + 1;
  const restarted = fixture.reopen();
  const lease = restarted.acquireExecutorLease("reloaded-executor", stalledAt, 30_000);
  if (!lease.acquired) throw new Error("missing reload lease");
  const restartedFence = {
    ownerId: "reloaded-executor",
    generation: lease.generation,
    signal: AbortSignal.timeout(2_000),
  };
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => {
      if (!restarted.reserveControllerSpawn({
        controllerKey: "owner-7-controller",
        turnId: spawnTurn.id,
        projectId: "proj_personal",
        hostId: "host_personal",
        now: stalledAt + 2,
      })) throw new Error("controller spawn reservation failed after reload");
      return {
        threadId: "thr_after_stall",
        projectId: "proj_personal",
        hostId: "host_personal",
        spawnToken: spawnTurn.id,
      };
    }),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => { throw new Error("watchdog should run before provider reads"); }),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: false,
      assistantOutputObserved: false,
      toolActivityObserved: false,
      completed: false,
      error: null,
      pendingQuestion: null,
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({
    store: restarted,
    adapter,
    evidenceProjector,
    clock: { now: () => stalledAt },
  });

  await expect(service.reconcile(restartedFence, restartedFence.signal)).resolves.toBe(true);

  expect(restarted.getControllerTurn(stalled.id)).toMatchObject({
    state: "queued",
    leaseOwner: null,
    leaseGeneration: null,
    completionContinuations: 2,
    lastError: "Controller recovery: event high-water unavailable",
  });
  expect(restarted.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
  expect(restarted.getOutbox(`controller:${stalled.id}:reply`)).toMatchObject({ status: "pending" });
  expect(adapter.status).not.toHaveBeenCalled();
  expect(adapter.latestSeq).toHaveBeenCalledTimes(1);

  expect(restarted.releaseExecutorLease(
    restartedFence.ownerId,
    restartedFence.generation,
    stalledAt + 1,
  )).toBe(true);
  const afterSecondReload = fixture.reopen();
  const secondLease = afterSecondReload.acquireExecutorLease("reloaded-again", stalledAt + 2, 30_000);
  if (!secondLease.acquired) throw new Error("missing second reload lease");
  const secondFence = {
    ownerId: "reloaded-again",
    generation: secondLease.generation,
    signal: AbortSignal.timeout(2_000),
  };
  const secondService = new LunaControllerService({
    store: afterSecondReload,
    adapter,
    evidenceProjector,
    clock: { now: () => stalledAt + 2 },
  });

  await expect(secondService.processOne(secondFence, secondFence.signal)).resolves.toBe(true);
  expect(afterSecondReload.getControllerTurn(stalled.id)).toMatchObject({ state: "submitted", completionContinuations: 2 });
  expect(afterSecondReload.getControllerTurn(queued.id)).toMatchObject({ state: "queued" });
  expect(afterSecondReload.getControllerForOwner("7", "7")).toMatchObject({
    state: "active",
    threadId: "thr_after_stall",
  });
  expect(adapter.spawn).toHaveBeenCalledTimes(1);
});

it("delivers a completed answer even when the controller thread ends in error", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 65, inputText: "answer then break" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id)
    .toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_answered_then_errored",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
  })).toBe(true);
  const accepted = acceptControllerFinalization(store, turn.id, "Here is the answer.", 12);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "error" as const),
    latestSeq: vi.fn(async () => 12),
    events: vi.fn(async () => ({
      latestSeq: 12,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: true,
      error: null,
      pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "completed",
    responseText: accepted.renderedMessage,
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toBe(accepted.renderedMessage);
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ threadId: null, state: "pending_spawn" });
});

it("reports a streaming turn only while its answer is still arriving", async () => {
  const { store, fence, clock } = serviceFixture();
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });
  expect(service.isStreaming()).toBe(false);

  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 71, inputText: "stream this" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(service.isStreaming()).toBe(false);

  const claim = { ownerId: fence.ownerId, generation: fence.generation, now: 5_000 };
  expect(store.claimNextControllerTurn(claim)?.id).toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id, claim.now);
  expect(store.markControllerSpawned({
    ...claim,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...claim, turnId: turn.id })).toBe(true);
  expect(service.isStreaming()).toBe(true);

  completeAcceptedControllerTurn(store, turn, claim, "Answered.");
  expect(service.isStreaming()).toBe(false);
});

it("reconciles an uncertain send from the exact timeline without submitting it twice", async () => {
  const { db, store, fence, clock } = serviceFixture();
  activateControllerForServiceTest(store, fence, 61_001, "thr_uncertain_send");
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 61_002, inputText: "send once" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const adapter: ControllerAdapter = {
    spawn: vi.fn(),
    send: vi.fn(async () => {
      expect(db.prepare(
        `SELECT delivery_state, dispatch_kind, dispatch_correlation_id, dispatch_after_seq
           FROM controller_turns WHERE id = ?`,
      ).get(turn.id)).toEqual({
        delivery_state: "intent",
        dispatch_kind: "send",
        dispatch_correlation_id: `controller-dispatch:${turn.id}`,
        dispatch_after_seq: 10,
      });
      throw new Error("uncertain send");
    }),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 10),
    events: vi.fn(async (_threadId, afterSeq) => ({
      latestSeq: 11,
      inputAccepted: afterSeq === 10,
      assistantOutputObserved: false,
      toolActivityObserved: false,
      completed: false,
      failure: null,
      assistantDraft: null,
      interactionReferences: [],
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(false);

  expect(adapter.send).toHaveBeenCalledTimes(1);
  expect(adapter.events).toHaveBeenCalledWith("thr_uncertain_send", 10, fence.signal);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "submitted",
    inputText: "send once",
    dispatchAfterSeq: 10,
  });
  expect(db.prepare(
    `SELECT delivery_state, dispatch_kind, dispatch_correlation_id, delivery_reconcile_attempts
       FROM controller_turns WHERE id = ?`,
  ).get(turn.id)).toEqual({
    delivery_state: "none",
    dispatch_kind: "send",
    dispatch_correlation_id: `controller-dispatch:${turn.id}`,
    delivery_reconcile_attempts: 0,
  });
});

it("moves a timed-out send through delivery_unknown and reconciles it without replay", async () => {
  vi.useFakeTimers();
  const { store, fence, clock } = serviceFixture();
  activateControllerForServiceTest(store, fence, 61_101, "thr_timed_out_send");
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 61_102, inputText: "send this once despite a lost response" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  let releaseProvider!: () => void;
  const abandonedSend = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const { adapter, send } = sdkFixture({
    maxSeq: 10,
    events: [{
      id: "event-accepted-after-timeout",
      threadId: "thr_timed_out_send",
      seq: 11,
      createdAt: 2_002,
      scope: { kind: "thread" },
      type: "turn/input/accepted",
      data: {},
    }],
  });
  send.mockImplementation(async () => {
    await abandonedSend;
    return { ok: true };
  });
  const service = new LunaControllerService({
    store,
    adapter,
    evidenceProjector,
    clock,
  });
  let settled = false;
  const processing = service.processOne(fence, fence.signal).then((result) => {
    settled = true;
    return result;
  });

  try {
    for (let microtask = 0; microtask < 20 && send.mock.calls.length === 0; microtask += 1) {
      await Promise.resolve();
    }
    expect(send).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_001);
    for (let microtask = 0; microtask < 20 && !settled; microtask += 1) await Promise.resolve();

    expect(settled).toBe(true);
    await expect(processing).resolves.toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(store.getControllerTurn(turn.id)).toMatchObject({
      state: "submitted",
      deliveryState: "none",
      dispatchAfterSeq: 10,
    });
  } finally {
    releaseProvider();
    await processing;
    vi.useRealTimers();
  }
});

it("does not let a late SDK completion write through a retired executor generation", async () => {
  vi.useFakeTimers();
  const { store, fence, clock } = serviceFixture();
  activateControllerForServiceTest(store, fence, 61_201, "thr_late_send");
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 61_202, inputText: "keep the late result fenced" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  let releaseProvider!: () => void;
  const providerCall = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const { adapter, send } = sdkFixture({ maxSeq: 10, events: [] });
  send.mockImplementation(async () => {
    await providerCall;
    return { ok: true };
  });
  const service = new LunaControllerService({
    store,
    adapter,
    evidenceProjector,
    clock,
  });
  const processing = service.processOne(fence, fence.signal);

  try {
    for (let microtask = 0; microtask < 20 && send.mock.calls.length === 0; microtask += 1) {
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(processing).resolves.toBe(true);
    expect(store.getControllerTurn(turn.id)).toMatchObject({
      state: "dispatching",
      deliveryState: "delivery_unknown",
      leaseOwner: fence.ownerId,
      leaseGeneration: fence.generation,
    });

    expect(store.releaseExecutorLease(fence.ownerId, fence.generation, 2_003)).toBe(true);
    const successor = store.acquireExecutorLease("successor", 2_004, 30_000);
    if (!successor.acquired) throw new Error("missing successor lease");
    expect(store.failStaleControllerDispatches({
      ownerId: "successor",
      generation: successor.generation,
      now: 2_004,
    })).toBe(true);

    releaseProvider();
    for (let microtask = 0; microtask < 20 && adapter.hasPendingMutation(); microtask += 1) {
      await Promise.resolve();
    }

    expect(adapter.hasPendingMutation()).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(store.getControllerTurn(turn.id)).toMatchObject({
      state: "dispatching",
      deliveryState: "delivery_unknown",
      leaseOwner: "successor",
      leaseGeneration: successor.generation,
    });
    expect(store.markControllerTurnSubmitted({
      ownerId: fence.ownerId,
      generation: fence.generation,
      now: 2_005,
      turnId: turn.id,
      dispatchAfterSeq: 10,
    })).toBe(false);
  } finally {
    releaseProvider();
    vi.useRealTimers();
  }
});

it("fails an unresolved mutation visibly while leaving later owner input queued", async () => {
  vi.useFakeTimers();
  const { store, fence, clock } = serviceFixture();
  activateControllerForServiceTest(store, fence, 61_301, "thr_abandoned_mutation");
  const first = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 61_302, inputText: "first owner message" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  let releaseProvider!: () => void;
  const providerCall = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const { adapter, send } = sdkFixture({ maxSeq: 10, events: [] });
  send.mockImplementation(async () => {
    await providerCall;
    return { ok: true };
  });
  let now = 2_002;
  const service = new LunaControllerService({
    store,
    adapter,
    evidenceProjector,
    clock: { now: () => now },
  });
  const firstProcessing = service.processOne(fence, fence.signal);

  try {
    for (let microtask = 0; microtask < 20 && send.mock.calls.length === 0; microtask += 1) {
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(firstProcessing).resolves.toBe(true);
    expect(store.getControllerTurn(first.id)).toMatchObject({
      state: "dispatching",
      deliveryState: "delivery_unknown",
      deliveryReconcileAttempts: 1,
    });
    const second = store.enqueueControllerTurn({
      ...turnRecord({ updateId: 61_303, inputText: "second owner message" }),
      telegramUserId: "7",
      telegramChatId: "7",
      now: 2_003,
    });

    await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
    now = 3_002;
    await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
    now = 5_002;
    await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

    expect(send).toHaveBeenCalledOnce();
    expect(adapter.hasPendingMutation()).toBe(true);
    expect(store.getControllerTurn(first.id)).toMatchObject({
      state: "failed",
      inputText: "first owner message",
      deliveryReconcileAttempts: 3,
    });
    expect(store.getOutbox(`controller:${first.id}:reply`)?.payload.text).toMatch(/did not repeat/i);
    expect(store.getControllerTurn(second.id)).toMatchObject({
      state: "queued",
      deliveryState: "none",
      inputText: "second owner message",
    });
  } finally {
    releaseProvider();
    vi.useRealTimers();
  }
});

it("preserves an uncertain send exactly once across a restart during reconciliation", async () => {
  const fixture = serviceFixture();
  const { db, store, fence, clock } = fixture;
  activateControllerForServiceTest(store, fence, 61_003, "thr_restart_reconcile");
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 61_004, inputText: "do not lose or repeat this" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const firstAdapter: ControllerAdapter = {
    spawn: vi.fn(),
    send: vi.fn(async () => { throw new Error("connection ended after send"); }),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 20),
    events: vi.fn(async () => { throw new Error("timeline temporarily unavailable"); }),
    steer: vi.fn(),
    answerQuestion: vi.fn(),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const firstService = new LunaControllerService({
    store,
    adapter: firstAdapter,
    evidenceProjector,
    clock,
  });

  await expect(firstService.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "dispatching", inputText: "do not lose or repeat this" });
  expect(db.prepare(
    "SELECT delivery_state, delivery_reconcile_attempts FROM controller_turns WHERE id = ?",
  ).get(turn.id)).toEqual({ delivery_state: "delivery_unknown", delivery_reconcile_attempts: 1 });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text)
    .toBe("I preserved that message because its delivery could not be confirmed. It will be reconciled before any action is repeated.");

  expect(store.releaseExecutorLease(fence.ownerId, fence.generation, 2_003)).toBe(true);
  const restarted = fixture.reopen();
  const successorLease = restarted.acquireExecutorLease("successor", 3_100, 30_000);
  if (!successorLease.acquired) throw new Error("missing successor lease");
  const successorFence = {
    ownerId: "successor",
    generation: successorLease.generation,
    signal: AbortSignal.timeout(2_000),
  };
  const successorAdapter: ControllerAdapter = {
    spawn: vi.fn(),
    send: vi.fn(),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 21),
    events: vi.fn(async (_threadId, afterSeq) => ({
      latestSeq: 21,
      inputAccepted: afterSeq === 20,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: false,
      failure: null,
      assistantDraft: null,
      interactionReferences: [],
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(),
    answerQuestion: vi.fn(),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const successorService = new LunaControllerService({
    store: restarted,
    adapter: successorAdapter,
    evidenceProjector,
    clock: { now: () => 3_100 },
  });

  await expect(successorService.reconcile(successorFence, successorFence.signal)).resolves.toBe(true);

  expect(successorAdapter.send).not.toHaveBeenCalled();
  expect(restarted.getControllerTurn(turn.id)).toMatchObject({
    state: "submitted",
    inputText: "do not lose or repeat this",
    dispatchAfterSeq: 20,
  });
  expect(db.prepare(
    "SELECT COUNT(*) AS count FROM controller_turns WHERE telegram_update_id = ? AND input_text = ?",
  ).get(turn.updateId, turn.inputText)).toEqual({ count: 1 });
});

it("terminates unresolved delivery after bounded reconciliation and tells the owner", async () => {
  const { store, fence, clock } = serviceFixture();
  activateControllerForServiceTest(store, fence, 61_005, "thr_unresolved_delivery");
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 61_006, inputText: "keep this exact owner input" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  let now = 2_002;
  const adapter: ControllerAdapter = {
    spawn: vi.fn(),
    send: vi.fn(async () => { throw new Error("uncertain provider boundary"); }),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 30),
    events: vi.fn(async () => { throw new Error("timeline unavailable"); }),
    steer: vi.fn(),
    answerQuestion: vi.fn(),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock: { now: () => now } });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)?.state).toBe("dispatching");
  now = 3_002;
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)?.state).toBe("dispatching");
  now = 5_002;
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(adapter.send).toHaveBeenCalledTimes(1);
  expect(adapter.events).toHaveBeenCalledTimes(3);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "failed",
    inputText: "keep this exact owner input",
    lastError: "Controller delivery could not be reconciled",
  });
  const notice = store.getOutbox(`controller:${turn.id}:reply`)?.payload.text;
  expect(notice).toBe(
    "I preserved that message, but could not confirm whether it was delivered. I did not repeat it. Please review the conversation before trying again.",
  );
  expect(notice).not.toContain("timeline unavailable");
});

it("bounds reconciliation when proved delivery cannot be durably submitted", async () => {
  const { db, store, fence, clock } = serviceFixture();
  activateControllerForServiceTest(store, fence, 61_007, "thr_unsettled_delivery");
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 61_008, inputText: "preserve a proved but unsettled delivery" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  db.exec(`
    CREATE TRIGGER block_controller_submission
    BEFORE UPDATE OF state ON controller_turns
    WHEN OLD.telegram_update_id = 61008 AND NEW.state = 'submitted'
    BEGIN
      SELECT RAISE(IGNORE);
    END
  `);
  let now = 2_002;
  const adapter: ControllerAdapter = {
    spawn: vi.fn(),
    send: vi.fn(async () => { throw new Error("uncertain provider boundary"); }),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 40),
    events: vi.fn(async () => ({
      latestSeq: 41,
      inputAccepted: true,
      assistantOutputObserved: false,
      toolActivityObserved: false,
      completed: false,
      failure: null,
      assistantDraft: null,
      interactionReferences: [],
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(),
    answerQuestion: vi.fn(),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock: { now: () => now } });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "dispatching",
    deliveryState: "delivery_unknown",
    deliveryReconcileAttempts: 1,
  });
  now = 3_002;
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  now = 5_002;
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(adapter.send).toHaveBeenCalledTimes(1);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "failed",
    inputText: "preserve a proved but unsettled delivery",
    deliveryReconcileAttempts: 3,
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toMatch(/did not repeat/i);
});

it("keeps an idle submitted turn durable when BB output retrieval fails transiently", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 31, inputText: "answer after retry" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id).toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
  })).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => { throw new Error("temporary BB event failure"); }),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(false);

  expect(store.listControllerTurns("owner-7-controller", 10)[0]?.state).toBe("submitted");
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    payload: { text: "Connecting to Hanoon…" },
  });
});

it("projects active Luna assistant deltas into the durable controller reply", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 36, inputText: "stream answer" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id)
    .toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_streaming",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    dispatchAfterSeq: 8,
    now: 2_000,
  })).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    // The dispatch baseline is read from latestSeq just before sending, so the
    // thread's latest sequence is never behind the turn that sits in it.
    latestSeq: vi.fn(async () => 10),
    events: vi.fn(async () => ({
      latestSeq: 10,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: false,
      error: null,
      pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(adapter.events).toHaveBeenCalledWith("thr_streaming", 8, fence.signal);
  expect(store.listControllerTurns("owner-7-controller", 10)[0]).toMatchObject({
    bbEventSeq: 10,
    streamText: "Hanoon is preparing the answer…",
    streamPhase: "responding",
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    payload: { text: "Hanoon is preparing the answer…" },
  });
});

it("refreshes an unchanged active Luna draft before Telegram expires it", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 37, inputText: "keep thinking" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id)
    .toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_thinking",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
  })).toBe(true);
  const [draft] = store.leaseOutbox(fence.ownerId, fence.generation, 2_000, 1, 30_000);
  expect(store.completeOutbox(draft!.logicalKey, fence.ownerId, fence.generation, null, 2_000)).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: true,
      assistantDelta: "",
      completed: false,
      error: null,
      pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock: { now: () => 22_000 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    messageId: null,
  });
});

it("reconciles an accepted errored turn before a later queued message", async () => {
  const { store, fence, clock } = serviceFixture();
  const failed = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 41, inputText: "show active threads" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  store.enqueueControllerTurn({
    ...turnRecord({ updateId: 42, inputText: "try again" }),
    telegramUserId: "7",
    telegramChatId: "7",
    // Received after the first claim, so it stays queued for its own dispatch.
    now: 5_500,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id)
    .toBe(failed.id);
  reserveControllerSpawnForTest(store, failed.id);
  expect(store.markControllerSpawned({
    turnId: failed.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_poisoned",
    spawnToken: failed.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: failed.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
  })).toBe(true);
  const spawn = vi.fn(async (spawnTurn: { id: string }) => {
    expect(store.reserveControllerSpawn({
      controllerKey: "owner-7-controller",
      turnId: spawnTurn.id,
      projectId: "proj_personal",
      hostId: "host_personal",
      now: 2_000,
    })).toBe(true);
    return {
      threadId: "thr_fresh",
      projectId: "proj_personal",
      hostId: "host_personal",
      spawnToken: spawnTurn.id,
    };
  });
  const adapter: ControllerAdapter = {
    spawn,
    send: vi.fn(async () => undefined),
    status: vi.fn(async (threadId: string) => threadId === "thr_poisoned" ? "error" : "active"),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 22, inputAccepted: true, assistantDelta: "", completed: false, error: "Controller provider turn failed", pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.listControllerTurns("owner-7-controller", 10).map((turn) => turn.state))
    .toEqual(["queued", "queued"]);
  expect(store.getControllerTurn(failed.id)).toMatchObject({ completionContinuations: 2 });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    threadId: null,
    state: "pending_spawn",
  });
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(store.getControllerForOwner("7", "7")?.threadId).toBe("thr_fresh");
});

it("recovers from the 2026-08-10 poisoned controller before dispatching the next message", async () => {
  const { store, fence, clock } = serviceFixture();
  const previous = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 46, inputText: "previous failed request" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id)
    .toBe(previous.id);
  reserveControllerSpawnForTest(store, previous.id);
  expect(store.markControllerSpawned({
    turnId: previous.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_poisoned_idle",
    spawnToken: previous.id,
  })).toBe(true);
  expect(store.failControllerTurn({
    turnId: previous.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_001,
    error: "Controller provider turn failed",
  })).toBe(true);
  const next = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 47, inputText: "show active threads" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  const spawn = vi.fn(async (spawnTurn: { id: string }) => {
    expect(store.reserveControllerSpawn({
      controllerKey: "owner-7-controller",
      turnId: spawnTurn.id,
      projectId: "proj_personal",
      hostId: "host_personal",
      now: 2_003,
    })).toBe(true);
    return {
    threadId: "thr_fresh_after_poison",
    projectId: "proj_personal",
    hostId: "host_personal",
    spawnToken: spawnTurn.id,
    };
  });
  const adapter: ControllerAdapter = {
    spawn,
    send: vi.fn(async () => undefined),
    status: vi.fn(async (threadId: string) => threadId === "thr_poisoned_idle" ? "error" : "active"),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  expect(store.listControllerTurns("owner-7-controller", 10).at(-1)).toMatchObject({
    id: next.id,
    state: "submitted",
  });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(store.getControllerForOwner("7", "7")?.threadId).toBe("thr_fresh_after_poison");
});

it("retires an errored controller generation even when no turn remains submitted", async () => {
  const { store, fence, clock } = serviceFixture();
  const previous = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 48, inputText: "provider initialization timed out" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id)
    .toBe(previous.id);
  reserveControllerSpawnForTest(store, previous.id);
  expect(store.markControllerSpawned({
    turnId: previous.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_initialize_timeout",
    spawnToken: previous.id,
  })).toBe(true);
  expect(store.failControllerTurn({
    turnId: previous.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_001,
    error: "Controller send outcome is uncertain",
  })).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async (spawnTurn: { id: string }) => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "error" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    threadId: null,
    state: "pending_spawn",
  });
});

it("retries one controller generation when BB proves the input was never accepted", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 51, inputText: "show active threads" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 0,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 5_000 })?.id)
    .toBe(turn.id);
  reserveControllerSpawnForTest(store, turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 0,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_never_accepted",
    spawnToken: turn.id,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    dispatchAfterSeq: 9,
    now: 0,
  })).toBe(true);
  const spawn = vi.fn(async (spawnTurn: { id: string }) => {
    expect(store.reserveControllerSpawn({
      controllerKey: "owner-7-controller",
      turnId: spawnTurn.id,
      projectId: "proj_personal",
      hostId: "host_personal",
      now: 2_000,
    })).toBe(true);
    return {
      threadId: "thr_retry",
      projectId: "proj_personal",
      hostId: "host_personal",
      spawnToken: spawnTurn.id,
    };
  });
  const adapter: ControllerAdapter = {
    configuredProfileCount: () => 2,
    spawn,
    send: vi.fn(async () => undefined),
    status: vi.fn(async (threadId: string) => threadId === "thr_never_accepted" ? "error" : "active"),
    // The dispatch baseline is read from latestSeq just before sending, so the
    // thread's latest sequence is never behind the turn that sits in it.
    latestSeq: vi.fn(async () => 11),
    events: vi.fn(async () => ({
      latestSeq: 11,
      inputAccepted: false,
      assistantDelta: "",
      completed: false,
      error: "Controller provider turn failed",
      pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.listControllerTurns("owner-7-controller", 10)[0]).toMatchObject({
    state: "queued",
    retryCount: 0,
    modelFallbackIndex: 1,
    dispatchAfterSeq: 0,
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    payload: { text: "Connecting to Hanoon…" },
  });
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(store.getControllerForOwner("7", "7")?.threadId).toBe("thr_retry");
});

it("tries every configured execution profile once before failing an unaccepted turn", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = submittedServiceTurn(store, fence, { updateId: 51_001, threadId: "thr_profile_0" });
  const attemptedProfiles: number[] = [];
  let now = 2_001;
  const spawn = vi.fn(async (spawnTurn: { id: string; modelFallbackIndex: number }) => {
    attemptedProfiles.push(spawnTurn.modelFallbackIndex);
    expect(store.reserveControllerSpawn({
      controllerKey: turn.controllerKey,
      turnId: spawnTurn.id,
      projectId: "proj_personal",
      hostId: "host_personal",
      now,
    })).toBe(true);
    return {
      threadId: `thr_profile_${spawnTurn.modelFallbackIndex}`,
      projectId: "proj_personal",
      hostId: "host_personal",
      spawnToken: spawnTurn.id,
    };
  });
  const adapter: ControllerAdapter = {
    configuredProfileCount: () => 3,
    spawn,
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "error" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: false,
      assistantOutputObserved: false,
      toolActivityObserved: false,
      completed: false,
      failure: { code: "startup_timeout" as const, retryable: true, willRetry: false, inputAccepted: false },
      assistantDraft: null,
      interactionReferences: [],
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(),
    answerQuestion: vi.fn(),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock: { now: () => now } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "queued", modelFallbackIndex: 1, retryCount: 0 });
  now = 2_002;
    await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  now = 2_003;
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "queued", modelFallbackIndex: 2, retryCount: 0 });
  now = 2_004;
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  now = 2_005;
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed", modelFallbackIndex: 2, retryCount: 0 });
  expect(attemptedProfiles).toEqual([1, 2]);
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).not.toMatch(/resend/i);
});

it("lets a provider-owned retry event continue and then completes the accepted success", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = submittedServiceTurn(store, fence, { updateId: 52_001, threadId: "thr_provider_retry" });
  const warnings: string[] = [];
  const status = vi.fn()
    .mockResolvedValueOnce("error" as const)
    .mockResolvedValue("idle" as const);
  const events = vi.fn(async () => ({
    latestSeq: 1,
    inputAccepted: true,
    assistantOutputObserved: false,
    toolActivityObserved: false,
    completed: false,
    failure: { code: "unknown" as const, retryable: true, willRetry: true, inputAccepted: true },
    assistantDraft: null,
    interactionReferences: [],
    toolCalls: 0,
    commandFailures: 0,
    totalTokens: 0,
  }));
  const adapter: ControllerAdapter = {
    spawn: vi.fn(), send: vi.fn(), status, latestSeq: vi.fn(async () => 1), events,
    steer: vi.fn(), answerQuestion: vi.fn(), findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({
    store,
    adapter,
    evidenceProjector,
    clock,
    warn: (message) => warnings.push(message),
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "submitted", inputAccepted: true });
  expect(warnings.map((message) => JSON.parse(message))).toEqual([{
    event: "controller_failure",
    stage: "provider_retry",
    turnId: turn.id,
    controllerThreadId: "thr_provider_retry",
    code: "unknown",
    retryable: true,
    willRetry: true,
    inputAccepted: true,
    executionProfileAttempt: 1,
    recoveryAttempt: 0,
  }]);

  const accepted = acceptControllerFinalization(store, turn.id, "Recovered provider answer.");
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "completed", responseText: accepted.renderedMessage });
});

it.each([
  ["timeout before acceptance", "startup_timeout", false, "queued", 0],
  ["disconnect before acceptance", "host_disconnected", false, "queued", 0],
  ["timeout after acceptance", "rpc_timeout", true, "queued", 2],
  ["disconnect after acceptance", "host_disconnected", true, "queued", 2],
] as const)("recovers a %s with the correct generation boundary", async (_label, code, inputAccepted, state, continuation) => {
  const { store, fence, clock } = serviceFixture();
  const turn = submittedServiceTurn(store, fence, {
    updateId: 53_000 + continuation + (code === "host_disconnected" ? 10 : 0),
    threadId: `thr_${code}_${inputAccepted ? "after" : "before"}`,
  });
  const adapter: ControllerAdapter = {
    configuredProfileCount: () => 2,
    spawn: vi.fn(), send: vi.fn(), status: vi.fn(async () => "error" as const), latestSeq: vi.fn(async () => 1),
    events: vi.fn(async () => ({
      latestSeq: 1,
      inputAccepted,
      assistantOutputObserved: inputAccepted,
      toolActivityObserved: false,
      completed: false,
      failure: { code, retryable: true, willRetry: false, inputAccepted },
      assistantDraft: inputAccepted ? { itemId: "draft-recovery", text: "unfinished private draft" } : null,
      interactionReferences: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
    steer: vi.fn(), answerQuestion: vi.fn(), findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state,
    completionContinuations: continuation,
    modelFallbackIndex: inputAccepted ? 1 : 1,
    retryCount: 0,
  });
});

it.each([
  ["oauth_expired", /sign-in has expired/i],
  ["provider_rejected", /provider settings/i],
] as const)("circuit-breaks permanent %s failures with a specific safe notice", async (code, expectedText) => {
  const { store, fence, clock } = serviceFixture();
  const turn = submittedServiceTurn(store, fence, { updateId: code === "oauth_expired" ? 54_001 : 54_002, threadId: `thr_${code}` });
  const adapter: ControllerAdapter = {
    configuredProfileCount: () => 3,
    spawn: vi.fn(), send: vi.fn(), status: vi.fn(async () => "error" as const), latestSeq: vi.fn(async () => 1),
    events: vi.fn(async () => ({
      latestSeq: 1, inputAccepted: false, assistantOutputObserved: false, toolActivityObserved: false, completed: false,
      failure: { code, retryable: false, willRetry: false, inputAccepted: false }, assistantDraft: null,
      interactionReferences: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
    steer: vi.fn(), answerQuestion: vi.fn(), findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed", modelFallbackIndex: 0 });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toMatch(expectedText);
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).not.toMatch(/resend/i);
});

it("lets an accepted finalization win a provider-error race", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = submittedServiceTurn(store, fence, { updateId: 55_001, threadId: "thr_accept_error_race" });
  const events = vi.fn(async () => {
    acceptControllerFinalization(store, turn.id, "The accepted answer wins.");
    return {
      latestSeq: 1, inputAccepted: true, assistantOutputObserved: true, toolActivityObserved: false, completed: false,
      failure: { code: "process_exit" as const, retryable: true, willRetry: false, inputAccepted: true },
      assistantDraft: { itemId: "race-draft", text: "untrusted draft" }, interactionReferences: [],
      toolCalls: 0, commandFailures: 0, totalTokens: 0,
    };
  });
  const adapter: ControllerAdapter = {
    spawn: vi.fn(), send: vi.fn(), status: vi.fn(async () => "error" as const), latestSeq: vi.fn(async () => 1), events,
    steer: vi.fn(), answerQuestion: vi.fn(), findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "completed", responseText: "The accepted answer wins." });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toBe("The accepted answer wins.");
});

it("persists an exact continuation-send intent before calling the provider", async () => {
  const { db, store, fence, clock } = serviceFixture();
  const turn = submittedServiceTurn(store, fence, {
    updateId: 55_101,
    threadId: "thr_continuation_intent",
  });
  expect(store.recordControllerNativeEvidence({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [],
  })).toBe("recorded");
  let intentAtProviderCall: unknown;
  const send = vi.fn(async () => {
    intentAtProviderCall = db.prepare(
      `SELECT state, delivery_state, dispatch_kind, dispatch_correlation_id, dispatch_after_seq
         FROM controller_turns WHERE id = ?`,
    ).get(turn.id);
  });
  const expectedIntent = {
      state: "submitted",
      delivery_state: "intent",
      dispatch_kind: "send",
      dispatch_correlation_id: `controller-continuation:${turn.id}:1`,
      dispatch_after_seq: 1,
    };
  const adapter: ControllerAdapter = {
    spawn: vi.fn(),
    send,
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 1),
    events: vi.fn(async () => ({
      latestSeq: 1,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: true,
      failure: null,
      assistantDraft: null,
      interactionReferences: [],
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(),
    answerQuestion: vi.fn(),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({
    store,
    adapter,
    evidenceProjector,
    clock,
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(send).toHaveBeenCalledOnce();
  expect(intentAtProviderCall).toEqual(expectedIntent);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "submitted",
    deliveryState: "none",
    completionContinuations: 1,
  });
});

it("reconciles a timed-out continuation send from its exact timeline without replay", async () => {
  vi.useFakeTimers();
  const { store, fence, clock } = serviceFixture();
  const turn = submittedServiceTurn(store, fence, {
    updateId: 55_102,
    threadId: "thr_continuation_timeout",
  });
  expect(store.recordControllerNativeEvidence({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [],
  })).toBe("recorded");
  let releaseProvider!: () => void;
  const providerCall = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const { adapter, send } = sdkFixture({
    maxSeq: 1,
    eventPages: [[{
      id: "continuation-before-timeout",
      threadId: "thr_continuation_timeout",
      seq: 1,
      createdAt: 2_000,
      scope: { kind: "thread" },
      type: "turn/completed",
      data: {},
    }], [{
      id: "continuation-accepted-after-timeout",
      threadId: "thr_continuation_timeout",
      seq: 2,
      createdAt: 2_001,
      scope: { kind: "thread" },
      type: "turn/input/accepted",
      data: {},
    }]],
  });
  send.mockImplementation(async () => {
    await providerCall;
    return { ok: true };
  });
  const service = new LunaControllerService({
    store,
    adapter,
    evidenceProjector,
    clock,
  });
  const reconciliation = service.reconcile(fence, fence.signal);

  try {
    for (let microtask = 0; microtask < 20 && send.mock.calls.length === 0; microtask += 1) {
      await Promise.resolve();
    }
    expect(send).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30_001);
    await expect(reconciliation).resolves.toBe(true);

    expect(send).toHaveBeenCalledOnce();
    expect(store.getControllerTurn(turn.id)).toMatchObject({
      state: "submitted",
      completionContinuations: 1,
      deliveryState: "none",
      dispatchAfterSeq: 1,
    });
  } finally {
    releaseProvider();
    vi.useRealTimers();
  }
});

it("keeps a late continuation completion fenced after retiring its controller generation", async () => {
  vi.useFakeTimers();
  const { store, fence, clock } = serviceFixture();
  const turn = submittedServiceTurn(store, fence, {
    updateId: 55_103,
    threadId: "thr_retired_continuation",
  });
  expect(store.recordControllerNativeEvidence({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [],
  })).toBe("recorded");
  let releaseProvider!: () => void;
  const providerCall = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const { adapter, send } = sdkFixture({ maxSeq: 1, eventPages: [[], [], [], []] });
  send.mockImplementation(async () => {
    await providerCall;
    return { ok: true };
  });
  let now = 2_001;
  const service = new LunaControllerService({
    store,
    adapter,
    evidenceProjector,
    clock: { now: () => now },
  });
  const firstReconciliation = service.reconcile(fence, fence.signal);

  try {
    for (let microtask = 0; microtask < 20 && send.mock.calls.length === 0; microtask += 1) {
      await Promise.resolve();
    }
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(firstReconciliation).resolves.toBe(true);

    now = 3_001;
    await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
    now = 5_001;
    await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

    expect(adapter.hasPendingMutation()).toBe(true);
    expect(store.getControllerTurn(turn.id)).toMatchObject({
      state: "queued",
      completionContinuations: 2,
      deliveryState: "none",
    });
    expect(store.getControllerForOwner("7", "7")).toMatchObject({
      threadId: null,
      state: "pending_spawn",
    });
    expect(store.listControllerGenerations(turn.controllerKey, 10)).toContainEqual(expect.objectContaining({
      threadId: "thr_retired_continuation",
      endedAt: 5_001,
    }));

    releaseProvider();
    for (let microtask = 0; microtask < 20 && adapter.hasPendingMutation(); microtask += 1) {
      await Promise.resolve();
    }

    expect(send).toHaveBeenCalledOnce();
    expect(store.getControllerTurn(turn.id)).toMatchObject({
      state: "queued",
      completionContinuations: 2,
    });
    expect(store.getControllerForOwner("7", "7")?.threadId).toBeNull();
  } finally {
    releaseProvider();
    vi.useRealTimers();
  }
});

it("uses one same-session correction, one receipt-seeded fresh recovery, then a safe terminal", async () => {
  const { store, fence, clock } = serviceFixture();
  const turn = submittedServiceTurn(store, fence, { updateId: 56_001, threadId: "thr_graduated_recovery" });
  expect(store.updateControllerStream({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    cursor: 1,
    phase: "responding",
    inputAccepted: true,
    assistantDraft: { itemId: "draft-graduated", text: "Bounded unfinished answer" },
  })).toBe(true);
  expect(store.recordControllerNativeEvidence({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [],
  })).toBe("recorded");
  const receipt = { turnId: turn.id, toolName: "telegram_agent_cancel", argsSha256: "c".repeat(64) };
  expect(store.claimToolReceipt({ ...receipt, controllerKey: turn.controllerKey, ...fence, now: 2_000 })).toEqual({ outcome: "fresh" });
  store.completeToolReceipt({ ...receipt, result: JSON.stringify({ cancelled: true }), now: 2_000 });
  const spawn = vi.fn(async (spawnTurn: { id: string; inputText: string }) => {
    expect(spawnTurn.inputText).toContain("Bounded unfinished answer");
    expect(spawnTurn.inputText).toContain("telegram_agent_cancel: already done");
    expect(spawnTurn.inputText).toMatch(/do not repeat/i);
    expect(store.reserveControllerSpawn({
      controllerKey: turn.controllerKey, turnId: turn.id, projectId: "proj_personal", hostId: "host_personal", now: 2_002,
    })).toBe(true);
    return { threadId: "thr_fresh_recovery", projectId: "proj_personal", hostId: "host_personal", spawnToken: spawnTurn.id };
  });
  const send = vi.fn(async () => undefined);
  const adapter: ControllerAdapter = {
    configuredProfileCount: () => 1,
    spawn, send, status: vi.fn(async () => "idle" as const), latestSeq: vi.fn(async () => 1),
    events: vi.fn(async () => ({
      latestSeq: 1, inputAccepted: false, assistantOutputObserved: false, toolActivityObserved: false, completed: true,
      failure: null, assistantDraft: null,
      interactionReferences: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
    steer: vi.fn(), answerQuestion: vi.fn(), findSpawnCandidate: vi.fn(async () => null),
  };
  let now = 2_001;
  const service = new LunaControllerService({ store, adapter, evidenceProjector, clock: { now: () => now } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "submitted", completionContinuations: 1 });

  now = 2_002;
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "queued", completionContinuations: 2 });
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(store.recordControllerNativeEvidence({
    ...fence,
    now: 2_002,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [],
  })).toBe("recorded");

  now = 2_003;
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed", completionContinuations: 2 });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toMatch(/tried that again/i);
});

it("uses the vetted stall notice when exhausted recovery cannot read its event high-water", async () => {
  const { db, store, fence, clock } = serviceFixture();
  const turn = submittedServiceTurn(store, fence, { updateId: 56_002, threadId: "thr_stalled_recovery" });
  db.prepare(
    "UPDATE controller_turns SET completion_continuations = 2, updated_at = 0 WHERE id = ?",
  ).run(turn.id);
  expect(store.renewExecutorLease(
    fence.ownerId,
    fence.generation,
    2_001,
    CONTROLLER_STALL_MS + 30_000,
  )).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(),
    send: vi.fn(),
    status: vi.fn(),
    latestSeq: vi.fn(async () => { throw new Error("host unavailable"); }),
    events: vi.fn(),
    steer: vi.fn(),
    answerQuestion: vi.fn(),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({
    store,
    adapter,
    evidenceProjector,
    clock: { now: () => CONTROLLER_STALL_MS + 2_001 },
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed", completionContinuations: 2 });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toMatch(/stopped making progress/i);
  expect(adapter.status).not.toHaveBeenCalled();
  expect(adapter.events).not.toHaveBeenCalled();
});

it("relaunches a turn that asked for more capability, instead of stranding the request", async () => {
  // The fault the owner watched for four turns: the agent asks for a bundle,
  // a profile is written, the turn finalizes, and the tools never arrive. The
  // relaunch can only act on a submitted turn, so finalizing first strands it
  // permanently and the agent asks again next turn, and the next.
  const { store, fence, clock } = serviceFixture();
  const turn = submittedServiceTurn(store, fence, { updateId: 91, threadId: "thr_expansion" });

  const requested = store.requestControllerCapabilityExpansion({
    ...fence,
    now: 2_001,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    bundleIds: ["job-control"],
    expectedProfileId: store.getControllerTurn(turn.id)?.capabilityProfileId ?? "",
  });
  expect(requested.outcome).toBe("resume_required");
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "submitted",
    capabilityContinuationState: "requested",
  });

  const adapter = {
    status: vi.fn(async () => "idle" as const),
    events: vi.fn(async () => []),
    send: vi.fn(async () => undefined),
    spawn: vi.fn(async () => ({ threadId: "thr_expansion", projectId: "proj_personal", hostId: "host_personal" })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
  };
  const service = new LunaControllerService({
    store,
    adapter: adapter as never,
    evidenceProjector,
    clock,
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  // Back in the queue against the expanded profile, rather than completed with
  // the request stranded behind it.
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "queued",
    capabilityContinuationState: "relaunching",
  });
});
