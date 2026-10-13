import { describe, expect, test } from "vitest";

import { foldTurnUsage, summarizeUsageTotals } from "./agent-usage-totals.js";

describe("agent usage totals", () => {
  test("two turns accumulate every figure the provider reported", () => {
    const afterFirst = foldTurnUsage(undefined, {
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 1_000,
      cacheWriteTokens: 200,
      costUsd: 0.25,
    });
    const afterSecond = foldTurnUsage(afterFirst, {
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 1_500,
      cacheWriteTokens: 0,
      costUsd: 0.125,
    });

    expect(summarizeUsageTotals(afterSecond)).toEqual({
      turnsCounted: 2,
      inputTokens: 150,
      outputTokens: 50,
      cacheReadTokens: 2_500,
      cacheWriteTokens: 200,
      costUsd: 0.375,
      turnsReporting: {
        inputTokens: 2,
        outputTokens: 2,
        cacheReadTokens: 2,
        cacheWriteTokens: 2,
        costUsd: 2,
      },
      complete: true,
    });
  });

  test("folding never mutates the totals it was given", () => {
    const first = foldTurnUsage(undefined, { inputTokens: 1 });
    const snapshot = JSON.stringify(first);

    foldTurnUsage(first, { inputTokens: 2 });

    expect(JSON.stringify(first)).toBe(snapshot);
  });

  test("a figure no turn reported is unknown, not zero", () => {
    const totals = foldTurnUsage(foldTurnUsage(undefined, { inputTokens: 10, outputTokens: 5 }), {
      inputTokens: 20,
      outputTokens: 5,
    });

    const summary = summarizeUsageTotals(totals);

    expect(summary.costUsd).toBeNull();
    expect(summary.cacheWriteTokens).toBeNull();
    expect(summary.inputTokens).toBe(30);
    expect(summary.turnsReporting.costUsd).toBe(0);
    // Unknown is not partial: every figure that has a value covers every counted turn.
    expect(summary.complete).toBe(true);
  });

  test("a turn the provider reported nothing for is counted and makes the sums lower bounds", () => {
    const totals = foldTurnUsage(
      foldTurnUsage(undefined, { inputTokens: 10, costUsd: 1 }),
      undefined,
    );

    const summary = summarizeUsageTotals(totals);

    expect(summary.turnsCounted).toBe(2);
    expect(summary.inputTokens).toBe(10);
    expect(summary.costUsd).toBe(1);
    expect(summary.turnsReporting.costUsd).toBe(1);
    expect(summary.complete).toBe(false);
  });

  test("a zero the provider reported is a zero, distinct from unknown", () => {
    const summary = summarizeUsageTotals(foldTurnUsage(undefined, { costUsd: 0, inputTokens: 0 }));

    expect(summary.costUsd).toBe(0);
    expect(summary.inputTokens).toBe(0);
    expect(summary.outputTokens).toBeNull();
  });

  test("ignores figures that are not finite non-negative numbers", () => {
    const totals = foldTurnUsage(undefined, {
      inputTokens: Number.NaN,
      outputTokens: -3,
      costUsd: Number.POSITIVE_INFINITY,
    });

    const summary = summarizeUsageTotals(totals);

    expect(summary.turnsCounted).toBe(1);
    expect(summary.inputTokens).toBeNull();
    expect(summary.outputTokens).toBeNull();
    expect(summary.costUsd).toBeNull();
  });

  test("no counted turns reads as all unknown", () => {
    expect(summarizeUsageTotals(undefined)).toEqual({
      turnsCounted: 0,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      turnsReporting: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
      complete: true,
    });
  });
});
