export const CONTROLLER_MODELS = [
  "claude-opus-5[1m]",
  "claude-opus-4-8[1m]",
  "claude-sonnet-5",
  "claude-fable-5",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const;

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

export type ControllerExecutionProfile = {
  model: ControllerModel;
  reasoningLevel: typeof CONTROLLER_REASONING_LEVELS[number];
  serviceTier: typeof CONTROLLER_SERVICE_TIERS[number];
  permissionMode: typeof CONTROLLER_PERMISSION_MODES[number];
};

export const CONTROLLER_PROVIDERS = ["claude-code", "codex"] as const;
export type ControllerProvider = typeof CONTROLLER_PROVIDERS[number];

/** The provider that owns a model, so one setting picks both. */
export function controllerProviderFor(model: string): ControllerProvider {
  return model.startsWith("claude-") ? "claude-code" : "codex";
}

// Only Codex exposes a service tier. Sending one to Claude Code would be an
// execution input the provider cannot honour.
export function supportsServiceTier(model: string): boolean {
  return controllerProviderFor(model) === "codex";
}

export const DEFAULT_CONTROLLER_EXECUTION_PROFILE: ControllerExecutionProfile = {
  model: "claude-opus-5[1m]",
  reasoningLevel: "xhigh",
  serviceTier: "default",
  // The owner drives this agent from Telegram and does not watch the BB app, so
  // an approval prompt rendered there is a dead end rather than a safeguard.
  // Merges and production still gate on a one-use Telegram approval.
  permissionMode: "full",
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
  const withTier = supportsServiceTier(profile.model);
  return {
    ...(options.includeProvider ? { providerId: controllerProviderFor(profile.model) } : {}),
    model: profile.model,
    reasoningLevel: profile.reasoningLevel,
    ...(withTier ? { serviceTier: profile.serviceTier } : {}),
    permissionMode: profile.permissionMode,
    executionInputSources: {
      ...(options.includeProvider ? { providerId: "explicit" as const } : {}),
      model: "explicit",
      reasoningLevel: "explicit",
      ...(withTier ? { serviceTier: "explicit" as const } : {}),
      permissionMode: "explicit",
    },
  } as ExecutionArguments;
}
