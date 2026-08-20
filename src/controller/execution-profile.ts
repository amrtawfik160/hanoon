import {
  compatiblePermissionMode,
  stageModelEntry,
} from "../domain/stage-execution";

export const CONTROLLER_MODELS = [
  "claude-opus-5[1m]",
  "claude-opus-4-8[1m]",
  "claude-sonnet-5",
  "claude-fable-5",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "cursor-grok-4.6-medium",
  "gpt-5.6-sol-medium",
  "claude-opus-5-thinking-medium",
  "claude-fable-5-thinking-medium",
  "composer-2.5",
  "grok-4.6",
  "grok-4.5",
] as const;

export const CONTROLLER_FALLBACK_MODELS = ["disabled", ...CONTROLLER_MODELS] as const;

// Background extraction should not run on the owner's conversational tier.
// `inherit` keeps the project default, because a model this installation's
// providers do not offer would fail every extraction.
export const EXTRACTION_MODELS = ["inherit", ...CONTROLLER_MODELS] as const;

export const CONTROLLER_REASONING_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const CONTROLLER_SERVICE_TIERS = ["fast", "default"] as const;
export const CONTROLLER_PERMISSION_MODES = ["auto", "accept-edits", "full"] as const;

export type ControllerModel = typeof CONTROLLER_MODELS[number];
export type ControllerFallbackModel = typeof CONTROLLER_FALLBACK_MODELS[number];

export type ControllerExecutionProfile = {
  model: ControllerModel;
  reasoningLevel: typeof CONTROLLER_REASONING_LEVELS[number];
  serviceTier: typeof CONTROLLER_SERVICE_TIERS[number];
  permissionMode: typeof CONTROLLER_PERMISSION_MODES[number];
};

export const CONTROLLER_PROVIDERS = ["claude-code", "codex", "acp-cursor", "acp-grok"] as const;
export type ControllerProvider = typeof CONTROLLER_PROVIDERS[number];

/** The provider that owns a model, so one setting picks both. */
export function controllerProviderFor(model: string): ControllerProvider {
  const providerId = stageModelEntry(model)?.providerId;
  if (providerId !== undefined && (CONTROLLER_PROVIDERS as readonly string[]).includes(providerId)) {
    return providerId as ControllerProvider;
  }
  throw new TypeError(`Unknown controller model "${model}"`);
}

export function supportsServiceTier(model: string): boolean {
  return stageModelEntry(model)?.supportsServiceTier === true;
}

export const DEFAULT_CONTROLLER_EXECUTION_PROFILE: ControllerExecutionProfile = {
  model: "claude-opus-5[1m]",
  reasoningLevel: "xhigh",
  serviceTier: "default",
  // Fresh or unset settings use BB's automatic mode; supported approvals can
  // reach Telegram while BB and the execution machine keep enforcing limits.
  permissionMode: "auto",
};

type ExecutionArguments = {
  providerId?: ControllerProvider;
  model: ControllerModel;
  reasoningLevel: ControllerExecutionProfile["reasoningLevel"];
  serviceTier?: ControllerExecutionProfile["serviceTier"];
  permissionMode: ControllerExecutionProfile["permissionMode"];
  executionInputSources: Record<string, "explicit">;
};

/**
 * The execution tuple for a spawn or send. Every field sent is declared
 * explicit, so BB never silently substitutes a project default.
 */
export function controllerExecutionArguments(
  profile: ControllerExecutionProfile,
  options: { includeProvider: boolean },
): ExecutionArguments {
  const providerId = controllerProviderFor(profile.model);
  const withTier = supportsServiceTier(profile.model);
  const permissionMode = compatiblePermissionMode(providerId, profile.permissionMode);
  return {
    ...(options.includeProvider ? { providerId } : {}),
    model: profile.model,
    reasoningLevel: profile.reasoningLevel,
    ...(withTier ? { serviceTier: profile.serviceTier } : {}),
    permissionMode,
    executionInputSources: {
      ...(options.includeProvider ? { providerId: "explicit" as const } : {}),
      model: "explicit",
      reasoningLevel: "explicit",
      ...(withTier ? { serviceTier: "explicit" as const } : {}),
      permissionMode: "explicit",
    },
  } as ExecutionArguments;
}
