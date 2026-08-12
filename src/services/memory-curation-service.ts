import { detectStandingInstruction } from "../controller/context";
import type { TelegramAgentStore } from "../storage/store";

/**
 * Memory that only ever grows becomes memory that is mostly wrong. Two forces
 * keep it honest, and neither needs a model: what the owner said next judges
 * what was recalled, and idle time ages out what was never useful.
 */
const SCORE_BATCH = 20;
// Curation is housekeeping; running it on every executor tick would rewrite
// every live memory row continuously for no benefit.
export const MEMORY_CURATION_INTERVAL_MS = 6 * 60 * 60_000;

export type MemoryCurationDependencies = {
  store: Pick<
    TelegramAgentStore,
    | "listUnscoredRecallTurns"
    | "getControllerTurnAfter"
    | "scoreRecalledMemories"
    | "curateMemories"
  >;
  clock: { now(): number };
};

/**
 * The owner's next message is the verdict on the last answer. A correction
 * means what was recalled misled the agent; anything else means it did not.
 */
export function recallOutcome(nextOwnerText: string | null): "reinforced" | "demoted" {
  if (nextOwnerText === null) return "reinforced";
  return detectStandingInstruction(nextOwnerText)?.kind === "correction" ? "demoted" : "reinforced";
}

export class MemoryCurationService {
  private lastCuratedAt = 0;

  public constructor(private readonly dependencies: MemoryCurationDependencies) {}

  public processDue(): boolean {
    const now = this.dependencies.clock.now();
    let worked = this.scorePending(now);
    if (now - this.lastCuratedAt >= MEMORY_CURATION_INTERVAL_MS) {
      this.lastCuratedAt = now;
      const { decayed, tombstoned } = this.dependencies.store.curateMemories({ now });
      worked = worked || decayed > 0 || tombstoned > 0;
    }
    return worked;
  }

  private scorePending(now: number): boolean {
    let scored = false;
    for (const turn of this.dependencies.store.listUnscoredRecallTurns(SCORE_BATCH)) {
      const next = this.dependencies.store.getControllerTurnAfter(turn.controllerKey, turn.ordinal);
      // Nothing said yet is not a verdict: the turn stays unscored until the
      // owner's reaction — or its absence over a later message — is known.
      if (!next) continue;
      const outcome = recallOutcome(next.inputText);
      if (this.dependencies.store.scoreRecalledMemories({ turnId: turn.turnId, outcome, now }) > 0) {
        scored = true;
      }
    }
    return scored;
  }
}
