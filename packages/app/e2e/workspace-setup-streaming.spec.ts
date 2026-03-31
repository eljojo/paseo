import { test, expect } from "./fixtures";
import { createTempGitRepo } from "./helpers/workspace";
import {
  connectWorkspaceSetupClient,
  createWorkspaceFromSidebar,
  createWorkspaceThroughDaemon,
  expectSetupPanel,
  openHomeWithProject,
  seedProjectForWorkspaceSetup,
  waitForWorkspaceSetupProgress,
} from "./helpers/workspace-setup";

test.describe("Workspace setup streaming", () => {
  test("opens the setup tab when a workspace is created from the sidebar", async ({ page }) => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-open-", {
      paseoConfig: {
        worktree: {
          setup: ["sh -c 'echo starting setup; sleep 2; echo setup complete'"],
        },
      },
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      await openHomeWithProject(page, repo.path);
      await createWorkspaceFromSidebar(page, repo.path);

      await expectSetupPanel(page);
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("streams running and completed setup snapshots for a successful setup", async () => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-success-", {
      paseoConfig: {
        worktree: {
          setup: ["sh -c 'echo starting setup; sleep 2; echo setup complete'"],
        },
      },
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const running = waitForWorkspaceSetupProgress(client, (payload) => payload.status === "running");
      const completed = waitForWorkspaceSetupProgress(
        client,
        (payload) => payload.status === "completed" && payload.detail.log.includes("setup complete"),
      );

      await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: "workspace-setup-success",
      });

      const runningPayload = await running;
      const completedPayload = await completed;

      expect(runningPayload.detail.log).toContain("starting setup");
      expect(completedPayload.detail.log).toContain("setup complete");
      expect(completedPayload.error).toBeNull();
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("streams a failed setup snapshot when setup fails", async () => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-failure-", {
      paseoConfig: {
        worktree: {
          setup: ["sh -c 'echo starting setup; sleep 2; echo setup failed 1>&2; exit 1'"],
        },
      },
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const failed = waitForWorkspaceSetupProgress(
        client,
        (payload) => payload.status === "failed" && payload.detail.log.includes("setup failed"),
      );

      await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: "workspace-setup-failure",
      });

      const failedPayload = await failed;
      expect(failedPayload.detail.log).toContain("starting setup");
      expect(failedPayload.detail.log).toContain("setup failed");
      expect(failedPayload.error).toMatch(/failed/i);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("emits a completed empty snapshot when no setup commands exist", async () => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-none-");

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const completed = waitForWorkspaceSetupProgress(
        client,
        (payload) =>
          payload.status === "completed" &&
          payload.detail.commands.length === 0 &&
          payload.detail.log === "",
      );

      await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: "workspace-setup-none",
      });

      const completedPayload = await completed;
      expect(completedPayload.error).toBeNull();
      expect(completedPayload.detail.commands).toEqual([]);
      expect(completedPayload.detail.log).toBe("");
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
