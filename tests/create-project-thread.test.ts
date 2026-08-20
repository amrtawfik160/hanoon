import { expect, it, vi } from "vitest";
import { createProjectThread } from "../src/controller/thread-observer";

function sdkFixture() {
  const spawn = vi.fn(async () => ({ id: "thr_new" }));
  return { spawn, sdk: { threads: { spawn } } as unknown as Parameters<typeof createProjectThread>[0]["sdk"] };
}

function input(overrides: { baseBranch: string }) {
  const { sdk, spawn } = sdkFixture();
  return {
    spawn,
    args: {
      sdk,
      projectId: "proj_1",
      hostId: "host_1",
      title: "Look into the failing check",
      prompt: "Read the CI log and report what broke.",
      signal: new AbortController().signal,
      ...overrides,
    },
  };
}

it("cuts a new thread's worktree from the base branch it was given", async () => {
  const { spawn, args } = input({ baseBranch: "feature/trunk" });

  await createProjectThread(args);

  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
    environment: {
      type: "host",
      hostId: "host_1",
      // A named base, never { kind: "default" }: BB's default branch is what put
      // threads on a history that could not merge back.
      workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "feature/trunk" } },
    },
  }));
});

it("sends the controller execution tuple so Cursor and Grok child threads can start", async () => {
  const { spawn, args } = input({ baseBranch: "main" });

  await createProjectThread({
    ...args,
    execution: {
      providerId: "acp-grok",
      model: "grok-4.6",
      reasoningLevel: "xhigh",
      permissionMode: "accept-edits",
      executionInputSources: {
        providerId: "explicit",
        model: "explicit",
        reasoningLevel: "explicit",
        permissionMode: "explicit",
      },
    },
  });

  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
    providerId: "acp-grok",
    model: "grok-4.6",
    permissionMode: "accept-edits",
  }));
});

it.each([[""], ["   "]])("refuses to spawn a thread with a blank base branch (%j)", async (baseBranch) => {
  const { spawn, args } = input({ baseBranch });

  await expect(createProjectThread(args)).rejects.toThrow(/explicit base branch/i);
  expect(spawn).not.toHaveBeenCalled();
});
