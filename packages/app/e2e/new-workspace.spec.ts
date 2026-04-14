import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  archiveWorkspaceFromDaemon,
  archiveLocalWorkspaceFromDaemon,
  assertNewWorkspaceSidebarAndHeader,
  clickNewWorkspaceButton,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "./helpers/new-workspace";
import { createTempGitRepo } from "./helpers/workspace";
import {
  expectWorkspaceHeader,
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
  workspaceLabelFromPath,
} from "./helpers/workspace-ui";

test.describe("New workspace flow", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  const localWorkspaceIds = new Set<string>();
  const createdWorktreeIds = new Set<string>();

  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    if (client) {
      for (const workspaceId of createdWorktreeIds) {
        await archiveWorkspaceFromDaemon(client, workspaceId).catch(() => undefined);
      }
      for (const workspaceId of localWorkspaceIds) {
        await archiveLocalWorkspaceFromDaemon(client, workspaceId).catch(() => undefined);
      }
    }
    createdWorktreeIds.clear();
    localWorkspaceIds.clear();
    await client?.close().catch(() => undefined);
  });

  test("sidebar workspace navigation updates URL and header", async ({ page }) => {
    const serverId = process.env.E2E_SERVER_ID;
    if (!serverId) {
      throw new Error("E2E_SERVER_ID is not set.");
    }

    const firstRepo = await createTempGitRepo("workspace-nav-a-");
    const secondRepo = await createTempGitRepo("workspace-nav-b-");

    try {
      const firstWorkspace = await openProjectViaDaemon(client, firstRepo.path);
      const secondWorkspace = await openProjectViaDaemon(client, secondRepo.path);
      localWorkspaceIds.add(firstWorkspace.workspaceId);
      localWorkspaceIds.add(secondWorkspace.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: firstWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: secondWorkspace.workspaceId,
      });
      await waitForWorkspaceInSidebar(page, {
        serverId,
        workspaceId: secondWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: secondWorkspace.workspaceName,
        subtitle: secondWorkspace.projectDisplayName,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: firstWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });
    } finally {
      await secondRepo.cleanup();
      await firstRepo.cleanup();
    }
  });

  test("clicking new workspace redirects, renders header, shows sidebar row, and keeps one draft tab", async ({
    page,
  }) => {
    const serverId = process.env.E2E_SERVER_ID;
    if (!serverId) {
      throw new Error("E2E_SERVER_ID is not set.");
    }

    const tempRepo = await createTempGitRepo("new-workspace-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        targetWorkspacePath: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await clickNewWorkspaceButton(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeIds.add(createdWorkspace.workspaceId);

      expect(createdWorkspace.workspaceId).not.toBe(openedProject.workspaceId);
      await expect(page).toHaveURL(
        buildHostWorkspaceRoute(serverId, createdWorkspace.workspaceId),
        {
          timeout: 30_000,
        },
      );

      const createdWorkspaceRow = page.getByTestId(
        `sidebar-workspace-row-${serverId}:${createdWorkspace.workspaceId}`,
      );
      await expect(createdWorkspaceRow).toBeVisible({ timeout: 30_000 });

      await expectWorkspaceHeader(page, {
        title: workspaceLabelFromPath(createdWorkspace.workspaceId),
        subtitle: openedProject.projectDisplayName,
      });

      const agentTabs = page.locator('[data-testid^="workspace-tab-agent_"]');
      await expect(agentTabs).toHaveCount(1, { timeout: 30_000 });

      // Workspace setup may auto-open a setup tab that steals focus,
      // hiding the agent panel (display:none removes it from the
      // accessibility tree). Click the agent tab to ensure it's active.
      await agentTabs.first().click();

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toBeEditable({ timeout: 30_000 });
    } finally {
      await tempRepo.cleanup();
    }
  });
});
