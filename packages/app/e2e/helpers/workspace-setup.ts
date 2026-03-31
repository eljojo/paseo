import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { expect, type Page } from "@playwright/test";
import { gotoAppShell } from "./app";
import type { SessionOutboundMessage } from "@server/shared/messages";

type WorkspaceSetupDaemonClient = {
  connect(): Promise<void>;
  close(): Promise<void>;
  openProject(
    cwd: string,
  ): Promise<{ workspace: { id: string; name: string } | null; error: string | null }>;
  createPaseoWorktree(
    input: { cwd: string; worktreeSlug?: string },
  ): Promise<{ workspace: { id: string; name: string } | null; error: string | null }>;
  subscribeRawMessages(handler: (message: SessionOutboundMessage) => void): () => void;
};

export type WorkspaceSetupProgressPayload = Extract<
  SessionOutboundMessage,
  { type: "workspace_setup_progress" }
>["payload"];

function getDaemonWsUrl(): string {
  const daemonPort = process.env.E2E_DAEMON_PORT;
  if (!daemonPort) {
    throw new Error("E2E_DAEMON_PORT is not set.");
  }
  return `ws://127.0.0.1:${daemonPort}/ws`;
}

async function loadDaemonClientConstructor(): Promise<
  new (config: { url: string; clientId: string; clientType: "cli" }) => WorkspaceSetupDaemonClient
> {
  const repoRoot = path.resolve(process.cwd(), "../..");
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, "packages/server/dist/server/server/exports.js"),
  ).href;
  const mod = (await import(moduleUrl)) as {
    DaemonClient: new (config: {
      url: string;
      clientId: string;
      clientType: "cli";
    }) => WorkspaceSetupDaemonClient;
  };
  return mod.DaemonClient;
}

export async function connectWorkspaceSetupClient(): Promise<WorkspaceSetupDaemonClient> {
  const DaemonClient = await loadDaemonClientConstructor();
  const client = new DaemonClient({
    url: getDaemonWsUrl(),
    clientId: `workspace-setup-${randomUUID()}`,
    clientType: "cli",
  });
  await client.connect();
  return client;
}

export async function seedProjectForWorkspaceSetup(
  client: WorkspaceSetupDaemonClient,
  repoPath: string,
): Promise<void> {
  const result = await client.openProject(repoPath);
  if (!result.workspace || result.error) {
    throw new Error(result.error ?? `Failed to open project ${repoPath}`);
  }
}

export function projectNameFromPath(repoPath: string): string {
  return repoPath.replace(/\/+$/, "").split("/").filter(Boolean).pop() ?? repoPath;
}

export async function openHomeWithProject(page: Page, repoPath: string): Promise<void> {
  await gotoAppShell(page);
  await expect(createWorkspaceButton(page, repoPath)).toBeVisible({ timeout: 30_000 });
}

function createWorkspaceButton(page: Page, repoPath: string) {
  return page.getByRole("button", {
    name: `Create a new workspace for ${projectNameFromPath(repoPath)}`,
  });
}

async function revealWorkspaceButton(page: Page, repoPath: string): Promise<void> {
  await page.getByTestId(`sidebar-project-row-${repoPath}`).hover();
}

export async function createWorkspaceFromSidebar(page: Page, repoPath: string): Promise<void> {
  await revealWorkspaceButton(page, repoPath);
  await expect(createWorkspaceButton(page, repoPath)).toBeEnabled({ timeout: 30_000 });
  await createWorkspaceButton(page, repoPath).click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
}

export async function expectSetupPanel(page: Page): Promise<void> {
  await expect(page.getByText("Workspace setup", { exact: true })).toBeVisible({ timeout: 30_000 });
}

export async function expectSetupStatus(
  page: Page,
  status: "Running" | "Completed" | "Failed",
): Promise<void> {
  await expect(page.getByTestId("workspace-setup-status")).toContainText(status, {
    timeout: 30_000,
  });
}

export async function expectSetupLogContains(page: Page, text: string): Promise<void> {
  await expect(page.getByTestId("workspace-setup-log")).toContainText(text, {
    timeout: 30_000,
  });
}

export async function expectNoSetupMessage(page: Page): Promise<void> {
  await expect(page.getByText("No setup commands ran for this workspace.", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

export async function createWorkspaceThroughDaemon(
  client: WorkspaceSetupDaemonClient,
  input: { cwd: string; worktreeSlug: string },
): Promise<{ id: string; name: string }> {
  const result = await client.createPaseoWorktree(input);
  if (!result.workspace || result.error) {
    throw new Error(result.error ?? `Failed to create workspace for ${input.cwd}`);
  }
  return result.workspace;
}

export async function waitForWorkspaceSetupProgress(
  client: WorkspaceSetupDaemonClient,
  predicate: (payload: WorkspaceSetupProgressPayload) => boolean,
  timeoutMs = 30_000,
): Promise<WorkspaceSetupProgressPayload> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for workspace_setup_progress after ${timeoutMs}ms`));
    }, timeoutMs);

    const unsubscribe = client.subscribeRawMessages((message) => {
      if (message.type !== "workspace_setup_progress") {
        return;
      }
      if (!predicate(message.payload)) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe();
      resolve(message.payload);
    });
  });
}
