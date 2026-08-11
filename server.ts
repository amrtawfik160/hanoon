import type { BbPluginApi } from "@bb/plugin-sdk";
import { createPlugin } from "./src/plugin";

export default function plugin(bb: BbPluginApi): Promise<void> {
  return createPlugin(bb);
}
