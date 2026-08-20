import { parseCommandJson, shellSingleQuote, type CommandResult } from "./terminal-command";

/**
 * What GitHub itself enforces on the branch an unattended merge would land on.
 *
 * Everything else in this plugin that guards a merge is this plugin's own: the
 * review lenses, the validation receipts, the approval. A standing grant removes
 * the last human from that list, which leaves one boundary that is not ours to
 * weaken — the repository's own rules. So a project may only declare that it
 * merges unattended if the repository already refuses a merge that has not
 * passed something.
 *
 * The check is deliberately live and deliberately at `project enable` time. A
 * policy field asserting "this branch is protected" would be the operator's
 * word for a fact GitHub already knows, and asking GitHub during the merge
 * itself would add a network call to the one path that must stay fenced and
 * deterministic.
 *
 * Fail closed: a 404, an error, an unparseable answer, and a protection with no
 * required check all read the same — not enforced.
 */

/** One `gh` invocation, run wherever the caller can reach the repository. */
export type ProtectionProbe = (input: Readonly<{ name: string; command: string }>) => Promise<CommandResult>;

export type BranchProtectionVerdict =
  | Readonly<{
    outcome: "enforced";
    /** Which mechanism carried the required checks, for the operator's benefit. */
    source: "protection" | "ruleset";
    requiredChecks: number;
    /**
     * Whether the rules also bind repository administrators. The merge runs
     * under an owner-scoped token, so `false` means GitHub may let this exact
     * merge past the checks it just proved exist.
     */
    adminEnforced: boolean;
  }>
  | Readonly<{ outcome: "no_required_checks" }>
  | Readonly<{ outcome: "unavailable" }>;

/** Bounded: this is one operator-facing preflight, not a background poller. */
const PROBE_TIMEOUT_MS = 30_000;

function branchPath(repository: string, branch: string): string {
  return `repos/${repository}/branches/${encodeURIComponent(branch)}`;
}

function githubApi(path: string): string {
  return `gh api ${shellSingleQuote(path)} -H ${shellSingleQuote("Accept: application/vnd.github+json")}`;
}

async function readJson<T>(probe: ProtectionProbe, name: string, path: string): Promise<T | null> {
  let result: CommandResult;
  try {
    result = await probe({ name, command: githubApi(path) });
  } catch {
    return null;
  }
  if (result.outcome !== "exited" || result.exitCode !== 0) return null;
  try {
    return parseCommandJson<T>(result.output, name);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contextStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => typeof entry === "string"
      ? entry
      : isRecord(entry) && typeof entry.context === "string" ? entry.context : null)
    .filter((entry): entry is string => entry !== null && entry.length > 0);
}

/**
 * The required status checks a classic branch protection declares. `contexts`
 * is the older shape and `checks` the newer one; a repository can carry either,
 * so both are read and merged rather than one being preferred.
 */
export function parseBranchProtection(
  document: unknown,
): Readonly<{ requiredChecks: readonly string[]; adminEnforced: boolean }> | null {
  if (!isRecord(document)) return null;
  const required = document.required_status_checks;
  const checks = isRecord(required)
    ? new Set([...contextStrings(required.contexts), ...contextStrings(required.checks)])
    : new Set<string>();
  const enforceAdmins = document.enforce_admins;
  return {
    requiredChecks: [...checks],
    adminEnforced: isRecord(enforceAdmins) && enforceAdmins.enabled === true,
  };
}

/**
 * The required status checks the rulesets that apply to this branch declare.
 * GitHub returns only rules that are actively enforced on the branch, so a
 * ruleset in evaluate or disabled mode never appears here.
 */
export function parseBranchRules(
  document: unknown,
): Readonly<{ requiredChecks: readonly string[]; rulesetIds: readonly number[] }> | null {
  if (!Array.isArray(document)) return null;
  const checks = new Set<string>();
  const rulesetIds = new Set<number>();
  for (const rule of document) {
    if (!isRecord(rule) || rule.type !== "required_status_checks") continue;
    const parameters = rule.parameters;
    if (isRecord(parameters)) {
      for (const context of contextStrings(parameters.required_status_checks)) checks.add(context);
    }
    if (typeof rule.ruleset_id === "number" && Number.isSafeInteger(rule.ruleset_id)) {
      rulesetIds.add(rule.ruleset_id);
    }
  }
  return { requiredChecks: [...checks], rulesetIds: [...rulesetIds] };
}

/**
 * A ruleset binds administrators when nothing is allowed to bypass it. Any
 * bypass actor at all is reported as unenforced: the token this plugin merges
 * with is the owner's, and deciding it is not one of the listed actors would be
 * guessing about an account this code cannot see.
 */
export function parseRulesetBypass(document: unknown): boolean {
  if (!isRecord(document)) return false;
  if (document.enforcement !== "active") return false;
  return Array.isArray(document.bypass_actors) && document.bypass_actors.length === 0;
}

/**
 * Asks GitHub what it enforces on one branch. Classic branch protection is read
 * first because it is the older and more common shape; rulesets are read when
 * protection is absent or carries no required check, because a repository may
 * express the same requirement either way and refusing the newer one would
 * reject a correctly configured project.
 */
export async function inspectBranchProtection(input: Readonly<{
  probe: ProtectionProbe;
  repository: string;
  branch: string;
}>): Promise<BranchProtectionVerdict> {
  const protection = parseBranchProtection(
    await readJson(input.probe, "branch protection", `${branchPath(input.repository, input.branch)}/protection`),
  );
  if (protection !== null && protection.requiredChecks.length > 0) {
    return {
      outcome: "enforced",
      source: "protection",
      requiredChecks: protection.requiredChecks.length,
      adminEnforced: protection.adminEnforced,
    };
  }

  const rules = parseBranchRules(
    await readJson(input.probe, "branch rules", `repos/${input.repository}/rules/branches/${encodeURIComponent(input.branch)}`),
  );
  if (rules !== null && rules.requiredChecks.length > 0) {
    // Every ruleset governing this branch, not just the first: a branch can be
    // covered by several, and one of them allowing a bypass is enough for this
    // merge to go round the checks the others require.
    const bypassChecks = await Promise.all(rules.rulesetIds.map(async (rulesetId) =>
      parseRulesetBypass(
        await readJson(input.probe, "ruleset", `repos/${input.repository}/rulesets/${rulesetId}`),
      )));
    return {
      outcome: "enforced",
      source: "ruleset",
      requiredChecks: rules.requiredChecks.length,
      // No ruleset id at all is an answer this code cannot read, and an
      // unreadable ruleset already parses as not binding administrators.
      adminEnforced: bypassChecks.length > 0 && bypassChecks.every((bound) => bound),
    };
  }

  // Something answered, and what it said was "nothing is required here". That
  // is a different thing to tell the operator than "I could not look".
  if (protection !== null || rules !== null) return { outcome: "no_required_checks" };
  return { outcome: "unavailable" };
}

/** Runs the probe against a project source host through the terminal runner. */
export function terminalProtectionProbe(input: Readonly<{
  run: (command: Readonly<{
    scope: { kind: "host_path"; hostId: string; cwd: string | null };
    title: string;
    command: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }>) => Promise<CommandResult>;
  hostId: string;
  cwd: string;
  signal?: AbortSignal;
}>): ProtectionProbe {
  return ({ name, command }) => input.run({
    scope: { kind: "host_path", hostId: input.hostId, cwd: input.cwd },
    title: `Telegram Agent autonomy preflight: ${name}`,
    command,
    timeoutMs: PROBE_TIMEOUT_MS,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

/**
 * What the operator has to go and do. Kept beside the verdict so the enable
 * refusal and the doctor row cannot drift into describing different fixes for
 * the same finding, and deliberately free of anything GitHub said back: an API
 * error can carry a token, an internal hostname, or an account name.
 */
export function branchProtectionRemedy(input: Readonly<{
  verdict: BranchProtectionVerdict;
  repository: string;
  branch: string;
}>): string | null {
  const where = `${input.repository}@${input.branch}`;
  if (input.verdict.outcome === "no_required_checks") {
    return `Unattended merging requires at least one required status check on ${where}. ` +
      "Add one to its branch protection rule or ruleset, then enable the project again.";
  }
  if (input.verdict.outcome === "unavailable") {
    return `Unattended merging requires ${where} to have branch protection or a ruleset with ` +
      "at least one required status check, readable by the authenticated gh CLI. " +
      "Configure it, then enable the project again.";
  }
  if (!input.verdict.adminEnforced) {
    return `Admin enforcement is off for ${where}. This plugin merges with an owner-scoped token, ` +
      "which GitHub may exempt from the required checks it just proved exist.";
  }
  return null;
}
