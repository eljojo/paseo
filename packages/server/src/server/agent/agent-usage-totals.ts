import { z } from "zod";

import type { AgentTurnUsage } from "./agent-sdk-types.js";

const USAGE_FIGURES = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
] as const satisfies readonly (keyof AgentTurnUsage)[];

type UsageFigure = (typeof USAGE_FIGURES)[number];

// `turns` is how many counted turns reported this figure. A figure whose `turns` is below
// the record's `turns` is a lower bound, and a figure that is absent was never reported.
const UsageSumSchema = z.object({
  total: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
});

export const AgentUsageTotalsSchema = z.object({
  turns: z.number().int().nonnegative(),
  inputTokens: UsageSumSchema.optional(),
  outputTokens: UsageSumSchema.optional(),
  cacheReadTokens: UsageSumSchema.optional(),
  cacheWriteTokens: UsageSumSchema.optional(),
  costUsd: UsageSumSchema.optional(),
});

export type AgentUsageTotals = z.infer<typeof AgentUsageTotalsSchema>;

export interface AgentUsageSummary {
  turnsCounted: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  turnsReporting: Record<UsageFigure, number>;
  /** False when some figure is a lower bound: a counted turn did not report it. */
  complete: boolean;
}

function isReportable(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Adds one completed turn. Returns new totals; the input is never mutated because agent
 * snapshots are shallow copies that share it.
 */
export function foldTurnUsage(
  totals: AgentUsageTotals | undefined,
  turnUsage: AgentTurnUsage | undefined,
): AgentUsageTotals {
  const next: AgentUsageTotals = { ...totals, turns: (totals?.turns ?? 0) + 1 };
  for (const figure of USAGE_FIGURES) {
    const value = turnUsage?.[figure];
    if (!isReportable(value)) {
      continue;
    }
    const previous = totals?.[figure];
    next[figure] = {
      total: (previous?.total ?? 0) + value,
      turns: (previous?.turns ?? 0) + 1,
    };
  }
  return next;
}

export function summarizeUsageTotals(totals: AgentUsageTotals | undefined): AgentUsageSummary {
  const turnsCounted = totals?.turns ?? 0;
  const values = {} as Record<UsageFigure, number | null>;
  const turnsReporting = {} as Record<UsageFigure, number>;
  for (const figure of USAGE_FIGURES) {
    values[figure] = totals?.[figure]?.total ?? null;
    turnsReporting[figure] = totals?.[figure]?.turns ?? 0;
  }
  const complete = USAGE_FIGURES.every(
    (figure) => turnsReporting[figure] === 0 || turnsReporting[figure] === turnsCounted,
  );
  return { turnsCounted, ...values, turnsReporting, complete };
}

const CLAUDE_BASIS =
  "Claude: figures are the SDK's running totals for the session process, differenced per completed turn. costUsd is the SDK's estimate (list price unless managed pricing applies), not an invoice. Subagent and compaction calls are included; inputTokens excludes cache reads and writes. Spend from a failed or interrupted turn is counted in the next completed turn, and a /clear inside the session can hide spend.";

const CODEX_BASIS =
  "Codex reports tokens only and never reports cost, so costUsd stays null. inputTokens includes cacheReadTokens. Figures are the growth of the app-server's thread token total across each turn; sub-agent threads are not included.";

const NO_PER_TURN_USAGE_BASIS =
  "This provider does not report per-turn usage to Paseo: turns are counted, but every figure stays null.";

/** What a reader must know to interpret one agent's figures, by provider. */
export function describeUsageBasis(provider: string, summary: AgentUsageSummary): string[] {
  if (provider === "claude") return [CLAUDE_BASIS];
  if (provider === "codex") return [CODEX_BASIS];
  const reportsNothing = USAGE_FIGURES.every((figure) => summary.turnsReporting[figure] === 0);
  return summary.turnsCounted > 0 && reportsNothing ? [NO_PER_TURN_USAGE_BASIS] : [];
}
