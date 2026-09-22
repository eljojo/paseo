import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";

function createQueryMock(events: unknown[]): Query {
  let index = 0;
  return {
    next: vi.fn(async () =>
      index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined },
    ),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

function initEvents(permissionMode: string): unknown[] {
  return [
    {
      type: "system",
      subtype: "init",
      session_id: "claude-permission-mode-session",
      permissionMode,
      model: "opus",
    },
    { type: "assistant", message: { content: "done" } },
    {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1, output_tokens: 1 },
      total_cost_usd: 0,
    },
  ];
}

async function runWith(
  requestedMode: string,
  reportedMode: string,
): Promise<{ events: AgentStreamEvent[] }> {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: () => createQueryMock(initEvents(reportedMode)),
    resolveBinary: async () => "/test/claude/bin",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    modeId: requestedMode,
  });
  const events: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => {
    events.push(event);
  });
  try {
    await session.run("permission mode check");
  } finally {
    unsubscribe();
    await session.close();
  }
  return { events };
}

function modeNotices(events: AgentStreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "timeline" &&
    event.item.type === "assistant_message" &&
    event.item.text.includes("permission mode")
      ? [event.item.text]
      : [],
  );
}

describe("Claude permission mode downgrade", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("says so when Claude applies a mode other than the requested one", async () => {
    const { events } = await runWith("auto", "default");

    expect(modeNotices(events)).toEqual([
      "Claude started in permission mode 'default', not the requested 'auto'.",
    ]);
  });

  test("stays quiet when the requested mode is the one applied", async () => {
    const { events } = await runWith("auto", "auto");

    expect(modeNotices(events)).toEqual([]);
  });
});
