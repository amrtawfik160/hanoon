import { describe, expect, it } from "vitest";
import {
  GhCliIssueGateway,
  type GhCliCommandInput,
  type GhCliCommandRunner,
} from "../src/work-artifacts/gh-cli-issue-gateway";
import { TerminalGhCliCommandRunner } from "../src/work-artifacts/gh-terminal-command-runner";
import { GitHubWorkTracker } from "../src/work-artifacts/github-tracker";
import { TrackerConflictError } from "../src/work-artifacts/tracker";

const PRODUCTION_CAPTURE_BYTES = 65_536;

function retainProductionTail(stdout: string, maximumBytes = PRODUCTION_CAPTURE_BYTES): string {
  const bytes = Buffer.from(stdout, "utf8");
  return bytes.length <= maximumBytes
    ? stdout
    : bytes.subarray(bytes.length - maximumBytes).toString("utf8");
}

type MutableIssue = {
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
  stateReason: string | null;
  assignees: Array<{ login: string }>;
  comments: Array<{ id: number; body: string }>;
  parent: { number: number; repository?: { nameWithOwner: string }; url: string } | null;
  blockedBy: {
    nodes: Array<{ number: number; repository?: { nameWithOwner: string }; url: string }>;
    totalCount: number;
  };
  subIssues: {
    nodes: Array<{ number: number; repository?: { nameWithOwner: string }; url: string }>;
    totalCount: number;
  };
  updatedAt: string;
};

class StatefulGhRunner implements GhCliCommandRunner {
  public readonly calls: GhCliCommandInput[] = [];
  public hideIndexedIssue = false;
  public hideRecentIssue = false;
  public putIssueOnSecondApiPage = false;
  public truncateListComments = false;
  public commentPageFault: "malformed" | "partial" | "non_progressing" | null = null;
  public editBeforeCoreCorroboration = false;
  private commentMutationBeforeSecondCore: "delete" | "insert" | "edit" | null = null;
  private deleteAfterFirstCommentPage = false;
  private bodyEditBeforeNextComment: string | null = null;
  private commentPageReads = 0;
  private coreReads = 0;
  private discoveryScans = 0;
  private removeMarkerAfterSecondDiscovery = false;
  private revision = 1;
  private readonly issue: MutableIssue = {
    number: 7,
    url: "https://github.com/acme/widgets/issues/7",
    title: "Tracked issue",
    body: "<!-- hanoon:artifact:eyJvcGVyYXRpb25JZCI6ImNyZWF0ZS03Iiwia2luZCI6ImltcGxlbWVudGF0aW9uX3RpY2tldCIsImFjY2VwdGFuY2VDcml0ZXJpYSI6W119 -->\n<!-- hanoon:operation:5da0c05e33f2ce125aa7fe06e40762e1399066287e711542bb072b3c153296af:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->\n# Goal",
    state: "OPEN",
    stateReason: null,
    assignees: [],
    comments: [],
    parent: null,
    blockedBy: {
      nodes: [{
        number: 8,
        repository: { nameWithOwner: "Acme/Widgets" },
        url: "https://github.com/acme/widgets/issues/8",
      }],
      totalCount: 1,
    },
    subIssues: {
      nodes: [{
        number: 10,
        repository: { nameWithOwner: "acme/widgets" },
        url: "https://github.com/acme/widgets/issues/10",
      }],
      totalCount: 1,
    },
    updatedAt: "2026-08-25T00:00:01Z",
  };

  public async run(input: GhCliCommandInput): Promise<Readonly<{ stdout: string }>> {
    this.calls.push(input);
    const args = input.args;
    if (args[1] === "issue" && args[2] === "view") {
      this.coreReads += 1;
      if (this.coreReads === 2 && this.commentMutationBeforeSecondCore !== null) {
        if (this.commentMutationBeforeSecondCore === "delete") {
          this.issue.comments.splice(4, 1);
        } else if (this.commentMutationBeforeSecondCore === "insert") {
          this.issue.comments.push({ id: this.nextCommentId(), body: "Inserted comment" });
        } else {
          const existing = this.issue.comments[4];
          if (!existing) throw new Error("comment edit fixture is missing its target");
          this.issue.comments[4] = { ...existing, body: "Edited comment" };
        }
        this.commentMutationBeforeSecondCore = null;
      }
      if (this.editBeforeCoreCorroboration && this.coreReads % 2 === 0) {
        this.issue.body = `${this.issue.body}\nConcurrent edit.`;
        this.editBeforeCoreCorroboration = false;
        this.bump();
      }
      const fields = new Set(args[args.indexOf("--json") + 1]?.split(",") ?? []);
      const { comments: _comments, ...core } = this.issue;
      return this.output(input, JSON.stringify(fields.has("comments") ? this.issue : core));
    }
    if (args[1] === "issue" && args[2] === "list") {
      if (this.hideIndexedIssue && args.includes("--search")) return this.output(input, "[]");
      if (this.hideRecentIssue && !args.includes("--search")) return this.output(input, "[]");
      const search = args[args.indexOf("--search") + 1] ?? "";
      const operationHash = /[0-9a-f]{64}/u.exec(search)?.[0];
      const matchesSearch = operationHash === undefined ||
        this.issue.body.includes(operationHash) ||
        this.issue.comments.some((comment) => comment.body.includes(operationHash));
      return this.output(input, JSON.stringify(matchesSearch ? [this.issue.number] : []));
    }
    if (args[1] === "api" && args.some((arg) => arg.includes("?state=all"))) {
      const endpoint = args.find((arg) => arg.includes("?state=all")) ?? "";
      const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
      if (this.putIssueOnSecondApiPage && page === 1) {
        const numbers = Array.from({ length: 100 }, (_, index) => 107 - index);
        return this.output(input, JSON.stringify({ count: 100, numbers, matches: [] }));
      }
      const operationHash = /[0-9a-f]{64}/u.exec(args.join(" "))?.[0];
      const matches = this.removeMarkerAfterSecondDiscovery ||
        operationHash !== undefined && this.issue.body.includes(operationHash)
        ? [this.issue.number]
        : [];
      const output = this.output(input, JSON.stringify({
        count: 1,
        numbers: [this.issue.number],
        matches,
      }));
      if (page === 1) {
        this.discoveryScans += 1;
        if (this.discoveryScans === 2 && this.removeMarkerAfterSecondDiscovery) {
          this.issue.body = this.issue.body.replace(
            /\n?<!-- hanoon:operation:[0-9a-f]{64}:[0-9a-f]{64} -->/u,
            "",
          );
          this.removeMarkerAfterSecondDiscovery = false;
          this.bump();
        }
      }
      return output;
    }
    if (args[1] === "api" && args.some((arg) => arg.includes("/comments?"))) {
      this.commentPageReads += 1;
      const endpoint = args.find((arg) => arg.includes("/comments?")) ?? "";
      const parameters = new URLSearchParams(endpoint.split("?")[1]);
      const page = Number(parameters.get("page"));
      const perPage = Number(parameters.get("per_page"));
      const start = (page - 1) * perPage;
      if (this.commentPageFault === "malformed" && page === 1) {
        return this.output(input, "{");
      }
      const comments = this.issue.comments.slice(start, start + perPage)
        .map((comment, offset) => ({
          id: this.commentPageFault === "non_progressing" && page === 2
            ? offset + 1
            : comment.id,
          body: comment.body,
        }));
      if (this.deleteAfterFirstCommentPage && this.commentPageReads === 1 && page === 1) {
        this.issue.comments.shift();
        this.deleteAfterFirstCommentPage = false;
      }
      if (this.commentPageFault === "partial" && page === 1) {
        return this.output(input, JSON.stringify({ count: comments.length + 1, comments }));
      }
      return this.output(input, JSON.stringify({ count: comments.length, comments }));
    }
    if (args[1] === "api" && args.some((arg) => arg.endsWith("/assignees"))) {
      const payload = JSON.parse(input.stdin ?? "null") as { assignees?: unknown };
      if (!Array.isArray(payload.assignees) || payload.assignees.some((login) => typeof login !== "string")) {
        throw new Error("assignee mutation body was invalid");
      }
      if (args[args.indexOf("--method") + 1] === "DELETE") {
        const removed = new Set(payload.assignees);
        this.issue.assignees = this.issue.assignees.filter(({ login }) => !removed.has(login));
      } else {
        for (const login of payload.assignees) {
          if (!this.issue.assignees.some((assignee) => assignee.login === login)) {
            this.issue.assignees.push({ login });
          }
        }
      }
      this.bump();
      return this.output(input, "");
    }
    if (args[1] === "issue" && args[2] === "create") {
      if (input.stdin === undefined) throw new Error("create body was not supplied on stdin");
      this.issue.title = args[args.indexOf("--title") + 1];
      this.issue.body = input.stdin;
      this.bump();
      return this.output(input, this.issue.url);
    }
    if (args[1] === "issue" && args[2] === "edit") {
      const bodyFileIndex = args.indexOf("--body-file");
      if (bodyFileIndex >= 0) {
        if (args[bodyFileIndex + 1] !== "-" || input.stdin === undefined) {
          throw new Error("edit body was not supplied on stdin");
        }
        this.issue.body = input.stdin;
      }
      const subIssueIndex = args.indexOf("--add-sub-issue");
      if (subIssueIndex >= 0) {
        const number = Number(args[3]);
        this.issue.parent = {
          number,
          repository: { nameWithOwner: "acme/widgets" },
          url: `https://github.com/acme/widgets/issues/${number}`,
        };
      }
      const removeBlockerIndex = args.indexOf("--remove-blocked-by");
      if (removeBlockerIndex >= 0) {
        const removed = new Set(args[removeBlockerIndex + 1].split(",").map(Number));
        this.issue.blockedBy.nodes = this.issue.blockedBy.nodes
          .filter((blocker) => !removed.has(blocker.number));
        this.issue.blockedBy.totalCount = this.issue.blockedBy.nodes.length;
      }
      const addBlockerIndex = args.indexOf("--add-blocked-by");
      if (addBlockerIndex >= 0) {
        for (const number of args[addBlockerIndex + 1].split(",").map(Number)) {
          if (!this.issue.blockedBy.nodes.some((blocker) => blocker.number === number)) {
            this.issue.blockedBy.nodes.push({
              number,
              repository: { nameWithOwner: "acme/widgets" },
              url: `https://github.com/acme/widgets/issues/${number}`,
            });
          }
        }
        this.issue.blockedBy.totalCount = this.issue.blockedBy.nodes.length;
      }
      this.bump();
      return this.output(input, "");
    }
    if (args[1] === "issue" && args[2] === "comment") {
      if (input.stdin === undefined) throw new Error("comment body was not supplied on stdin");
      if (this.bodyEditBeforeNextComment !== null) {
        this.issue.body = `${this.issue.body}\n\n${this.bodyEditBeforeNextComment}`;
        this.bodyEditBeforeNextComment = null;
        this.bump();
      }
      this.issue.comments.push({ id: this.nextCommentId(), body: input.stdin });
      this.bump();
      return this.output(input, "");
    }
    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  }

  private output(input: GhCliCommandInput, stdout: string): Readonly<{ stdout: string }> {
    return { stdout: retainProductionTail(stdout, input.maxCaptureBytes) };
  }

  private bump(): void {
    this.revision += 1;
    this.issue.updatedAt = `2026-08-25T00:00:${String(this.revision).padStart(2, "0")}Z`;
  }

  public omitOneBlockedByNode(): void {
    this.issue.blockedBy.totalCount += 1;
  }

  public removeOperationMarkerAfterDiscovery(): void {
    this.removeMarkerAfterSecondDiscovery = true;
  }

  public injectBodyEditBeforeNextComment(content: string): void {
    this.bodyEditBeforeNextComment = content;
  }

  public seedComments(count: number): void {
    this.issue.comments = Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      body: `Comment ${index + 1}`,
    }));
    this.bump();
  }

  public seedBody(body: string): void {
    this.issue.body = body;
    this.bump();
  }

  public seedCommentBodies(comments: readonly string[]): void {
    this.issue.comments = comments.map((body, index) => ({ id: index + 1, body }));
    this.bump();
  }

  public mutateCommentsBeforeSecondCore(mutation: "delete" | "insert" | "edit"): void {
    this.commentMutationBeforeSecondCore = mutation;
  }

  public shiftCommentsAfterFirstPage(): void {
    this.deleteAfterFirstCommentPage = true;
  }

  private nextCommentId(): number {
    return Math.max(0, ...this.issue.comments.map((comment) => comment.id)) + 1;
  }

  public combinedHydrationBytes(): number {
    return Buffer.byteLength(JSON.stringify(this.issue), "utf8");
  }

  public coreHydrationBytes(): number {
    const { comments: _comments, ...core } = this.issue;
    return Buffer.byteLength(JSON.stringify(core), "utf8");
  }

  public setRelationshipRepository(
    relationship: "parent" | "blockedBy" | "subIssues",
    repository: string,
  ): void {
    if (relationship === "parent") {
      this.issue.parent = {
        number: 6,
        repository: { nameWithOwner: repository },
        url: `https://github.com/${repository}/issues/6`,
      };
      return;
    }
    this.issue[relationship].nodes[0].repository = { nameWithOwner: repository };
    this.issue[relationship].nodes[0].url =
      `https://github.com/${repository}/issues/${this.issue[relationship].nodes[0].number}`;
  }

  public omitRelationshipRepository(relationship: "blockedBy" | "subIssues"): void {
    delete this.issue[relationship].nodes[0].repository;
  }
}

class ProductionCappedDiscoveryRunner implements GhCliCommandRunner {
  public readonly sourceBytes: number;
  private readonly delegate = new StatefulGhRunner();
  private readonly rawResponse: string;

  public constructor() {
    const filler = Array.from({ length: 900 }, (_, index) => ({
      number: index + 100,
      body: `Unrelated issue ${index} ${"x".repeat(128)}`,
    }));
    this.rawResponse = JSON.stringify([[{
      number: 7,
      body: "<!-- hanoon:operation:5da0c05e33f2ce125aa7fe06e40762e1399066287e711542bb072b3c153296af:",
    }, ...filler]]);
    this.sourceBytes = Buffer.byteLength(this.rawResponse, "utf8");
  }

  public run(input: GhCliCommandInput): Promise<Readonly<{ stdout: string }>> {
    if (input.args[1] === "api" && input.args.some((arg) => arg.includes("?state=all"))) {
      const endpoint = input.args.find((arg) => arg.includes("?state=all")) ?? "";
      const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
      const stdout = input.args.includes("--jq")
        ? JSON.stringify(page === 1
          ? {
              count: 100,
              numbers: Array.from({ length: 100 }, (_, index) => 106 - index),
              matches: [7],
            }
          : { count: 0, numbers: [], matches: [] })
        : this.rawResponse;
      return Promise.resolve({ stdout: stdout.slice(-65_536) });
    }
    return this.delegate.run(input);
  }
}

class AdvancingPaginationRunner extends StatefulGhRunner {
  public now = 0;
  public advanceMs = 0;

  public constructor(
    private readonly fullCommentPages: number,
    private readonly fullDiscoveryPages: number,
    private readonly commentBody = "advancing comment",
  ) {
    super();
  }

  public override async run(input: GhCliCommandInput): Promise<Readonly<{ stdout: string }>> {
    const endpoint = input.args.find((argument) => argument.includes("?"));
    let response: Readonly<{ stdout: string }>;
    if (endpoint?.includes("/comments?")) {
      this.calls.push(input);
      const parameters = new URLSearchParams(endpoint.split("?")[1]);
      const page = Number(parameters.get("page"));
      const perPage = Number(parameters.get("per_page"));
      const comments = page <= this.fullCommentPages
        ? Array.from({ length: perPage }, (_, offset) => ({
            id: (page - 1) * perPage + offset + 1,
            body: this.commentBody,
          }))
        : [];
      response = { stdout: JSON.stringify({ count: comments.length, comments }) };
    } else if (endpoint?.includes("?state=all")) {
      this.calls.push(input);
      const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
      const count = page <= this.fullDiscoveryPages ? 100 : 0;
      response = {
        stdout: JSON.stringify({
          count,
          numbers: Array.from({ length: count }, (_, offset) =>
            100_000 - (page - 1) * 100 - offset),
          matches: [],
        }),
      };
    } else {
      response = await super.run(input);
    }
    this.now += this.advanceMs;
    return response;
  }
}

class ChangingIssueDiscoveryRunner extends StatefulGhRunner {
  private scan = 0;

  public constructor(
    private readonly mutation: "order" | "boundary" | "count" | "high-water" | "deletion-shift",
  ) {
    super();
    this.hideIndexedIssue = true;
  }

  public override async run(input: GhCliCommandInput): Promise<Readonly<{ stdout: string }>> {
    if (input.args[1] === "issue" && input.args[2] === "list") {
      this.calls.push(input);
      return { stdout: "[]" };
    }
    const endpoint = input.args.find((argument) => argument.includes("?state=all"));
    if (!endpoint) return super.run(input);
    this.calls.push(input);
    const page = Number(new URLSearchParams(endpoint.split("?")[1]).get("page"));
    if (page === 1) this.scan += 1;
    let numbers = page === 1
      ? Array.from({ length: 100 }, (_, index) => 200 - index)
      : Array.from({ length: 99 }, (_, index) => 100 - index);
    if (this.mutation === "deletion-shift" && this.scan === 1 && page === 2) {
      numbers = Array.from({ length: 99 }, (_, index) => 99 - index);
    }
    if (this.scan === 2) {
      if (this.mutation === "order" && page === 1) {
        [numbers[0], numbers[1]] = [numbers[1] as number, numbers[0] as number];
      } else if (this.mutation === "boundary") {
        numbers = page === 1
          ? Array.from({ length: 100 }, (_, index) => 201 - index)
          : Array.from({ length: 99 }, (_, index) => 101 - index);
      } else if (this.mutation === "count" && page === 2) {
        numbers = numbers.slice(0, -1);
      } else if (this.mutation === "high-water" && page === 1) {
        numbers = [201, ...numbers.slice(1)];
      } else if (this.mutation === "deletion-shift") {
        numbers = page === 1
          ? Array.from({ length: 100 }, (_, index) => 199 - index)
          : Array.from({ length: 99 }, (_, index) => 99 - index);
      }
    }
    const matches = this.mutation === "deletion-shift" && this.scan === 2 && page === 1
      ? [100]
      : [];
    return {
      stdout: retainProductionTail(JSON.stringify({
        count: numbers.length,
        numbers,
        matches,
      }), input.maxCaptureBytes),
    };
  }
}

function operationLimits(overrides: Partial<Readonly<{
  maxPages: number;
  maxItems: number;
  maxBytes: number;
  maxElapsedMs: number;
}>> = {}) {
  return {
    maxPages: 100,
    maxItems: 10_000,
    maxBytes: 10_000_000,
    maxElapsedMs: 10_000,
    ...overrides,
  };
}

describe("GhCliIssueGateway", () => {
  it("reads current native hierarchy, dependencies, and mutable revision", async () => {
    const runner = new StatefulGhRunner();
    const gateway = new GhCliIssueGateway("acme/widgets", runner);

    const issue = await gateway.readIssue("acme/widgets#7");

    expect(issue).toMatchObject({
      externalId: "acme/widgets#7",
      parentExternalId: null,
      blockerExternalIds: ["acme/widgets#8"],
      childExternalIds: ["acme/widgets#10"],
      state: "open",
    });
    expect(issue.revision).toMatch(/^[0-9a-f]{64}$/u);
    expect(runner.calls[0].args.at(-1)).toContain("blockedBy");
    expect(runner.calls[0].args.at(-1)).toContain("subIssues");
  });

  it("streams issue comments through body-file stdin and refuses a stale revision", async () => {
    const runner = new StatefulGhRunner();
    const gateway = new GhCliIssueGateway("acme/widgets", runner);
    const initial = await gateway.readIssue("acme/widgets#7");
    const comment = "Focused verification passed.";
    await gateway.addComment("acme/widgets#7", initial.revision, comment);
    await expect(gateway.addComment("acme/widgets#7", initial.revision, "Stale comment."))
      .rejects.toThrow(TrackerConflictError);

    const writes = runner.calls.filter((call) => call.args[2] === "comment");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.args).toEqual(expect.arrayContaining(["--body-file", "-"]));
    expect(writes[0]?.stdin).toBe(comment);
    expect(writes.flatMap((call) => call.args)).not.toContain(comment);
  });

  it("preserves a body edit injected between observation and an owned-section mutation", async () => {
    const runner = new StatefulGhRunner();
    const gateway = new GhCliIssueGateway("acme/widgets", runner);
    const tracker = new GitHubWorkTracker(gateway);
    const created = await tracker.create({
      operationId: "gateway-race-create",
      kind: "implementation_ticket",
      title: "Concurrent body edit",
      body: "# Goal\n\nPreserve human content.",
      acceptanceCriteria: [],
    });
    runner.injectBodyEditBeforeNextComment("Human-managed note added concurrently.");

    const updated = await tracker.updateOwnedSection({
      externalId: created.externalId,
      sectionId: "implementation-notes",
      content: "Tracker-owned note.",
      operationId: "gateway-race-update",
      expectedRevision: created.revision,
    });

    expect(updated.body).toContain("Human-managed note added concurrently.");
    expect(updated.body).toContain("Tracker-owned note.");
    expect(runner.calls.some((call) =>
      call.args[1] === "issue" && call.args[2] === "edit" && call.args.includes("--body-file")))
      .toBe(false);
  });

  it("does not expose unconditional overwrite operations", () => {
    const gateway = new GhCliIssueGateway("acme/widgets", new StatefulGhRunner());

    expect(gateway).not.toHaveProperty("updateBody");
    expect(gateway).not.toHaveProperty("setParent");
    expect(gateway).not.toHaveProperty("replaceBlockers");
    expect(gateway).not.toHaveProperty("setAssignees");
  });

  it("uses targeted native edge and assignee mutations", async () => {
    const runner = new StatefulGhRunner();
    const gateway = new GhCliIssueGateway("acme/widgets", runner);
    let issue = await gateway.readIssue("acme/widgets#7");

    issue = await gateway.addSubIssue("acme/widgets#6", issue.externalId, issue.revision);
    expect(issue.parentExternalId).toBe("acme/widgets#6");
    issue = await gateway.addBlockedBy(issue.externalId, issue.revision, "acme/widgets#9");
    expect(issue.blockerExternalIds).toEqual(["acme/widgets#8", "acme/widgets#9"]);
    issue = await gateway.removeBlockedBy(issue.externalId, issue.revision, "acme/widgets#8");
    expect(issue.blockerExternalIds).toEqual(["acme/widgets#9"]);
    issue = await gateway.addAssignee(issue.externalId, issue.revision, "human-owner");
    issue = await gateway.addAssignee(issue.externalId, issue.revision, "hanoon-bot");
    issue = await gateway.removeAssignee(issue.externalId, issue.revision, "hanoon-bot");
    expect(issue.assignees).toEqual(["human-owner"]);

    const edits = runner.calls.filter((call) => call.args[1] === "issue" && call.args[2] === "edit");
    expect(edits.map((call) => call.args)).toEqual(expect.arrayContaining([
      expect.arrayContaining(["--add-sub-issue", "7"]),
      expect.arrayContaining(["--add-blocked-by", "9"]),
      expect.arrayContaining(["--remove-blocked-by", "8"]),
    ]));
    const assigneeWrites = runner.calls.filter((call) =>
      call.args[1] === "api" && call.args.some((arg) => arg.endsWith("/assignees")));
    expect(assigneeWrites).toHaveLength(3);
    expect(assigneeWrites.every((call) => call.args.includes("--silent"))).toBe(true);
  });

  it("combines indexed marker search with exhaustive direct pagination", async () => {
    const runner = new StatefulGhRunner();
    const gateway = new GhCliIssueGateway("acme/widgets", runner);
    const marker = "<!-- hanoon:operation:5da0c05e33f2ce125aa7fe06e40762e1399066287e711542bb072b3c153296af:";

    expect(await gateway.findIssuesByOperationMarker(marker)).toHaveLength(1);
    const lists = runner.calls.filter((call) => call.args[2] === "list");
    expect(lists).toHaveLength(1);
    const search = lists[0];
    expect(search?.args).toEqual(expect.arrayContaining(["--search", expect.stringContaining("5da0c05e")]));
    expect(search?.args).not.toEqual(expect.arrayContaining(["--limit", "1000"]));
    expect(runner.calls.find((call) => call.args[1] === "api")?.args)
      .toEqual(expect.arrayContaining(["--jq"]));
    expect(runner.calls.find((call) => call.args[1] === "api")?.args.join(" "))
      .toContain("per_page=100&page=1");
  });

  it("filters exhaustive pages before the production retained-output cap", async () => {
    const runner = new ProductionCappedDiscoveryRunner();
    const gateway = new GhCliIssueGateway("acme/widgets", runner);
    const marker = "<!-- hanoon:operation:5da0c05e33f2ce125aa7fe06e40762e1399066287e711542bb072b3c153296af:";

    expect(runner.sourceBytes).toBeGreaterThan(65_536);
    expect((await gateway.findIssuesByOperationMarker(marker)).map((issue) => issue.externalId))
      .toEqual(["acme/widgets#7"]);
  });

  it("finds a just-created marker before GitHub search indexing catches up", async () => {
    const runner = new StatefulGhRunner();
    runner.hideIndexedIssue = true;
    const gateway = new GhCliIssueGateway("acme/widgets", runner);
    const marker = "<!-- hanoon:operation:5da0c05e33f2ce125aa7fe06e40762e1399066287e711542bb072b3c153296af:";

    expect((await gateway.findIssuesByOperationMarker(marker)).map((issue) => issue.externalId))
      .toEqual(["acme/widgets#7"]);
  });

  it("hydrates marker candidates before computing revisions from all comments", async () => {
    const runner = new StatefulGhRunner();
    runner.seedComments(101);
    runner.truncateListComments = true;
    const gateway = new GhCliIssueGateway("acme/widgets", runner);
    const marker = "<!-- hanoon:operation:5da0c05e33f2ce125aa7fe06e40762e1399066287e711542bb072b3c153296af:";

    const [found] = await gateway.findIssuesByOperationMarker(marker);
    const direct = await gateway.readIssue("acme/widgets#7");
    expect(found.comments).toHaveLength(101);
    expect(found.revision).toBe(direct.revision);
    expect(runner.calls.filter((call) => call.args[2] === "view")).toHaveLength(6);
  });

  it("hydrates a maximum-sized body when the valid core JSON exceeds the production default cap", async () => {
    const runner = new StatefulGhRunner();
    const body = "x".repeat(65_536);
    runner.seedBody(body);
    const gateway = new GhCliIssueGateway("acme/widgets", runner);

    expect(runner.coreHydrationBytes()).toBeGreaterThan(PRODUCTION_CAPTURE_BYTES);
    expect((await gateway.readIssue("acme/widgets#7")).body).toBe(body);
    const coreCalls = runner.calls.filter((call) => call.args[2] === "view");
    expect(coreCalls).toHaveLength(3);
    expect(coreCalls.every((call) =>
      (call.maxCaptureBytes ?? 0) > PRODUCTION_CAPTURE_BYTES &&
      !call.args[call.args.indexOf("--json") + 1].split(",").includes("comments")))
      .toBe(true);
  });

  it("hydrates ordered comment pages when aggregate history exceeds the production default cap", async () => {
    const runner = new StatefulGhRunner();
    const comments = Array.from({ length: 24 }, (_, index) =>
      `Comment ${String(index + 1).padStart(2, "0")} ${"x".repeat(3_000)}`);
    runner.seedCommentBodies(comments);
    const gateway = new GhCliIssueGateway("acme/widgets", runner);

    expect(runner.combinedHydrationBytes()).toBeGreaterThan(PRODUCTION_CAPTURE_BYTES);
    expect((await gateway.readIssue("acme/widgets#7")).comments).toEqual(comments);
    const pages = runner.calls.filter((call) =>
      call.args[1] === "api" && call.args.some((arg) => arg.includes("/comments?")));
    expect(pages).toHaveLength(8);
    expect(pages.every((call) =>
      (call.maxCaptureBytes ?? 0) > PRODUCTION_CAPTURE_BYTES &&
      call.args.some((arg) => /per_page=8&page=[1-4]$/u.test(arg))))
      .toBe(true);
  });

  it.each(["delete", "insert", "edit"] as const)(
    "fails closed when comments %s between complete captures",
    async (mutation) => {
      const runner = new StatefulGhRunner();
      runner.seedComments(9);
      runner.mutateCommentsBeforeSecondCore(mutation);
      const gateway = new GhCliIssueGateway("acme/widgets", runner);

      await expect(gateway.readIssue("acme/widgets#7")).rejects.toThrow(TrackerConflictError);
    },
  );

  it("fails closed when deletion shifts comments between pages", async () => {
    const runner = new StatefulGhRunner();
    runner.seedComments(17);
    runner.shiftCommentsAfterFirstPage();
    const gateway = new GhCliIssueGateway("acme/widgets", runner);

    await expect(gateway.readIssue("acme/widgets#7")).rejects.toThrow(TrackerConflictError);
  });

  it("terminates both captures after the empty page for an exact page multiple", async () => {
    const runner = new StatefulGhRunner();
    runner.seedComments(16);
    const gateway = new GhCliIssueGateway("acme/widgets", runner);

    expect((await gateway.readIssue("acme/widgets#7")).comments).toHaveLength(16);
    const pages = runner.calls.filter((call) =>
      call.args[1] === "api" && call.args.some((arg) => arg.includes("/comments?")));
    expect(pages.map((call) => call.args.find((arg) => arg.includes("/comments?"))))
      .toEqual([
        expect.stringContaining("page=1"),
        expect.stringContaining("page=2"),
        expect.stringContaining("page=3"),
        expect.stringContaining("page=1"),
        expect.stringContaining("page=2"),
        expect.stringContaining("page=3"),
      ]);
  });

  it.each([
    ["malformed", /invalid JSON/iu],
    ["partial", /partial issue comment page/iu],
    ["non_progressing", /did not make progress/iu],
  ] as const)("fails closed on %s comment pagination", async (fault, expected) => {
    const runner = new StatefulGhRunner();
    runner.seedComments(9);
    runner.commentPageFault = fault;
    const gateway = new GhCliIssueGateway("acme/widgets", runner);

    await expect(gateway.readIssue("acme/widgets#7")).rejects.toThrow(expected);
  });

  it("fails closed when core issue state changes during comment pagination", async () => {
    const runner = new StatefulGhRunner();
    runner.editBeforeCoreCorroboration = true;
    const gateway = new GhCliIssueGateway("acme/widgets", runner);

    await expect(gateway.readIssue("acme/widgets#7")).rejects.toThrow(TrackerConflictError);
  });

  it("fails closed when GitHub reports a partial native relationship connection", async () => {
    const runner = new StatefulGhRunner();
    runner.omitOneBlockedByNode();
    const gateway = new GhCliIssueGateway("acme/widgets", runner);

    await expect(gateway.readIssue("acme/widgets#7"))
      .rejects.toThrow(/incomplete blockedBy connection/iu);
  });

  it("preserves native relationship identity from the issue URL fallback", async () => {
    const runner = new StatefulGhRunner();
    runner.omitRelationshipRepository("subIssues");
    const gateway = new GhCliIssueGateway("acme/widgets", runner);

    expect((await gateway.readIssue("acme/widgets#7")).childExternalIds)
      .toEqual(["acme/widgets#10"]);
  });

  it("rejects external identities from a different configured repository", async () => {
    const runner = new StatefulGhRunner();
    const gateway = new GhCliIssueGateway("acme/widgets", runner);

    await expect(gateway.readIssue("acme/other#7"))
      .rejects.toThrow(/match the configured repository/iu);
    expect(runner.calls).toHaveLength(0);
  });

  it("uses one canonical repository identity across mixed-case restarts", async () => {
    const runner = new StatefulGhRunner();
    const first = new GhCliIssueGateway("Acme/Widgets", runner);
    const observed = await first.readIssue("ACME/WIDGETS#7");
    const restarted = new GhCliIssueGateway("ACME/WIDGETS", runner);

    expect(first.namespace).toBe("github:acme/widgets");
    expect(restarted.namespace).toBe(first.namespace);
    expect(observed.externalId).toBe("acme/widgets#7");
    expect((await restarted.readIssue(observed.externalId)).externalId).toBe(observed.externalId);
    expect(runner.calls.flatMap((call) => call.args))
      .not.toEqual(expect.arrayContaining(["Acme/Widgets", "ACME/WIDGETS"]));
    expect(runner.calls.filter((call) => call.args.includes("--repo")).every((call) =>
      call.args[call.args.indexOf("--repo") + 1] === "acme/widgets"))
      .toBe(true);
  });

  it.each(["parent", "blockedBy", "subIssues"] as const)(
    "fails closed on a cross-repository %s relationship",
    async (relationship) => {
      const runner = new StatefulGhRunner();
      runner.setRelationshipRepository(relationship, "acme/other");
      const gateway = new GhCliIssueGateway("acme/widgets", runner);

      await expect(gateway.readIssue("acme/widgets#7"))
        .rejects.toThrow(/cross-repository relationship/iu);
    },
  );

  it("exhausts direct issue pagination before concluding an operation is absent", async () => {
    const runner = new StatefulGhRunner();
    runner.hideIndexedIssue = true;
    runner.hideRecentIssue = true;
    runner.putIssueOnSecondApiPage = true;
    const gateway = new GhCliIssueGateway("acme/widgets", runner);
    const marker = "<!-- hanoon:operation:5da0c05e33f2ce125aa7fe06e40762e1399066287e711542bb072b3c153296af:";

    expect((await gateway.findIssuesByOperationMarker(marker)).map((issue) => issue.externalId))
      .toEqual(["acme/widgets#7"]);
    const pages = runner.calls.filter((call) =>
      call.args[1] === "api" && call.args.some((arg) => arg.includes("?state=all")));
    expect(pages).toHaveLength(4);
    expect(pages[1]?.args.join(" ")).toContain("page=2");
    expect(pages[2]?.args.join(" ")).toContain("page=1");
    expect(pages[3]?.args.join(" ")).toContain("page=2");
  });

  it.each([
    ["page", operationLimits({ maxPages: 3 }), "advancing comment", /page limit/iu],
    ["item", operationLimits({ maxItems: 9 }), "advancing comment", /item limit/iu],
    ["UTF-8 byte", operationLimits({ maxBytes: 2_500 }), "😀".repeat(100), /byte limit/iu],
    ["deadline", operationLimits({ maxElapsedMs: 3 }), "advancing comment", /deadline/iu],
  ] as const)("fails closed when full advancing comment pages cross the %s budget", async (
    bound,
    limits,
    commentBody,
    expected,
  ) => {
    const runner = new AdvancingPaginationRunner(5, 0, commentBody);
    if (bound === "deadline") runner.advanceMs = 1;
    const gateway = new GhCliIssueGateway(
      "acme/widgets",
      runner,
      limits,
      () => runner.now,
    );

    await expect(gateway.readIssue("acme/widgets#7")).rejects.toThrow(expected);
    const commentCalls = runner.calls.filter((call) =>
      call.args.some((argument) => argument.includes("/comments?")));
    expect(commentCalls.length).toBeGreaterThan(0);
    if (bound === "deadline") {
      expect(runner.calls.map((call) => call.timeoutMs)).toEqual([3, 2, 1]);
    }
  });

  it("shares one page budget across both comment captures and their core reads", async () => {
    const runner = new AdvancingPaginationRunner(1, 0);
    const gateway = new GhCliIssueGateway(
      "acme/widgets",
      runner,
      operationLimits({ maxPages: 6 }),
      () => runner.now,
    );

    await expect(gateway.readIssue("acme/widgets#7")).rejects.toThrow(/page limit/iu);
    expect(runner.calls.filter((call) =>
      call.args.some((argument) => argument.includes("/comments?")))).toHaveLength(4);
  });

  it("shares reconciliation bounds across indexed and exhaustive scans and refuses creation", async () => {
    const runner = new AdvancingPaginationRunner(0, 1);
    runner.hideIndexedIssue = true;
    const gateway = new GhCliIssueGateway(
      "acme/widgets",
      runner,
      operationLimits({ maxPages: 2 }),
      () => runner.now,
    );
    const tracker = new GitHubWorkTracker(gateway);

    await expect(tracker.create({
      operationId: "bounded-create-reconciliation",
      kind: "implementation_ticket",
      title: "Bounded reconciliation",
      body: "# Goal\n\nNever create after an incomplete absence scan.",
      acceptanceCriteria: [],
    })).rejects.toThrow(/page limit/iu);
    expect(runner.calls.some((call) =>
      call.args[1] === "issue" && call.args[2] === "create")).toBe(false);
  });

  it.each(["order", "boundary", "count", "high-water", "deletion-shift"] as const)(
    "refuses creation when exhaustive issue pagination changes its %s identity",
    async (mutation) => {
      const runner = new ChangingIssueDiscoveryRunner(mutation);
      const tracker = new GitHubWorkTracker(new GhCliIssueGateway("acme/widgets", runner));

      await expect(tracker.create({
        operationId: `changing-discovery-${mutation}`,
        kind: "implementation_ticket",
        title: "Changing issue discovery",
        body: "# Goal\n\nFail closed when exhaustive reconciliation is unstable.",
        acceptanceCriteria: [],
      })).rejects.toThrow(/conflict|changed|stable|pagination/iu);
      expect(runner.calls.some((call) =>
        call.args[1] === "issue" && call.args[2] === "create")).toBe(false);
    },
  );

  it("refuses creation when a corroborated marker candidate loses its marker during hydration", async () => {
    const runner = new StatefulGhRunner();
    runner.removeOperationMarkerAfterDiscovery();
    const tracker = new GitHubWorkTracker(new GhCliIssueGateway("acme/widgets", runner));

    await expect(tracker.create({
      operationId: "create-7",
      kind: "implementation_ticket",
      title: "Tracked issue",
      body: "# Goal",
      acceptanceCriteria: [],
    })).rejects.toThrow(/marker|candidate|changed|conflict/iu);
    expect(runner.calls.some((call) =>
      call.args[1] === "issue" && call.args[2] === "create")).toBe(false);
  });
});

describe("TerminalGhCliCommandRunner", () => {
  it("fails closed when the terminal reports output truncation", async () => {
    const terminal = {
      run: async () => ({
        outcome: "exited" as const,
        exitCode: 0,
        output: "{}",
        outputTruncated: true as const,
      }),
    };
    const runner = new TerminalGhCliCommandRunner(terminal as never, {
      scope: { kind: "environment", environmentId: "env-1" },
    });

    await expect(runner.run({ args: ["gh", "issue", "view", "7"] }))
      .rejects.toThrow(/exceeded its capture budget/iu);
  });

  it("passes the remaining operation deadline to the terminal command", async () => {
    let observedTimeout = 0;
    const terminal = {
      run: async (input: Readonly<{ timeoutMs: number }>) => {
        observedTimeout = input.timeoutMs;
        return {
          outcome: "exited" as const,
          exitCode: 0,
          output: "{}",
        };
      },
    };
    const runner = new TerminalGhCliCommandRunner(terminal as never, {
      scope: { kind: "environment", environmentId: "env-1" },
      timeoutMs: 60_000,
    });

    await runner.run({ args: ["gh", "issue", "view", "7"], timeoutMs: 125 });

    expect(observedTimeout).toBe(125);
  });
});
