export function resolvePluginRoot(moduleUrl: string): string;

export function verifySkillBundle(pluginRoot: string): Readonly<{
  bundleDigest: string;
  skillIds: readonly string[];
}>;
