import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import {
  BbControllerAdapter,
  ControllerImagePreparationError,
  type ControllerAdapter,
} from "../src/controller/bb-controller";
import {
  DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  type ControllerExecutionProfile,
} from "../src/controller/execution-profile";
import { LunaControllerService } from "../src/controller/service";
import { CONTROLLER_UNWATCHED_PROMISE_RESPONSE } from "../src/controller/promise-gate";

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
    state: "dispatching",
    leaseOwner: "executor",
    leaseGeneration: 1,
    dispatchAfterSeq: 0,
    retryCount: 0,
    modelFallbackIndex: 0,
    bbEventSeq: 0,
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
  downloadImage?: (fileId: string, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array>;
  sampleMotionFrames?: (input: {
    bytes: Uint8Array;
    fileName: string;
    signal: AbortSignal;
  }) => Promise<readonly { fileName: string; mimeType: "image/jpeg"; bytes: Uint8Array }[]>;
} = {}) {
  const spawn = vi.fn(async (
    _input: Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0],
  ) => ({ id: "thr_controller", environmentId: "env_personal" }));
  const send = vi.fn(async () => ({ ok: true }));
  const upload = vi.fn(async (input: {
    clientFile: Uint8Array;
    filename: string;
    mimeType?: string;
  }) => ({
    type: "localImage" as const,
    path: `/attachments/${input.filename}`,
    name: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.clientFile.byteLength,
  }));
  const list = vi.fn(async () => options.threads ?? []);
  const get = vi.fn(async () => ({
    id: "thr_controller",
    status: "idle",
    providerId: options.threadProvider ?? "claude-code",
    archivedAt: null,
    deletedAt: null,
  }));
  const output = vi.fn(async () => ({ output: "Hello from Luna." }));
  const pages = options.eventPages ?? [options.events ?? []];
  let page = 0;
  const eventsList = vi.fn(async () => pages[page++] ?? []);
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
    executionProfiles: () => options.executionProfiles ?? [
      options.executionProfile ?? DEFAULT_CONTROLLER_EXECUTION_PROFILE,
    ],
    downloadImage: options.downloadImage,
    sampleMotionFrames: options.sampleMotionFrames,
  };
  return { adapter: new BbControllerAdapter(dependencies), spawn, send, upload, list, eventsList, timeline };
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

  await adapter.spawn(turnRecord(), controllerRecord(), AbortSignal.timeout(1_000));

  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
    projectId: "proj_personal",
    providerId: "claude-code",
    model: "claude-opus-5[1m]",
    reasoningLevel: "xhigh",
    permissionMode: "full",
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
    input: [{ type: "text", text: expect.stringContaining("What projects can you work on?"), mentions: [] }],
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
    permissionMode: "full",
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
  const downloadImage = vi.fn(async () => bytes);
  const { adapter, send, upload } = sdkFixture({ downloadImage });
  const signal = AbortSignal.timeout(1_000);

  await adapter.send("thr_controller", "Fix this overlap", signal, {
    fileId: "telegram-file-id",
    fileName: "telegram-screenshot.png",
    mimeType: "image/png",
    sizeBytes: 4,
  });

  expect(downloadImage).toHaveBeenCalledWith("telegram-file-id", 10 * 1024 * 1024, signal);
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

it("uses BB's active-steer mode for a text correction", async () => {
  const { adapter, send } = sdkFixture();

  await adapter.steer("thr_controller", "Use the second option instead", AbortSignal.timeout(1_000));

  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    threadId: "thr_controller",
    mode: "steer-if-active",
  }));
});

it("samples a Telegram video into ordered stills the controller can see", async () => {
  const videoBytes = new Uint8Array([9, 9, 9]);
  const frameA = new Uint8Array([1]);
  const frameB = new Uint8Array([2]);
  const downloadImage = vi.fn(async (fileId: string) => {
    if (fileId === "video-file-id") return videoBytes;
    throw new Error(`unexpected file ${fileId}`);
  });
  const sampleMotionFrames = vi.fn(async () => [
    { fileName: "telegram-clip-frame-01.jpg", mimeType: "image/jpeg" as const, bytes: frameA },
    { fileName: "telegram-clip-frame-02.jpg", mimeType: "image/jpeg" as const, bytes: frameB },
  ]);
  const { adapter, send, upload } = sdkFixture({ downloadImage, sampleMotionFrames });

  await adapter.send("thr_controller", "What is on this screen?", AbortSignal.timeout(1_000), {
    fileId: "video-file-id",
    fileName: "telegram-clip.mp4",
    mimeType: "video/mp4",
    sizeBytes: 3,
    kind: "video",
    durationSeconds: 8,
    thumbnail: {
      fileId: "thumb-file-id",
      fileName: "telegram-clip-thumb.jpg",
      sizeBytes: 1,
    },
  });

  expect(downloadImage).toHaveBeenCalledWith("video-file-id", 20 * 1024 * 1024, expect.any(AbortSignal));
  expect(upload).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    input: [
      {
        type: "text",
        text: expect.stringContaining("The owner sent a video. These 2 stills are sampled in order"),
        mentions: [],
      },
      { type: "localImage", path: "/attachments/telegram-clip-frame-01.jpg" },
      { type: "localImage", path: "/attachments/telegram-clip-frame-02.jpg" },
    ],
  }));
});

it("falls back to the Telegram preview still when a clip cannot be sampled", async () => {
  const downloadImage = vi.fn(async (fileId: string) => {
    if (fileId === "thumb-file-id") return new Uint8Array([3]);
    return new Uint8Array([9, 9, 9]);
  });
  const { adapter, send, upload } = sdkFixture({
    downloadImage,
    sampleMotionFrames: async () => [],
  });

  await adapter.send("thr_controller", "Look at this", AbortSignal.timeout(1_000), {
    fileId: "video-file-id",
    fileName: "telegram-clip.mp4",
    mimeType: "video/mp4",
    sizeBytes: 3,
    kind: "video",
    durationSeconds: 5,
    thumbnail: {
      fileId: "thumb-file-id",
      fileName: "telegram-clip-thumb.jpg",
      sizeBytes: 1,
    },
  });

  expect(upload).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(expect.objectContaining({
    input: [
      { type: "text", text: expect.stringContaining("preview still"), mentions: [] },
      { type: "localImage", path: "/attachments/telegram-clip-thumb.jpg" },
    ],
  }));
});

it("classifies a pre-submit image download failure as retryable", async () => {
  const downloadImage = vi.fn(async () => { throw new Error("temporary Telegram outage"); });
  const { adapter, send } = sdkFixture({ downloadImage });

  await expect(adapter.send("thr_controller", "Inspect this", AbortSignal.timeout(1_000), {
    fileId: "telegram-file-id",
    fileName: "telegram-screenshot.png",
    mimeType: "image/png",
    sizeBytes: null,
  })).rejects.toMatchObject({ name: "ControllerImagePreparationError", retryable: true });
  expect(send).not.toHaveBeenCalled();
});

it("reduces BB controller events after the durable sequence without exposing reasoning", async () => {
  const events = [
    { id: "e11", threadId: "thr_controller", seq: 11, createdAt: 11, scope: { kind: "thread" }, type: "turn/input/accepted", data: {} },
    { id: "e12", threadId: "thr_controller", seq: 12, createdAt: 12, scope: { kind: "thread" }, type: "item/reasoning/textDelta", data: { delta: "private chain" } },
    { id: "e12b", threadId: "thr_controller", seq: 12.5, createdAt: 12, scope: { kind: "thread" }, type: "item/reasoning/summaryTextDelta", data: { delta: "Checking the webhook" } },
    { id: "e13", threadId: "thr_controller", seq: 13, createdAt: 13, scope: { kind: "thread" }, type: "item/agentMessage/delta", data: { delta: "Hello" } },
    { id: "e14", threadId: "thr_controller", seq: 14, createdAt: 14, scope: { kind: "thread" }, type: "turn/completed", data: {} },
  ];
  const { adapter, eventsList } = sdkFixture({ events });
  const signal = AbortSignal.timeout(1_000);

  await expect(adapter.events("thr_controller", 10, signal)).resolves.toEqual({
    latestSeq: 14,
    inputAccepted: true,
    assistantDelta: "Hello",
    thinkingDelta: "Checking the webhook",
    completed: true,
    error: null,
    pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0,
  });
  expect(eventsList).toHaveBeenCalledWith({
    threadId: "thr_controller",
    afterSeq: "10",
    limit: "100",
    signal,
  });
});

it("reads every page of BB controller events rather than the first hundred", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => agentDelta(index + 1, "a"));
  const { adapter, eventsList } = sdkFixture({
    eventPages: [firstPage, [agentDelta(101, "b"), { ...agentDelta(102, "" ), type: "turn/completed", data: {} }]],
  });

  await expect(adapter.events("thr_controller", 0, AbortSignal.timeout(1_000))).resolves.toMatchObject({
    latestSeq: 102,
    assistantDelta: "a".repeat(100) + "b",
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
    title: "Telegram Codex controller owner-7-controller",
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

it("selects each configured fallback profile from the turn's durable fallback index", async () => {
  const executionProfiles: readonly ControllerExecutionProfile[] = [
    DEFAULT_CONTROLLER_EXECUTION_PROFILE,
    {
      model: "gpt-5.6-terra",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "accept-edits",
    },
    {
      model: "gpt-5.6-sol",
      reasoningLevel: "high",
      serviceTier: "fast",
      permissionMode: "accept-edits",
    },
  ];
  const { adapter, spawn } = sdkFixture({ executionProfiles, threadProvider: "codex" });

  await adapter.spawn(
    turnRecord({ modelFallbackIndex: 1 }),
    controllerRecord(),
    AbortSignal.timeout(1_000),
  );
  await adapter.spawn(
    turnRecord({ modelFallbackIndex: 2 }),
    controllerRecord(),
    AbortSignal.timeout(1_000),
  );

  expect(spawn.mock.calls.map(([input]) => ({
    providerId: input.providerId,
    model: input.model,
  }))).toEqual([
    { providerId: "codex", model: "gpt-5.6-terra" },
    { providerId: "codex", model: "gpt-5.6-sol" },
  ]);
  expect(adapter.hasExecutionProfile(0)).toBe(true);
  expect(adapter.hasExecutionProfile(2)).toBe(true);
  expect(adapter.hasExecutionProfile(3)).toBe(false);
  await expect(adapter.status("thr_controller", AbortSignal.timeout(1_000), 1)).resolves.toBe("idle");
  await expect(adapter.status("thr_controller", AbortSignal.timeout(1_000), 0)).resolves.toBe("incompatible");
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
    title: "Telegram Luna controller owner-7-controller",
    visibility: "hidden",
    originPluginId: "telegram-agent",
    archivedAt: null,
    deletedAt: null,
  };
  const one = sdkFixture({ threads: [candidate] });
  await expect(one.adapter.findSpawnCandidate("owner-7-controller", AbortSignal.timeout(1_000))).resolves.toMatchObject({
    threadId: "thr_candidate",
    projectId: "proj_personal",
    hostId: "host_personal",
  });

  const ambiguous = sdkFixture({ threads: [candidate, { ...candidate, id: "thr_other" }] });
  await expect(ambiguous.adapter.findSpawnCandidate("owner-7-controller", AbortSignal.timeout(1_000))).rejects.toThrow(/multiple|ambiguous/i);
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

  await expect(adapter.findSpawnCandidate("owner-7-controller", AbortSignal.timeout(1_000))).resolves.toBeNull();
});

let serviceFixtureNumber = 0;
function serviceFixture() {
  const { bb } = createFakePluginHost({ pluginId: `telegram-controller-service-${serviceFixtureNumber++}` });
  const store = openStore(bb.storage, bb.storage.kv, () => 2_000);
  store.createPairingCode(hashSecret("pair"), 1_000, 10_000);
  expect(store.pairOwnerWithCode(hashSecret("pair"), "7", "7", 1_001)).toEqual({ ok: true });
  const lease = store.acquireExecutorLease("executor", 2_000, 30_000);
  if (!lease.acquired) throw new Error("missing lease");
  const fence = { ownerId: "executor", generation: lease.generation, signal: AbortSignal.timeout(2_000) };
  return { store, fence };
}

it("dispatches FIFO, waits for idle output, and then sends the next turn with mode start", async () => {
  const { store, fence } = serviceFixture();
  store.enqueueControllerTurn({ ...turnRecord({ updateId: 11, inputText: "first" }), telegramUserId: "7", telegramChatId: "7", now: 2_000 });
  store.enqueueControllerTurn({ ...turnRecord({ updateId: 12, inputText: "second" }), telegramUserId: "7", telegramChatId: "7", now: 2_001 });
  let status: "active" | "idle" = "active";
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: async () => status,
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => "First answer."),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_000 } });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(false);
  expect(store.listControllerTurns("owner-7-controller", 10).map((turn) => turn.state)).toEqual(["submitted", "queued"]);

  status = "idle";
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getOutbox("controller:controller-turn-11:reply")?.payload.text).toBe("First answer.");
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(adapter.send).toHaveBeenCalledWith("thr_controller", "second", fence.signal);
  expect(store.listControllerTurns("owner-7-controller", 10).map((turn) => turn.state)).toEqual(["completed", "submitted"]);
});

it("relaunches once at an idle capability boundary before exposing the expanded profile", async () => {
  const { store, fence } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    controllerKey: "owner-7-controller",
    telegramUserId: "7",
    telegramChatId: "7",
    updateId: 120,
    inputText: "show job status",
    now: 2_000,
  });
  let spawnCount = 0;
  const spawn = vi.fn(async (_turn: Parameters<ControllerAdapter["spawn"]>[0]) => ({
    threadId: `thr_capability_${++spawnCount}`,
    projectId: "proj_personal",
    hostId: "host_personal",
  }));
  const stop = vi.fn(async () => undefined);
  const output = vi.fn(async () => "This partial answer must not be delivered.");
  const findSpawnCandidate = vi.fn(async () => null);
  const adapter: ControllerAdapter = {
    spawn,
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    output,
    events: vi.fn(async () => ({
      latestSeq: 1,
      inputAccepted: true,
      assistantDelta: "",
      completed: true,
      error: null,
      pendingQuestion: null,
      toolCalls: 1,
      commandFailures: 0,
      totalTokens: 100,
    })),
    steer: vi.fn(async () => undefined),
    stop,
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate,
    hasExecutionProfile: () => false,
  };
  let now = 2_000;
  const service = new LunaControllerService({ store, adapter, clock: { now: () => now } });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  const initial = store.getActiveCapabilityProfile("controller_turn", turn.id);
  if (!initial) throw new Error("missing initial controller capability profile");
  const expanded = store.requestControllerCapabilityExpansion({
    controllerKey: turn.controllerKey,
    turnId: turn.id,
    expectedProfileId: initial.id,
    bundleIds: ["job-control"],
    now: ++now,
  });
  expect(expanded).toMatchObject({ outcome: "resume_required", profile: { revision: 2 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(stop).toHaveBeenCalledWith("thr_capability_1", fence.signal);
  expect(output).not.toHaveBeenCalled();
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "queued",
    capabilityContinuationCount: 1,
    capabilityContinuationState: "relaunching",
    capabilityConfiguredRevision: 1,
  });

  now += 1;
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(findSpawnCandidate).not.toHaveBeenCalled();
  expect(spawn.mock.calls[1]?.[0].inputText).toContain("Resume the same owner request");
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "submitted",
    capabilityProfileRevision: 2,
    capabilityConfiguredRevision: 2,
    capabilityContinuationState: "resolved",
  });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    threadId: "thr_capability_2",
    capabilitySubjectId: turn.id,
    capabilityProfileRevision: 2,
  });

  if (expanded.outcome !== "resume_required") throw new Error("capability expansion was denied");
  expect(store.requestControllerCapabilityExpansion({
    controllerKey: turn.controllerKey,
    turnId: turn.id,
    expectedProfileId: expanded.profile.id,
    bundleIds: ["memory"],
    now: ++now,
  })).toEqual({ outcome: "denied", reasonCode: "expansion_limit" });
});

it("refuses to deliver a future check-in promise without a durable watch", async () => {
  const { store, fence } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 13, inputText: "keep me posted" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => "I'll follow up when the job finishes."),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: true, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_000 } });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)?.responseText).toBe(CONTROLLER_UNWATCHED_PROMISE_RESPONSE);
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toBe(CONTROLLER_UNWATCHED_PROMISE_RESPONSE);
});

it("delivers a future check-in promise backed by a completed durable watch receipt", async () => {
  const { store, fence } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 14, inputText: "tell me when it finishes" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  const promised = "I'll let you know when the job finishes.";
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => promised),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: true, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_000 } });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  const receipt = {
    turnId: turn.id,
    toolName: "telegram_agent_watch",
    argsSha256: "a".repeat(64),
  };
  expect(store.claimToolReceipt({ ...receipt, controllerKey: turn.controllerKey, now: 2_000 })).toEqual({ outcome: "fresh" });
  store.completeToolReceipt({
    ...receipt,
    result: JSON.stringify({ watching: { id: "monitor_1", kind: "thread_idle", state: "armed", threadId: "thr_job" } }),
    now: 2_000,
  });
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)?.responseText).toBe(promised);
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toBe(promised);
});

it("keeps a queued image durable until the active turn finishes", async () => {
  const { store, fence } = serviceFixture();
  const running = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 15, inputText: "first request" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  const leaseFence = { ownerId: fence.ownerId, generation: fence.generation, now: 2_000 };
  expect(store.claimNextControllerTurn(leaseFence)?.id).toBe(running.id);
  expect(store.markControllerSpawned({
    ...leaseFence,
    turnId: running.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...leaseFence, turnId: running.id })).toBe(true);
  const image = {
    fileId: "replacement-file-id",
    fileName: "telegram-replacement.webp",
    mimeType: "image/webp" as const,
    sizeBytes: 8,
  };
  const waiting = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 16, inputText: "Use this screenshot instead", image }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_001,
  });
  let status: "active" | "idle" = "active";
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => status),
    latestSeq: vi.fn(async () => 1),
    output: vi.fn(async () => "First answer."),
    events: vi.fn(async () => ({ latestSeq: 1, inputAccepted: true, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_001 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(adapter.steer).not.toHaveBeenCalled();
  expect(store.getControllerTurn(waiting.id)).toMatchObject({ state: "queued", image });

  status = "idle";
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(adapter.send).toHaveBeenCalledWith(
    "thr_controller",
    "Use this screenshot instead",
    fence.signal,
    expect.objectContaining(image),
  );
});

it("requeues a transient image preparation failure without adopting a late spawn candidate", async () => {
  const { store, fence } = serviceFixture();
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
    now: 2_000,
  });
  const findSpawnCandidate = vi.fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ threadId: "thr_unrelated", projectId: "proj_personal", hostId: "host_personal" });
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => { throw new ControllerImagePreparationError(true); }),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate,
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_001 } });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  expect(findSpawnCandidate).not.toHaveBeenCalled();
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "queued",
    retryCount: 2,
    modelFallbackIndex: 0,
  });
  expect(store.getControllerForOwner("7", "7")?.threadId).toBeNull();
});

it("requeues an aborted image preparation without consuming a retry", async () => {
  const { store, fence } = serviceFixture();
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
    now: 2_000,
  });
  const aborted = new AbortController();
  aborted.abort();
  const findSpawnCandidate = vi.fn(async () => ({
    threadId: "thr_unrelated",
    projectId: "proj_personal",
    hostId: "host_personal",
  }));
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => { throw new ControllerImagePreparationError(true); }),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate,
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_001 } });

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

it("requeues a turn while the controller thread is still busy instead of failing it", async () => {
  const { store, fence } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 61, inputText: "answer me" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id)
    .toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_busy",
  })).toBe(true);
  expect(store.failControllerTurn({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    error: "setup",
  })).toBe(true);
  const pending = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 62, inputText: "second question" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_001,
  });
  let status: "active" | "idle" = "active";
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => status),
    latestSeq: vi.fn(async () => 4),
        output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({ latestSeq: 4, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_002 } });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(pending.id)).toMatchObject({ state: "queued", lastError: null });
  expect(adapter.send).not.toHaveBeenCalled();

  status = "idle";
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(adapter.send).toHaveBeenCalledWith("thr_busy", "second question", fence.signal);
  expect(store.getControllerTurn(pending.id)).toMatchObject({ state: "submitted", dispatchAfterSeq: 4 });
});

it("gives up on a turn the busy controller never accepts within its bounded wait", async () => {
  const { store, fence } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 63, inputText: "answer me" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id)
    .toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_wedged",
  })).toBe(true);
  expect(store.failControllerTurn({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    error: "setup",
  })).toBe(true);
  const stranded = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 64, inputText: "second question" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_001,
  });
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
        output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const wedgedAt = 2_001 + 15 * 60_000;
  expect(store.renewExecutorLease(fence.ownerId, fence.generation, 2_100, 30 * 60_000)).toBe(true);
  const service = new LunaControllerService({ store, adapter, clock: { now: () => wedgedAt } });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(stranded.id)).toMatchObject({
    state: "failed",
    lastError: "Controller thread stayed busy for too long",
  });
  expect(store.getOutbox(`controller:${stranded.id}:reply`)?.status).toBe("pending");
});

it("delivers a completed answer even when the controller thread ends in error", async () => {
  const { store, fence } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 65, inputText: "answer then break" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id)
    .toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_answered_then_errored",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
  })).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "error" as const),
    latestSeq: vi.fn(async () => 12),
        output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({
      latestSeq: 12,
      inputAccepted: true,
      assistantDelta: "Here is the answer.",
      completed: true,
      error: null,
      pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_002 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "completed",
    responseText: "Here is the answer.",
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toBe("Here is the answer.");
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ threadId: null, state: "pending_spawn" });
});

it("reports a streaming turn only while its answer is still arriving", async () => {
  const { store, fence } = serviceFixture();
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_000 } });
  expect(service.isStreaming()).toBe(false);

  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 71, inputText: "stream this" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(service.isStreaming()).toBe(false);

  const claim = { ownerId: fence.ownerId, generation: fence.generation, now: 2_000 };
  expect(store.claimNextControllerTurn(claim)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    ...claim,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...claim, turnId: turn.id })).toBe(true);
  expect(service.isStreaming()).toBe(true);

  expect(store.completeControllerTurn({ ...claim, turnId: turn.id, responseText: "Answered." })).toBe(true);
  expect(service.isStreaming()).toBe(false);
});

it("fails an uncertain send closed and never submits it twice", async () => {
  const { store, fence } = serviceFixture();
  store.enqueueControllerTurn({ ...turnRecord({ updateId: 21, inputText: "send once" }), telegramUserId: "7", telegramChatId: "7", now: 2_000 });
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => { throw new Error("uncertain send"); }),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({ latestSeq: 22, inputAccepted: true, assistantDelta: "", completed: false, error: "Controller provider turn failed", pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal" })),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_000 } });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })).not.toBeNull();
  expect(store.markControllerSpawned({
    turnId: "controller-turn-21",
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
  })).toBe(true);
  expect(store.failControllerTurn({
    turnId: "controller-turn-21",
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    error: "setup",
  })).toBe(true);
  store.enqueueControllerTurn({ ...turnRecord({ updateId: 22, inputText: "send once" }), telegramUserId: "7", telegramChatId: "7", now: 2_001 });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(false);
  expect(adapter.send).toHaveBeenCalledTimes(1);
  expect(store.listControllerTurns("owner-7-controller", 10).at(-1)?.state).toBe("failed");
});

it("keeps an idle submitted turn durable when BB output retrieval fails transiently", async () => {
  const { store, fence } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 31, inputText: "answer after retry" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_controller",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
  })).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => { throw new Error("temporary BB output failure"); }),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_000 } });

  await expect(service.reconcile(fence, fence.signal)).rejects.toThrow("temporary BB output failure");

  expect(store.listControllerTurns("owner-7-controller", 10)[0]?.state).toBe("submitted");
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    payload: { text: "Connecting…" },
  });
});

it("fails one unsafe final reply without crashing controller reconciliation", async () => {
  const { store, fence } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 32, inputText: "answer safely" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  const claim = { ownerId: fence.ownerId, generation: fence.generation, now: 2_000 };
  expect(store.claimNextControllerTurn(claim)?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    ...claim,
    turnId: turn.id,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_unsafe_reply",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({ ...claim, turnId: turn.id })).toBe(true);
  const unsafeReply = `m:${"N".repeat(32)}`;
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => unsafeReply),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: true, assistantDelta: "", completed: true, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_001 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed" });
  expect(store.getPendingControllerTurn("owner-7-controller")).toBeNull();
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload).toMatchObject({
    text: "I couldn't return that response safely. Please ask again.",
  });
  expect(JSON.stringify(store.getOutbox(`controller:${turn.id}:reply`)?.payload)).not.toContain(unsafeReply);
});

it("projects active Luna assistant deltas into the durable controller reply", async () => {
  const { store, fence } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 36, inputText: "stream answer" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id)
    .toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_streaming",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    dispatchAfterSeq: 8,
    now: 2_000,
  })).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({
      latestSeq: 10,
      inputAccepted: true,
      assistantDelta: "Working on it",
      completed: false,
      error: null,
      pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_001 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(adapter.events).toHaveBeenCalledWith("thr_streaming", 8, fence.signal);
  expect(store.listControllerTurns("owner-7-controller", 10)[0]).toMatchObject({
    bbEventSeq: 10,
    streamText: "Working on it",
    streamPhase: "responding",
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    payload: { text: "Working on it" },
  });
});

it("refreshes an unchanged active Luna draft before Telegram expires it", async () => {
  const { store, fence } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 37, inputText: "keep thinking" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id)
    .toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_thinking",
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
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => "unused"),
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
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 22_000 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    messageId: null,
  });
});

it.each([
  ["accepted the input", true, 0],
  ["started a tool", false, 1],
] as const)("does not use a fallback after the provider %s", async (
  _scenario,
  inputAccepted,
  toolCalls,
) => {
  const { store, fence } = serviceFixture();
  const failed = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 41, inputText: "show active threads" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  store.enqueueControllerTurn({
    ...turnRecord({ updateId: 42, inputText: "try again" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_001,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id)
    .toBe(failed.id);
  expect(store.markControllerSpawned({
    turnId: failed.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_poisoned",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: failed.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
  })).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({
      threadId: "thr_fresh",
      projectId: "proj_personal",
      hostId: "host_personal",
    })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async (threadId: string) => threadId === "thr_poisoned" ? "error" : "active"),
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({ latestSeq: 22, inputAccepted, assistantDelta: "", completed: false, error: "Controller provider turn failed", pendingQuestion: null, toolCalls, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => true,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_002 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.listControllerTurns("owner-7-controller", 10).map((turn) => turn.state))
    .toEqual(["failed", "queued"]);
  expect(store.getOutbox(`controller:${failed.id}:reply`)?.payload.text).toBe(
    "I couldn't complete that controller turn safely. Please resend your request.",
  );
  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    threadId: null,
    state: "pending_spawn",
  });
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerForOwner("7", "7")?.threadId).toBe("thr_fresh");
});

it("recovers from the 2026-08-10 poisoned controller before dispatching the next message", async () => {
  const { store, fence } = serviceFixture();
  const previous = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 46, inputText: "previous failed request" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id)
    .toBe(previous.id);
  expect(store.markControllerSpawned({
    turnId: previous.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_poisoned_idle",
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
    now: 2_002,
  });
  const spawn = vi.fn(async () => ({
    threadId: "thr_fresh_after_poison",
    projectId: "proj_personal",
    hostId: "host_personal",
  }));
  const adapter: ControllerAdapter = {
    spawn,
    send: vi.fn(async () => undefined),
    status: vi.fn(async (threadId: string) => threadId === "thr_poisoned_idle" ? "error" : "active"),
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_003 } });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  expect(store.listControllerTurns("owner-7-controller", 10).at(-1)).toMatchObject({
    id: next.id,
    state: "submitted",
  });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(store.getControllerForOwner("7", "7")?.threadId).toBe("thr_fresh_after_poison");
});

it("retires an errored controller generation even when no turn remains submitted", async () => {
  const { store, fence } = serviceFixture();
  const previous = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 48, inputText: "provider initialization timed out" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id)
    .toBe(previous.id);
  expect(store.markControllerSpawned({
    turnId: previous.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_initialize_timeout",
  })).toBe(true);
  expect(store.failControllerTurn({
    turnId: previous.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_001,
    error: "Controller send outcome is uncertain",
  })).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "error" as const),
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => "unused"),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantDelta: "", completed: false, error: null, pendingQuestion: null, toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    answerQuestion: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_002 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    threadId: null,
    state: "pending_spawn",
  });
});

it("recovers from the 2026-08-13 unaccepted provider login failure, then reports fallback exhaustion", async () => {
  const { store, fence } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 51, inputText: "show active threads" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id)
    .toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    projectId: "proj_personal",
    hostId: "host_personal",
    threadId: "thr_never_accepted",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id,
    ownerId: fence.ownerId,
    generation: fence.generation,
    dispatchAfterSeq: 9,
    now: 2_000,
  })).toBe(true);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({
      threadId: "thr_retry",
      projectId: "proj_personal",
      hostId: "host_personal",
    })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "error" as const),
    latestSeq: vi.fn(async () => 0),
    output: vi.fn(async () => "unused"),
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
    hasExecutionProfile: vi.fn((index: number) => index <= 1),
  };
  const service = new LunaControllerService({ store, adapter, clock: { now: () => 2_002 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.listControllerTurns("owner-7-controller", 10)[0]).toMatchObject({
    state: "queued",
    retryCount: 1,
    modelFallbackIndex: 1,
    dispatchAfterSeq: 0,
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    payload: { text: "Connecting…" },
  });
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "submitted",
    modelFallbackIndex: 1,
  });
  expect(store.getControllerForOwner("7", "7")?.threadId).toBe("thr_retry");

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "failed",
    modelFallbackIndex: 1,
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    payload: {
      text: "I couldn't connect using any configured controller model. Check provider login or change the controller fallback models in Settings, then resend.",
    },
  });
});
