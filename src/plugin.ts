import type { BbPluginApi } from "@bb/plugin-sdk";
import { parseGlobalConfig } from "./config";
import { openStore } from "./storage/store";

export async function createPlugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    botToken: { type: "string", label: "Telegram bot token", secret: true },
    bbAppBaseUrl: { type: "string", label: "BB app base URL", default: "" },
    pollTimeoutSeconds: {
      type: "string",
      label: "Telegram poll timeout in seconds",
      default: "30",
    },
  });
  const store = openStore(bb.storage);
  void store;
  const config = parseGlobalConfig(await settings.get());
  if (!config.ok) bb.status.needsConfiguration(config.message);
}
