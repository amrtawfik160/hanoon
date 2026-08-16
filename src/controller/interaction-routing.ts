import type { ThreadApprovalDecision, ThreadInteraction } from "./questions";

/**
 * Who answers a block raised by a thread.
 *
 * A thread the controller started is the controller's to run end to end, so its
 * questions are the controller's to answer. Reaching the owner is the exception,
 * reserved for a decision the owner alone can make, and it stays narrow on
 * purpose: a menu that arrives at 1:50am for a design question the controller
 * could have answered is the failure this exists to prevent.
 */
export type InteractionAudience = "controller" | "owner";

export type OwnerReservedReason =
  /** Merging or promoting to production, which is the owner's one-use approval. */
  | "merge_or_deploy"
  /** Money, credentials, or a write to someone else's system. */
  | "irreversible_external_action"
  /** An approval not positively classified as bounded local work. */
  | "unclassified_approval";

export type ThreadInteractionRoute =
  | Readonly<{ audience: "controller"; decisions: readonly ThreadApprovalDecision[] }>
  | Readonly<{ audience: "owner"; reason: OwnerReservedReason | "thread_not_controller_owned" }>;

/**
 * Commands the owner alone may approve, by the rule already written into the
 * standing instructions: merge and production promotion go through the owner's
 * one-use approval, and installing an integration, changing a credential,
 * spending money, or an irreversible external write needs their decision first.
 *
 * The reserved patterns improve the reason shown for known cases. They are not
 * the safety boundary: an approval must also match the narrow local allowlist
 * below, and every unclassified approval fails closed to the owner.
 */
const MERGE_OR_DEPLOY = [
  /\bgh\s+pr\s+merge\b/iu,
  /\bgit\s+push\b[^\n]*\b(?:main|master|trunk|production|release)\b/iu,
  /\bvercel\b[^\n]*(?:--prod\b|\b(?:deploy|promote|rollback)\b)/iu,
  /\b(?:fly|heroku|render)\s+deploy\b/iu,
  /\bkubectl\s+(?:apply|rollout|delete)\b/iu,
  /\bterraform\s+(?:apply|destroy)\b/iu,
] as const;

const IRREVERSIBLE_EXTERNAL = [
  // Credentials.
  /\bgh\s+auth\b/iu,
  /\bop\s+(?:item|document|vault)\s+(?:create|edit|delete)\b/iu,
  /\baws\s+(?:configure|secretsmanager|iam)\b/iu,
  /\b(?:gcloud|az)\s+(?:auth|secrets)\b/iu,
  /\bdocker\s+login\b/iu,
  // Money.
  /\bstripe\b/iu,
  /\b(?:npm|pnpm)\s+publish\b/iu,
  /\byarn\s+(?:npm\s+)?publish\b/iu,
  /\b(?:cargo|gem|twine)\s+publish\b/iu,
  // Writes into someone else's system.
  /\bcurl\b[^\n]*(?:-X\s*|--request(?:=|\s+))(?:POST|PUT|PATCH|DELETE)\b/iu,
  /\bgh\s+api\b[^\n]*(?:-X\s*|--method(?:=|\s+))(?:POST|PUT|PATCH|DELETE)\b/iu,
  /\bgh\s+(?:release|repo)\s+(?:create|delete|edit)\b/iu,
] as const;

function ownerReservedCommand(summary: string): OwnerReservedReason | null {
  if (MERGE_OR_DEPLOY.some((pattern) => pattern.test(summary))) return "merge_or_deploy";
  if (IRREVERSIBLE_EXTERNAL.some((pattern) => pattern.test(summary))) return "irreversible_external_action";
  return null;
}

const SAFE_LOCAL_COMMAND = new RegExp(
  "^wants to run:\\s*`(?:npm test|npm run (?:test|check|build|typecheck|lint)|" +
    "pnpm (?:test|run (?:test|check|build|typecheck|lint))|" +
    "yarn (?:test|run (?:test|check|build|typecheck|lint)))`[.!]?$",
  "iu",
);
const LOCAL_FILE_WRITE = /^wants to (?:write|edit|create) files? under\s+([^\r\n`]+?)[.!]?$/iu;

function controllerSafeApproval(summary: string): boolean {
  if (SAFE_LOCAL_COMMAND.test(summary.trim())) return true;
  const match = LOCAL_FILE_WRITE.exec(summary.trim());
  if (!match) return false;
  const path = match[1].trim().replace(/[.!]$/u, "");
  if (path.length === 0 || path.length > 512 || path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path)) {
    return false;
  }
  return !path.split(/[\\/]+/u).includes("..");
}

/**
 * A session-wide grant removes the boundary for everything the thread does
 * afterwards, including work nobody has looked at yet. The controller may
 * unblock a thread but never hand it a standing allowance, so its answer is
 * narrowed to the one-shot decisions.
 */
function controllerDecisions(
  offered: readonly ThreadApprovalDecision[],
): readonly ThreadApprovalDecision[] {
  return offered.filter((decision) => decision !== "allow_for_session");
}

/**
 * Decides who answers one pending thread interaction.
 *
 * `threadOwnedByController` must come from durable provenance, not from a
 * guess: a thread the owner opened in BB is still theirs to answer, and routing
 * it away would silently take their own work off their phone.
 */
export function routeThreadInteraction(input: {
  threadOwnedByController: boolean;
  interaction: ThreadInteraction;
}): ThreadInteractionRoute {
  if (!input.threadOwnedByController) {
    return { audience: "owner", reason: "thread_not_controller_owned" };
  }
  const { interaction } = input;
  // Something the plugin cannot represent cannot be handed to the owner as a
  // menu either; it becomes "your thread is stuck", which is the controller's
  // problem to chase because the controller started the thread.
  if (interaction.kind === "unsupported") return { audience: "controller", decisions: [] };
  if (interaction.kind === "user_question") return { audience: "controller", decisions: [] };
  const reserved = ownerReservedCommand(interaction.summary);
  if (reserved !== null) return { audience: "owner", reason: reserved };
  if (!controllerSafeApproval(interaction.summary)) {
    return { audience: "owner", reason: "unclassified_approval" };
  }
  const decisions = controllerDecisions(interaction.decisions);
  // An approval offering nothing but a session-wide grant leaves the controller
  // no answer it is allowed to give, so the owner decides it rather than the
  // thread waiting on a decision that cannot be made.
  if (decisions.length === 0) {
    return { audience: "owner", reason: "irreversible_external_action" };
  }
  return { audience: "controller", decisions };
}
