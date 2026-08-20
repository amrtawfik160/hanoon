import { createHash } from "node:crypto";
import { z } from "zod";
import { DEFAULT_MAX_CONCURRENT_JOBS, type MaxConcurrentJobs } from "./autonomy/models";
import { MAX_CONTROLLER_IDENTITY } from "./controller/instructions";
import type { CredentialBrokerConfigResult } from "./credentials/config";
import {
  EXTRACTION_MODELS,
  CONTROLLER_FALLBACK_MODELS,
  CONTROLLER_MODELS,
  CONTROLLER_PERMISSION_MODES,
  CONTROLLER_REASONING_LEVELS,
  CONTROLLER_SERVICE_TIERS,
  DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  controllerProviderFor,
  type ControllerExecutionProfile,
} from "./controller/execution-profile";
import {
  DEFAULT_MODEL_POOL_REGISTRY,
  selectModelRoute,
  type ModelPool,
  type ModelRoute,
} from "./capabilities/models";

const MAX_CONCURRENT_JOB_VALUES = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;
const maxConcurrentJobsSchema = z.preprocess(
  (value) => value === undefined ? String(DEFAULT_MAX_CONCURRENT_JOBS) : value,
  z.enum(MAX_CONCURRENT_JOB_VALUES).transform((value) => Number(value) as MaxConcurrentJobs),
);

const globalConfigSchema = z.object({
  botToken: z.string().min(1),
  bbAppBaseUrl: z.union([z.literal(""), z.string().url()]),
  maxConcurrentJobs: maxConcurrentJobsSchema,
  controllerModel: z.enum(CONTROLLER_MODELS).default(DEFAULT_CONTROLLER_EXECUTION_PROFILE.model),
  controllerFallbackModel1: z.enum(CONTROLLER_FALLBACK_MODELS).default("gpt-5.6-sol"),
  controllerFallbackModel2: z.enum(CONTROLLER_FALLBACK_MODELS).default("disabled"),
  controllerReasoningLevel: z.enum(CONTROLLER_REASONING_LEVELS)
    .default(DEFAULT_CONTROLLER_EXECUTION_PROFILE.reasoningLevel),
  controllerServiceTier: z.enum(CONTROLLER_SERVICE_TIERS)
    .default(DEFAULT_CONTROLLER_EXECUTION_PROFILE.serviceTier),
  // Unset resolves to the safer automatic mode. An explicitly saved value is
  // preserved for later turns and is never rewritten by parsing.
  controllerPermissionMode: z.enum(CONTROLLER_PERMISSION_MODES)
    .default(DEFAULT_CONTROLLER_EXECUTION_PROFILE.permissionMode),
  extractionModel: z.enum(EXTRACTION_MODELS).default("inherit"),
  // Empty means the shipped character. Bounded here as well as at composition
  // because a setting is the one input to the standing block that no paired
  // owner has to approve.
  controllerIdentity: z.string().max(MAX_CONTROLLER_IDENTITY).default(""),
  systemUpkeep: z.enum(["enabled", "disabled"]).default("enabled"),
  // Separate from systemUpkeep on purpose: reclaiming a temporary directory and
  // deleting a branch are not the same risk, so arming one must not arm the other.
  workspaceReclaim: z.preprocess(
    (value) => value === true || value === "true",
    z.boolean().default(false),
  ),
  selfDiagnosisEnabled: z.preprocess(
    (value) => value === true || value === "true",
    z.boolean().default(false),
  ),
  selfDiagnosisProjectId: z.string().trim().max(256).default(""),
  // What a diagnosis becomes. `draft-pr` pushes a branch nobody reviewed and
  // waits for a person; `pipeline` files the fix as ordinary work and lets the
  // gates decide. Meaningful only when self-diagnosis is on at all.
  selfDiagnosisMode: z.enum(["draft-pr", "pipeline"]).default("draft-pr"),
  capabilityJobGraph: z.enum(["adaptive", "legacy"]).default("adaptive"),
  controllerCapabilityMode: z.enum(["bundled", "all-tools"]).default("bundled"),
  capabilityModelRouting: z.enum(["adaptive", "strong-only"]).default("adaptive"),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type GlobalConfigResult =
  | { ok: true; value: GlobalConfig }
  | { ok: false; message: string };

export function parseGlobalConfig(values: {
  botToken?: string;
  bbAppBaseUrl: string;
  maxConcurrentJobs?: string;
  controllerModel?: string;
  controllerFallbackModel1?: string;
  controllerFallbackModel2?: string;
  controllerReasoningLevel?: string;
  controllerServiceTier?: string;
  controllerPermissionMode?: string;
  extractionModel?: string;
  controllerIdentity?: string;
  systemUpkeep?: string;
  workspaceReclaim?: boolean | string;
  selfDiagnosisEnabled?: boolean | string;
  selfDiagnosisProjectId?: string;
  selfDiagnosisMode?: string;
  capabilityJobGraph?: string;
  controllerCapabilityMode?: string;
  capabilityModelRouting?: string;
}): GlobalConfigResult {
  if (!values.botToken) {
    return {
      ok: false,
      message:
        "Set the Telegram bot token in Extensions → Plugins → Telegram Agent.",
    };
  }
  const parsed = globalConfigSchema.safeParse(values);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : {
        ok: false,
        message: "Fix the Telegram Agent URL or controller execution settings.",
      };
}

/** `inherit` leaves the model to the project default, which is the only safe
 *  answer when we cannot know which providers this installation has. */
export function extractionModel(config: GlobalConfig): string | null {
  return config.extractionModel === "inherit" ? null : config.extractionModel;
}

/** The agent's own daily and weekly upkeep. Owners who do not want unprompted
 *  messages can turn it off without losing anything they set themselves. */
export function systemUpkeepEnabled(config: GlobalConfig): boolean {
  return config.systemUpkeep === "enabled";
}

export function workspaceReclaimEnabled(config: GlobalConfig): boolean {
  return config.workspaceReclaim;
}

export function selfDiagnosisEnabled(config: GlobalConfig): boolean {
  return config.selfDiagnosisEnabled;
}

/**
 * A diagnosis is a guess about a failure, and the difference between the two
 * modes is who decides whether the guess was right. The draft pull request asks
 * a person; the pipeline asks the project's own gates. The default stays the
 * person, because the pipeline answer requires a project that has already said
 * how much work it will start unattended.
 */
export function selfDiagnosisMode(config: GlobalConfig): "draft-pr" | "pipeline" {
  return config.selfDiagnosisMode;
}

export function controllerExecutionProfile(config: GlobalConfig): ControllerExecutionProfile {
  if (config.capabilityModelRouting === "strong-only") {
    const strong = selectModelRoute({
      executionClass: "controller",
      recipe: "architectural",
      stage: "orchestration",
      risk: "high",
      minimumPool: "strong",
    }, DEFAULT_MODEL_POOL_REGISTRY);
    return {
      model: strong.modelId as ControllerExecutionProfile["model"],
      reasoningLevel: strong.reasoning as ControllerExecutionProfile["reasoningLevel"],
      serviceTier: strong.serviceTier,
      permissionMode: config.controllerPermissionMode,
    };
  }
  return {
    model: config.controllerModel,
    reasoningLevel: config.controllerReasoningLevel,
    serviceTier: config.controllerServiceTier,
    permissionMode: config.controllerPermissionMode,
  };
}

/** Ordered model attempts for one owner message. Fallbacks inherit the same
 * reasoning, service tier, and permission policy as the effective primary. */
export function controllerExecutionProfiles(config: GlobalConfig): readonly ControllerExecutionProfile[] {
  const primary = controllerExecutionProfile(config);
  if (config.capabilityModelRouting === "strong-only") return [primary];
  const profiles: ControllerExecutionProfile[] = [primary];
  const models = new Set<string>([primary.model]);
  for (const model of [config.controllerFallbackModel1, config.controllerFallbackModel2]) {
    if (model === "disabled" || models.has(model)) continue;
    models.add(model);
    profiles.push({ ...primary, model });
  }
  return profiles;
}

export function controllerCapabilityModelRoute(config: GlobalConfig): ModelRoute {
  if (config.capabilityModelRouting === "strong-only") {
    return selectModelRoute({
      executionClass: "controller",
      recipe: "architectural",
      stage: "orchestration",
      risk: "high",
      minimumPool: "strong",
    }, DEFAULT_MODEL_POOL_REGISTRY);
  }
  return Object.freeze({
    pool: "standard",
    providerId: controllerProviderFor(config.controllerModel),
    modelId: config.controllerModel,
    reasoning: config.controllerReasoningLevel,
    serviceTier: config.controllerServiceTier,
  });
}

export function backgroundCapabilityModelRoute(config: GlobalConfig): ModelRoute {
  if (config.capabilityModelRouting === "strong-only") {
    return selectModelRoute({
      executionClass: "background",
      recipe: "architectural",
      stage: "extraction",
      risk: "high",
      minimumPool: "strong",
    }, DEFAULT_MODEL_POOL_REGISTRY);
  }
  if (config.extractionModel === "inherit") {
    return selectModelRoute({
      executionClass: "background",
      recipe: "direct",
      stage: "extraction",
      risk: "low",
    }, DEFAULT_MODEL_POOL_REGISTRY);
  }
  return Object.freeze({
    pool: "fast",
    providerId: controllerProviderFor(config.extractionModel),
    modelId: config.extractionModel,
    reasoning: "low",
    serviceTier: "default",
  });
}

export function capabilityRoutingSettings(config: GlobalConfig): Readonly<{
  jobGraph: "adaptive" | "legacy";
  controllerTools: "bundled" | "all-tools";
  modelRouting: "adaptive" | "strong-only";
}> {
  return Object.freeze({
    jobGraph: config.capabilityJobGraph,
    controllerTools: config.controllerCapabilityMode,
    modelRouting: config.capabilityModelRouting,
  });
}

export function capabilityMinimumModelPool(config: GlobalConfig): ModelPool | undefined {
  return config.capabilityModelRouting === "strong-only" ? "strong" : undefined;
}

/**
 * A stable digest of an already-parsed `parseCredentialBrokerConfig` result,
 * used only to detect whether a settings change is credential-relevant. The
 * client private key feeds the hash (so rotating it is detected) but the hash
 * itself cannot be reversed to recover it, unlike comparing the raw config.
 */
export function credentialBrokerConfigFingerprint(result: CredentialBrokerConfigResult): string {
  if (result.state === "disabled") return "disabled";
  if (result.state === "invalid") return `invalid:${result.code}`;
  const { value } = result;
  const canonical = JSON.stringify([
    value.endpointOrigin,
    value.installationId,
    value.topologyReceiptDigest,
    value.topologyReceiptExpiresAt,
    value.clientCertificatePem,
    value.clientKeyPem,
    value.caCertificatePem,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
