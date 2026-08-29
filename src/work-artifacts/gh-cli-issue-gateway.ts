import { performance } from "node:perf_hooks";
import {
  TrackerConflictError,
  TrackerNotFoundError,
} from "./tracker";
import {
  type GitHubIssueGateway,
  type GitHubIssueRecord,
} from "./github-tracker";
import { assertBoundedString, normalizeSingleLine, sha256 } from "./models";

export type GhCliCommandInput = Readonly<{
  args: readonly string[];
  stdin?: string;
  maxCaptureBytes?: number;
  timeoutMs?: number;
}>;

export interface GhCliCommandRunner {
  run(input: GhCliCommandInput): Promise<Readonly<{ stdout: string }>>;
}

type GhRelatedIssue = Readonly<{
  number: number;
  repository?: Readonly<{ nameWithOwner: string }>;
  url?: string;
}>;

type GhIssueCore = Readonly<{
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  stateReason: string | null;
  assignees: readonly Readonly<{ login: string }>[];
  parent: GhRelatedIssue | null;
  blockedBy: GhConnection<GhRelatedIssue>;
  subIssues: GhConnection<GhRelatedIssue>;
  updatedAt: string;
}>;

type GhCommentPage = Readonly<{
  count: number;
  comments: readonly Readonly<{ id: number; body: string }>[];
}>;

type GhConnection<T> = Readonly<{
  nodes: readonly T[];
  totalCount: number;
}>;

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const CORE_ISSUE_FIELDS = [
  "number",
  "url",
  "title",
  "body",
  "state",
  "stateReason",
  "assignees",
  "parent",
  "blockedBy",
  "subIssues",
  "updatedAt",
].join(",");
const CORE_ISSUE_JQ = [
  "def related: {number,repository:(.repository | if . == null then null else {nameWithOwner} end),url};",
  "{number,url,title,body,state,stateReason,assignees:[.assignees[]|{login}],",
  "parent:(.parent | if . == null then null else related end),",
  "blockedBy:{nodes:[.blockedBy.nodes[]|related],totalCount:.blockedBy.totalCount},",
  "subIssues:{nodes:[.subIssues.nodes[]|related],totalCount:.subIssues.totalCount},updatedAt}",
].join("");
const MAX_BODY_CHARACTERS = 65_536;
const MAX_COMMENT_CHARACTERS = 65_536;
const MAX_TITLE_CHARACTERS = 512;
const MAX_URL_CHARACTERS = 2_048;
const MAX_REPOSITORY_CHARACTERS = 256;
const MAX_LOGIN_CHARACTERS = 256;
const MAX_ASSIGNEES = 64;
const MAX_RELATIONSHIPS = 100;
const COMMENT_PAGE_SIZE = 8;
const JSON_BYTES_PER_CHARACTER = 6;
const JSON_STRUCTURE_BYTES = 65_536;
const TERMINAL_ENVELOPE_BYTES = 4_096;
const CORE_CAPTURE_BYTES = JSON_BYTES_PER_CHARACTER * (
  MAX_BODY_CHARACTERS + MAX_TITLE_CHARACTERS + MAX_URL_CHARACTERS + 128 +
  MAX_ASSIGNEES * MAX_LOGIN_CHARACTERS +
  (1 + 2 * MAX_RELATIONSHIPS) * (MAX_REPOSITORY_CHARACTERS + MAX_URL_CHARACTERS)
) + JSON_STRUCTURE_BYTES + TERMINAL_ENVELOPE_BYTES;
const COMMENT_PAGE_CAPTURE_BYTES = JSON_BYTES_PER_CHARACTER * (
  COMMENT_PAGE_SIZE * MAX_COMMENT_CHARACTERS
) + JSON_STRUCTURE_BYTES + TERMINAL_ENVELOPE_BYTES;
const MAX_RECONCILIATION_CANDIDATES = 2;
export const GH_CLI_OPERATION_LIMITS = {
  maxPages: 20_000,
  maxItems: 100_000,
  maxBytes: 134_217_728,
  maxElapsedMs: 60_000,
} as const;

export type GhCliOperationLimits = Readonly<{
  maxPages: number;
  maxItems: number;
  maxBytes: number;
  maxElapsedMs: number;
}>;

class GhCliOperationBudget {
  private pages = 0;
  private items = 0;
  private bytes = 0;
  private readonly deadline: number;

  public constructor(
    private readonly limits: GhCliOperationLimits,
    private readonly now: () => number,
  ) {
    this.deadline = now() + limits.maxElapsedMs;
  }

  public reservePage(): number {
    const remaining = this.remainingMs();
    this.pages += 1;
    if (this.pages > this.limits.maxPages) {
      throw new Error("GitHub pagination page limit was exceeded");
    }
    return remaining;
  }

  public recordResponse(stdout: string): void {
    this.bytes += Buffer.byteLength(stdout, "utf8");
    if (this.bytes > this.limits.maxBytes) {
      throw new Error("GitHub pagination byte limit was exceeded");
    }
    this.remainingMs();
  }

  public recordItems(count: number): void {
    this.items += count;
    if (this.items > this.limits.maxItems) {
      throw new Error("GitHub pagination item limit was exceeded");
    }
  }

  private remainingMs(): number {
    const remaining = this.deadline - this.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      throw new Error("GitHub pagination operation deadline was exceeded");
    }
    return Math.ceil(remaining);
  }
}

type GhIssueDiscoveryPage = Readonly<{
  count: number;
  numbers: readonly number[];
  matches: readonly number[];
}>;

type GhIssueDiscoveryScan = Readonly<{
  pages: readonly GhIssueDiscoveryPage[];
  matches: readonly number[];
}>;

function parseJson<T>(stdout: string, subject: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`${subject} returned invalid JSON`);
  }
}

function boundedProviderString(providerValue: unknown, field: string, maximum: number): string {
  if (typeof providerValue !== "string" || providerValue.length > maximum) {
    throw new Error(`GitHub returned an invalid ${field}`);
  }
  return providerValue;
}

function providerRecord(providerValue: unknown, field: string): Record<string, unknown> {
  if (typeof providerValue !== "object" || providerValue === null) {
    throw new Error(`GitHub returned an invalid ${field}`);
  }
  return providerValue as Record<string, unknown>;
}

function positiveProviderInteger(providerValue: unknown, field: string): number {
  if (!Number.isSafeInteger(providerValue) || (providerValue as number) < 1) {
    throw new Error(`GitHub returned an invalid ${field}`);
  }
  return providerValue as number;
}

function relatedIssue(providerValue: unknown, field: string): GhRelatedIssue {
  const candidate = providerRecord(providerValue, field);
  const number = positiveProviderInteger(candidate.number, `${field} issue number`);
  let repository: GhRelatedIssue["repository"];
  if (candidate.repository !== undefined && candidate.repository !== null) {
    const repositoryFields = providerRecord(candidate.repository, `${field} repository`);
    repository = {
      nameWithOwner: boundedProviderString(
        repositoryFields.nameWithOwner,
        `${field} repository`,
        MAX_REPOSITORY_CHARACTERS,
      ),
    };
  }
  const url = candidate.url === undefined || candidate.url === null
    ? undefined
    : boundedProviderString(candidate.url, `${field} URL`, MAX_URL_CHARACTERS);
  return {
    number,
    ...(repository === undefined ? {} : { repository }),
    ...(url === undefined ? {} : { url }),
  };
}

function issueConnection(providerValue: unknown, field: string): GhConnection<GhRelatedIssue> {
  const candidate = providerRecord(providerValue, `${field} connection`);
  if (
    !Array.isArray(candidate.nodes) || candidate.nodes.length > MAX_RELATIONSHIPS ||
    !Number.isSafeInteger(candidate.totalCount) || (candidate.totalCount as number) < 0 ||
    candidate.totalCount !== candidate.nodes.length
  ) {
    throw new Error(`GitHub returned an incomplete ${field} connection`);
  }
  return {
    nodes: candidate.nodes.map((node) => relatedIssue(node, field)),
    totalCount: candidate.totalCount as number,
  };
}

function issueAssignees(providerValue: unknown): readonly Readonly<{ login: string }>[] {
  if (!Array.isArray(providerValue) || providerValue.length > MAX_ASSIGNEES) {
    throw new Error("GitHub returned invalid issue assignees");
  }
  return providerValue.map((assignee) => {
    const fields = providerRecord(assignee, "issue assignee");
    return {
      login: boundedProviderString(fields.login, "issue assignee", MAX_LOGIN_CHARACTERS),
    };
  });
}

function parseIssueCore(providerValue: unknown): GhIssueCore {
  const candidate = providerRecord(providerValue, "issue core data");
  const number = positiveProviderInteger(candidate.number, "issue number");
  const stateReason = candidate.stateReason === null
    ? null
    : boundedProviderString(candidate.stateReason, "issue state reason", 32);
  return {
    number,
    url: boundedProviderString(candidate.url, "issue URL", MAX_URL_CHARACTERS),
    title: boundedProviderString(candidate.title, "issue title", MAX_TITLE_CHARACTERS),
    body: boundedProviderString(candidate.body, "issue body", MAX_BODY_CHARACTERS),
    state: boundedProviderString(candidate.state, "issue state", 16),
    stateReason,
    assignees: issueAssignees(candidate.assignees),
    parent: candidate.parent === null ? null : relatedIssue(candidate.parent, "parent"),
    blockedBy: issueConnection(candidate.blockedBy, "blockedBy"),
    subIssues: issueConnection(candidate.subIssues, "subIssues"),
    updatedAt: boundedProviderString(candidate.updatedAt, "issue update time", 64),
  };
}

function issueComment(providerValue: unknown): Readonly<{ id: number; body: string }> {
  const fields = providerRecord(providerValue, "issue comment");
  return {
    id: positiveProviderInteger(fields.id, "issue comment id"),
    body: boundedProviderString(fields.body, "issue comment body", MAX_COMMENT_CHARACTERS),
  };
}

function parseCommentPage(providerValue: unknown): GhCommentPage {
  const candidate = providerRecord(providerValue, "issue comment page data");
  if (
    !Number.isSafeInteger(candidate.count) || (candidate.count as number) < 0 ||
    (candidate.count as number) > COMMENT_PAGE_SIZE || !Array.isArray(candidate.comments) ||
    candidate.comments.length !== candidate.count
  ) {
    throw new Error("GitHub returned a partial issue comment page");
  }
  return {
    count: candidate.count as number,
    comments: candidate.comments.map(issueComment),
  };
}

function qualifiedIssueId(repository: string, number: string | number): string {
  return `${repository}#${String(number)}`;
}

function canonicalRepository(repositoryValue: string): string {
  const repository = assertBoundedString(repositoryValue, "GitHub repository", 256);
  if (!REPOSITORY.test(repository)) {
    throw new TypeError("GitHub repository must use the owner/name form");
  }
  return repository.toLocaleLowerCase("en-US");
}

function issueNumber(value: string, repository: string): string {
  const externalId = assertBoundedString(value, "externalId", 320);
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/u.exec(externalId);
  if (!match || canonicalRepository(match[1]) !== repository) {
    throw new TypeError("GitHub issue externalId must match the configured repository");
  }
  return match[2];
}

function connectionNodes<T>(connection: GhConnection<T>, field: string): readonly T[] {
  if (
    !connection || !Array.isArray(connection.nodes) ||
    !Number.isSafeInteger(connection.totalCount) || connection.totalCount < 0 ||
    connection.totalCount !== connection.nodes.length
  ) {
    throw new Error(`GitHub returned an incomplete ${field} connection`);
  }
  return connection.nodes;
}

function relationshipRepository(value: GhRelatedIssue, field: string): string {
  const declared = value.repository?.nameWithOwner === undefined
    ? null
    : canonicalRepository(value.repository.nameWithOwner);
  let fromUrl: string | null = null;
  if (value.url !== undefined) {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)\/?$/iu.exec(value.url);
    if (!match || Number(match[2]) !== value.number) {
      throw new Error(`GitHub returned an invalid ${field} issue URL`);
    }
    fromUrl = canonicalRepository(match[1]);
  }
  if (declared === null && fromUrl === null) {
    throw new Error(`GitHub returned ${field} without repository identity`);
  }
  if (declared !== null && fromUrl !== null && declared !== fromUrl) {
    throw new Error(`GitHub returned conflicting ${field} repository identity`);
  }
  return declared ?? fromUrl as string;
}

function qualifiedRelationships(
  values: readonly GhRelatedIssue[],
  repository: string,
  field: string,
): readonly string[] {
  return values.map((value) => {
    if (!Number.isSafeInteger(value.number) || value.number < 1) {
      throw new Error(`GitHub returned an invalid ${field} issue number`);
    }
    const relatedRepository = relationshipRepository(value, field);
    if (relatedRepository !== repository) {
      throw new Error(`GitHub returned a cross-repository relationship in ${field}`);
    }
    return qualifiedIssueId(relatedRepository, value.number);
  });
}

function recordState(issue: GhIssueCore): Pick<GitHubIssueRecord, "state" | "stateReason"> {
  const state = issue.state.toUpperCase();
  const reason = issue.stateReason?.toUpperCase() ?? null;
  if (state === "OPEN") return { state: "open", stateReason: null };
  if (state !== "CLOSED") throw new Error(`GitHub returned an unknown issue state: ${issue.state}`);
  if (reason === "COMPLETED") {
    return { state: "closed", stateReason: "completed" };
  }
  if (reason === "NOT_PLANNED") return { state: "cancelled", stateReason: "not_planned" };
  throw new Error(`GitHub returned an unknown closed issue reason: ${issue.stateReason ?? "missing"}`);
}

function parseIssue(
  issue: GhIssueCore,
  comments: readonly Readonly<{ body: string }>[],
  repository: string,
): GitHubIssueRecord {
  if (!Number.isSafeInteger(issue.number) || issue.number < 1) {
    throw new Error("GitHub returned an invalid issue number");
  }
  const blockers = connectionNodes(issue.blockedBy, "blockedBy");
  const children = connectionNodes(issue.subIssues, "subIssues");
  const parentExternalId = issue.parent === null
    ? null
    : qualifiedRelationships([issue.parent], repository, "parent")[0];
  const blockerExternalIds = qualifiedRelationships(blockers, repository, "blockedBy");
  const childExternalIds = qualifiedRelationships(children, repository, "subIssues");
  const mutableIdentity = JSON.stringify({
    updatedAt: issue.updatedAt,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    stateReason: issue.stateReason,
    assignees: issue.assignees.map((assignee) => assignee.login).sort(),
    comments: comments.map((comment) => comment.body),
    parent: parentExternalId,
    blockedBy: [...blockerExternalIds].sort(),
    subIssues: childExternalIds,
  });
  return {
    externalId: qualifiedIssueId(repository, issue.number),
    url: issue.url,
    title: issue.title,
    body: issue.body,
    ...recordState(issue),
    assignees: issue.assignees.map((assignee) => assignee.login),
    comments: comments.map((comment) => comment.body),
    parentExternalId,
    blockerExternalIds,
    childExternalIds,
    revision: sha256(mutableIdentity),
  };
}

export class GhCliIssueGateway implements GitHubIssueGateway {
  private readonly repository: string;
  public readonly namespace: string;

  public constructor(
    repositoryValue: string,
    private readonly commands: GhCliCommandRunner,
    private readonly operationLimits: GhCliOperationLimits = GH_CLI_OPERATION_LIMITS,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.repository = canonicalRepository(repositoryValue);
    for (const [field, limit] of Object.entries(operationLimits)) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new TypeError(`GitHub ${field} must be a positive safe integer`);
      }
    }
    this.namespace = `github:${this.repository}`;
  }

  public async createIssue(input: Readonly<{ title: string; body: string }>): Promise<GitHubIssueRecord> {
    const title = normalizeSingleLine(input.title, "artifact title", 512);
    const body = assertBoundedString(input.body, "artifact body", 65_536);
    const result = await this.commands.run({
      args: ["gh", "issue", "create", "--repo", this.repository, "--title", title, "--body-file", "-"],
      stdin: body,
    });
    const match = /\/issues\/([1-9][0-9]*)\s*$/u.exec(result.stdout.trim());
    if (!match) throw new Error("gh issue create did not return an issue URL");
    return this.readIssue(qualifiedIssueId(this.repository, match[1]));
  }

  public async readIssue(externalIdValue: string): Promise<GitHubIssueRecord> {
    return this.readIssueWithinBudget(externalIdValue, this.newOperationBudget());
  }

  private async readIssueWithinBudget(
    externalIdValue: string,
    budget: GhCliOperationBudget,
  ): Promise<GitHubIssueRecord> {
    const externalId = assertBoundedString(externalIdValue, "externalId", 320);
    const number = issueNumber(externalId, this.repository);
    try {
      const initial = await this.readIssueCore(number, externalId, budget);
      const initialComments = await this.readIssueComments(number, externalId, budget);
      const middle = await this.readIssueCore(number, externalId, budget);
      const corroboratedComments = await this.readIssueComments(number, externalId, budget);
      const corroborated = await this.readIssueCore(number, externalId, budget);
      if (
        JSON.stringify(initial) !== JSON.stringify(middle) ||
        JSON.stringify(middle) !== JSON.stringify(corroborated) ||
        JSON.stringify(initialComments) !== JSON.stringify(corroboratedComments)
      ) {
        throw new TrackerConflictError(externalId);
      }
      return parseIssue(corroborated, corroboratedComments, this.repository);
    } catch (error) {
      if (error instanceof Error && /not found|could not resolve|no issue/iu.test(error.message)) {
        throw new TrackerNotFoundError(externalId);
      }
      throw error;
    }
  }

  private async readIssueCore(
    number: string,
    externalId: string,
    budget: GhCliOperationBudget,
  ): Promise<GhIssueCore> {
    const result = await this.runWithinBudget({
      args: [
        "gh", "issue", "view", number,
        "--repo", this.repository,
        "--json", CORE_ISSUE_FIELDS,
        "--jq", CORE_ISSUE_JQ,
      ],
      maxCaptureBytes: CORE_CAPTURE_BYTES,
    }, budget);
    const issue = parseIssueCore(parseJson<unknown>(result.stdout, `GitHub issue ${externalId} core`));
    budget.recordItems(1);
    return issue;
  }

  private async readIssueComments(
    number: string,
    externalId: string,
    budget: GhCliOperationBudget,
  ): Promise<readonly Readonly<{ id: number; body: string }>[]> {
    const comments: Array<Readonly<{ id: number; body: string }>> = [];
    let previousId = 0;
    for (let page = 1; ; page += 1) {
      const result = await this.runWithinBudget({
        args: [
          "gh", "api",
          `repos/${this.repository}/issues/${number}/comments?per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
          "--jq", "{count:length,comments:[.[] | {id:.id,body:.body}]}",
        ],
        maxCaptureBytes: COMMENT_PAGE_CAPTURE_BYTES,
      }, budget);
      const parsed = parseJson<unknown>(result.stdout, `GitHub issue ${externalId} comment page ${page}`);
      const commentPage = parseCommentPage(parsed);
      budget.recordItems(commentPage.count);
      for (const comment of commentPage.comments) {
        if (comment.id <= previousId) {
          throw new Error("GitHub issue comment pagination did not make progress");
        }
        previousId = comment.id;
        comments.push(comment);
      }
      if (commentPage.count < COMMENT_PAGE_SIZE) return comments;
    }
  }

  public async findIssuesByOperationMarker(markerValue: string): Promise<readonly GitHubIssueRecord[]> {
    const marker = assertBoundedString(markerValue, "operation marker", 128);
    const match = /^<!-- hanoon:operation:([0-9a-f]{64}):$/u.exec(marker);
    if (!match) throw new TypeError("operation marker is invalid");
    const budget = this.newOperationBudget();
    const [indexed, initialDirectScan] = await Promise.all([
      this.runWithinBudget({
        args: [
          "gh", "issue", "list",
          "--repo", this.repository,
          "--state", "all",
          "--search", `\"${match[1]}\" in:body,comments`,
          "--limit", "100",
          "--json", "number",
          "--jq", "[.[].number]",
        ],
      }, budget),
      this.captureDirectIssueScan(marker, budget),
    ]);
    const corroboratedDirectScan = await this.captureDirectIssueScan(marker, budget);
    if (JSON.stringify(initialDirectScan.pages) !== JSON.stringify(corroboratedDirectScan.pages)) {
      throw new Error("GitHub exhaustive issue pagination changed during reconciliation");
    }
    const directCandidates = corroboratedDirectScan.matches;
    const indexedCandidates = parseJson<unknown>(
      indexed.stdout,
      "GitHub indexed issue list",
    );
    for (const [label, candidates] of [
      ["indexed", indexedCandidates],
      ["exhaustive", directCandidates],
    ] as const) {
      if (
        !Array.isArray(candidates) ||
        candidates.some((number) => !Number.isSafeInteger(number) || number < 1)
      ) {
        throw new Error(`GitHub ${label} issue list returned invalid issue numbers`);
      }
    }
    const numbers = [...new Set([
      ...(indexedCandidates as number[]),
      ...(directCandidates as number[]),
    ])];
    budget.recordItems((indexedCandidates as number[]).length);
    const hydrated = await Promise.all(numbers.map((number) =>
      this.readIssueWithinBudget(qualifiedIssueId(this.repository, number), budget)));
    if (hydrated.some((issue) =>
      !issue.body.includes(marker) && !issue.comments.some((comment) => comment.includes(marker)))) {
      throw new Error("GitHub operation marker candidate changed during hydration");
    }
    return hydrated;
  }

  public async addSubIssue(
    parentExternalId: string,
    childExternalId: string,
    expectedChildRevision: string,
  ): Promise<GitHubIssueRecord> {
    const child = await this.assertRevision(childExternalId, expectedChildRevision);
    const parentNumber = issueNumber(parentExternalId, this.repository);
    if (child.parentExternalId !== null && child.parentExternalId !== parentExternalId) {
      throw new TrackerConflictError(child.externalId);
    }
    await this.commands.run({
      args: [
        "gh", "issue", "edit", parentNumber,
        "--repo", this.repository,
        "--add-sub-issue", issueNumber(child.externalId, this.repository),
      ],
    });
    return this.readIssue(child.externalId);
  }

  public addBlockedBy(
    externalId: string,
    expectedRevision: string,
    blockerExternalId: string,
  ): Promise<GitHubIssueRecord> {
    return this.mutateIssueEdge(externalId, expectedRevision, "--add-blocked-by", blockerExternalId);
  }

  public removeBlockedBy(
    externalId: string,
    expectedRevision: string,
    blockerExternalId: string,
  ): Promise<GitHubIssueRecord> {
    return this.mutateIssueEdge(externalId, expectedRevision, "--remove-blocked-by", blockerExternalId);
  }

  public addAssignee(
    externalId: string,
    expectedRevision: string,
    assigneeValue: string,
  ): Promise<GitHubIssueRecord> {
    return this.mutateAssignee(externalId, expectedRevision, assigneeValue, "POST");
  }

  public removeAssignee(
    externalId: string,
    expectedRevision: string,
    assigneeValue: string,
  ): Promise<GitHubIssueRecord> {
    return this.mutateAssignee(externalId, expectedRevision, assigneeValue, "DELETE");
  }

  public async addComment(
    externalId: string,
    expectedRevision: string,
    body: string,
  ): Promise<GitHubIssueRecord> {
    const current = await this.assertRevision(externalId, expectedRevision);
    await this.commands.run({
      args: [
        "gh", "issue", "comment", issueNumber(current.externalId, this.repository),
        "--repo", this.repository,
        "--body-file", "-",
      ],
      stdin: assertBoundedString(body, "issue comment", 65_536),
    });
    return this.readIssue(current.externalId);
  }

  public async closeIssue(
    externalId: string,
    expectedRevision: string,
    reason: "completed" | "not_planned",
  ): Promise<GitHubIssueRecord> {
    const current = await this.assertRevision(externalId, expectedRevision);
    await this.commands.run({
      args: [
        "gh", "issue", "close", issueNumber(current.externalId, this.repository),
        "--repo", this.repository,
        "--reason", reason === "completed" ? "completed" : "not planned",
      ],
    });
    return this.readIssue(current.externalId);
  }

  private async assertRevision(
    externalId: string,
    expectedRevisionValue: string,
  ): Promise<GitHubIssueRecord> {
    const current = await this.readIssue(externalId);
    const expectedRevision = assertBoundedString(expectedRevisionValue, "expectedRevision", 512);
    if (current.revision !== expectedRevision) throw new TrackerConflictError(current.externalId);
    return current;
  }

  private async mutateIssueEdge(
    externalId: string,
    expectedRevision: string,
    flag: "--add-blocked-by" | "--remove-blocked-by",
    relatedExternalId: string,
  ): Promise<GitHubIssueRecord> {
    const current = await this.assertRevision(externalId, expectedRevision);
    await this.commands.run({
      args: [
        "gh", "issue", "edit", issueNumber(current.externalId, this.repository),
        "--repo", this.repository,
        flag, issueNumber(relatedExternalId, this.repository),
      ],
    });
    return this.readIssue(current.externalId);
  }

  private async captureDirectIssueScan(
    marker: string,
    budget: GhCliOperationBudget,
  ): Promise<GhIssueDiscoveryScan> {
    const matches = new Set<number>();
    const seen = new Set<number>();
    const pages: GhIssueDiscoveryPage[] = [];
    let previousNumber = Number.POSITIVE_INFINITY;
    for (let page = 1; ; page += 1) {
      const result = await this.runWithinBudget({
        args: [
          "gh", "api",
          `repos/${this.repository}/issues?state=all&per_page=100&page=${page}`,
          "--jq",
          `{count:length,numbers:[.[].number],matches:[.[] | select((.body // \"\") | contains(${JSON.stringify(marker)})) | .number] | unique | .[:${MAX_RECONCILIATION_CANDIDATES}]}`,
        ],
      }, budget);
      const response = parseJson<unknown>(result.stdout, "GitHub exhaustive issue page");
      if (
        typeof response !== "object" || response === null ||
        !Number.isSafeInteger((response as GhIssueDiscoveryPage).count) ||
        (response as GhIssueDiscoveryPage).count < 0 ||
        (response as GhIssueDiscoveryPage).count > 100 ||
        !Array.isArray((response as GhIssueDiscoveryPage).numbers) ||
        (response as GhIssueDiscoveryPage).numbers.length !==
          (response as GhIssueDiscoveryPage).count ||
        (response as GhIssueDiscoveryPage).numbers.some((number) =>
          !Number.isSafeInteger(number) || number < 1) ||
        !Array.isArray((response as GhIssueDiscoveryPage).matches) ||
        (response as GhIssueDiscoveryPage).matches.length > MAX_RECONCILIATION_CANDIDATES ||
        (response as GhIssueDiscoveryPage).matches.some((number) =>
          !Number.isSafeInteger(number) || number < 1)
      ) throw new Error("GitHub exhaustive issue page returned invalid discovery data");
      const discovery = response as GhIssueDiscoveryPage;
      budget.recordItems(discovery.count);
      for (const number of discovery.numbers) {
        if (seen.has(number) || number >= previousNumber) {
          throw new Error("GitHub exhaustive issue pagination did not make progress");
        }
        seen.add(number);
        previousNumber = number;
      }
      if (
        new Set(discovery.matches).size !== discovery.matches.length ||
        discovery.matches.some((number) => !discovery.numbers.includes(number))
      ) {
        throw new Error("GitHub exhaustive issue page returned invalid discovery data");
      }
      pages.push(discovery);
      for (const number of discovery.matches) matches.add(number);
      if (discovery.count < 100) break;
    }
    return { pages, matches: [...matches] };
  }

  private newOperationBudget(): GhCliOperationBudget {
    return new GhCliOperationBudget(this.operationLimits, this.now);
  }

  private async runWithinBudget(
    input: GhCliCommandInput,
    budget: GhCliOperationBudget,
  ): Promise<Readonly<{ stdout: string }>> {
    const timeoutMs = budget.reservePage();
    const response = await this.commands.run({ ...input, timeoutMs });
    budget.recordResponse(response.stdout);
    return response;
  }

  private async mutateAssignee(
    externalId: string,
    expectedRevision: string,
    assigneeValue: string,
    method: "POST" | "DELETE",
  ): Promise<GitHubIssueRecord> {
    const current = await this.assertRevision(externalId, expectedRevision);
    const assignee = assertBoundedString(assigneeValue, "assignee");
    await this.commands.run({
      args: [
        "gh", "api", "--method", method,
        `repos/${this.repository}/issues/${issueNumber(current.externalId, this.repository)}/assignees`,
        "--input", "-", "--silent",
      ],
      stdin: JSON.stringify({ assignees: [assignee] }),
    });
    return this.readIssue(current.externalId);
  }
}
