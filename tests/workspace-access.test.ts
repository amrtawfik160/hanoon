import { expect, it } from "vitest";
import { createWorkspaceAccess } from "../src/services/workspace-access";
import type { CommandResult } from "../src/bb/terminal-command";

/** Captures the shell command each call would run on the host. */
function accessFixture() {
  const commands: string[] = [];
  const access = createWorkspaceAccess({
    sdk: {
      projects: { list: async () => [{ id: "proj_1", kind: "standard", sources: [{ hostId: "host_1", path: "/repo" }] }] },
      threads: { list: async () => [] },
    } as never,
    store: {
      listEnabledProjectPolicies: () => [{ policy: { projectId: "proj_1", alias: "repo", baseBranch: "trunk" } }],
    } as never,
    terminal: {
      run: async (input: { command: string }): Promise<CommandResult> => {
        commands.push(input.command);
        return { outcome: "exited", exitCode: 0, output: "" };
      },
    },
  });
  return { access, commands };
}

it("lets the host expand $HOME when rescuing uncommitted work", async () => {
  // The bug this pins: the destination was single-quoted, so `$HOME` stayed
  // literal and every rescue redirected into a directory named `$HOME`, while
  // the unquoted `mkdir` expanded and created the real one. Directory present,
  // every write failing, and it failed safe so nothing shouted.
  const { access, commands } = accessFixture();
  const [project] = await access.listProjects();

  await expect(access.preserveUncommitted(project, "/root/w/env_a/repo")).resolves.toContain(".patch");

  const rescue = commands.find((command) => command.includes(".patch"));
  expect(rescue).toBeDefined();
  expect(rescue).not.toContain("'$HOME");
  expect(rescue).toContain('"$HOME/.hanoon-worktree-rescue"');
  expect(rescue).toMatch(/> "\$HOME\/\.hanoon-worktree-rescue\/[A-Za-z0-9._-]+\.patch"/);
});

it("keeps the worktree path itself safely quoted", async () => {
  // The path comes from git output rather than from us, so it stays
  // single-quoted; only the $HOME-bearing destination may expand.
  const { access, commands } = accessFixture();
  const [project] = await access.listProjects();
  await access.preserveUncommitted(project, "/root/w/env a/repo");

  const rescue = commands.find((command) => command.includes(".patch"));
  expect(rescue).toContain("'/root/w/env a/repo'");
});
