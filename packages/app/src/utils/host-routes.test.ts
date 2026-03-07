import { describe, expect, it } from "vitest";
import {
  buildHostAgentDetailRoute,
  buildHostNewAgentRoute,
  buildHostRootRoute,
  buildHostWorkspaceAgentRoute,
  buildHostWorkspaceFileRoute,
  buildHostWorkspaceRoute,
  buildHostWorkspaceRouteWithOpenIntent,
  buildHostWorkspaceTerminalRoute,
  decodeFilePathFromPathSegment,
  decodeWorkspaceIdFromPathSegment,
  encodeFilePathForPathSegment,
  encodeWorkspaceIdForPathSegment,
  parseHostAgentRouteFromPathname,
  parseHostWorkspaceOpenIntentFromPathname,
  parseHostWorkspaceRouteFromPathname,
  parseWorkspaceOpenIntent,
} from "./host-routes";

describe("parseHostAgentRouteFromPathname", () => {
  it("continues parsing detail routes", () => {
    expect(parseHostAgentRouteFromPathname("/h/local/agent/abc123")).toEqual({
      serverId: "local",
      agentId: "abc123",
    });
  });
});

describe("workspace route parsing", () => {
  it("encodes workspace IDs as base64url (no padding)", () => {
    expect(encodeWorkspaceIdForPathSegment("/tmp/repo")).toBe("L3RtcC9yZXBv");
    expect(decodeWorkspaceIdFromPathSegment("L3RtcC9yZXBv")).toBe("/tmp/repo");
  });

  it("decodes non-canonical base64url workspace IDs used by older links", () => {
    expect(
      decodeWorkspaceIdFromPathSegment("L1VzZXJzL21vYm91ZHJhL2Rldi9wYXNlby")
    ).toBe("/Users/moboudra/dev/paseo");
  });

  it("encodes file paths as base64url (no padding)", () => {
    const encoded = encodeFilePathForPathSegment("src/index.ts");
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeFilePathFromPathSegment(encoded)).toBe("src/index.ts");
  });

  it("parses workspace route", () => {
    expect(parseHostWorkspaceRouteFromPathname("/h/local/workspace/L3RtcC9yZXBv")).toEqual({
      serverId: "local",
      workspaceId: "/tmp/repo",
    });
  });

  it("does not treat /tab routes as valid workspace routes", () => {
    expect(
      parseHostWorkspaceRouteFromPathname("/h/local/workspace/L3RtcC9yZXBv/tab/draft_abc123")
    ).toBeNull();
  });

  it("builds base64url workspace routes", () => {
    expect(buildHostWorkspaceRoute("local", "/tmp/repo")).toBe("/h/local/workspace/L3RtcC9yZXBv");
  });

  it("builds host root routes", () => {
    expect(buildHostRootRoute("local")).toBe("/h/local");
  });

  it("builds host new-agent routes", () => {
    expect(buildHostNewAgentRoute("local")).toBe("/h/local/new-agent");
    expect(
      buildHostNewAgentRoute("local", {
        workingDir: "/tmp/repo",
        worktreeMode: "create",
      })
    ).toBe("/h/local/new-agent?workingDir=%2Ftmp%2Frepo&worktreeMode=create");
  });

  it("builds workspace routes with open intent query", () => {
    expect(buildHostWorkspaceAgentRoute("local", "/tmp/repo", "agent-1")).toBe(
      "/h/local/workspace/L3RtcC9yZXBv?open=agent%3Aagent-1"
    );
    expect(buildHostWorkspaceTerminalRoute("local", "/tmp/repo", "term-1")).toBe(
      "/h/local/workspace/L3RtcC9yZXBv?open=terminal%3Aterm-1"
    );
    expect(buildHostWorkspaceFileRoute("local", "/tmp/repo", "src/index.ts")).toBe(
      "/h/local/workspace/L3RtcC9yZXBv?open=file%3Ac3JjL2luZGV4LnRz"
    );
    expect(
      buildHostWorkspaceRouteWithOpenIntent("local", "/tmp/repo", {
        kind: "draft",
        draftId: "new",
      })
    ).toBe("/h/local/workspace/L3RtcC9yZXBv?open=draft%3Anew");
  });

  it("parses workspace open intent from pathname query", () => {
    expect(
      parseHostWorkspaceOpenIntentFromPathname(
        "/h/local/workspace/L3RtcC9yZXBv?open=agent%3Aagent-1"
      )
    ).toEqual({
      kind: "agent",
      agentId: "agent-1",
    });
    expect(parseWorkspaceOpenIntent("terminal:term-1")).toEqual({
      kind: "terminal",
      terminalId: "term-1",
    });
    expect(parseWorkspaceOpenIntent("draft:new")).toEqual({
      kind: "draft",
      draftId: "new",
    });
    expect(parseWorkspaceOpenIntent("file:c3JjL2luZGV4LnRz")).toEqual({
      kind: "file",
      path: "src/index.ts",
    });
  });

  it("keeps agent detail workspace routing on workspace path with open intent", () => {
    expect(buildHostAgentDetailRoute("local", "agent-1", "/tmp/repo")).toBe(
      "/h/local/workspace/L3RtcC9yZXBv?open=agent%3Aagent-1"
    );
  });
});
