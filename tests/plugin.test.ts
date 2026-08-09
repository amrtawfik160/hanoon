import { createFakePluginHost } from "@bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import plugin from "../server";

it("loads safely and requests the secret bot token", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "telegram-agent" });

  await plugin(bb);

  expect(harness.needsConfigurationMessages).toEqual([
    "Set the Telegram bot token in Extensions → Plugins → Telegram Agent.",
  ]);
});
