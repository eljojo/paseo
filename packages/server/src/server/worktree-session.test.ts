import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { SessionOutboundMessage } from "./messages.js";
import { ServiceRouteStore } from "./service-proxy.js";
import { createPaseoWorktreeInBackground } from "./worktree-session.js";
import { computeWorktreePath, createWorktree } from "../utils/worktree.js";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function createTerminalManagerStub(options?: {
  createTerminal?: (input: {
    cwd: string;
    name?: string;
    env?: Record<string, string>;
  }) => Promise<any>;
}) {
  const terminals: Array<{
    id: string;
    cwd: string;
    name: string | undefined;
    env: Record<string, string> | undefined;
    sent: string[];
  }> = [];

  return {
    terminals,
    manager: {
      registerCwdEnv: vi.fn(),
      createTerminal: vi.fn(async (input: {
        cwd: string;
        name?: string;
        env?: Record<string, string>;
      }) => {
        if (options?.createTerminal) {
          return options.createTerminal(input);
        }
        const sent: string[] = [];
        const terminal = {
          id: `terminal-${terminals.length + 1}`,
          getState: () => ({
            scrollback: [[{ char: "$" }]],
            grid: [],
          }),
          subscribe: () => () => {},
          send: (message: { type: string; data: string }) => {
            if (message.type === "input") {
              sent.push(message.data);
            }
          },
        };
        terminals.push({
          id: terminal.id,
          cwd: input.cwd,
          name: input.name,
          env: input.env,
          sent,
        });
        return terminal;
      }),
    } as any,
  };
}

function createGitRepo(options?: { paseoConfig?: Record<string, unknown> }) {
  const tempDir = realpathSync(mkdtempSync(path.join(tmpdir(), "worktree-session-test-")));
  const repoDir = path.join(tempDir, "repo");
  execSync(`mkdir -p ${JSON.stringify(repoDir)}`);
  execSync("git init -b main", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", { cwd: repoDir, stdio: "pipe" });
  execSync("git config user.name 'Test'", { cwd: repoDir, stdio: "pipe" });
  writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  if (options?.paseoConfig) {
    writeFileSync(path.join(repoDir, "paseo.json"), JSON.stringify(options.paseoConfig, null, 2));
  }
  execSync("git add .", { cwd: repoDir, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'initial'", { cwd: repoDir, stdio: "pipe" });
  return { tempDir, repoDir };
}

describe("createPaseoWorktreeInBackground", () => {
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const target of cleanupPaths.splice(0)) {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test("emits a single completed snapshot for no-setup workspaces and then launches services", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        services: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const worktreePath = await computeWorktreePath(repoDir, "feature-no-setup", paseoHome);
    const emitted: SessionOutboundMessage[] = [];
    const routeStore = new ServiceRouteStore();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
        serviceRouteStore: routeStore,
        daemonPort: 6767,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        baseBranch: "main",
        slug: "feature-no-setup",
        worktreePath,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(1);
    expect(progressMessages[0]?.payload).toMatchObject({
      workspaceId: worktreePath,
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-no-setup",
        log: "",
        commands: [],
      },
    });

    expect(routeStore.listRoutes()).toEqual([
      { hostname: "feature-no-setup.web.localhost", port: expect.any(Number) },
    ]);
    expect(terminalManager.terminals).toHaveLength(1);
    expect(terminalManager.terminals[0]?.cwd).toBe(worktreePath);
    expect(terminalManager.terminals[0]?.sent).toEqual(["npm run dev\r"]);
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(worktreePath);
  });

  test("archives the pending workspace and emits a failed snapshot when setup cannot start", async () => {
    const { tempDir, repoDir } = createGitRepo();
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const worktreePath = await computeWorktreePath(repoDir, "broken-feature", paseoHome);
    const emitted: SessionOutboundMessage[] = [];
    const logger = createLogger();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: null,
        archiveWorkspaceRecord,
        serviceRouteStore: null,
        daemonPort: null,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        baseBranch: "does-not-exist",
        slug: "broken-feature",
        worktreePath,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(1);
    expect(progressMessages[0]?.payload.status).toBe("failed");
    expect(progressMessages[0]?.payload.error).toContain("does-not-exist");
    expect(progressMessages[0]?.payload.detail.commands).toEqual([]);
    expect(archiveWorkspaceRecord).toHaveBeenCalledWith(worktreePath);
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(worktreePath);
  });

  test("emits running setup snapshots before completed for real setup commands", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        worktree: {
          setup: ['sh -c "printf \'phase-one\\\\n\'; sleep 0.1; printf \'phase-two\\\\n\'"'],
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const worktreePath = await computeWorktreePath(repoDir, "feature-running-setup", paseoHome);
    const emitted: SessionOutboundMessage[] = [];
    const logger = createLogger();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: null,
        archiveWorkspaceRecord,
        serviceRouteStore: null,
        daemonPort: null,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        baseBranch: "main",
        slug: "feature-running-setup",
        worktreePath,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages.length).toBeGreaterThan(1);
    expect(progressMessages.at(-1)?.payload.status).toBe("completed");

    const runningMessages = progressMessages.filter((message) => message.payload.status === "running");
    expect(runningMessages.length).toBeGreaterThan(0);
    expect(progressMessages.findIndex((message) => message.payload.status === "running")).toBeLessThan(
      progressMessages.findIndex((message) => message.payload.status === "completed"),
    );

    expect(runningMessages[0]?.payload.detail.log).toContain("phase-one");
    expect(runningMessages[0]?.payload.detail.commands[0]).toMatchObject({
      index: 1,
      command: 'sh -c "printf \'phase-one\\\\n\'; sleep 0.1; printf \'phase-two\\\\n\'"',
      status: "running",
    });

    expect(progressMessages.at(-1)?.payload).toMatchObject({
      workspaceId: worktreePath,
      status: "completed",
      error: null,
      detail: {
        type: "worktree_setup",
        worktreePath,
        branchName: "feature-running-setup",
      },
    });
    expect(progressMessages.at(-1)?.payload.detail.log).toContain("phase-two");
    expect(progressMessages.at(-1)?.payload.detail.commands[0]).toMatchObject({
      index: 1,
      command: 'sh -c "printf \'phase-one\\\\n\'; sleep 0.1; printf \'phase-two\\\\n\'"',
      status: "completed",
      exitCode: 0,
    });
  });

  test("keeps setup completed when service launch fails afterward", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        services: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const worktreePath = await computeWorktreePath(repoDir, "feature-service-failure", paseoHome);
    const emitted: SessionOutboundMessage[] = [];
    const routeStore = new ServiceRouteStore();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub({
      createTerminal: async () => {
        throw new Error("terminal spawn failed");
      },
    });
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
        serviceRouteStore: routeStore,
        daemonPort: 6767,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        baseBranch: "main",
        slug: "feature-service-failure",
        worktreePath,
      },
    );

    const progressMessages = emitted.filter(
      (message): message is Extract<SessionOutboundMessage, { type: "workspace_setup_progress" }> =>
        message.type === "workspace_setup_progress",
    );
    expect(progressMessages).toHaveLength(1);
    expect(progressMessages[0]?.payload.status).toBe("completed");
    expect(progressMessages[0]?.payload.error).toBeNull();
    expect(emitted.some((message) => message.type === "workspace_setup_progress" && message.payload.status === "failed")).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        worktreePath,
      }),
      "Failed to spawn worktree services after workspace setup completed",
    );
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(worktreePath);
  });

  test("reused existing worktrees do not rerun setup or spawn services", async () => {
    const { tempDir, repoDir } = createGitRepo({
      paseoConfig: {
        worktree: {
          setup: ["printf 'ran' > setup-ran.txt"],
        },
        services: {
          web: {
            command: "npm run dev",
          },
        },
      },
    });
    cleanupPaths.push(tempDir);

    const paseoHome = path.join(tempDir, ".paseo");
    const existingWorktree = await createWorktree({
      branchName: "reused-worktree",
      cwd: repoDir,
      baseBranch: "main",
      worktreeSlug: "reused-worktree",
      runSetup: false,
      paseoHome,
    });

    const emitted: SessionOutboundMessage[] = [];
    const routeStore = new ServiceRouteStore();
    const logger = createLogger();
    const terminalManager = createTerminalManagerStub();
    const emitWorkspaceUpdateForCwd = vi.fn(async () => {});
    const archiveWorkspaceRecord = vi.fn(async () => {});

    await createPaseoWorktreeInBackground(
      {
        paseoHome,
        emitWorkspaceUpdateForCwd,
        emit: (message) => emitted.push(message),
        sessionLogger: logger,
        terminalManager: terminalManager.manager,
        archiveWorkspaceRecord,
        serviceRouteStore: routeStore,
        daemonPort: 6767,
      },
      {
        requestCwd: repoDir,
        repoRoot: repoDir,
        baseBranch: "main",
        slug: "reused-worktree",
        worktreePath: existingWorktree.worktreePath,
      },
    );

    expect(
      emitted.some((message) => message.type === "workspace_setup_progress"),
    ).toBe(false);
    expect(routeStore.listRoutes()).toEqual([]);
    expect(terminalManager.terminals).toHaveLength(0);
    expect(
      readFileSync(path.join(existingWorktree.worktreePath, "README.md"), "utf8"),
    ).toContain("hello");
    expect(() => readFileSync(path.join(existingWorktree.worktreePath, "setup-ran.txt"), "utf8")).toThrow();
    expect(archiveWorkspaceRecord).not.toHaveBeenCalled();
    expect(emitWorkspaceUpdateForCwd).toHaveBeenCalledWith(existingWorktree.worktreePath);
  });
});
