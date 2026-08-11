import { z } from "zod";
import { DEFAULT_MAX_CONCURRENT_JOBS, type MaxConcurrentJobs } from "./autonomy/models";
import {
  CONTROLLER_MODELS,
  CONTROLLER_PERMISSION_MODES,
  CONTROLLER_REASONING_LEVELS,
  CONTROLLER_SERVICE_TIERS,
  DEFAULT_CONTROLLER_EXECUTION_PROFILE,
  type ControllerExecutionProfile,
} from "./controller/execution-profile";

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
  maxConcurrentJobs?: string;
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
        message: "Fix the Telegram Agent URL or controller execution settings.",
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
