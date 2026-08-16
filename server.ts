import type { BbPluginApi } from "@bb/plugin-sdk";
import { createPlugin } from "./src/plugin";
import { resolvePluginRoot, verifySkillBundle } from "./src/agent-skills/bundle-integrity.js";

export function activatePlugin(bb: BbPluginApi, pluginRoot: string): Promise<void> {
  verifySkillBundle(pluginRoot);
  return createPlugin(bb, pluginRoot);
}

export default function plugin(bb: BbPluginApi): Promise<void> {
  return activatePlugin(bb, resolvePluginRoot(import.meta.url));
}
