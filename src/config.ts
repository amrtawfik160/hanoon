import { z } from "zod";

const globalConfigSchema = z.object({
  botToken: z.string().min(1),
  bbAppBaseUrl: z.union([z.literal(""), z.string().url()]),
  pollTimeoutSeconds: z.coerce.number().int().min(5).max(50),
});

export type GlobalConfig = z.infer<typeof globalConfigSchema>;
export type GlobalConfigResult =
  | { ok: true; value: GlobalConfig }
  | { ok: false; message: string };

export function parseGlobalConfig(values: {
  botToken?: string;
  bbAppBaseUrl: string;
  pollTimeoutSeconds: string;
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
        message: "Fix the Telegram Agent URL or polling timeout setting.",
      };
}
