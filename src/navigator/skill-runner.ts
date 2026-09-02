import type { NavigatorSkillAttempt } from "./models";

export type NavigatorSkillResource = Readonly<{
  kind: "bb_thread";
  id: string;
}>;

export interface NavigatorSkillRunner {
  run(
    attempt: NavigatorSkillAttempt,
    hooks: Readonly<{
      bindResource(resource: NavigatorSkillResource): Promise<void>;
    }>,
    signal: AbortSignal,
  ): Promise<Readonly<{
    resource: NavigatorSkillResource;
    observedExternalStateDigest: string;
    result: unknown;
  }>>;
}
