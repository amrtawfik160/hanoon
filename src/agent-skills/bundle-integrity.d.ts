export function resolvePluginRoot(moduleUrl: string): string;

export function verifySkillBundle(pluginRoot: string): Readonly<{
  bundleDigest: string;
  admittedSkillIds: readonly string[];
  legacySkillIds: readonly string[];
  skillIds: readonly string[];
}>;
