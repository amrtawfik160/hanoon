import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { expect, it, vi } from "vitest";
import { hashSecret } from "../src/crypto";
import { openStore } from "../src/storage/store";
import {
  CONTROLLER_PHASE_TEXT,
} from "../src/controller/models";
import {
  BbControllerAdapter,
  ControllerImagePreparationError,
  type ControllerAdapter,
} from "../src/controller/bb-controller";
import {
  DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  type ControllerExecutionProfile,
} from "../src/controller/execution-profile";
import { CONTROLLER_UNWATCHED_PROMISE_RESPONSE } from "../src/controller/promise-gate";
import {
  CONTROLLER_STALL_MS,
  LunaControllerService,
  type ControllerInteractionReconciler,
} from "../src/controller/service";
import { CONTROLLER_INSTRUCTION_SENTINEL } from "../src/controller/instructions";
import { ControllerInteractionService } from "../src/controller/interaction-service";
import { ControllerInteractionRepository } from "../src/storage/controller-interaction-repository";
import {
  ControllerEvidenceProjectorError,
  type ControllerEvidenceReconciler,
  type ControllerEvidenceReconciliation,
} from "../src/controller/evidence-projector";


function stubInteractionService(
  overrides: Partial<ControllerInteractionReconciler> = {},
): ControllerInteractionReconciler {
  return {
    deliverAnswered: vi.fn(async () => false),
    fetchPending: vi.fn(async () => ({ outcome: "invalid" as const })),
    ...overrides,
  };
}

const evidenceProjector = { reconcile: vi.fn(async () => ({
  outcome: "reconciled" as const,
  reconciliationIncomplete: null,
  fromSeq: 0,
  throughSeq: 0,
  targetSeq: 0,
})) };

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
    evidenceEventSeq: 0,
    completionContinuations: 0,
    acceptedFinalizationId: null,
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
    assistantOutputObserved: true, toolActivityObserved: false,
    completed: true,
    error: null,
    interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
  });
  expect(eventsList).toHaveBeenCalledWith({
    threadId: "thr_controller",
    afterSeq: "10",
    limit: "100",
    signal,
  });
});

it.each(["webFetch", "imageView"] as const)("counts %s as observed tool activity", async (itemType) => {
  const events = [{
    id: `e-${itemType}`,
    threadId: "thr_controller",
    seq: 11,
    createdAt: 11,
    scope: { kind: "thread" },
    type: "item/started",
    data: { item: { type: itemType } },
  }];
  const { adapter } = sdkFixture({ events });

  await expect(adapter.events("thr_controller", 10, AbortSignal.timeout(1_000))).resolves.toMatchObject({
    latestSeq: 11,
    toolActivityObserved: true,
    toolCalls: 1,
  });
});

it("reads every page of BB controller events rather than the first hundred", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => agentDelta(index + 1, "a"));
  const { adapter, eventsList } = sdkFixture({
    eventPages: [firstPage, [agentDelta(101, "b"), { ...agentDelta(102, "" ), type: "turn/completed", data: {} }]],
  });

  await expect(adapter.events("thr_controller", 0, AbortSignal.timeout(1_000))).resolves.toMatchObject({
    latestSeq: 102,
    assistantOutputObserved: true, toolActivityObserved: false,
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
  return { store, fence, db: bb.storage.database() };
}

it("dispatches FIFO and never completes an idle turn from raw provider output", async () => {
  evidenceProjector.reconcile.mockClear();
  const { store, fence } = serviceFixture();
  store.enqueueControllerTurn({ ...turnRecord({ updateId: 11, inputText: "first" }), telegramUserId: "7", telegramChatId: "7", now: 2_000 });
  store.enqueueControllerTurn({ ...turnRecord({ updateId: 12, inputText: "second" }), telegramUserId: "7", telegramChatId: "7", now: 2_001 });
  let status: "active" | "idle" = "active";
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: async () => status,
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantOutputObserved: false, toolActivityObserved: false, completed: false, error: null, interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 2_000 } });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(false);
  expect(store.listControllerTurns("owner-7-controller", 10).map((turn) => turn.state)).toEqual(["submitted", "queued"]);

  status = "idle";
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  // The pre-terminal reconcile boundary runs the evidence projector on every
  // pass for the submitted turn before any legacy/terminal work.
  expect(evidenceProjector.reconcile).toHaveBeenCalled();
  // Raw provider output and stream_text never become an answer: with no
  // accepted finalization the first turn stays submitted and durable, and the
  // outbox carries only the phase placeholder, never "First answer.".
  const turned = store.listControllerTurns("owner-7-controller", 10);
  expect(turned[0]?.state).toBe("submitted");
  expect(turned[0]?.responseText).toBeNull();
  expect(store.getOutbox("controller:controller-turn-11:reply")?.payload.text).toBe(CONTROLLER_PHASE_TEXT.connecting);
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
    events: vi.fn(async () => ({
      latestSeq: 1,
      inputAccepted: true,
      assistantOutputObserved: false,
      toolActivityObserved: false,
      completed: true,
      error: null,
      interactions: [],
      toolCalls: 1,
      commandFailures: 0,
      totalTokens: 100,
    })),
    steer: vi.fn(async () => undefined),
    stop,
    findSpawnCandidate,
    hasExecutionProfile: () => false,
  };
  let now = 2_000;
  const service = new LunaControllerService({ store, adapter, evidenceProjector, interactionService: stubInteractionService(), clock: { now: () => now } });

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
    events: vi.fn(async () => ({ latestSeq: 1, inputAccepted: true, assistantOutputObserved: false, toolActivityObserved: false, completed: false, error: null, interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  expect(store.recordControllerNativeEvidence({
    ...leaseFence,
    turnId: running.id,
    controllerKey: running.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [],
  })).toBe("recorded");
  const projector = makeProjector(async () => ({
    outcome: "reconciled" as const,
    reconciliationIncomplete: null,
    fromSeq: 1,
    throughSeq: 1,
    targetSeq: 1,
  }));
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector: projector, clock: { now: () => 2_001 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(adapter.steer).not.toHaveBeenCalled();
  expect(store.getControllerTurn(waiting.id)).toMatchObject({ state: "queued", image });

  status = "idle";
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  acceptAnswer(store, fence, running, "Finished.");
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
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantOutputObserved: false, toolActivityObserved: false, completed: false, error: null, interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate,
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 2_001 } });

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
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantOutputObserved: false, toolActivityObserved: false, completed: false, error: null, interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate,
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 2_001 } });

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
    events: vi.fn(async () => ({ latestSeq: 4, inputAccepted: false, assistantOutputObserved: false, toolActivityObserved: false, completed: false, error: null, interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 2_002 } });

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
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantOutputObserved: false, toolActivityObserved: false, completed: false, error: null, interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const wedgedAt = 2_001 + 15 * 60_000;
  expect(store.renewExecutorLease(fence.ownerId, fence.generation, 2_100, 30 * 60_000)).toBe(true);
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => wedgedAt } });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(stranded.id)).toMatchObject({
    state: "failed",
    lastError: "Controller thread stayed busy for too long",
  });
  expect(store.getOutbox(`controller:${stranded.id}:reply`)?.status).toBe("pending");
});

it("never completes an errored controller turn from raw provider output", async () => {
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
    events: vi.fn(async () => ({
      latestSeq: 12,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: true,
      error: null,
      interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 2_002 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  // Raw provider prose can never become a completed response, digest, or
  // final-answer outbox — the turn fails and the generation is retired.
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "failed",
    responseText: null,
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).not.toBe("Here is the answer.");
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ threadId: null, state: "pending_spawn" });
});

it("reports a streaming turn only while its answer is still arriving", async () => {
  const { store, fence } = serviceFixture();
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "idle" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantOutputObserved: false, toolActivityObserved: false, completed: false, error: null, interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 2_000 } });
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

  acceptAnswer(store, fence, turn, "Answered.");
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
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
    events: vi.fn(async () => ({ latestSeq: 22, inputAccepted: true, assistantOutputObserved: false, toolActivityObserved: false, completed: false, error: "Controller provider turn failed", interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => ({ threadId: "thr_controller", projectId: "proj_personal", hostId: "host_personal" })),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 2_000 } });
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

it("keeps an idle submitted turn durable when no accepted finalization exists", async () => {
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
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantOutputObserved: false, toolActivityObserved: false, completed: false, error: null, interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 2_000 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  // No raw output is read at idle: the turn stays submitted and durable, and
  // only the phase placeholder reaches the outbox.
  expect(store.listControllerTurns("owner-7-controller", 10)[0]?.state).toBe("submitted");
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    payload: { text: CONTROLLER_PHASE_TEXT.connecting },
  });
});

it("projects active assistant output into a phase-only durable controller draft", async () => {
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
    events: vi.fn(async () => ({
      latestSeq: 10,
      inputAccepted: true,
      assistantOutputObserved: true,
      toolActivityObserved: false,
      completed: false,
      error: null,
      interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 2_001 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(adapter.events).toHaveBeenCalledWith("thr_streaming", 8, fence.signal);
  // The raw "Working on it" prose never reaches the durable stream_text or the
  // outbox: only the phase-derived placeholder does.
  expect(store.listControllerTurns("owner-7-controller", 10)[0]).toMatchObject({
    bbEventSeq: 10,
    streamText: CONTROLLER_PHASE_TEXT.responding,
    streamPhase: "responding",
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    payload: { text: CONTROLLER_PHASE_TEXT.responding },
  });
});

it("never leaks pre-cutover raw stream_text into a draft or outbox", async () => {
  const { store, fence, db } = serviceFixture();
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 38, inputText: "migrate me" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now: 2_000 })?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000,
    projectId: "proj_personal", hostId: "host_personal", threadId: "thr_cutover",
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now: 2_000, dispatchAfterSeq: 3,
  })).toBe(true);
  // A pre-cutover row already holding raw provider prose must never surface.
  db.prepare("UPDATE controller_turns SET stream_text = ? WHERE id = ?").run("pre-cutover RAWSECRET prose", turn.id);
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 5, inputAccepted: true, assistantOutputObserved: true, toolActivityObserved: false,
      completed: false, error: null, interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 2_001 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  const stored = store.listControllerTurns("owner-7-controller", 10)[0];
  expect(stored?.streamText).toBe(CONTROLLER_PHASE_TEXT.responding);
  expect(stored?.streamText).not.toContain("RAWSECRET");
  const outbox = store.getOutbox(`controller:${turn.id}:reply`);
  expect(outbox?.payload.text).toBe(CONTROLLER_PHASE_TEXT.responding);
  expect(outbox?.payload.text).not.toContain("RAWSECRET");
  // The turn stays submitted and unfinished, so raw prose became no completed
  // response, digest, or final-answer outbox.
  expect(stored?.state).toBe("submitted");
  expect(stored?.responseText).toBeNull();
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
    events: vi.fn(async () => ({
      latestSeq: 0,
      inputAccepted: true,
      assistantOutputObserved: false, toolActivityObserved: false,
      completed: false,
      error: null,
      interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 22_000 } });

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
    events: vi.fn(async () => ({ latestSeq: 22, inputAccepted: true, assistantOutputObserved: false, toolActivityObserved: false, completed: false, error: "Controller provider turn failed", interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => true,
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 2_002 } });

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
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantOutputObserved: false, toolActivityObserved: false, completed: false, error: null, interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 2_003 } });

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
    events: vi.fn(async () => ({ latestSeq: 0, inputAccepted: false, assistantOutputObserved: false, toolActivityObserved: false, completed: false, error: null, interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0 })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 2_002 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    threadId: null,
    state: "pending_spawn",
  });
});

it("retries one unaccepted generation, then fails and retires the second provider error", async () => {
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
  const spawn = vi.fn(async () => ({
    threadId: "thr_retry",
    projectId: "proj_personal",
    hostId: "host_personal",
  }));
  let retryErrored = false;
  const adapter: ControllerAdapter = {
    spawn: vi.fn(async () => ({
      threadId: "thr_retry",
      projectId: "proj_personal",
      hostId: "host_personal",
    })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async (threadId: string) =>
      threadId === "thr_never_accepted" || retryErrored ? "error" : "active"),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 11,
      inputAccepted: false,
      assistantOutputObserved: false, toolActivityObserved: false,
      completed: false,
      error: "Controller provider turn failed",
      interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: vi.fn((index: number) => index <= 1),
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 2_002 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.listControllerTurns("owner-7-controller", 10)[0]).toMatchObject({
    state: "queued",
    retryCount: 1,
    modelFallbackIndex: 1,
    dispatchAfterSeq: 0,
  });
  expect(store.getOutbox(`controller:${turn.id}:reply`)).toMatchObject({
    status: "pending",
    payload: { text: CONTROLLER_PHASE_TEXT.connecting },
  });
  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "submitted",
    modelFallbackIndex: 1,
  });
  expect(store.getControllerForOwner("7", "7")?.threadId).toBe("thr_retry");

  retryErrored = true;
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed", retryCount: 1 });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
});

// ===== B2a: pre-terminal reconcile boundary + projection outcome routing =====

function makeProjector(impl?: () => Promise<ControllerEvidenceReconciliation>): ControllerEvidenceReconciler {
  return {
    reconcile: impl
      ? vi.fn(async () => impl())
      : vi.fn(async () => ({
        outcome: "reconciled" as const,
        reconciliationIncomplete: null,
        fromSeq: 0,
        throughSeq: 0,
        targetSeq: 0,
      })),
  };
}

function makeSubmittedServiceTurn(
  store: ReturnType<typeof openStore>,
  fence: { ownerId: string; generation: number },
  updateId: number,
  threadId: string,
): ReturnType<typeof store.enqueueControllerTurn> {
  const turn = store.enqueueControllerTurn({
    ...turnRecord({ updateId, inputText: "evidence work" }),
    telegramUserId: "7",
    telegramChatId: "7",
    now: 2_000,
  });
  const now = 2_000;
  expect(store.claimNextControllerTurn({ ownerId: fence.ownerId, generation: fence.generation, now })?.id).toBe(turn.id);
  expect(store.markControllerSpawned({
    turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now,
    projectId: "proj_personal", hostId: "host_personal", threadId,
  })).toBe(true);
  expect(store.markControllerTurnSubmitted({
    turnId: turn.id, ownerId: fence.ownerId, generation: fence.generation, now, dispatchAfterSeq: 4,
  })).toBe(true);
  return turn;
}

function adapterForSubmitted(): ControllerAdapter {
  return {
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(async () => undefined),
    status: vi.fn(async () => "active" as const),
    latestSeq: vi.fn(async () => 0),
    events: vi.fn(async () => ({
      latestSeq: 4, inputAccepted: true, assistantOutputObserved: false,
      toolActivityObserved: false, completed: false, error: null,
      interactions: [], toolCalls: 0, commandFailures: 0, totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
}

it("runs the evidence projector every pass and writes no terminal state when it reports stale", async () => {
  const { store, fence } = serviceFixture();
  const turn = makeSubmittedServiceTurn(store, fence, 301, "thr_stale_recon");
  const projector = makeProjector(async () => ({
    outcome: "stale" as const,
    reconciliationIncomplete: null,
    fromSeq: 4, throughSeq: 4, targetSeq: 4,
  }));
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter: adapterForSubmitted(), evidenceProjector: projector, clock: { now: () => 2_001 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(false);
  expect(projector.reconcile).toHaveBeenCalledTimes(1);
  expect(store.getControllerTurn(turn.id)?.state).toBe("submitted");
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "active", threadId: "thr_stale_recon" });
});

it("fails and retires atomically when reconciliation is limit-exceeded", async () => {
  const { store, fence } = serviceFixture();
  const turn = makeSubmittedServiceTurn(store, fence, 302, "thr_limit_recon");
  const projector = makeProjector(async () => ({
    outcome: "limit_exceeded" as const,
    reconciliationIncomplete: null,
    fromSeq: 4, throughSeq: 4, targetSeq: 4,
  }));
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter: adapterForSubmitted(), evidenceProjector: projector, clock: { now: () => 2_001 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  const t = store.getControllerTurn(turn.id);
  expect(t?.state).toBe("failed");
  expect(t?.lastError).toBe("Controller evidence limit exceeded during reconciliation");
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
  // The notice is the fixed safe message, never any raw or accepted text.
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text)
    .toBe("I couldn't complete that controller turn safely. Please resend your request.");
});

it.each([
  ["page cap", { outcome: "reconciled" as const, reconciliationIncomplete: "page_cap" as const, fromSeq: 4, throughSeq: 10, targetSeq: 40 }],
  ["source gap", { outcome: "reconciled" as const, reconciliationIncomplete: "source_gap" as const, fromSeq: 4, throughSeq: 10, targetSeq: 40 }],
])("fails and retires deterministically on an incomplete %s reconciliation", async (_label, result) => {
  const { store, fence } = serviceFixture();
  const turn = makeSubmittedServiceTurn(store, fence, 303 + Math.floor(Math.random() * 100), "thr_gap_recon");
  const projector = makeProjector(async () => result);
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter: adapterForSubmitted(), evidenceProjector: projector, clock: { now: () => 2_001 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed" });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
});

it("fails and retires on a deterministic projector error code", async () => {
  const { store, fence } = serviceFixture();
  const turn = makeSubmittedServiceTurn(store, fence, 304, "thr_det_recon");
  const projector = makeProjector(async () => {
    throw new ControllerEvidenceProjectorError("native_identity_conflict");
  });
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter: adapterForSubmitted(), evidenceProjector: projector, clock: { now: () => 2_001 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed" });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
});

it("propagates generation invariant corruption instead of reporting deterministic failure handled", async () => {
  const { store, fence, db } = serviceFixture();
  const turn = makeSubmittedServiceTurn(store, fence, 442, "thr_corrupt_failure_generation");
  db.prepare(
    "UPDATE controller_generations SET ended_at = 1, end_reason = 'corrupt' WHERE controller_key = ? AND thread_id = ?",
  ).run(turn.controllerKey, "thr_corrupt_failure_generation");
  const projector = makeProjector(async () => {
    throw new ControllerEvidenceProjectorError("native_identity_conflict");
  });
  const service = new LunaControllerService({
    interactionService: stubInteractionService(),
    store,
    adapter: adapterForSubmitted(),
    evidenceProjector: projector,
    clock: { now: () => 2_001 },
  });

  await expect(service.reconcile(fence, fence.signal)).rejects.toThrow(/generation/i);
  expect(store.getControllerTurn(turn.id)?.state).toBe("submitted");
  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    state: "active",
    threadId: "thr_corrupt_failure_generation",
  });
});

it("leaves a submitted turn durable on a transient projector read failure", async () => {
  const { store, fence } = serviceFixture();
  const turn = makeSubmittedServiceTurn(store, fence, 305, "thr_transient_recon");
  const projector = makeProjector(async () => { throw new Error("temporary boundary read failure"); });
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter: adapterForSubmitted(), evidenceProjector: projector, clock: { now: () => 2_001 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(false);
  expect(store.getControllerTurn(turn.id)?.state).toBe("submitted");
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "active", threadId: "thr_transient_recon" });
});

it("bounds a persistent untyped projector failure by the durable stall clock", async () => {
  const { store, fence } = serviceFixture();
  const turn = makeSubmittedServiceTurn(store, fence, 325, "thr_projector_stalled");
  const projector = makeProjector(async () => { throw new Error("persistent boundary defect"); });
  expect(store.renewExecutorLease(fence.ownerId, fence.generation, 2_100, CONTROLLER_STALL_MS * 2)).toBe(true);
  const service = new LunaControllerService({
    interactionService: stubInteractionService(),
    store,
    adapter: adapterForSubmitted(),
    evidenceProjector: projector,
    clock: { now: () => 2_000 + CONTROLLER_STALL_MS },
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed" });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
});

it.each(["status", "events"] as const)("bounds a persistent %s boundary failure by the durable stall clock", async (boundary) => {
  const { store, fence } = serviceFixture();
  const turn = makeSubmittedServiceTurn(store, fence, boundary === "status" ? 326 : 327, `thr_${boundary}_stalled`);
  const adapter = adapterForSubmitted();
  if (boundary === "status") vi.mocked(adapter.status).mockRejectedValue(new Error("persistent status defect"));
  else {
    vi.mocked(adapter.status).mockResolvedValue("idle");
    vi.mocked(adapter.events).mockRejectedValue(new Error("persistent event defect"));
  }
  expect(store.renewExecutorLease(fence.ownerId, fence.generation, 2_100, CONTROLLER_STALL_MS * 2)).toBe(true);
  const service = new LunaControllerService({
    interactionService: stubInteractionService(),
    store,
    adapter,
    evidenceProjector: makeProjector(),
    clock: { now: () => 2_000 + CONTROLLER_STALL_MS },
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed" });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
});

it("fails and retires when a cap marker is observed on the re-read turn", async () => {
  const { store, fence, db } = serviceFixture();
  const turn = makeSubmittedServiceTurn(store, fence, 306, "thr_cap_recon");
  db.prepare("UPDATE controller_turns SET evidence_limit_exceeded_at = ? WHERE id = ?").run(2_000, turn.id);
  const projector = makeProjector(); // reconciled; the re-read cap marker must still fail-and-retire
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter: adapterForSubmitted(), evidenceProjector: projector, clock: { now: () => 2_001 } });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed" });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
});

it.each(["active", "starting", "stopping"] as const)("does not consume a finalization while the controller is %s", async (status) => {
  const { store, fence } = serviceFixture();
  const turn = makeSubmittedServiceTurn(
    store,
    fence,
    status === "active" ? 307 : status === "starting" ? 308 : 309,
    `thr_${status}_finalize`,
  );
  expect(store.proposeControllerFinalization({
    ownerId: fence.ownerId,
    generation: fence.generation,
    now: 2_000,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text: "The job is queued." }],
      obligationRefs: [],
    },
  })).toMatchObject({ outcome: "accepted" });
  const adapter: ControllerAdapter = {
    ...adapterForSubmitted(),
    status: vi.fn(async () => status),
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector, clock: { now: () => 2_001 } });
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "submitted" });
  expect(store.getAcceptedControllerFinalization(turn.id)).toMatchObject({ consumedAt: null });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "active" });
});

// ===== B2b: terminal finalization + one durable continuation =====

const RECOVERY_PROMPT =
  "Your previous turn ended without an accepted telegram_agent_respond call. " +
  "Inspect telegram_agent_turn_evidence, correct any rejected finalization, and make telegram_agent_respond your final action now. " +
  "Do not repeat a side effect.";

type TerminalStatus = "idle" | "active" | "starting" | "stopping" | "error" | "missing" | "incompatible";

function terminalAdapter(options: {
  status?: TerminalStatus;
  latestSeq?: number;
  completed?: boolean;
  inputAccepted?: boolean;
  send?: () => Promise<void>;
} = {}): ControllerAdapter {
  const latestSeq = options.latestSeq ?? 0;
  return {
    spawn: vi.fn(async () => ({ threadId: "unused", projectId: "proj_personal", hostId: "host_personal" })),
    send: vi.fn(options.send ?? (async () => undefined)),
    status: vi.fn(async () => options.status ?? "idle"),
    latestSeq: vi.fn(async () => latestSeq),
    events: vi.fn(async () => ({
      latestSeq,
      inputAccepted: options.inputAccepted ?? true,
      assistantOutputObserved: false,
      toolActivityObserved: false,
      completed: options.completed ?? false,
      error: options.status === "error" ? "provider error" : null,
      interactions: [],
      toolCalls: 0,
      commandFailures: 0,
      totalTokens: 0,
    })),
    steer: vi.fn(async () => undefined),
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
}

function acceptAnswer(
  store: ReturnType<typeof openStore>,
  fence: { ownerId: string; generation: number },
  turn: ReturnType<typeof store.enqueueControllerTurn>,
  text = "The exact accepted answer.",
) {
  const result = store.proposeControllerFinalization({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    candidate: {
      disposition: "answered",
      segments: [{ type: "text", text }],
      obligationRefs: [],
    },
  });
  expect(result).toMatchObject({ outcome: "accepted" });
  return result;
}

function terminalServiceFixture(options: {
  updateId: number;
  threadId: string;
  status?: TerminalStatus;
  latestSeq?: number;
  completed?: boolean;
  inputAccepted?: boolean;
  send?: () => Promise<void>;
}) {
  const fixture = serviceFixture();
  const turn = makeSubmittedServiceTurn(fixture.store, fixture.fence, options.updateId, options.threadId);
  const adapter = terminalAdapter(options);
  const projector = makeProjector(async () => ({
    outcome: "reconciled" as const,
    reconciliationIncomplete: null,
    fromSeq: 0,
    throughSeq: options.latestSeq ?? 0,
    targetSeq: options.latestSeq ?? 0,
  }));
  const service = new LunaControllerService({
    interactionService: stubInteractionService(),
    store: fixture.store,
    adapter,
    evidenceProjector: projector,
    clock: { now: () => 2_001 },
  });
  return { ...fixture, turn, adapter, projector, service };
}

type TerminalReadFailure = "accepted_latest" | "continuation_latest" | "provider_error_baseline";

function terminalReadFailureFixture(boundary: TerminalReadFailure, updateId: number) {
  const status = boundary === "provider_error_baseline" ? "error" as const : "idle" as const;
  const fixture = terminalServiceFixture({
    updateId,
    threadId: `thr_${boundary}_${updateId}`,
    status,
    latestSeq: boundary === "provider_error_baseline" ? 5 : 0,
    inputAccepted: true,
  });
  fixture.db.prepare(
    "UPDATE controller_turns SET stream_phase = 'thinking', stream_text = ?, updated_at = 2000 WHERE id = ?",
  ).run(CONTROLLER_PHASE_TEXT.thinking, fixture.turn.id);
  if (boundary === "accepted_latest") {
    acceptAnswer(fixture.store, fixture.fence, fixture.turn, "Accepted before the latest-sequence read failed.");
    vi.mocked(fixture.adapter.latestSeq).mockRejectedValue(new Error("latest sequence unavailable"));
  } else if (boundary === "continuation_latest") {
    vi.mocked(fixture.adapter.latestSeq).mockRejectedValue(new Error("latest sequence unavailable"));
  } else {
    fixture.db.prepare("UPDATE controller_turns SET bb_event_seq = 5 WHERE id = ?").run(fixture.turn.id);
    vi.mocked(fixture.adapter.events)
      .mockResolvedValueOnce({
        latestSeq: 5,
        inputAccepted: true,
        assistantOutputObserved: false,
        toolActivityObserved: false,
        completed: false,
        error: "provider error",
        interactions: [],
        toolCalls: 0,
        commandFailures: 0,
        totalTokens: 0,
      })
      .mockRejectedValueOnce(new Error("provider error baseline unavailable"));
  }
  return fixture;
}

it.each([
  ["idle", false],
  ["idle", true],
] as const)("completes an accepted finalization exactly once at the %s terminal boundary (completed=%s)", async (status, completed) => {
  const { store, fence, turn, service } = terminalServiceFixture({
    updateId: completed ? 402 : 401,
    threadId: completed ? "thr_completed_final" : "thr_idle_final",
    status,
    completed,
  });
  acceptAnswer(store, fence, turn);

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(false);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "completed",
    responseText: "The exact accepted answer.",
    streamText: "",
  });
  expect(store.getAcceptedControllerFinalization(turn.id)).toMatchObject({ consumedAt: 2_001 });
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text).toBe("The exact accepted answer.");
});

it("completes an accepted finalization after provider error and retires only its generation", async () => {
  const { store, fence, turn, service } = terminalServiceFixture({
    updateId: 403,
    threadId: "thr_error_after_final",
    status: "error",
  });
  acceptAnswer(store, fence, turn, "Durably accepted before the provider failed.");

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "completed",
    responseText: "Durably accepted before the provider failed.",
    lastError: null,
  });
  expect(store.getAcceptedControllerFinalization(turn.id)?.consumedAt).toBe(2_001);
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
});

it("keeps accepted completion durable when error-generation retirement loses its lease and retries retirement later", async () => {
  const { store, fence, db, turn, adapter, projector, service } = terminalServiceFixture({
    updateId: 441,
    threadId: "thr_error_retirement_retry",
    status: "error",
  });
  acceptAnswer(store, fence, turn, "The accepted answer survives retirement arbitration.");
  db.exec(`
    CREATE TRIGGER expire_lease_after_final_completion
    AFTER UPDATE OF state ON controller_turns
    WHEN NEW.id = '${turn.id}' AND NEW.state = 'completed'
    BEGIN
      UPDATE executor_lease SET lease_expires_at = 0 WHERE singleton = 1;
    END
  `);

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(false);
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "completed",
    responseText: "The accepted answer survives retirement arbitration.",
  });
  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    state: "active",
    threadId: "thr_error_retirement_retry",
  });

  const nextLease = store.acquireExecutorLease("executor-next", 2_002, 30_000);
  if (!nextLease.acquired) throw new Error("successor lease was not acquired");
  const nextFence = {
    ownerId: "executor-next",
    generation: nextLease.generation,
    signal: AbortSignal.timeout(2_000),
  };
  const restarted = new LunaControllerService({
    interactionService: stubInteractionService(),
    store,
    adapter,
    evidenceProjector: projector,
    clock: { now: () => 2_003 },
  });
  await expect(restarted.reconcile(nextFence, nextFence.signal)).resolves.toBe(true);
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
});

it("defers accepted completion when the BB high-water advances past the projected target", async () => {
  const { store, fence, turn, adapter, service } = terminalServiceFixture({
    updateId: 404,
    threadId: "thr_target_race",
    status: "idle",
  });
  acceptAnswer(store, fence, turn);
  vi.mocked(adapter.latestSeq).mockResolvedValueOnce(1);

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(false);

  expect(store.getControllerTurn(turn.id)?.state).toBe("submitted");
  expect(store.getAcceptedControllerFinalization(turn.id)?.consumedAt).toBeNull();
});

it("leaves an accepted idle turn submitted when its terminal event boundary cannot be read", async () => {
  const { store, fence, turn, adapter, service } = terminalServiceFixture({
    updateId: 420,
    threadId: "thr_terminal_event_read_failure",
    status: "idle",
  });
  acceptAnswer(store, fence, turn);
  vi.mocked(adapter.events).mockRejectedValueOnce(new Error("temporary event boundary outage"));

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(false);

  expect(store.getControllerTurn(turn.id)?.state).toBe("submitted");
  expect(store.getAcceptedControllerFinalization(turn.id)?.consumedAt).toBeNull();
  expect(adapter.send).not.toHaveBeenCalled();
});

it.each([
  "accepted_latest",
  "continuation_latest",
  "provider_error_baseline",
] as const)("defers a transient %s read failure without a terminal write", async (boundary) => {
  const fixture = terminalReadFailureFixture(
    boundary,
    boundary === "accepted_latest" ? 432 : boundary === "continuation_latest" ? 433 : 434,
  );

  await expect(fixture.service.reconcile(fixture.fence, fixture.fence.signal)).resolves.toBe(false);

  expect(fixture.store.getControllerTurn(fixture.turn.id)?.state).toBe("submitted");
  expect(fixture.store.getControllerForOwner("7", "7")).toMatchObject({
    state: "active",
    threadId: `thr_${boundary}_${boundary === "accepted_latest" ? 432 : boundary === "continuation_latest" ? 433 : 434}`,
  });
});

it.each([
  "accepted_latest",
  "continuation_latest",
  "provider_error_baseline",
] as const)("fails and retires after a persistent %s read failure reaches the durable stall", async (boundary) => {
  const updateId = boundary === "accepted_latest" ? 435 : boundary === "continuation_latest" ? 436 : 437;
  const fixture = terminalReadFailureFixture(boundary, updateId);
  expect(fixture.store.renewExecutorLease(
    fixture.fence.ownerId,
    fixture.fence.generation,
    2_100,
    CONTROLLER_STALL_MS * 2,
  )).toBe(true);
  const service = new LunaControllerService({
    interactionService: stubInteractionService(),
    store: fixture.store,
    adapter: fixture.adapter,
    evidenceProjector: fixture.projector,
    clock: { now: () => 2_000 + CONTROLLER_STALL_MS },
  });

  await expect(service.reconcile(fixture.fence, fixture.fence.signal)).resolves.toBe(true);

  expect(fixture.store.getControllerTurn(fixture.turn.id)?.state).toBe("failed");
  expect(fixture.store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
  if (boundary === "accepted_latest") {
    expect(fixture.store.getAcceptedControllerFinalization(fixture.turn.id)?.consumedAt).toBeNull();
  }
});

it.each([
  "accepted_latest",
  "continuation_latest",
  "provider_error_baseline",
] as const)("does not write for an aborted %s read failure", async (boundary) => {
  const updateId = boundary === "accepted_latest" ? 438 : boundary === "continuation_latest" ? 439 : 440;
  const fixture = terminalReadFailureFixture(boundary, updateId);
  const abort = new AbortController();
  abort.abort();

  await expect(fixture.service.reconcile(fixture.fence, abort.signal)).resolves.toBe(false);

  expect(fixture.store.getControllerTurn(fixture.turn.id)?.state).toBe("submitted");
  expect(fixture.store.getControllerForOwner("7", "7")).toMatchObject({ state: "active" });
});

it("fails and retires without delivering accepted words when evidence advances past the seal", async () => {
  const { store, fence, turn, service } = terminalServiceFixture({
    updateId: 405,
    threadId: "thr_late_evidence",
    status: "idle",
    latestSeq: 1,
  });
  acceptAnswer(store, fence, turn, "Never deliver these accepted words.");
  expect(store.recordControllerNativeEvidence({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [{
      sourceName: "commandExecution",
      sourceItemId: "command-after-finalization",
      outcome: "failed",
      argsSha256: "a".repeat(64),
      resultSha256: "b".repeat(64),
      proofKinds: ["command_result"],
      subjectRefs: ["bb-item:command-after-finalization"],
    }],
  })).toBe("recorded");

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "failed", responseText: null });
  expect(store.getAcceptedControllerFinalization(turn.id)?.consumedAt).toBeNull();
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text)
    .toBe("I couldn't complete that controller turn safely. Please resend your request.");
  expect(store.getOutbox(`controller:${turn.id}:reply`)?.payload.text)
    .not.toContain("Never deliver these accepted words.");
});

it("fails closed through the atomic aggregate when accepted payload storage is corrupt", async () => {
  const { store, fence, db, turn, service } = terminalServiceFixture({
    updateId: 406,
    threadId: "thr_corrupt_final",
    status: "idle",
  });
  const accepted = acceptAnswer(store, fence, turn);
  if (accepted.outcome !== "accepted") throw new Error("missing accepted finalization");
  db.prepare("UPDATE controller_finalizations SET payload_json = ? WHERE id = ?")
    .run("{}", accepted.finalization.id);

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)?.state).toBe("failed");
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
});

function ownerQuestionInteraction(interactionId: string) {
  return {
    kind: "user_question" as const,
    interactionId,
    questions: [{
      id: "choice",
      prompt: "What should I use?",
      shortLabel: null,
      multiSelect: false,
      allowFreeText: true,
      options: [],
    }],
  };
}

function parkOwnerInteraction(
  fixture: ReturnType<typeof terminalServiceFixture>,
  threadId: string,
  interactionId: string,
): void {
  const generation = fixture.store.getOpenControllerGeneration(fixture.turn.controllerKey, threadId);
  if (!generation) throw new Error("missing open controller generation");
  expect(fixture.store.recordControllerInteraction({
    ...fixture.fence,
    now: 2_000,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    bbThreadId: threadId,
    controllerGenerationId: generation.id,
    interaction: ownerQuestionInteraction(interactionId),
  })).toBe(true);
  expect(fixture.store.proposeControllerFinalization({
    ...fixture.fence,
    now: 2_000,
    turnId: fixture.turn.id,
    controllerKey: fixture.turn.controllerKey,
    candidate: {
      disposition: "needs_owner",
      segments: [{ type: "text", text: "I need your answer." }],
      obligationRefs: [],
    },
  })).toMatchObject({ outcome: "accepted" });
}

function deliveringInteractionService(
  fixture: ReturnType<typeof terminalServiceFixture>,
  threadId: string,
  interactionId: string,
) {
  const resolve = vi.fn(async () => ({ id: interactionId, threadId, status: "resolved" }));
  const get = vi.fn(async () => ({ id: interactionId, threadId, status: "pending", payload: null }));
  const service = new ControllerInteractionService({
    store: new ControllerInteractionRepository(fixture.db),
    interactions: { get, resolve } as never,
    clock: () => 2_001,
  });
  return { interactionService: service, resolve };
}

it("parks an accepted needs_owner finalization on its exact pending interaction across restart", async () => {
  const fixture = terminalServiceFixture({
    updateId: 407,
    threadId: "thr_pending_owner",
    status: "idle",
  });
  const { store, fence, turn, adapter, projector } = fixture;
  parkOwnerInteraction(fixture, "thr_pending_owner", "interaction-pending-owner");

  const first = new LunaControllerService({
    interactionService: stubInteractionService(),
    store, adapter, evidenceProjector: projector, clock: { now: () => 2_001 },
  });
  await expect(first.reconcile(fence, fence.signal)).resolves.toBe(true);
  const restarted = new LunaControllerService({
    interactionService: stubInteractionService(),
    store, adapter, evidenceProjector: projector, clock: { now: () => 2_002 },
  });
  await expect(restarted.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)?.state).toBe("submitted");
  expect(store.getAcceptedControllerFinalization(turn.id)?.consumedAt).toBeNull();
  expect(adapter.send).not.toHaveBeenCalled();
});

it("delivers an answered interaction only for the exact adopted turn before terminal work", async () => {
  const fixture = terminalServiceFixture({
    updateId: 408,
    threadId: "thr_answered_owner",
    status: "idle",
  });
  const { store, fence, turn, adapter, projector } = fixture;
  parkOwnerInteraction(fixture, "thr_answered_owner", "interaction-answered-owner");
  expect(store.answerControllerInteractionWithText({
    controllerKey: turn.controllerKey,
    userId: "7",
    chatId: "7",
    text: "Use the safer option",
    now: 2_000,
  })).toMatchObject({ ok: true, turnId: turn.id });
  const { interactionService, resolve } = deliveringInteractionService(
    fixture, "thr_answered_owner", "interaction-answered-owner",
  );
  const service = new LunaControllerService({
    interactionService, store, adapter, evidenceProjector: projector, clock: { now: () => 2_001 },
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(resolve).toHaveBeenCalledWith({
    threadId: "thr_answered_owner",
    interactionId: "interaction-answered-owner",
    resolution: { kind: "user_answer", answers: { choice: { selected: [], freeText: "Use the safer option" } } },
  });
  expect(store.getControllerTurn(turn.id)?.state).toBe("submitted");
  expect(store.getAcceptedControllerFinalization(turn.id)?.consumedAt).toBeNull();
  expect(adapter.send).not.toHaveBeenCalled();
});

it("consumes an accepted needs_owner finalization only on the pass after its answer is delivered", async () => {
  const fixture = terminalServiceFixture({
    updateId: 443,
    threadId: "thr_delivered_owner",
    status: "idle",
  });
  const { store, fence, turn, adapter, projector } = fixture;
  parkOwnerInteraction(fixture, "thr_delivered_owner", "interaction-delivered-owner");
  expect(store.answerControllerInteractionWithText({
    controllerKey: turn.controllerKey,
    userId: "7",
    chatId: "7",
    text: "Use the safer option",
    now: 2_000,
  })).toMatchObject({ ok: true, turnId: turn.id });
  const { interactionService, resolve } = deliveringInteractionService(
    fixture, "thr_delivered_owner", "interaction-delivered-owner",
  );
  const service = new LunaControllerService({
    interactionService, store, adapter, evidenceProjector: projector, clock: { now: () => 2_001 },
  });

  // Pass 1 delivers the owner's exact answer and transitions answered ->
  // delivered; it consumes nothing. Only pass 2 may complete the turn.
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(store.getControllerTurn(turn.id)).toMatchObject({ state: "submitted", responseText: null });
  expect(store.getAcceptedControllerFinalization(turn.id)?.consumedAt).toBeNull();

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(resolve).toHaveBeenCalledOnce();
  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "completed",
    responseText: "I need your answer.",
  });
  expect(store.getAcceptedControllerFinalization(turn.id)?.consumedAt).toBe(2_001);
});

it("claims and sends the fixed completion recovery prompt exactly once", async () => {
  const { store, fence, turn, adapter, service } = terminalServiceFixture({
    updateId: 409,
    threadId: "thr_one_continuation",
    status: "idle",
    completed: true,
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)).toMatchObject({
    state: "submitted",
    completionContinuations: 1,
  });
  expect(adapter.send).toHaveBeenCalledOnce();
  expect(adapter.send).toHaveBeenCalledWith("thr_one_continuation", RECOVERY_PROMPT, fence.signal);
});

it("retires after a claimed continuation ends without a finalization and never resends", async () => {
  const { store, fence, turn, adapter, service } = terminalServiceFixture({
    updateId: 410,
    threadId: "thr_continuation_omission",
    status: "idle",
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(adapter.send).toHaveBeenCalledTimes(1);
  expect(store.getControllerTurn(turn.id)?.state).toBe("failed");
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
});

it("does not resend after a crash between durable continuation claim and send", async () => {
  const { store, fence, turn, adapter, service } = terminalServiceFixture({
    updateId: 411,
    threadId: "thr_claim_crash",
    status: "idle",
  });
  expect(store.claimControllerCompletionContinuation({
    ...fence,
    now: 2_000,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    bbHighWaterSeq: 0,
  })).toBe("claimed");

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(adapter.send).not.toHaveBeenCalled();
  expect(store.getControllerTurn(turn.id)?.state).toBe("failed");
});

it("fails and retires after an ambiguous continuation send without retrying it", async () => {
  const { store, fence, turn, adapter, service } = terminalServiceFixture({
    updateId: 412,
    threadId: "thr_ambiguous_continuation",
    status: "idle",
    send: async () => { throw new Error("send outcome ambiguous"); },
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(false);

  expect(adapter.send).toHaveBeenCalledTimes(1);
  expect(store.getControllerTurn(turn.id)?.state).toBe("failed");
});

it("sends no continuation on a cursor race and succeeds after evidence reconciliation", async () => {
  const fixture = terminalServiceFixture({
    updateId: 413,
    threadId: "thr_cursor_stale",
    status: "idle",
  });
  const { store, fence, turn, adapter, projector, service } = fixture;
  vi.mocked(adapter.latestSeq).mockResolvedValueOnce(1);

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(false);
  expect(adapter.send).not.toHaveBeenCalled();
  expect(store.getControllerTurn(turn.id)?.completionContinuations).toBe(0);

  expect(store.recordControllerNativeEvidence({
    ...fence,
    now: 2_002,
    turnId: turn.id,
    controllerKey: turn.controllerKey,
    fromSeq: 0,
    throughSeq: 1,
    items: [],
  })).toBe("recorded");
  vi.mocked(adapter.latestSeq).mockResolvedValue(1);
  vi.mocked(adapter.events).mockResolvedValue({
    latestSeq: 1,
    inputAccepted: true,
    assistantOutputObserved: false,
    toolActivityObserved: false,
    completed: false,
    error: null,
    interactions: [],
    toolCalls: 0,
    commandFailures: 0,
    totalTokens: 0,
  });
  vi.mocked(projector.reconcile).mockResolvedValue({
    outcome: "reconciled",
    reconciliationIncomplete: null,
    fromSeq: 1,
    throughSeq: 1,
    targetSeq: 1,
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);
  expect(adapter.send).toHaveBeenCalledOnce();
  expect(store.getControllerTurn(turn.id)?.completionContinuations).toBe(1);
});

it("returns stale without consuming when the adopted fence changes at final completion", async () => {
  const { store, fence, db, turn, adapter, service } = terminalServiceFixture({
    updateId: 417,
    threadId: "thr_stale_completion",
    status: "idle",
  });
  acceptAnswer(store, fence, turn);
  vi.mocked(adapter.latestSeq).mockImplementationOnce(async () => {
    db.prepare("UPDATE controller_turns SET lease_generation = ? WHERE id = ?")
      .run(fence.generation + 1, turn.id);
    return 0;
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(false);

  expect(store.getControllerTurn(turn.id)?.state).toBe("submitted");
  expect(store.getAcceptedControllerFinalization(turn.id)?.consumedAt).toBeNull();
});

it.each(["stall", "supervisor"] as const)("uses one rollback boundary for the %s fail-and-retire path", async (mode) => {
  const { store, fence, db } = serviceFixture();
  const turn = makeSubmittedServiceTurn(
    store,
    fence,
    mode === "stall" ? 418 : 419,
    `thr_${mode}_aggregate`,
  );
  if (mode === "supervisor") {
    db.prepare("UPDATE controller_turns SET tool_calls = 120 WHERE id = ?").run(turn.id);
    expect(store.getControllerTurn(turn.id)?.toolCalls).toBe(120);
  }
  db.exec(`CREATE TRIGGER reject_${mode}_failure_outbox
    BEFORE UPDATE ON outbox
    WHEN OLD.logical_key = 'controller:${turn.id}:reply'
    BEGIN SELECT RAISE(ABORT, 'injected aggregate rollback'); END`);
  const adapter = terminalAdapter({ status: "active", latestSeq: 4, inputAccepted: false });
  const projector = makeProjector(async () => ({
    outcome: "reconciled" as const,
    reconciliationIncomplete: null,
    fromSeq: 0,
    throughSeq: 0,
    targetSeq: 0,
  }));
  const now = mode === "stall" ? 2_001 + CONTROLLER_STALL_MS : 2_001;
  if (mode === "stall") {
    expect(store.renewExecutorLease(fence.ownerId, fence.generation, 2_100, CONTROLLER_STALL_MS * 2)).toBe(true);
  }
  const service = new LunaControllerService({
    interactionService: stubInteractionService(), store, adapter, evidenceProjector: projector, clock: { now: () => now } });

  await expect(service.reconcile(fence, fence.signal)).rejects.toThrow("injected aggregate rollback");

  expect(store.getControllerTurn(turn.id)?.state).toBe("submitted");
  expect(store.getControllerForOwner("7", "7")).toMatchObject({
    state: "active",
    threadId: `thr_${mode}_aggregate`,
  });
});

it.each(["missing", "incompatible"] as const)("fails and retires a submitted turn atomically when its provider is %s", async (status) => {
  const { store, fence, turn, service } = terminalServiceFixture({
    updateId: status === "missing" ? 415 : 416,
    threadId: `thr_${status}_terminal`,
    status,
  });

  await expect(service.reconcile(fence, fence.signal)).resolves.toBe(true);

  expect(store.getControllerTurn(turn.id)?.state).toBe("failed");
  expect(store.getControllerForOwner("7", "7")).toMatchObject({ state: "pending_spawn", threadId: null });
});

it("sends the owner's first message byte-for-byte, with no standing instruction block", async () => {
  const { adapter, spawn } = sdkFixture();
  const inputText = "What projects can you work on?";

  await adapter.spawn(turnRecord({ inputText }), controllerRecord(), AbortSignal.timeout(1_000));

  const sent = spawn.mock.calls.at(0)?.at(0) as unknown as { input: { type: string; text?: string }[] };
  expect(sent.input).toEqual([{ type: "text", text: inputText, mentions: [] }]);
  // `bb.agents.configure` is the only standing-instruction source now, so the
  // spawn payload must carry none of it.
  expect(JSON.stringify(sent.input)).not.toContain(CONTROLLER_INSTRUCTION_SENTINEL);
  expect(JSON.stringify(sent.input)).not.toContain("You are the owner's teammate");
});

it("composes the replacement digest once and never as a standing block", async () => {
  const { store, fence } = serviceFixture();
  const earlier = store.enqueueControllerTurn({
    ...turnRecord({ updateId: 71, inputText: "what changed in cyndra?" }),
    telegramUserId: "7", telegramChatId: "7", now: 1_900,
  });
  store.claimNextControllerTurn({ ...fence, now: 1_900 });
  store.markControllerSpawned({
    ...fence, now: 1_901, turnId: earlier.id, projectId: "proj_personal", hostId: "host_personal", threadId: "thr_gone",
  });
  store.markControllerTurnSubmitted({ ...fence, now: 1_902, turnId: earlier.id });
  store.failControllerTurn({ ...fence, now: 1_903, turnId: earlier.id, error: "Provider turn failed" });
  expect(store.resetControllerThread({
    ...fence, now: 1_904, controllerKey: earlier.controllerKey,
    expectedThreadId: "thr_gone", reason: "Provider session ended in error",
  })).toBe(true);
  store.enqueueControllerTurn({
    ...turnRecord({ updateId: 72, inputText: "and now?" }),
    telegramUserId: "7", telegramChatId: "7", now: 2_000,
  });
  const spawn = vi.fn(async () => ({ threadId: "thr_replacement", projectId: "proj_personal", hostId: "host_personal" }));
  const adapter: ControllerAdapter = {
    ...adapterForSubmitted(),
    spawn: spawn as unknown as ControllerAdapter["spawn"],
    findSpawnCandidate: vi.fn(async () => null),
    hasExecutionProfile: () => false,
  };
  const service = new LunaControllerService({
    interactionService: stubInteractionService(),
    store, adapter, evidenceProjector, clock: { now: () => 2_001 },
  });

  await expect(service.processOne(fence, fence.signal)).resolves.toBe(true);

  const seeded = spawn.mock.calls.at(0)?.at(0) as unknown as { inputText: string };
  // The digest is composed exactly once, by the service, and carries no
  // standing-instruction block of its own.
  expect(seeded.inputText).toContain("and now?");
  expect(seeded.inputText).not.toContain(CONTROLLER_INSTRUCTION_SENTINEL);
  expect(seeded.inputText).not.toContain("You are the owner's teammate");
});
