import { describe, expect, it } from "vitest";

import { buildGitActions, type BuildGitActionsInput } from "./git-actions-policy";

function createInput(
  overrides: Partial<BuildGitActionsInput> = {}
): BuildGitActionsInput {
  return {
    isGit: true,
    githubFeaturesEnabled: true,
    hasPullRequest: false,
    pullRequestUrl: null,
    hasRemote: false,
    isPaseoOwnedWorktree: false,
    isOnBaseBranch: true,
    hasUncommittedChanges: false,
    baseRefAvailable: true,
    baseRefLabel: "main",
    aheadCount: 0,
    aheadOfOrigin: 0,
    behindOfOrigin: 0,
    shouldPromoteArchive: false,
    shipDefault: "merge",
    runtime: {
      commit: {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      push: {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      pr: {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      "merge-branch": {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      "merge-from-base": {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
      "archive-worktree": {
        disabled: false,
        status: "idle",
        handler: () => undefined,
      },
    },
    ...overrides,
  };
}

describe("git-actions-policy", () => {
  it("keeps the secondary menu order stable while the primary action changes", () => {
    const noPrActions = buildGitActions(createInput());
    const withPrActions = buildGitActions(
      createInput({
        hasRemote: true,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/123",
        aheadCount: 3,
        aheadOfOrigin: 2,
        shipDefault: "pr",
      })
    );

    expect(noPrActions.primary).toBeNull();
    expect(withPrActions.primary?.id).toBe("push");
    expect(noPrActions.secondary.map((action) => action.id)).toEqual([
      "merge-branch",
      "pr",
      "merge-from-base",
      "push",
    ]);
    expect(withPrActions.secondary.map((action) => action.id)).toEqual([
      "merge-branch",
      "pr",
      "merge-from-base",
      "push",
    ]);
  });

  it("disables hidden-before actions with explanations instead", () => {
    const actions = buildGitActions(createInput());
    const actionById = new Map(actions.secondary.map((action) => [action.id, action]));

    expect(actionById.get("push")).toMatchObject({
      disabled: true,
      description: "No remote configured",
    });
    expect(actionById.get("pr")).toMatchObject({
      label: "Create PR",
      disabled: true,
      description: "Branch has no commits ahead of main",
    });
    expect(actionById.get("merge-branch")).toMatchObject({
      disabled: true,
      description: "No commits to merge into main",
    });
    expect(actionById.get("merge-from-base")).toMatchObject({
      disabled: true,
      description: "No remote configured",
    });
    expect(actionById.has("archive-worktree")).toBe(false);
  });

  it("keeps the current primary action visible in the menu", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
        hasPullRequest: true,
        pullRequestUrl: "https://example.com/pr/456",
      })
    );

    expect(actions.primary?.id).toBe("pr");
    expect(actions.secondary.some((action) => action.id === "pr" && action.label === "View PR")).toBe(true);
  });

  it("disables sync on the base branch when already up to date", () => {
    const actions = buildGitActions(
      createInput({
        hasRemote: true,
      })
    );
    const syncAction = actions.secondary.find((action) => action.id === "merge-from-base");

    expect(syncAction).toMatchObject({
      label: "Sync",
      disabled: true,
      description: "Already up to date",
    });
  });

  it("only shows archive worktree for paseo worktrees", () => {
    const hidden = buildGitActions(createInput());
    const shown = buildGitActions(createInput({ isPaseoOwnedWorktree: true }));

    expect(hidden.secondary.some((action) => action.id === "archive-worktree")).toBe(false);
    expect(shown.secondary.some((action) => action.id === "archive-worktree")).toBe(true);
  });
});
