import { z } from "zod";
import {
  CONTROLLER_MODELS,
  CONTROLLER_PERMISSION_MODES,
  CONTROLLER_REASONING_LEVELS,
  CONTROLLER_SERVICE_TIERS,
  DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  type ControllerExecutionProfile,
} from "./controller/execution-profile";

const globalConfigSchema = z.object({
  botToken: z.string().min(1),
  bbAppBaseUrl: z.union([z.literal(""), z.string().url()]),
  pollTimeoutSeconds: z.coerce.number().int().min(5).max(50),
  controllerModel: z.enum(CONTROLLER_MODELS).default(DEFAULT_CONTROLLER_EXECUTION_PROFILE.model),
  controllerReasoningLevel: z.enum(CONTROLLER_REASONING_LEVELS)
    .default(DEFAULT_CONTROLLER_EXECUTION_PROFILE.reasoningLevel),
  controllerServiceTier: z.enum(CONTROLLER_SERVICE_TIERS)
    .default(DEFAULT_CONTROLLER_EXECUTION_PROFILE.serviceTier),
  controllerPermissionMode: z.enum(CONTROLLER_PERMISSION_MODES)
    .default(DEFAULT_CONTROLLER_EXECUTION_PROFILE.permissionMode),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type GlobalConfigResult =
  | { ok: true; value: GlobalConfig }
  | { ok: false; message: string };

export function parseGlobalConfig(values: {
  botToken?: string;
  bbAppBaseUrl: string;
  pollTimeoutSeconds: string;
  controllerModel?: string;
  controllerReasoningLevel?: string;
  controllerServiceTier?: string;
  controllerPermissionMode?: string;
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
        message: "Fix the Telegram Agent URL, polling timeout, or controller execution settings.",
      };
}

export function controllerExecutionProfile(config: GlobalConfig): ControllerExecutionProfile {
  return {
    model: config.controllerModel,
    reasoningLevel: config.controllerReasoningLevel,
    serviceTier: config.controllerServiceTier,
    permissionMode: config.controllerPermissionMode,
  };
}
