export const CONTROLLER_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
] as const;

export const CONTROLLER_REASONING_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const CONTROLLER_SERVICE_TIERS = ["fast", "default"] as const;
export const CONTROLLER_PERMISSION_MODES = ["auto", "accept-edits", "full"] as const;

export type ControllerExecutionProfile = {
  model: typeof CONTROLLER_MODELS[number];
  reasoningLevel: typeof CONTROLLER_REASONING_LEVELS[number];
  serviceTier: typeof CONTROLLER_SERVICE_TIERS[number];
  permissionMode: typeof CONTROLLER_PERMISSION_MODES[number];
};

export const DEFAULT_CONTROLLER_EXECUTION_PROFILE: ControllerExecutionProfile = {
  model: "gpt-5.6-luna",
  reasoningLevel: "max",
  serviceTier: "fast",
  permissionMode: "auto",
};
