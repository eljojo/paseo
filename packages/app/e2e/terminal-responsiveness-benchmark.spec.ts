import { readFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "./fixtures";
import { setWorkingDirectory } from "./helpers/app";
import { createTempGitRepo } from "./helpers/workspace";
import {
  openNewAgentComposer,
  seedWorkspaceActivity,
  switchWorkspaceViaSidebar,
} from "./helpers/workspace-ui";

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

function summarize(values: number[]) {
  if (values.length === 0) {
    return {
      count: 0,
      minMs: 0,
      maxMs: 0,
      avgMs: 0,
      p95Ms: 0,
      p99Ms: 0,
    };
  }

  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    count: values.length,
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    avgMs: Math.round((sum / values.length) * 100) / 100,
    p95Ms: percentile(values, 95),
    p99Ms: percentile(values, 99),
  };
}

function buildStressCommand(doneMarker: string): string {
  // Deterministic synthetic "TUI-like" redraw loop: alternate screen + cursor-home repaint.
  const markerFile = ".paseo-terminal-benchmark-marker";
  return [
    "i=1",
    "printf '\\033[?1049h\\033[2J'",
    "while [ $i -le 240 ]; do",
    "printf '\\033[H'",
    "r=1",
    "while [ $r -le 24 ]; do",
    "printf 'bench frame:%03d row:%02d ########################################\\n' \"$i\" \"$r\"",
    "r=$((r+1))",
    "done",
    "sleep 0.01",
    "i=$((i+1))",
    "done",
    `printf '\\033[?1049l\\n${doneMarker}\\n'`,
    `printf '${doneMarker}\\n' > '${markerFile}'`,
  ].join("; ");
}

async function markerFileContains(filePath: string, marker: string): Promise<boolean> {
  try {
    const text = await readFile(filePath, "utf8");
    return text.includes(marker);
  } catch {
    return false;
  }
}

async function toggleExplorerAndMeasureLatency(page: Page): Promise<number> {
  const toggle = page.getByTestId("workspace-explorer-toggle").first();
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  const currentlyExpanded = (await toggle.getAttribute("aria-expanded")) === "true";
  const expected = currentlyExpanded ? "false" : "true";

  const start = Date.now();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", expected, { timeout: 15_000 });
  return Date.now() - start;
}

test("workspace terminal responsiveness benchmark (report-only, single stress profile)", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const repo = await createTempGitRepo("paseo-e2e-terminal-benchmark-");
  const markerFilePath = path.join(repo.path, ".paseo-terminal-benchmark-marker");

  try {
    const serverId = process.env.E2E_SERVER_ID;
    if (!serverId) {
      throw new Error("E2E_SERVER_ID is not set.");
    }

    await openNewAgentComposer(page);
    await setWorkingDirectory(page, repo.path);
    await seedWorkspaceActivity(page, `terminal benchmark seed ${Date.now()}`);

    await switchWorkspaceViaSidebar({ page, serverId, targetWorkspacePath: repo.path });
    await expect(page.getByTestId("workspace-new-terminal-tab").first()).toBeVisible({
      timeout: 30_000,
    });

    const newTerminalButton = page.getByTestId("workspace-new-terminal-tab").first();
    await expect(newTerminalButton).toBeVisible({ timeout: 30_000 });
    await newTerminalButton.click();

    const surface = page.locator('[data-testid="terminal-surface"]:visible').first();
    await expect(surface).toBeVisible({ timeout: 60_000 });
    await surface.click({ force: true });

    await page.evaluate(() => {
      const monitor = {
        samples: [] as number[],
        active: true,
        rafId: 0,
        lastTs: performance.now(),
      };

      const tick = (ts: number) => {
        if (!monitor.active) {
          return;
        }
        monitor.samples.push(ts - monitor.lastTs);
        monitor.lastTs = ts;
        monitor.rafId = requestAnimationFrame(tick);
      };

      monitor.rafId = requestAnimationFrame(tick);

      (window as { __PASEO_E2E_RAF_MONITOR__?: { stop: () => { samples: number[] } } }).__PASEO_E2E_RAF_MONITOR__ =
        {
          stop: () => {
            if (!monitor.active) {
              return { samples: monitor.samples };
            }
            monitor.active = false;
            cancelAnimationFrame(monitor.rafId);
            return { samples: monitor.samples };
          },
        };
    });

    const doneMarker = `TERMINAL_BENCH_DONE_${Date.now()}`;
    const postMarker = `TERMINAL_BENCH_POST_${Date.now()}`;
    const stressCommand = buildStressCommand(doneMarker);
    await page.keyboard.type(stressCommand, { delay: 0 });
    await page.keyboard.press("Enter");

    const interactionLatenciesMs: number[] = [];
    for (let attempt = 0; attempt < 18; attempt += 1) {
      const latency = await toggleExplorerAndMeasureLatency(page);
      interactionLatenciesMs.push(latency);
    }

    const rafResult = await page.evaluate(() => {
      const handle = (
        window as { __PASEO_E2E_RAF_MONITOR__?: { stop: () => { samples: number[] } } }
      ).__PASEO_E2E_RAF_MONITOR__;
      if (!handle || typeof handle.stop !== "function") {
        return { samples: [] as number[] };
      }
      return handle.stop();
    });

    await surface.click({ force: true });
    await page.keyboard.type(`echo ${postMarker} >> .paseo-terminal-benchmark-marker`, { delay: 0 });
    await page.keyboard.press("Enter");
    await expect.poll(async () => await markerFileContains(markerFilePath, postMarker), {
      timeout: 120_000,
    }).toBe(true);

    const frameGapsMs = (rafResult.samples ?? []).filter(
      (sample) => Number.isFinite(sample) && sample > 0
    );
    const report = {
      mode: "report-only",
      profile: "single-stress",
      generatedAt: new Date().toISOString(),
      workload: {
        frames: 240,
        rowsPerFrame: 24,
        frameSleepMs: 10,
        doneMarker,
        postMarker,
        doneMarkerObserved: await markerFileContains(markerFilePath, doneMarker),
      },
      frameGapMs: {
        ...summarize(frameGapsMs),
        over100Ms: frameGapsMs.filter((gap) => gap > 100).length,
        over250Ms: frameGapsMs.filter((gap) => gap > 250).length,
        over500Ms: frameGapsMs.filter((gap) => gap > 500).length,
      },
      explorerToggleLatencyMs: summarize(interactionLatenciesMs),
    };

    await testInfo.attach("terminal-responsiveness-report", {
      body: JSON.stringify(report, null, 2),
      contentType: "application/json",
    });
  } finally {
    await repo.cleanup();
  }
});
