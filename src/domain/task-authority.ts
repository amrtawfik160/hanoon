import { createHash } from "node:crypto";

export const TASK_OUTCOMES = ["artifact", "reviewed_change", "shipped_change"] as const;
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];

export const TASK_CONSTRAINTS = [
  "artifact_only",
  "pull_request_only",
  "no_merge",
  "no_deploy",
] as const;
export type TaskConstraint = (typeof TASK_CONSTRAINTS)[number];

export type TaskOutcomeDerivation = Readonly<{
  outcome: TaskOutcome;
  constraints: readonly TaskConstraint[];
  requestDigest: string;
  scopeDigest: string;
}>;

export type TaskAuthorityEffect =
  | "read"
  | "artifact_write"
  | "prototype_write"
  | "worktree_write"
  | "commit"
  | "pull_request"
  | "merge"
  | "deploy"
  | "rollback";

export function taskAuthorityAllows(outcome: TaskOutcome, effect: TaskAuthorityEffect): boolean {
  if (effect === "read" || effect === "artifact_write") return true;
  if (effect === "prototype_write") return outcome === "artifact";
  if (outcome === "artifact") return false;
  if (effect === "worktree_write" || effect === "commit" || effect === "pull_request") return true;
  return outcome === "shipped_change";
}

export function taskAuthorityAllowsEffect(
  authority: Readonly<{
    status: "active" | "revoked" | "suspended" | "superseded";
    outcome: TaskOutcome;
    constraints: readonly TaskConstraint[];
  }>,
  effect: TaskAuthorityEffect,
): boolean {
  if (authority.status !== "active") return false;
  if (effect === "merge" && authority.constraints.includes("no_merge")) return false;
  if ((effect === "deploy" || effect === "rollback") && authority.constraints.includes("no_deploy")) return false;
  if (authority.constraints.includes("artifact_only") && effect !== "read" && effect !== "artifact_write") return false;
  if (authority.constraints.includes("pull_request_only") && (effect === "merge" || effect === "deploy" || effect === "rollback")) return false;
  return taskAuthorityAllows(authority.outcome, effect);
}

const EXPLICIT_ARTIFACT_ONLY = /\b(?:artifact|research|diagnos(?:e|is)|analysis|review|design|map|spec(?:ification)?|tickets?)\s*only\b|\bnon[- ]release\b|\bno\s+(?:implementation|code|release)\b/u;
const ARTIFACT_LANGUAGE = /\b(?:research|investigate|diagnos(?:e|is)|analy[sz]e|analysis|map|spec(?:ification)?|design|review|tickets?|decision)\b/u;
const DIRECT_ARTIFACT_VERB = /^(?:please|can you|could you|i need you to|i want you to)\s+(?:research|investigate|diagnose|analy[sz]e|map|design|review)\b/u;
const RELEASE_ACTION = /\b(?:implement|fix|change|modify|update|add|remove|refactor|build|configure|migrate|ship|merge|deploy|publish|release|take\s+(?:it|this)\s+live)\b/u;
const DOCUMENTATION_CHANGE = /\b(?:write|create|draft)\s+(?:the\s+)?(?:documentation|docs?|readme)\b/u;
const PULL_REQUEST_ONLY = /\b(?:pr|pull\s+request)\s*[- ]only\b/u;
const PREPARE_PULL_REQUEST = /\b(?:prepare|open|update|publish|create)\s+(?:and\s+open\s+)?(?:an?\s+)?(?:the\s+)?(?:pr|pull\s+request)\b/u;
const SHIPPING_CONFIRMATION = /\b(?:ship|merge|land|deploy|release|take\s+(?:it|this)\s+live)\b/u;
const NO_MERGE = /\b(?:do\s+not|don'?t|don\s+t|dont|never|no)\s+(?:merge|land)\b/u;
const NO_DEPLOY = /\b(?:do\s+not|don'?t|don\s+t|dont|never|no)\s+deploy\b/u;

function normalizeRequest(text: string): string {
  if (typeof text !== "string" || text.trim().length === 0 || text.length > 8_000) {
    throw new TypeError("task must be a bounded non-empty string");
  }
  return text.trim().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/gu, " ").trim().toLowerCase();
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasReleaseIntent(text: string): boolean {
  return RELEASE_ACTION.test(text) || DOCUMENTATION_CHANGE.test(text);
}

function isArtifactRequest(text: string): boolean {
  if (EXPLICIT_ARTIFACT_ONLY.test(text) || DIRECT_ARTIFACT_VERB.test(text)) return true;
  return ARTIFACT_LANGUAGE.test(text) && !hasReleaseIntent(text);
}

function deriveConstraints(
  artifact: boolean,
  pullRequestOnly: boolean,
  noMerge: boolean,
  noDeploy: boolean,
): TaskConstraint[] {
  const constraints: TaskConstraint[] = [];
  if (artifact) constraints.push("artifact_only");
  if (pullRequestOnly) constraints.push("pull_request_only");
  if (noMerge) constraints.push("no_merge");
  if (noDeploy) constraints.push("no_deploy");
  return constraints;
}

export function deriveTaskOutcome(requestText: string): TaskOutcomeDerivation {
  const normalized = normalizeRequest(requestText);
  const artifact = isArtifactRequest(normalized);
  const noMerge = NO_MERGE.test(normalized);
  const noDeploy = NO_DEPLOY.test(normalized);
  const shippingConfirmed = SHIPPING_CONFIRMATION.test(normalized);
  const pullRequestOnly = !shippingConfirmed && (PULL_REQUEST_ONLY.test(normalized) || PREPARE_PULL_REQUEST.test(normalized));
  const constraints = deriveConstraints(artifact, pullRequestOnly, noMerge, noDeploy);
  const outcome: TaskOutcome = artifact
    ? "artifact"
    : pullRequestOnly || noMerge || noDeploy ? "reviewed_change" : "shipped_change";
  const requestDigest = digest(normalized);
  const scopeDigest = digest(JSON.stringify({ requestDigest, outcome, constraints }));
  return { outcome, constraints, requestDigest, scopeDigest };
}
