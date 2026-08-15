import type { BbPluginApi } from "@bb/plugin-sdk";
import { createHash } from "node:crypto";
import { createSecret } from "./crypto";
import { recordImplementationCapabilityOutcomes } from "./capabilities/outcomes";
import { CAPABILITY_BY_ID } from "./capabilities/catalog";
import {
  guardRequirementBindings,
  persistBlockedGuardSettlement,
  persistGuardEnvelopeSettlement,
  requiredGuardsForChangeSurface,
  type GuardAssessmentPolicy,
} from "./capabilities/guards";
import {
  backgroundCapabilityModelRoute,
  capabilityMinimumModelPool,
  capabilityRoutingSettings,
  controllerCapabilityModelRoute,
  controllerExecutionProfile,
  controllerExecutionProfiles,
  credentialBrokerConfigFingerprint,
  parseGlobalConfig,
  systemUpkeepEnabled,
} from "./config";
import { parseCredentialBrokerConfig, type CredentialBrokerConfigResult } from "./credentials/config";
import { CredentialBrokerClient } from "./credentials/broker-client";
import { CredentialAccessService } from "./credentials/service";
import {
  RecipePromotionService,
} from "./capabilities/promotion";
import { DurableRecipePromotionEvidenceReader } from "./capabilities/promotion-evidence";
import { DEFAULT_CONTROLLER_CAPABILITY_MODEL } from "./capabilities/controller-bundles";
import { BbRunner, environmentDiffText } from "./bb/runner";
import {
  environmentChangeShouldWake,
  threadChangeShouldWake,
  threadInteractionsChanged,
} from "./bb/realtime-events";
import { environmentWorktreeIsClean, resolvePrHead, runValidation } from "./bb/validation";
import { TerminalCommandRunner } from "./bb/terminal-command";
import { TelegramClient, TelegramFileTooLargeError } from "./telegram/client";
import { TelegramIngress } from "./telegram/ingress";
import { openStore, type TelegramAgentStore } from "./storage/store";
import { AutonomyRepository } from "./storage/autonomy-repository";
import { DEFAULT_MAX_CONCURRENT_JOBS } from "./autonomy/models";
import { AutonomyScheduler } from "./autonomy/scheduler";
import { EffectRunner } from "./services/effect-runner";
import type { EffectFence } from "./services/effect-runner";
import { runJobExecutorService } from "./services/job-executor-service";
import { createFreshGateCollector, MergeHandler } from "./services/merge-handler";
import type { GateInput } from "./domain/gates";
import type { ReviewFinding } from "./domain/models";
import { documentationRequirement } from "./domain/pipeline-graph";
import { assessReviewGroup } from "./domain/review-lenses";
import {
  ReviewHandler,
  ReviewInvocationStaleError,
  type ReviewAttemptLookup,
  type ReviewAttemptUpdate,
  type ReviewFormatCorrectionClaim,
  type ReviewEnvironmentStatusInput,
  type ReviewInvocation,
  type ReviewHandlerCompletion,
} from "./services/review-handler";
import { runTelegramService } from "./services/telegram-service";
import {
  classifyThreadRecovery,
  projectUnknownWorker,
  projectTerminalLiveness,
  projectWorkerLiveness,
  workerRegistrationGeneration,
} from "./services/worker-liveness";
import { runTelegramAgentCli } from "./cli";
import { ExecutorNudge } from "./services/executor-nudge";
import { CONTROLLER_TOOL_NAMES, registerControllerTools } from "./controller/tools";
import { retireLiveWorkPollingSchedules } from "./controller/monitor-policy";
import {
  BbControllerAdapter,
  ControllerImagePreparationError,
  parseControllerInteractionResolution,
} from "./controller/bb-controller";
import { ControllerEvidenceProjector } from "./controller/evidence-projector";
import {
  CONTROLLER_FALLBACK_MODELS,
  CONTROLLER_MODELS,
  CONTROLLER_PERMISSION_MODES,
  CONTROLLER_REASONING_LEVELS,
  CONTROLLER_SERVICE_TIERS,
  DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  EXTRACTION_MODELS,
  controllerProviderFor,
} from "./controller/execution-profile";
import { LunaControllerService } from "./controller/service";
import { ControllerInteractionService } from "./controller/interaction-service";
import { TelegramPresenceCoordinator } from "./services/telegram-presence";
import { JobLaneSnapshotProvider } from "./services/job-lane-runner";
import { MonitorService } from "./services/monitor-service";
import { ThreadNoticeService } from "./services/thread-notice-service";
import { JobMemoryService } from "./services/job-memory-service";
import { MemoryCurationService } from "./services/memory-curation-service";
import { installSystemMonitors } from "./services/system-monitors";
import { ProductionHealthService } from "./services/production-health-service";
import { RegressionWatchService } from "./services/regression-watch-service";
import { FailureLoopService } from "./services/failure-loop-service";
import { buildHealthReport } from "./services/health-report";
import { ThreadOperationService } from "./controller/operations";
import { settlePipelineStageOutput } from "./services/pipeline-stage-runner";
import { runProductionStage } from "./services/production-runner";
import { CapabilityInventoryService } from "./services/capability-inventory-service";
import {
  captureRuntimeIdentity,
  inspectRuntimeIdentity,
  type ActivationHealth,
} from "./services/runtime-identity";

function clock(): number {
  return Date.now();
}

function reviewLineageScopeId(jobId: string, reviewStage: string): string {
  const digest = createHash("sha256").update(`${jobId}\0${reviewStage}`, "utf8").digest("hex");
  return `review-lineage:${digest}`;
}

export async function createPlugin(bb: BbPluginApi, pluginRoot: string): Promise<void> {
  const runtimeIdentity = captureRuntimeIdentity(pluginRoot, clock());
  const settings = bb.settings.define({
    botToken: { type: "string", label: "Telegram bot token", secret: true },
    bbAppBaseUrl: { type: "string", label: "BB app base URL", default: "" },
    maxConcurrentJobs: {
      type: "select",
      label: "Maximum concurrent jobs",
      description: "Independent projects may run together; each project remains serialized.",
      options: ["1", "2", "3", "4", "5", "6", "7", "8"],
      default: String(DEFAULT_MAX_CONCURRENT_JOBS),
    },
    controllerModel: {
      type: "select",
      label: "Controller model",
      description: "Model for Telegram conversation turns. Claude models run on Claude Code, gpt models on Codex. Job workers remain project-controlled.",
      options: [...CONTROLLER_MODELS],
      default: DEFAULT_CONTROLLER_EXECUTION_PROFILE.model,
    },
    controllerFallbackModel1: {
      type: "select",
      label: "Fallback model 1",
      description: "Tried only when the primary model fails before accepting the Telegram message.",
      options: [...CONTROLLER_FALLBACK_MODELS],
      default: "gpt-5.6-sol",
    },
    controllerFallbackModel2: {
      type: "select",
      label: "Fallback model 2",
      description: "Tried after fallback 1 only when the message was still not accepted. Disabled by default.",
      options: [...CONTROLLER_FALLBACK_MODELS],
      default: "disabled",
    },
    controllerReasoningLevel: {
      type: "select",
      label: "Controller reasoning level",
      description: "Reasoning effort for subsequent Telegram conversation turns.",
      options: [...CONTROLLER_REASONING_LEVELS],
      default: DEFAULT_CONTROLLER_EXECUTION_PROFILE.reasoningLevel,
    },
    controllerServiceTier: {
      type: "select",
      label: "Controller service tier",
      description: "Codex only. Fast prioritizes latency; default uses the provider's standard tier. Ignored by Claude models.",
      options: [...CONTROLLER_SERVICE_TIERS],
      default: DEFAULT_CONTROLLER_EXECUTION_PROFILE.serviceTier,
    },
    controllerPermissionMode: {
      type: "select",
      label: "Controller permission mode",
      description: "BB and the execution machine still enforce their permission limits.",
      options: [...CONTROLLER_PERMISSION_MODES],
      default: DEFAULT_CONTROLLER_EXECUTION_PROFILE.permissionMode,
    },
    extractionModel: {
      type: "select",
      label: "Background learning model",
      description: "Model for learning lessons from finished jobs. Inherit uses the project default; a cheaper model keeps background work off your conversational tier.",
      options: [...EXTRACTION_MODELS],
      default: "inherit",
    },
    systemUpkeep: {
      type: "select",
      label: "Self-maintenance",
      description: "Lets the agent run its own daily stale-work sweep, weekly memory audit, and weekly scorecard, and message you when something needs a decision. Turning this off does not touch monitors you set yourself.",
      options: ["enabled", "disabled"],
      default: "enabled",
    },
    capabilityJobGraph: {
      type: "select",
      label: "Capability job graph",
      description: "Adaptive keeps unpromoted recipes in shadow. Legacy is an independent new-job kill switch.",
      options: ["adaptive", "legacy"],
      default: "adaptive",
    },
    controllerCapabilityMode: {
      type: "select",
      label: "Controller capabilities",
      description: "Bundled is least-capability. All-tools is an independent new-turn kill switch.",
      options: ["bundled", "all-tools"],
      default: "bundled",
    },
    capabilityModelRouting: {
      type: "select",
      label: "Capability model routing",
      description: "Adaptive uses the selected pool. Strong-only is an independent new-attempt kill switch.",
      options: ["adaptive", "strong-only"],
      default: "adaptive",
    },
    credentialBrokerMode: {
      type: "select",
      label: "Credential broker mode",
      description: "Isolated enables read-only access to a protected credential broker. Disabled (default) keeps every access command and doctor check failing closed.",
      options: ["disabled", "isolated"],
      default: "disabled",
    },
    credentialBrokerEndpoint: {
      type: "string",
      label: "Credential broker endpoint",
      description: "Fixed HTTPS origin of the protected broker, e.g. https://broker.internal. Ignored while the mode is disabled.",
      default: "",
    },
    credentialBrokerInstallationId: {
      type: "string",
      label: "Credential broker installation id",
      description: "Opaque installation id issued by the broker's protected enrollment CLI.",
      default: "",
    },
    credentialBrokerTopologyReceiptDigest: {
      type: "string",
      label: "Credential broker topology receipt digest",
      description: "SHA-256 of the current reviewed topology acceptance report, installed after the protected negative probes pass.",
      default: "",
    },
    credentialBrokerTopologyReceiptExpiresAt: {
      type: "string",
      label: "Credential broker topology receipt expiry",
      description: "Epoch-millisecond expiry from the same reviewed report, as a base-10 integer string.",
      default: "",
    },
    credentialBrokerClientCertificate: {
      type: "string",
      label: "Credential broker client certificate",
      description: "This installation's public mTLS client certificate (PEM).",
      default: "",
    },
    credentialBrokerClientKey: {
      type: "string",
      label: "Credential broker client private key",
      description: "This installation's mTLS client private key (PEM). Never logged, stored in plugin SQLite, or shown in CLI/doctor output.",
      secret: true,
    },
    credentialBrokerCaCertificate: {
      type: "string",
      label: "Credential broker CA certificate",
      description: "Public CA certificate (PEM) that issued the broker's server certificate.",
      default: "",
    },
  });
  let config = parseGlobalConfig(await settings.get());
  const store = openStore(
    bb.storage,
    bb.storage.kv,
    clock,
    () => config.ok ? controllerCapabilityModelRoute(config.value) : DEFAULT_CONTROLLER_CAPABILITY_MODEL,
    () => config.ok ? capabilityRoutingSettings(config.value) : {
      jobGraph: "adaptive",
      controllerTools: "bundled",
    },
  );
  const retiredLivePollers = retireLiveWorkPollingSchedules(store, clock());
  if (retiredLivePollers > 0) {
    bb.log.warn(`Retired ${retiredLivePollers} controller schedule(s) that polled live work`);
  }
  const promotionEvidence = new DurableRecipePromotionEvidenceReader(store);
  const recipePromotions = new RecipePromotionService({
    store,
    readEvidence: (recipe) => promotionEvidence.read(recipe),
    now: clock,
  });
  const scheduler = new AutonomyScheduler(new AutonomyRepository(bb.storage.database()), store);
  const executorNudge = new ExecutorNudge();
  const laneSnapshots = new JobLaneSnapshotProvider();

  const reportActivationProblem = (activation: ActivationHealth | null): void => {
    if (activation && !activation.ok) {
      bb.status.needsConfiguration(
        `Plugin activation mismatch: ${activation.problems.join("; ")} (source ${activation.sourceRoot})`,
      );
    }
  };
  const runtimeHealth = (): ActivationHealth => {
    const activation = inspectRuntimeIdentity(bb.storage.database(), runtimeIdentity);
    reportActivationProblem(activation);
    return activation;
  };
  const pluginHealth = (now: number) => {
    const report = buildHealthReport(
      bb.storage.database(),
      now,
      config.ok ? config.value.maxConcurrentJobs : null,
      laneSnapshots.snapshot(),
      runtimeIdentity,
    );
    reportActivationProblem(report.activation);
    return report;
  };
  if (!config.ok) bb.status.needsConfiguration(config.message);
  else reportActivationProblem(runtimeHealth());

  let credentialConfig: CredentialBrokerConfigResult = parseCredentialBrokerConfig(await settings.get());
  let credentialFingerprint = credentialBrokerConfigFingerprint(credentialConfig);
  let credentialClient: CredentialBrokerClient | null = credentialConfig.state === "isolated"
    ? new CredentialBrokerClient(credentialConfig.value)
    : null;
  const buildCredentialAccessService = (): CredentialAccessService => new CredentialAccessService({
    store,
    client: credentialClient,
    config: () => credentialConfig,
    // The trust-kernel manifest is validated once at module load
    // (capability-policy.ts's validateManifest) and throws before this
    // factory could ever run, so by the time the plugin is live that
    // structural invariant already holds — there is no separate runtime
    // signal to poll for here.
    trustKernelReady: () => true,
    controllerPermissionMode: () => config.ok
      ? config.value.controllerPermissionMode
      : DEFAULT_CONTROLLER_EXECUTION_PROFILE.permissionMode,
    now: clock,
  });
  let credentialAccessService = buildCredentialAccessService();
  bb.onDispose(() => {
    // CredentialBrokerClient exposes rotate(config) but no bare close, so
    // this can only drop the reference rather than force-close its
    // keep-alive TLS agent.
    credentialClient = null;
  });

  const capabilityInventory = new CapabilityInventoryService({
    store,
    client: {
      providers: {
        list: (args) => bb.sdk.providers.list(args),
        models: (args) => bb.sdk.providers.models(args),
      },
      plugins: { list: (args) => bb.sdk.plugins.list(args) },
      skills: { list: (workspace) => bb.sdk.skills.list(workspace) },
    },
    clock: { now: clock },
    warn: (message) => bb.log.warn(message),
  });
  await capabilityInventory.refresh();

  const telegramForToken = (token: string): TelegramClient => new TelegramClient(token);
  let verifiedBotToken: string | null = null;
  const verifiedTelegramClient = (): TelegramClient => {
    if (verifiedBotToken === null) throw new Error("Telegram bot token is not verified.");
    return telegramForToken(verifiedBotToken);
  };
  const telegramTransport = {
    sendMessage: (chatId: string, payload: Parameters<TelegramClient["sendMessage"]>[1]) => {
      if (!config.ok) throw new Error(config.message);
      return telegramForToken(config.value.botToken).sendMessage(chatId, payload);
    },
    editMessage: (chatId: string, messageId: number, payload: Parameters<TelegramClient["editMessage"]>[2]) => {
      if (!config.ok) throw new Error(config.message);
      return telegramForToken(config.value.botToken).editMessage(chatId, messageId, payload);
    },
    answerCallback: (callbackQueryId: string, text: string) => {
      if (!config.ok) throw new Error(config.message);
      return telegramForToken(config.value.botToken).answerCallback(callbackQueryId, text);
    },
  };
  const threadOperations = new ThreadOperationService({
    store,
    sdk: bb.sdk,
    telegram: telegramTransport,
    pluginId: bb.pluginId,
    clock: { now: clock },
  });
  const evidenceProjector = new ControllerEvidenceProjector({
    sdk: bb.sdk,
    store,
    clock: { now: clock },
    hanoonToolNames: [...CONTROLLER_TOOL_NAMES, "telegram_agent_respond"],
  });
  const toolDependencies: Parameters<typeof registerControllerTools>[1] = {
    store,
    sdk: bb.sdk,
    evidenceProjector,
    threadOperations,
    downloadImage: async (fileId, maxBytes, signal) => {
      if (!config.ok) throw new Error(config.message);
      return telegramForToken(config.value.botToken).downloadFile(
        fileId,
        maxBytes,
        signal ?? new AbortController().signal,
      );
    },
    health: pluginHealth,
    notify: () => executorNudge.notify(),
    now: clock,
    credentialAccess: credentialAccessService,
    controllerProviderId: () => config.ok
      ? controllerProviderFor(controllerExecutionProfile(config.value).model)
      : undefined,
  };
  registerControllerTools(bb, toolDependencies);

  settings.onChange((next) => {
    const parsed = parseGlobalConfig(next);
    config = parsed;
    if (!parsed.ok || parsed.value.botToken !== verifiedBotToken) {
      verifiedBotToken = null;
    }
    if (!parsed.ok) bb.status.needsConfiguration(parsed.message);
    executorNudge.notify();

    const nextCredentialConfig = parseCredentialBrokerConfig(next);
    const nextFingerprint = credentialBrokerConfigFingerprint(nextCredentialConfig);
    if (nextFingerprint === credentialFingerprint) return;
    credentialFingerprint = nextFingerprint;
    credentialConfig = nextCredentialConfig;

    if (credentialConfig.state === "isolated" && credentialClient) {
      // Same broker relationship, rotated material: client identity is
      // preserved in place (rotate() destroys and rebuilds its own agent),
      // so the already-registered service — which reads credentialConfig
      // live through its config() closure — keeps working unrebuilt.
      credentialClient.rotate(credentialConfig.value);
      return;
    }

    // Every other transition changes whether a live client exists at all:
    // newly isolated stays pending until an explicit plugin reload rebuilds
    // the capability manifest from scratch (design: "enabling isolated mode
    // requires a plugin reload"), and leaving isolated drops the client.
    // Either way `client` — captured by value, not by closure — is now
    // stale, so the service must be rebuilt and re-published.
    credentialClient = null;
    credentialAccessService = buildCredentialAccessService();
    toolDependencies.credentialAccess = credentialAccessService;
  });

  const terminal = new TerminalCommandRunner(bb.sdk);
  const unpairNonceKey = createSecret(32);
  bb.cli.register({
    name: "telegram-agent",
    summary: "Pair Telegram and manage reviewed BB implementation jobs",
    commands: [
      { name: "pair", summary: "Create a one-use Telegram pairing link", usage: "bb telegram-agent pair [--json]" },
      { name: "unpair", summary: "Revoke the Telegram owner and approvals", usage: "bb telegram-agent unpair [--confirm <nonce>] [--json]" },
      { name: "project", summary: "Manage enabled BB project policies", usage: "bb telegram-agent project <list|enable|disable> ... [--production-target-key <key>]" },
      { name: "job", summary: "Inspect, retry, or cancel jobs", usage: "bb telegram-agent job <list|show|retry|cancel> ..." },
      { name: "capability", summary: "Inspect capability evidence and control recipe rollout", usage: "bb telegram-agent capability <status|inventory|receipts|promote|rollback> ..." },
      { name: "access", summary: "Inspect read-only credential broker bindings and status", usage: "bb telegram-agent access <list|status> [binding-id] [--json]" },
      { name: "doctor", summary: "Check Telegram, BB, host, provider, GitHub, and credential broker readiness", usage: "bb telegram-agent doctor [project-id] [--json]" },
    ],
    run: (argv, context) => runTelegramAgentCli({
      store,
      sdk: bb.sdk,
      terminal,
      now: clock,
      getBotToken: () => config.ok ? config.value.botToken : undefined,
      createTelegramClient: (token) => telegramForToken(token),
      capabilityPromotions: recipePromotions,
      capabilitySettings: () => config.ok ? capabilityRoutingSettings(config.value) : {
        jobGraph: "adaptive",
        controllerTools: "bundled",
        modelRouting: "adaptive",
      },
      credentialAccess: credentialAccessService,
      runtime: runtimeHealth,
      unpairNonceKey,
      recordOperatorAudit: async (auditEntry) => {
        const auditKey = `operator-audit/unpair/${String(auditEntry.occurredAt).padStart(13, "0")}-${createSecret(8)}`;
        await bb.storage.kv.set(auditKey, auditEntry);
      },
      revokeAllApprovals: (now) => {
        const db = bb.storage.database();
        const revoke = db.transaction(() => {
          const result = db
            .prepare(
              `UPDATE approvals
                  SET consumed_at = COALESCE(consumed_at, ?), outcome = 'revoked'
                WHERE outcome IS NULL OR outcome = 'accepted'`,
            )
            .run(now);
          db.prepare("DELETE FROM pairing_codes").run();
          return result.changes;
        });
        return revoke();
      },
      notify: () => executorNudge.notify(),
    }, argv, context),
  });
  const bbRunner = new BbRunner(bb.sdk);
  const createReviewHandler = (
    invocation: ReviewInvocation,
    expectedVersion: number,
    fence: EffectFence,
  ): ReviewHandler => {
    const reviewJobMatches = (): boolean => {
      const current = store.getJob(invocation.jobId);
      const currentQuality = current?.reviewThreadId ? store.getAttemptByThreadId(current.reviewThreadId) : null;
      const invocationAttempt = store.getAttempt(invocation.attemptId);
      return current !== null && current.id === invocation.jobId && current.version === expectedVersion &&
        (current.state === "reviewing" || current.state === "final_reviewing") &&
        current.environmentId === invocation.environmentId && current.prHeadSha === invocation.expectedSha &&
        currentQuality !== null && invocationAttempt !== null &&
        currentQuality.jobId === current.id && currentQuality.kind === "review" && currentQuality.reviewLens === "quality" &&
        invocationAttempt.jobId === current.id && invocationAttempt.kind === "review" &&
        invocationAttempt.reviewStage === currentQuality.reviewStage && invocationAttempt.ordinal === currentQuality.ordinal &&
        current.implementationThreadId === invocation.implementationThreadId;
    };
    const reviewAttemptMatches = (): boolean => {
      const attempt = store.getAttempt(invocation.attemptId);
      return attempt !== null && attempt.jobId === invocation.jobId && attempt.kind === "review" &&
        attempt.threadId === invocation.reviewThreadId && attempt.headSha === invocation.expectedSha;
    };
    const isCurrent = (): boolean => !invocation.signal.aborted && !fence.signal.aborted &&
      store.isExecutorLeaseCurrent(fence.ownerId, fence.generation, clock()) &&
      reviewJobMatches() && reviewAttemptMatches();
    const assertCurrent = (): void => {
      if (!isCurrent()) throw new ReviewInvocationStaleError("review invocation identity or fence changed");
    };
    const readAttemptResult = (resultJson: string | null): Record<string, unknown> | null => {
      if (resultJson === null) return null;
      try {
        const parsed = JSON.parse(resultJson);
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null;
      } catch {
        return null;
      }
    };
    return new ReviewHandler({
      threads: {
        output: async (threadId) => {
          assertCurrent();
          if (threadId !== invocation.reviewThreadId) throw new ReviewInvocationStaleError("review thread identity changed");
          const output = await bb.sdk.threads.output({ threadId });
          assertCurrent();
          return output;
        },
        send: async (threadId, prompt) => {
          assertCurrent();
          if (threadId !== invocation.reviewThreadId) throw new ReviewInvocationStaleError("review thread identity changed");
          await bbRunner.sendSteering(threadId, prompt);
          assertCurrent();
        },
        create: async () => {
          throw new Error("review cycle creation belongs to the leased review effect");
        },
      },
      environment: {
        status: async (input: ReviewEnvironmentStatusInput) => {
          assertCurrent();
          if (input.environmentId !== invocation.environmentId || input.mergeBaseBranch !== invocation.mergeBaseBranch) {
            throw new ReviewInvocationStaleError("review environment identity changed");
          }
          const value = await bb.sdk.environments.status({
            environmentId: input.environmentId,
            mergeBaseBranch: input.mergeBaseBranch,
          });
          assertCurrent();
          const raw = value as unknown as Record<string, unknown>;
          const workspace = (raw.workspace ?? {}) as Record<string, unknown>;
          const checkout = (raw.checkout ?? workspace.checkout ?? {}) as Record<string, unknown>;
          return {
            available: raw.available !== false && raw.outcome !== "unavailable" && raw.outcome !== "not_applicable",
            clean: environmentWorktreeIsClean(value),
            headSha: typeof checkout.headSha === "string" ? checkout.headSha : null,
          };
        },
      },
      attempts: {
        get: ({ jobId, attemptId }: ReviewAttemptLookup) => {
          assertCurrent();
          if (jobId !== invocation.jobId || attemptId !== invocation.attemptId) {
            throw new ReviewInvocationStaleError("review attempt identity changed");
          }
          const attempt = store.getAttempt(attemptId);
          if (!attempt || attempt.jobId !== jobId) throw new ReviewInvocationStaleError("review attempt owner changed");
          const result = readAttemptResult(attempt.resultJson);
          return {
            threadId: attempt.threadId,
            headSha: attempt.headSha ?? undefined,
            formatCorrectionSent: result?.formatCorrectionSent === true,
            requiresNewHead: result?.requiresNewHead === true,
            result: result as never,
          };
        },
        update: ({ jobId, attemptId, patch }: ReviewAttemptUpdate) => {
          assertCurrent();
          if (jobId !== invocation.jobId || attemptId !== invocation.attemptId) {
            throw new ReviewInvocationStaleError("review attempt identity changed");
          }
          const existing = store.getAttempt(attemptId);
          if (!existing || existing.jobId !== jobId) throw new ReviewInvocationStaleError("review attempt owner changed");
          const existingResult = readAttemptResult(existing.resultJson);
          const result = patch.result === undefined
            ? existingResult
            : patch.result === null
              ? null
              : {
                  ...existingResult,
                  ...patch.result,
                  ...(patch.formatCorrectionSent === undefined ? {} : { formatCorrectionSent: patch.formatCorrectionSent }),
                  ...(patch.requiresNewHead === undefined ? {} : { requiresNewHead: patch.requiresNewHead }),
                };
          const updated = store.updateExecutorAttempt({
            jobId,
            attemptId,
            patch: {
              threadId: patch.threadId,
              headSha: patch.headSha,
              result: result as Record<string, unknown> | null,
            },
            ownerId: fence.ownerId,
            generation: fence.generation,
            now: clock(),
          });
          if (!updated) {
            if (!isCurrent()) throw new ReviewInvocationStaleError("review attempt identity or fence changed before persistence");
            throw new ReviewInvocationStaleError("review attempt changed before persistence");
          }
          if (updated.jobId !== jobId) throw new ReviewInvocationStaleError("review attempt owner changed");
        },
        claimFormatCorrection: ({ jobId, attemptId, threadId, headSha }: ReviewFormatCorrectionClaim) => {
          assertCurrent();
          if (jobId !== invocation.jobId || attemptId !== invocation.attemptId || threadId !== invocation.reviewThreadId || headSha !== invocation.expectedSha) {
            throw new ReviewInvocationStaleError("review correction identity changed");
          }
          const claimed = store.claimExecutorReviewFormatCorrection({
            jobId,
            attemptId,
            threadId,
            headSha,
            ownerId: fence.ownerId,
            generation: fence.generation,
            now: clock(),
          });
          if (!claimed && !isCurrent()) throw new ReviewInvocationStaleError("review correction identity or fence changed before claim");
          return claimed;
        },
      },
      guards: {
        settle: ({ envelope, policy }) => {
          assertCurrent();
          const attempt = store.getAttempt(invocation.attemptId);
          if (!attempt?.reviewStage) throw new ReviewInvocationStaleError("guard review stage changed");
          const assessment = persistGuardEnvelopeSettlement({
            repository: store,
            scopeId: reviewLineageScopeId(invocation.jobId, attempt.reviewStage),
            envelope,
            policy,
            now: clock(),
          });
          assertCurrent();
          return assessment;
        },
        block: ({ policy, reasonCode }) => {
          assertCurrent();
          const attempt = store.getAttempt(invocation.attemptId);
          if (!attempt?.reviewStage) throw new ReviewInvocationStaleError("guard review stage changed");
          persistBlockedGuardSettlement({
            repository: store,
            scopeId: reviewLineageScopeId(invocation.jobId, attempt.reviewStage),
            policy,
            reasonCode,
            now: clock(),
          });
          assertCurrent();
        },
      },
    });
  };
  const collectGateInput = createFreshGateCollector({
    validation: { runner: terminal, environments: bb.sdk.environments },
    runValidation: (input) => runValidation({
      runner: terminal,
      environments: bb.sdk.environments,
      environmentId: input.environmentId,
      job: input.job,
      currentReviewAttempt: store.getJob(input.job.id)?.reviewThreadId
        ? (() => {
            const reviewThreadId = store.getJob(input.job.id)?.reviewThreadId;
            const attempt = reviewThreadId ? store.getAttemptByThreadId(reviewThreadId) : null;
            return attempt ? { id: attempt.id } : undefined;
          })()
        : undefined,
      signal: input.signal,
      onTerminalObservation: (observation) => {
        if (input.signal?.aborted) return;
        const current = store.getJob(input.job.id);
        if (current) projectTerminalLiveness(store, current, observation, "validation", clock(), undefined, input.fence);
      },
    }),
    getContext: async ({ job, receipt, validation, approvalExpiresAt }): Promise<{
      environment: GateInput["environment"];
      review: GateInput["review"];
      receipt: GateInput["receipt"];
    }> => {
      if (!job.environmentId || !job.projectId || !job.policy || job.prNumber === null) {
        throw new TypeError("Merge gate collection requires a fully configured job");
      }
      const rawStatus = await bb.sdk.environments.status({
        environmentId: job.environmentId,
        mergeBaseBranch: job.policy.baseBranch,
      }) as unknown as Record<string, unknown>;
      const workspace = (rawStatus.workspace ?? {}) as Record<string, unknown>;
      const workingTree = (rawStatus.workingTree ?? workspace.workingTree ?? {}) as Record<string, unknown>;
      const checkout = (rawStatus.checkout ?? workspace.checkout ?? {}) as Record<string, unknown>;
      const rawPullRequest = await bb.sdk.environments.pullRequest({ environmentId: job.environmentId });
      const pullRequestRecord = rawPullRequest as unknown as Record<string, unknown>;
      const pullRequest = (pullRequestRecord.pullRequest ?? {}) as Record<string, unknown>;
      const attempt = job.reviewThreadId ? store.getAttemptByThreadId(job.reviewThreadId) : null;
      let attemptResult: Record<string, unknown> = {};
      if (attempt?.resultJson) {
        try {
          const parsed = JSON.parse(attempt.resultJson);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) attemptResult = parsed as Record<string, unknown>;
        } catch {
          attemptResult = {};
        }
      }
      const defaultReceipt = {
        jobId: job.id,
        jobVersion: job.version,
        projectId: job.projectId,
        environmentId: job.environmentId,
        prNumber: job.prNumber,
        baseBranch: job.policy.baseBranch,
        headSha: validation.headSha,
        reviewAttemptId: attempt?.id ?? validation.reviewAttemptId ?? `review:${job.id}`,
        validationCompletedAt: validation.completedAt,
        requiredCheckNames: [...job.policy.requiredChecks].sort(),
        mergeMethod: job.policy.mergeMethod,
        expiresAt: new Date(approvalExpiresAt ?? (typeof validation.completedAt === "string" ? Date.parse(validation.completedAt) + 15 * 60_000 : Date.now() + 15 * 60_000)).toISOString(),
      };
      return {
        environment: {
          id: job.environmentId,
          projectId: job.projectId,
          status: rawStatus.outcome === "available" || rawStatus.status === "available" ? "available" : String(rawStatus.status ?? rawStatus.outcome ?? "unavailable"),
          worktree: {
            clean: environmentWorktreeIsClean(rawStatus),
            untrackedFiles: Array.isArray(workingTree.untrackedFiles) ? workingTree.untrackedFiles.filter((item): item is string => typeof item === "string") : [],
          },
          checkout: {
            kind: typeof checkout.kind === "string" ? checkout.kind : "unknown",
            branchName: typeof checkout.branchName === "string" ? checkout.branchName : typeof checkout.branch === "string" ? checkout.branch : undefined,
            headSha: typeof checkout.headSha === "string" ? checkout.headSha : null,
          },
        },
        review: {
          attemptId: attempt?.id ?? validation.reviewAttemptId ?? `review:${job.id}`,
          headSha: typeof attemptResult.reviewedHeadSha === "string" ? attemptResult.reviewedHeadSha : attempt?.headSha ?? null,
          verdict: typeof (attemptResult.verdict as Record<string, unknown> | undefined)?.verdict === "string"
            ? String((attemptResult.verdict as Record<string, unknown>).verdict)
            : typeof attemptResult.outcome === "string" ? attemptResult.outcome : "blocked",
          findings: Array.isArray(attemptResult.findings) ? attemptResult.findings : [],
          reviewerMutated: attemptResult.reviewerMutated === true,
        },
        receipt: receipt ?? defaultReceipt,
      };
    },
  });
  const mergeHandler = new MergeHandler({
    store,
    commandRunner: terminal,
    bb: { sdk: bb.sdk },
    collectGateInput,
  });
  const health = pluginHealth;
  const ingress = new TelegramIngress({
    store,
    telegram: telegramTransport,
    mergeHandler,
    onWorkAvailable: () => executorNudge.notify(),
    health,
  });
  const controllerAdapter = new BbControllerAdapter({
    sdk: bb.sdk,
    pluginId: bb.pluginId,
    now: clock,
    reserveSpawn: (input) => store.reserveControllerSpawn(input),
    executionProfiles: () => {
      if (!config.ok) throw new Error(config.message);
      return controllerExecutionProfiles(config.value);
    },
    downloadImage: async (fileId, maxBytes, signal) => {
      try {
        return await verifiedTelegramClient().downloadFile(fileId, maxBytes, signal);
      } catch (error) {
        if (error instanceof TelegramFileTooLargeError) {
          throw new ControllerImagePreparationError(false);
        }
        throw error;
      }
    },
  });
  const controllerInteractionService = new ControllerInteractionService({
    store: {
      isControllerInteractionDeliveryFenceCurrent: (input) =>
        store.isControllerInteractionDeliveryFenceCurrent(input),
      record: (input) => store.recordControllerInteraction(input),
      markResolved: (input) => store.markControllerInteractionResolved(input),
      answerByToken: (input) => store.answerControllerInteractionByToken(input),
      answerWithText: (input) => store.answerControllerInteractionWithText(input),
      getPending: (controllerKey) => store.getPendingControllerInteraction(controllerKey),
      getAnswered: (controllerKey) => store.getAnsweredControllerInteraction(controllerKey),
      markDelivered: (input) => store.markControllerInteractionDelivered(input),
    },
    clock: { now: clock },
    interactions: {
      get: async (threadId, interactionId, signal) => controllerAdapter.getInteraction(
        threadId,
        interactionId,
        signal ?? AbortSignal.timeout(30_000),
      ),
      resolve: async (input, signal) => {
        const effectiveSignal = signal ?? AbortSignal.timeout(30_000);
        await controllerAdapter.resolveInteraction(
          input.threadId,
          input.interactionId,
          parseControllerInteractionResolution(input.resolution),
          effectiveSignal,
        );
        return controllerAdapter.getInteraction(input.threadId, input.interactionId, effectiveSignal);
      },
    },
  });
  const controller = new LunaControllerService({
    store,
    evidenceProjector,
    adapter: controllerAdapter,
    interactionService: controllerInteractionService,
    clock: { now: clock },
    warn: (message) => bb.log.warn(message),
  });
  const monitors = new MonitorService({
    store,
    threads: {
      status: async (threadId) => {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.deletedAt !== null || thread.archivedAt !== null) return "missing";
        return thread.status;
      },
      output: async (threadId) => {
        const result = await bb.sdk.threads.output({ threadId });
        return result.output ?? "";
      },
    },
    clock: { now: clock },
    warn: (message) => bb.log.warn(message),
  });
  const jobMemory = new JobMemoryService({
    store,
    modelRoute: () => {
      if (!config.ok) throw new Error(config.message);
      return backgroundCapabilityModelRoute(config.value);
    },
    threads: {
      spawnHidden: async ({ projectId, title, prompt, modelRoute }) => {
        const hosts = await bb.sdk.hosts.list({});
        const host = hosts.find((candidate) => candidate.status === "connected");
        if (!host) throw new Error("No connected BB host can run a memory extraction");
        const thread = await bb.sdk.threads.spawn({
          projectId,
          title,
          visibility: "hidden",
          input: [{ type: "text", text: prompt, mentions: [] }],
          environment: {
            type: "host",
            hostId: host.id,
            workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
          },
          providerId: modelRoute.providerId,
          model: modelRoute.modelId,
          reasoningLevel: modelRoute.reasoning,
          serviceTier: modelRoute.serviceTier,
          permissionMode: "auto",
          executionInputSources: {
            providerId: "explicit",
            model: "explicit",
            reasoningLevel: "explicit",
            serviceTier: "explicit",
            permissionMode: "explicit",
          },
        });
        return thread.id;
      },
      status: async (threadId) => {
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.deletedAt !== null || thread.archivedAt !== null) return "missing";
        return thread.status;
      },
      output: async (threadId) => {
        const result = await bb.sdk.threads.output({ threadId });
        return result.output ?? "";
      },
    },
    clock: { now: clock },
    warn: (message) => bb.log.warn(message),
  });
  // Health ids share the monitor id space, which is derived from the clock and
  // kept above real Telegram update ids.
  let healthUpdateId = 0;
  const productionHealth = new ProductionHealthService({
    store,
    commands: {
      run: async ({ projectId, command }) => {
        const projects = await bb.sdk.projects.list({});
        const project = projects.find((candidate) => candidate.id === projectId);
        const source = project?.sources.find((candidate) => candidate.isDefault) ?? project?.sources[0];
        if (!source?.hostId) throw new Error("Project has no host to run a health check on");
        const result = await terminal.run({
          scope: { kind: "host_path", hostId: source.hostId, cwd: source.path ?? null },
          title: `Telegram production health: ${command.name.slice(0, 40)}`,
          command: command.command,
          timeoutMs: command.timeoutMs,
        });
        if (result.outcome !== "exited") return { ok: false, summary: `check ${result.outcome}` };
        return { ok: result.exitCode === 0, summary: result.output || `exit ${result.exitCode}` };
      },
    },
    clock: { now: clock },
    issueUpdateId: (now) => {
      healthUpdateId = Math.max(healthUpdateId + 1, 2_000_000_000 + Math.max(0, now - 1_700_000_000_000));
      return healthUpdateId;
    },
    warn: (message) => bb.log.warn(message),
  });
  const regressionWatch = new RegressionWatchService({
    store,
    commands: {
      run: async ({ projectId, command }) => {
        const projects = await bb.sdk.projects.list({});
        const project = projects.find((candidate) => candidate.id === projectId);
        const source = project?.sources.find((candidate) => candidate.isDefault) ?? project?.sources[0];
        if (!source?.hostId) throw new Error("Project has no host to run a scheduled check on");
        const result = await terminal.run({
          scope: { kind: "host_path", hostId: source.hostId, cwd: source.path ?? null },
          title: `Telegram scheduled check: ${command.name.slice(0, 40)}`,
          command: command.command,
          timeoutMs: command.timeoutMs,
        });
        if (result.outcome !== "exited") return { ok: false, summary: `check ${result.outcome}` };
        return { ok: result.exitCode === 0, summary: result.output || `exit ${result.exitCode}` };
      },
    },
    clock: { now: clock },
    issueUpdateId: (now) => {
      healthUpdateId = Math.max(healthUpdateId + 1, 2_000_000_000 + Math.max(0, now - 1_700_000_000_000));
      return healthUpdateId;
    },
    warn: (message) => bb.log.warn(message),
  });
  const failureLoop = new FailureLoopService({
    store,
    clock: { now: clock },
    issueUpdateId: (now) => {
      healthUpdateId = Math.max(healthUpdateId + 1, 2_000_000_000 + Math.max(0, now - 1_700_000_000_000));
      return healthUpdateId;
    },
    warn: (message) => bb.log.warn(message),
  });
  const memoryCuration = new MemoryCurationService({ store, clock: { now: clock } });
  let systemMonitorsInstalled = false;
  const systemMonitors = {
    install: () => {
      // Turning the setting off has to retire what is already armed, or the
      // owner keeps getting the daily sweep they just switched off.
      if (config.ok && !systemUpkeepEnabled(config.value)) {
        if (store.cancelSystemMonitors(clock()) > 0) systemMonitorsInstalled = false;
        return;
      }
      if (systemMonitorsInstalled) return;
      if (!config.ok) return;
      const installed = installSystemMonitors({
        store,
        clock: { now: clock },
        warn: (message) => bb.log.warn(message),
      });
      if (installed > 0) systemMonitorsInstalled = true;
    },
  };
  const threadNotices = new ThreadNoticeService({
    store,
    threads: {
      listWatchable: async () => {
        const threads = await bb.sdk.threads.list({ includeHidden: false, archived: false, limit: 100 });
        return threads
          .filter((thread) => thread.visibility === "visible" && thread.archivedAt === null && thread.deletedAt === null)
          .map((thread) => ({
            id: thread.id,
            title: thread.title ?? thread.titleFallback ?? "Untitled thread",
            status: thread.status,
            parentThreadId: thread.parentThreadId,
          }));
      },
      interactions: async (threadId) => {
        const pending = await bb.sdk.threads.interactions.list({ threadId });
        return pending.map((interaction) => ({
          id: interaction.id,
          status: interaction.status,
          payload: interaction.payload,
        }));
      },
      resolve: async (threadId, interactionId, resolution) => {
        await bb.sdk.threads.interactions.resolve({
          threadId,
          interactionId,
          resolution: resolution as Parameters<typeof bb.sdk.threads.interactions.resolve>[0]["resolution"],
        });
      },
    },
    clock: { now: clock },
    warn: (message) => bb.log.warn(message),
  });
  const presence = new TelegramPresenceCoordinator({
    store,
    telegram: {
      sendChatAction: (chatId, action, signal) => {
        if (!config.ok) throw new Error(config.message);
        return telegramForToken(config.value.botToken).sendChatAction(chatId, action, signal);
      },
    },
    warn: (message) => bb.log.warn(message),
  });

  const bbEffectAdapter = {
    spawnPlanner: (job: Parameters<BbRunner["spawnPlanner"]>[0], attempt: Parameters<BbRunner["spawnPlanner"]>[1], previousCritique?: string | null) => bbRunner.spawnPlanner(job, attempt, previousCritique),
    spawnCritic: (job: Parameters<BbRunner["spawnCritic"]>[0], attempt: Parameters<BbRunner["spawnCritic"]>[1], plan: Parameters<BbRunner["spawnCritic"]>[2]) => bbRunner.spawnCritic(job, attempt, plan),
    spawnBuilderFromPlan: (job: Parameters<BbRunner["spawnBuilderFromPlan"]>[0], attempt: Parameters<BbRunner["spawnBuilderFromPlan"]>[1], plan: Parameters<BbRunner["spawnBuilderFromPlan"]>[2]) => bbRunner.spawnBuilderFromPlan(job, attempt, plan),
    spawnDocs: (job: Parameters<BbRunner["spawnDocs"]>[0], attempt: Parameters<BbRunner["spawnDocs"]>[1]) => bbRunner.spawnDocs(job, attempt),
    spawnImplementation: (job: Parameters<BbRunner["spawnImplementation"]>[0], attempt: Parameters<BbRunner["spawnImplementation"]>[1]) => bbRunner.spawnImplementation(job, attempt),
    spawnReview: (job: Parameters<BbRunner["spawnReview"]>[0], attempt: Parameters<BbRunner["spawnReview"]>[1]) => bbRunner.spawnReview(job, attempt),
    spawnFinalReview: (job: Parameters<BbRunner["spawnFinalReview"]>[0], attempt: Parameters<BbRunner["spawnFinalReview"]>[1]) => bbRunner.spawnFinalReview(job, attempt),
    sendRemediation: (
      job: Parameters<BbRunner["sendRemediation"]>[0],
      findings: Parameters<BbRunner["sendRemediation"]>[1],
      reasons?: Parameters<BbRunner["sendRemediation"]>[2],
    ) => bbRunner.sendRemediation(job, findings, reasons),
    sendSteering: (threadId: string, text: string) => bbRunner.sendSteering(threadId, text),
    stopWorker: (worker: Parameters<BbRunner["stopWorker"]>[0]) => bbRunner.stopWorker(worker),
    retireWorker: (resourceId: string, allowMissing: boolean) => bbRunner.retireWorker(resourceId, allowMissing),
    prepareProgressScratchpad: (environmentId: string) => bbRunner.prepareProgressScratchpad(environmentId),
    getThread: (threadId: string) => bbRunner.getThread(threadId),
    getEnvironmentSnapshot: (environmentId: string, baseBranch: string) => bbRunner.getEnvironmentSnapshot(environmentId, baseBranch),
    getPullRequestSnapshot: (environmentId: string) => bbRunner.getPullRequestSnapshot(environmentId),
    sdk: { threads: bb.sdk.threads },
  };
  const reconcileJob = async (
    job: NonNullable<ReturnType<typeof store.getJob>>,
    signal: AbortSignal,
    fence: EffectFence,
    requestedResourceId?: string,
  ): Promise<void> => {
    const fenceCurrent = (): boolean => !signal.aborted && !fence.signal.aborted &&
      store.isExecutorLeaseCurrent(fence.ownerId, fence.generation, clock());
    const applyExecutorEvent = (jobId: string, expectedVersion: number, event: Parameters<TelegramAgentStore["applyExecutorJobEvent"]>[0]["event"]): void => {
      const updated = store.applyExecutorJobEvent({
        jobId,
        expectedVersion,
        event,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: clock(),
      });
      if (!updated) throw new Error("executor lease was lost before reconciliation transition");
    };
    const recoverWorker = (
      current: NonNullable<ReturnType<TelegramAgentStore["getJob"]>>,
      workerKind: Parameters<TelegramAgentStore["registerExecutorWorkerRecovery"]>[0]["workerKind"],
      resourceId: string,
      workerGeneration: number,
      classification: Parameters<TelegramAgentStore["registerExecutorWorkerRecovery"]>[0]["classification"],
      signature: string,
      attempt: ReturnType<TelegramAgentStore["getLatestPipelineStageAttempt"]>,
      retryPayload: Record<string, unknown>,
    ): boolean => {
      if (!current.projectId || !current.policy) return false;
      if (workerKind === "critique" && (
        typeof retryPayload.planAttemptId !== "string" || retryPayload.planAttemptId.length === 0
      )) {
        applyExecutorEvent(current.id, current.version, {
          type: "THREAD_FAILED",
          workerKind,
          error: "Critique recovery requires a durable plan attempt",
        });
        return true;
      }
      const recoveryId = `recovery_${createHash("sha256")
        .update(`${current.id}\0${resourceId}\0${String(workerGeneration)}\0${signature}`, "utf8")
        .digest("base64url")
        .slice(0, 28)}`;
      const registered = store.registerExecutorWorkerRecovery({
        id: recoveryId,
        jobId: current.id,
        expectedVersion: current.version,
        projectId: current.projectId,
        jobState: current.state,
        workerKind,
        resourceId,
        workerGeneration,
        classification,
        signature,
        retryLimit: current.policy.workerRecoveryLimit,
        ownerId: fence.ownerId,
        generation: fence.generation,
        now: clock(),
      });
      if (!registered) throw new Error("executor lease was lost before recovery registration");
      if (registered.action === "already_recorded" && registered.record.state !== "detected") return true;
      if (attempt?.state === "running") {
        if (!store.failPipelineStageAttempt({
          id: attempt.id,
          error: `${workerKind} worker was retired before it produced evidence`,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now: clock(),
        })) throw new Error("executor lease was lost before retired attempt persistence");
      }
      const latest = store.getJob(current.id);
      if (!latest || latest.state !== current.state) return true;
      if (registered.action === "owner_required") {
        applyExecutorEvent(latest.id, latest.version, {
          type: "THREAD_FAILED",
          workerKind,
          error: `${workerKind} worker stopped unexpectedly and needs a manual retry`,
        });
        return true;
      }
      applyExecutorEvent(latest.id, latest.version, {
        type: "WORKER_RECOVERY_REQUESTED",
        recoveryId: registered.record.id,
        workerKind,
        resourceId,
        classification,
        signature,
        retryPayload,
      });
      return true;
    };
    if (!fenceCurrent()) return;

    const pipelineRole = job.state === "planning" ? "PLAN" as const
      : job.state === "critiquing" ? "CRITIQUE" as const
      : job.state === "documenting" ? "DOCS" as const
      : null;
    const pipelineAttempt = pipelineRole ? store.getLatestPipelineStageAttempt(job.id, pipelineRole) : null;
    const reviewStage = job.state === "reviewing" || job.state === "final_reviewing";
    const implementationStage = ["implementing", "remediating"].includes(job.state);
    if (reviewStage && requestedResourceId === undefined && job.reviewThreadId) {
      const quality = store.getAttemptByThreadId(job.reviewThreadId);
      if (quality?.reviewStage && quality.kind === "review") {
        const attempts = store.listReviewAttempts(job.id, quality.reviewStage, quality.ordinal)
          .filter((attempt) => attempt.threadId !== null);
        if (attempts.length > 0) {
          for (const attempt of attempts) {
            if (signal.aborted || fence.signal.aborted || attempt.threadId === null) return;
            const current = store.getJob(job.id);
            if (!current || current.version !== job.version || current.state !== job.state) return;
            await reconcileJob(current, signal, fence, attempt.threadId);
          }
          return;
        }
      }
    }
    const qualityReviewAttempt = reviewStage && job.reviewThreadId ? store.getAttemptByThreadId(job.reviewThreadId) : null;
    const requestedReviewAttempt = reviewStage && requestedResourceId ? store.getAttemptByThreadId(requestedResourceId) : null;
    const requestedReviewMatches = requestedReviewAttempt !== null && qualityReviewAttempt !== null &&
      requestedReviewAttempt.jobId === job.id && requestedReviewAttempt.kind === "review" &&
      requestedReviewAttempt.reviewStage === qualityReviewAttempt.reviewStage &&
      requestedReviewAttempt.ordinal === qualityReviewAttempt.ordinal;
    if (requestedResourceId !== undefined) {
      const requestedResourceMatches = pipelineAttempt?.threadId === requestedResourceId ||
        (reviewStage && requestedReviewMatches) ||
        (implementationStage && job.implementationThreadId === requestedResourceId);
      if (!requestedResourceMatches) return;
    }
    const reviewResourceId = requestedReviewMatches ? requestedResourceId ?? null : job.reviewThreadId;
    const resourceId = pipelineAttempt?.threadId ?? (reviewStage ? reviewResourceId : implementationStage ? job.implementationThreadId : null);
    if (!resourceId) return;
    const recoveryRetryPayload = (): Record<string, unknown> => {
      if (pipelineRole === "CRITIQUE") {
        return { planAttemptId: store.getLatestPipelineStageAttempt(job.id, "PLAN")?.id ?? "" };
      }
      if (reviewStage && qualityReviewAttempt?.reviewStage) {
        const retireResourceIds = store
          .listReviewAttempts(job.id, qualityReviewAttempt.reviewStage, qualityReviewAttempt.ordinal)
          .map((attempt) => attempt.threadId)
          .filter((threadId): threadId is string => threadId !== null && threadId !== resourceId);
        return retireResourceIds.length > 0 ? { retireResourceIds } : {};
      }
      return {};
    };
    const workerKind = pipelineRole === "PLAN" ? "plan" as const
      : pipelineRole === "CRITIQUE" ? "critique" as const
      : pipelineRole === "DOCS" ? "docs" as const
      : reviewStage ? "review" as const
      : "implementation" as const;
    const generation = workerRegistrationGeneration(job, workerKind);
    const previousLiveness = store.getWorkerLivenessForResource(job.id, resourceId);
    let thread: Awaited<ReturnType<BbRunner["getThread"]>>;
    try {
      thread = await bbRunner.getThread(resourceId);
    } catch {
      if (!fenceCurrent()) return;
      const current = store.getJob(job.id);
      if (current) {
        const observedAt = clock();
        projectUnknownWorker(store, current, resourceId, observedAt, workerKind, generation, {
          ownerId: fence.ownerId,
          generation: fence.generation,
          now: observedAt,
        });
        const recovery = classifyThreadRecovery(current, null, previousLiveness, observedAt, workerKind);
        if (recovery) {
          const retryPayload = recoveryRetryPayload();
          recoverWorker(current, workerKind, resourceId, generation, recovery.classification, recovery.signature, pipelineAttempt, retryPayload);
        }
      }
      return;
    }
    if (!fenceCurrent()) return;
    const current = store.getJob(job.id);
    const currentPipelineAttempt = pipelineRole ? store.getLatestPipelineStageAttempt(job.id, pipelineRole) : null;
    const currentQualityAttempt = reviewStage && current?.reviewThreadId ? store.getAttemptByThreadId(current.reviewThreadId) : null;
    const currentRequestedAttempt = reviewStage ? store.getAttemptByThreadId(resourceId) : null;
    const currentReviewResourceMatches = currentRequestedAttempt !== null && currentQualityAttempt !== null &&
      currentRequestedAttempt.jobId === current?.id && currentRequestedAttempt.kind === "review" &&
      currentRequestedAttempt.reviewStage === currentQualityAttempt.reviewStage &&
      currentRequestedAttempt.ordinal === currentQualityAttempt.ordinal;
    const currentResourceId = currentPipelineAttempt?.threadId ??
      (reviewStage ? (currentReviewResourceMatches ? resourceId : current?.reviewThreadId) : current?.implementationThreadId);
    if (!current || current.state !== job.state || currentResourceId !== resourceId) return;
    if (!fenceCurrent()) return;
    const observedAt = clock();
    const projected = projectWorkerLiveness(store, current, thread, observedAt, workerKind, generation, {
      ownerId: fence.ownerId,
      generation: fence.generation,
      now: observedAt,
    });
    const recovery = classifyThreadRecovery(current, thread, previousLiveness, observedAt, workerKind);
    if (recovery) {
      const retryPayload = recoveryRetryPayload();
      recoverWorker(current, workerKind, resourceId, generation, recovery.classification, recovery.signature, currentPipelineAttempt, retryPayload);
      return;
    }
    const failed = thread.status === "error" || thread.runtime.displayStatus === "error";
    if (failed) {
      if (!fenceCurrent()) return;
      if (currentPipelineAttempt) {
        if (!store.failPipelineStageAttempt({
          id: currentPipelineAttempt.id,
          error: `${workerKind} worker thread failed`,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now: clock(),
        })) throw new Error("executor lease was lost before pipeline failure persistence");
      }
      const latest = store.getJob(job.id);
      if (latest && latest.cancelRequestedAt === null) {
        applyExecutorEvent(job.id, latest.version, { type: "THREAD_FAILED", workerKind, error: `${workerKind} worker thread failed` });
      }
      return;
    }
    if (projected.state !== "idle") return;

    if (pipelineRole && currentPipelineAttempt) {
      let output: string;
      let docsObservation: { clean: boolean; diff: string | null } | undefined;
      try {
        output = await bbRunner.getThreadOutput(resourceId);
        if (pipelineRole === "DOCS") {
          if (!current.environmentId || !current.policy) throw new Error("docs environment is unavailable");
          const snapshot = await bbRunner.getEnvironmentSnapshot(current.environmentId, current.policy.baseBranch);
          docsObservation = {
            clean: environmentWorktreeIsClean(snapshot.status),
            diff: environmentDiffText(snapshot.diff),
          };
        }
      } catch {
        if (!fenceCurrent()) return;
        if (!store.failPipelineStageAttempt({
          id: currentPipelineAttempt.id,
          error: `${workerKind} output is unavailable`,
          ownerId: fence.ownerId,
          generation: fence.generation,
          now: clock(),
        })) throw new Error("executor lease was lost before pipeline failure persistence");
        const latest = store.getJob(job.id);
        if (latest?.state === job.state) {
          applyExecutorEvent(job.id, latest.version, { type: "FAILED", error: `${workerKind} output is unavailable` });
        }
        return;
      }
      if (!fenceCurrent()) return;
      settlePipelineStageOutput({
        store,
        job: current,
        attempt: currentPipelineAttempt,
        output,
        docsObservation,
        fence: { ownerId: fence.ownerId, generation: fence.generation },
        now: clock(),
      });
      return;
    }

    if (!reviewStage) {
      if (!fenceCurrent()) return;
      const latest = store.getJob(job.id);
      if (latest && (latest.state === "implementing" || latest.state === "remediating")) {
        if (latest.routingMode !== "legacy") {
          const attempt = store.getAttemptByThreadId(resourceId);
          const profile = attempt
            ? store.getLatestCapabilityProfile("worker_attempt", attempt.id)
            : null;
          const profileMatches = profile !== null && profile.subjectId === attempt?.id &&
            profile.recipeId === latest.taskRecipe && profile.recipeVersion === latest.recipeVersion &&
            profile.mode === latest.routingMode;
          if (!attempt || !profileMatches || !attempt.handoffSha256 || !latest.environmentId || !latest.policy) {
            if (latest.routingMode === "active") {
              applyExecutorEvent(job.id, latest.version, {
                type: "FAILED",
                error: "Mandatory capability evidence is incomplete",
              });
              return;
            }
          } else {
            let diff: string | null = null;
            try {
              const snapshot = await bbRunner.getEnvironmentSnapshot(latest.environmentId, latest.policy.baseBranch);
              if (!fenceCurrent()) return;
              diff = environmentDiffText(snapshot.diff);
            } catch {
              if (!fenceCurrent()) return;
            }
            const commandEvidence = [] as Array<{
              commandSha256: string;
              outcome: "pass" | "fail" | "timed_out" | "aborted";
              terminalId?: string;
            }>;
            for (const validation of latest.policy.validationCommands) {
              let terminalId: string | undefined;
              try {
                const result = await terminal.run({
                  scope: { kind: "environment", environmentId: latest.environmentId },
                  title: `Capability verification ${validation.name}`,
                  command: validation.command,
                  timeoutMs: validation.timeoutMs,
                  signal,
                  onObservation: (observation) => {
                    terminalId = observation.id;
                  },
                });
                if (!fenceCurrent()) return;
                commandEvidence.push({
                  commandSha256: createHash("sha256").update(validation.command, "utf8").digest("hex"),
                  outcome: result.outcome === "exited"
                    ? result.exitCode === 0 ? "pass" : "fail"
                    : result.outcome,
                  ...(terminalId ? { terminalId } : {}),
                });
              } catch {
                if (!fenceCurrent()) return;
                commandEvidence.push({
                  commandSha256: createHash("sha256").update(validation.command, "utf8").digest("hex"),
                  outcome: "aborted",
                  ...(terminalId ? { terminalId } : {}),
                });
              }
            }
            const settlement = recordImplementationCapabilityOutcomes({
              store,
              profileId: profile.id,
              handoffSha256: attempt.handoffSha256,
              diff,
              commands: commandEvidence,
              validationPolicy: {
                commandSha256s: latest.policy.validationCommands.map((validation) =>
                  createHash("sha256").update(validation.command, "utf8").digest("hex")),
              },
              now: clock(),
            });
            if (!fenceCurrent()) return;
            if (!settlement.satisfied && latest.routingMode === "active") {
              applyExecutorEvent(job.id, latest.version, {
                type: "FAILED",
                error: "Mandatory capability evidence is incomplete",
              });
              return;
            }
          }
        }
        applyExecutorEvent(job.id, latest.version, { type: "IMPLEMENTATION_IDLE" });
      }
      return;
    }

    const attempt = store.getAttemptByThreadId(resourceId);
    if (!attempt || !current.implementationThreadId || !current.prHeadSha) {
      if (!fenceCurrent()) return;
      const latest = store.getJob(job.id);
      if (latest) applyExecutorEvent(job.id, latest.version, { type: "REVIEW_BLOCKED", reason: "configuration" });
      return;
    }
    if (attempt.jobId !== current.id || attempt.kind !== "review" || attempt.headSha !== current.prHeadSha) return;
    let guardPolicy: GuardAssessmentPolicy | undefined;
    if (current.routingMode === "active" && attempt.reviewLens === "quality") {
      if (!current.environmentId || !current.policy) {
        if (!fenceCurrent()) return;
        applyExecutorEvent(job.id, current.version, { type: "REVIEW_BLOCKED", reason: "configuration" });
        return;
      }
      const profile = store.getLatestCapabilityProfile("worker_attempt", attempt.id);
      let diff: string | null = null;
      try {
        const snapshot = await bbRunner.getEnvironmentSnapshot(current.environmentId, current.policy.baseBranch);
        if (!fenceCurrent()) return;
        diff = environmentDiffText(snapshot.diff);
      } catch {
        if (!fenceCurrent()) return;
      }
      const guardAssignments = profile?.assignments.filter((assignment) =>
        CAPABILITY_BY_ID.get(assignment.capabilityId)?.evidence.receiptType === "guard") ?? [];
      const requiredGuards = diff === null ? [] : [...requiredGuardsForChangeSurface(diff)];
      const selectedGuardIds = guardAssignments.map((assignment) => assignment.capabilityId)
        .sort((left, right) => left.localeCompare(right));
      const profileMatches = profile !== null && profile.subjectId === attempt.id &&
        profile.recipeId === current.taskRecipe && profile.recipeVersion === current.recipeVersion &&
        profile.mode === current.routingMode &&
        JSON.stringify(selectedGuardIds) === JSON.stringify(requiredGuards) &&
        guardAssignments.every((assignment) => CAPABILITY_BY_ID.get(assignment.capabilityId)?.digest === assignment.descriptorDigest);
      if (!profileMatches || diff === null) {
        if (!fenceCurrent()) return;
        applyExecutorEvent(job.id, current.version, { type: "REVIEW_BLOCKED", reason: "configuration" });
        return;
      }
      if (guardAssignments.length > 0) {
        guardPolicy = {
          profileId: profile.id,
          profileRevision: profile.revision,
          reviewedHeadSha: current.prHeadSha,
          diffDigest: createHash("sha256").update(diff, "utf8").digest("hex"),
          selectedGuards: guardAssignments.map((assignment) => {
            const descriptor = CAPABILITY_BY_ID.get(assignment.capabilityId);
            if (!descriptor) throw new Error("Selected guard disappeared before review settlement");
            return {
              capabilityId: assignment.capabilityId,
              descriptorDigest: assignment.descriptorDigest,
              mandatory: assignment.mandatory,
              substitutes: descriptor.composition.substitutes,
            };
          }),
          requirementIds: guardRequirementBindings(current.policy.requiredChecks).map((requirement) => requirement.id),
          mustFixRuleIds: ["clean.rule-1", "docs.rule-1", "tests.rule-1"],
          advisoryRuleIds: ["clean.rule-10", "docs.rule-10", "tests.rule-10"],
        };
      }
    }
    const invocation: ReviewInvocation = {
      jobId: current.id,
      attemptId: attempt.id,
      reviewThreadId: resourceId,
      implementationThreadId: current.implementationThreadId,
      environmentId: current.environmentId ?? "",
      mergeBaseBranch: current.policy?.baseBranch ?? "",
      expectedSha: current.prHeadSha,
      ...(guardPolicy === undefined ? {} : { guardPolicy }),
      signal,
    };
    if (!invocation.environmentId || !invocation.mergeBaseBranch || !fenceCurrent()) return;
    const reviewHandler = createReviewHandler(invocation, current.version, fence);
    let completion: ReviewHandlerCompletion;
    try {
      completion = await reviewHandler.handleThreadIdle(invocation);
    } catch (error) {
      if (error instanceof ReviewInvocationStaleError || !fenceCurrent()) return;
      throw error;
    }
    if (!completion.event || !fenceCurrent()) return;
    const latest = store.getJob(invocation.jobId);
    const latestAttempt = store.getAttempt(invocation.attemptId);
    const latestQualityAttempt = latest?.reviewThreadId ? store.getAttemptByThreadId(latest.reviewThreadId) : null;
    if (!latest || !latestAttempt || latestAttempt.jobId !== invocation.jobId ||
      latestAttempt.threadId !== invocation.reviewThreadId || latestAttempt.headSha !== invocation.expectedSha ||
      !latestQualityAttempt || latestQualityAttempt.jobId !== invocation.jobId || latestQualityAttempt.kind !== "review" ||
      latestQualityAttempt.reviewLens !== "quality" || latestAttempt.reviewStage !== latestQualityAttempt.reviewStage ||
      latestAttempt.ordinal !== latestQualityAttempt.ordinal ||
      latest.id !== invocation.jobId || latest.version !== current.version ||
      (latest.state !== "reviewing" && latest.state !== "final_reviewing") ||
      latest.environmentId !== invocation.environmentId || latest.prHeadSha !== invocation.expectedSha ||
      latest.implementationThreadId !== invocation.implementationThreadId || !fenceCurrent()) return;
    if (!latestQualityAttempt.reviewStage) return;
    const assessment = assessReviewGroup(
      store.listReviewAttempts(latest.id, latestQualityAttempt.reviewStage, latestQualityAttempt.ordinal),
      latest.deliveryMode,
      invocation.expectedSha,
    );
    if (assessment.outcome === "pending") return;
    if (assessment.outcome === "pass") {
      if (latest.routingMode === "active") {
        if (!latest.environmentId || !latest.policy) {
          applyExecutorEvent(job.id, latest.version, { type: "REVIEW_BLOCKED", reason: "configuration" });
          return;
        }
        let exactDiff: string | null = null;
        try {
          const snapshot = await bbRunner.getEnvironmentSnapshot(latest.environmentId, latest.policy.baseBranch);
          if (!fenceCurrent()) return;
          exactDiff = environmentDiffText(snapshot.diff);
        } catch {
          if (!fenceCurrent()) return;
        }
        if (exactDiff === null) {
          applyExecutorEvent(job.id, latest.version, { type: "REVIEW_BLOCKED", reason: "configuration" });
          return;
        }
        let documentation;
        try {
          documentation = documentationRequirement({
            diff: exactDiff,
            traits: latest.taskTraits.map((trait) => trait.id),
            reasonCodes: latest.taskReasonCodes,
          });
        } catch {
          applyExecutorEvent(job.id, latest.version, { type: "REVIEW_BLOCKED", reason: "configuration" });
          return;
        }
        applyExecutorEvent(job.id, latest.version, {
          type: "REVIEW_PASSED",
          headSha: invocation.expectedSha,
          documentation: {
            required: documentation.required,
            diffDigest: documentation.diffDigest,
            reasons: documentation.reasons,
          },
        });
      } else {
        applyExecutorEvent(job.id, latest.version, { type: "REVIEW_PASSED", headSha: invocation.expectedSha });
      }
    } else if (assessment.outcome === "changes_requested") {
      applyExecutorEvent(job.id, latest.version, {
        type: "REVIEW_CHANGES_REQUESTED",
        headSha: invocation.expectedSha,
        summary: assessment.summary ?? undefined,
        findings: assessment.findings as ReviewFinding[],
        reasons: assessment.reasons,
      });
    } else {
      applyExecutorEvent(job.id, latest.version, { type: "REVIEW_BLOCKED", reason: "configuration" });
    }
  };
  const effectRunnerFactory = (fence: EffectFence) => new EffectRunner({
    store,
    fence,
    now: clock,
    minimumModelPool: () => config.ok ? capabilityMinimumModelPool(config.value) : undefined,
    bb: bbEffectAdapter,
    terminal,
    mergeHandler,
    reconcileJob,
    resolvePrHead: async (job, _effect, signal) => {
      if (!job.environmentId || !job.prNumber || !job.policy) {
        return { event: "PR_HEAD_RESOLUTION_FAILED", reason: "PR head resolution requires an active environment" };
      }
      return resolvePrHead({
        runner: terminal,
        environments: bb.sdk.environments,
        environmentId: job.environmentId,
        prNumber: job.prNumber,
        githubRepository: job.policy.githubRepository,
        signal,
      });
    },
    runValidation: async (job, _effect, signal) => {
      if (!job.environmentId || job.prNumber === null || !job.policy) {
        throw new Error("Validation requires an active environment and pull request");
      }
      return runValidation({
        runner: terminal,
        environments: bb.sdk.environments,
        environmentId: job.environmentId,
        job: { id: job.id, version: job.version, policy: job.policy, prNumber: job.prNumber },
        signal,
        onTerminalObservation: (observation) => {
          if (signal.aborted || !store.isExecutorLeaseCurrent(fence.ownerId, fence.generation, clock())) return;
          const current = store.getJob(job.id);
          if (current) projectTerminalLiveness(store, current, observation, "validation", clock(), undefined, {
            ownerId: fence.ownerId,
            generation: fence.generation,
            now: clock(),
          });
        },
      });
    },
    runProductionStage: (job, _effect, phase, signal, onTerminalObservation) => {
      if (!job.environmentId || !job.policy || !job.mergeCommitSha) {
        throw new Error("Production stage requires an active environment, immutable policy, and merge commit");
      }
      return runProductionStage({
        runner: terminal,
        environmentId: job.environmentId,
        expectedHeadSha: job.mergeCommitSha,
        policy: job.policy,
        phase,
        signal,
        onTerminalObservation,
      });
    },
  });

  bb.background.service("telegram-ingress", {
    start: (signal) => runTelegramService({
      store,
      client: telegramForToken,
      ingress,
      getConfig: () => config,
      clock: { now: clock },
      onTokenVerified: (token) => {
        if (config.ok && config.value.botToken === token) verifiedBotToken = token;
      },
      warn: (message) => bb.log.warn(message),
    }, signal),
  });
  bb.background.service("capability-inventory", {
    start: (signal) => capabilityInventory.run(signal),
  });
  bb.background.service("job-executor", {
    start: (signal) => runJobExecutorService({
      store,
      effectRunnerFactory,
      scheduler,
      maxConcurrentJobs: () => config.ok ? config.value.maxConcurrentJobs : null,
      onWorkAvailable: () => executorNudge.notify(),
      clock: { now: clock },
      reconcileJob,
      getWorkerThread: (threadId) => bbRunner.getThread(threadId),
      telegramToken: () => config.ok ? config.value.botToken : undefined,
      getTelegramClient: () => {
        if (!config.ok) throw new Error(config.message);
        const client = new TelegramClient(config.value.botToken, fetch, { maxAttempts: 1 });
        return {
          sendMessage: (chatId: string, payload: Record<string, unknown>, signal: AbortSignal) =>
            client.sendMessage(chatId, payload as Parameters<TelegramClient["sendMessage"]>[1], signal),
          sendMessageDraft: (chatId: string, draftId: number, text: string, signal: AbortSignal) =>
            client.sendMessageDraft(chatId, draftId, text, signal),
          editMessage: (chatId: string, messageId: number, payload: Record<string, unknown>, signal: AbortSignal) =>
            client.editMessage(chatId, messageId, payload as Parameters<TelegramClient["editMessage"]>[2], signal),
          answerCallback: (callbackQueryId: string, text: string, signal: AbortSignal) =>
            client.answerCallback(callbackQueryId, text, signal),
        };
      },
      releaseOnShutdown: true,
      controller,
      operations: threadOperations,
      monitors,
      threadNotices,
      jobMemory,
      memoryCuration,
      productionHealth,
      regressionWatch,
      failureLoop,
      systemMonitors,
      presence,
      laneSnapshots,
      waitForWork: (milliseconds, signal) => executorNudge.wait(milliseconds, signal),
    }, signal),
  });

  const queueThreadReconcile = (threadId: string): void => {
    const jobQueued = store.enqueueReconcileForThread(threadId, clock());
    if (jobQueued || store.shouldWakeForThread(threadId)) executorNudge.notify();
  };
  const queueEnvironmentReconcile = (environmentId: string): void => {
    const jobQueued = store.enqueueReconcileForEnvironment(environmentId, clock());
    if (jobQueued || store.shouldWakeForEnvironment(environmentId)) executorNudge.notify();
  };
  bb.events.on("thread.created", ({ thread }) => queueThreadReconcile(thread.id));
  bb.events.on("thread.active", ({ thread }) => queueThreadReconcile(thread.id));
  bb.events.on("thread.idle", ({ thread }) => queueThreadReconcile(thread.id));
  bb.events.on("thread.failed", ({ thread }) => queueThreadReconcile(thread.id));
  bb.events.on("thread.archived", ({ thread }) => queueThreadReconcile(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => queueThreadReconcile(thread.id));
  // Older hosts do not expose SDK subscriptions. The event bus above remains
  // the baseline wake-up path, so optional SDK subscriptions should not make
  // plugin startup fail on those hosts.
  type SdkSubscribe = NonNullable<BbPluginApi["sdk"]["subscribe"]>;
  const sdkSubscribe = (
    subscription: Parameters<SdkSubscribe>[0],
  ): (() => void) | undefined => {
    if (typeof bb.sdk.subscribe !== "function") return undefined;
    try {
      return bb.sdk.subscribe(subscription);
    } catch (error) {
      // The SDK test host exposes an explicit throwing stub for capabilities it
      // does not implement. Treat that the same as an older host with no
      // subscription API, while preserving real subscription failures.
      if (error instanceof Error && /not stubbed/i.test(error.message)) return undefined;
      throw error;
    }
  };
  const unsubscribeThreadChanges = sdkSubscribe({
    event: "thread:changed",
    callback: (event) => {
      if (!event.id || !threadChangeShouldWake(event.changes)) return;
      // A question answered in BB leaves a live card on the owner's phone. That
      // is worth one unpaced sweep; ordinary ticks keep their 15-second pacing.
      if (threadInteractionsChanged(event.changes)) threadNotices.requestSweep();
      queueThreadReconcile(event.id);
    },
  });
  const unsubscribeEnvironmentChanges = sdkSubscribe({
    event: "environment:changed",
    callback: (event) => {
      if (!event.id || !environmentChangeShouldWake(event.changes)) return;
      queueEnvironmentReconcile(event.id);
    },
  });
  if (unsubscribeThreadChanges) bb.onDispose(unsubscribeThreadChanges);
  if (unsubscribeEnvironmentChanges) bb.onDispose(unsubscribeEnvironmentChanges);
}
