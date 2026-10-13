import { formatSystemNotificationPrompt } from "../agent/agent-messages/index.js";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { curateAgentActivity } from "../agent/activity-curator.js";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { startAgentRun, type AgentRunController } from "../agent/agent-prompt.js";
import { resolveCreateAgentTitles } from "../agent/create-agent-title.js";
import { type BoundCreateAgentCommand, formatProviderModel } from "../agent/create-agent/create.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import { ScheduleStore } from "./store.js";
import { computeNextRunAt, validateScheduleCadence } from "./cron.js";
import type {
  CreateScheduleInput,
  ScheduleExecutionResult,
  ScheduleRun,
  ScheduleTarget,
  StoredSchedule,
  UpdateScheduleInput,
  UpdateScheduleNewAgentConfig,
} from "@getpaseo/protocol/schedule/types";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";

const SCHEDULE_TICK_INTERVAL_MS = 1000;

// How often a heartbeat re-checks a busy target when the agent manager reports it
// as waiting (e.g. on a permission prompt) but still in flight, so the event wait
// returns at once and would otherwise spin.
const TARGET_BUSY_POLL_INTERVAL_MS = 1000;

// A run failed because its target no longer exists: the agent was deleted or
// archived, or a new-agent cwd was removed. These are permanent, so the schedule
// is completed instead of retried until it burns down to its expiry.
export class ScheduleTargetGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleTargetGoneError";
  }
}

export class ScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`Schedule not found: ${id}`);
    this.name = "ScheduleNotFoundError";
  }
}

export class ScheduleStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleStateConflictError";
  }
}

function advanceNextRunAtPast(
  cadence: StoredSchedule["cadence"],
  nextRunAt: Date,
  now: Date,
): Date {
  let next = nextRunAt;
  while (next.getTime() <= now.getTime()) {
    next = computeNextRunAt(cadence, next);
  }
  return next;
}

// A heartbeat fired while its target agent was mid-turn and the target did not go
// idle before the wait gave up. The run never reached the target, so it is recorded
// as undelivered and does not count against maxRuns.
export class ScheduleTargetBusyError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} was still busy; the heartbeat was not delivered`);
    this.name = "ScheduleTargetBusyError";
  }
}

// Handed to a runner so it can stop waiting once its run has been abandoned.
export interface ScheduleRunControl {
  // Aborted when the run exceeds the schedule's runTimeoutMs.
  signal: AbortSignal;
  // True while the runner is only waiting for its target to go idle (nothing has been
  // delivered yet). A timeout in that phase is an undelivered run, not a failed one.
  waitingForTarget: boolean;
}

function trimOptionalName(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildScheduleFireBody(schedule: StoredSchedule, runId: string): string {
  const heading = schedule.name
    ? `Schedule "${schedule.name}" fired (id=${schedule.id}, run=${runId}).`
    : `Schedule fired (id=${schedule.id}, run=${runId}).`;
  return `${heading}\n${schedule.prompt}`;
}

function normalizePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    throw new Error("Schedule prompt is required");
  }
  return trimmed;
}

function applyNewAgentConfig(
  target: Extract<ScheduleTarget, { type: "new-agent" }>,
  patch: UpdateScheduleNewAgentConfig,
): Extract<ScheduleTarget, { type: "new-agent" }> {
  const config = { ...target.config };
  if (patch.provider !== undefined) {
    const trimmed = patch.provider.trim();
    if (!trimmed) {
      throw new Error("provider cannot be empty");
    }
    config.provider = trimmed;
  }
  if (patch.cwd !== undefined) {
    const trimmed = patch.cwd.trim();
    if (!trimmed) {
      throw new Error("cwd cannot be empty");
    }
    config.cwd = trimmed;
  }
  if (patch.model !== undefined) {
    const trimmed = patch.model?.trim();
    if (trimmed) {
      config.model = trimmed;
    } else {
      delete config.model;
    }
  }
  if (patch.modeId !== undefined) {
    const trimmed = patch.modeId?.trim();
    if (trimmed) {
      config.modeId = trimmed;
    } else {
      delete config.modeId;
    }
  }
  if (patch.thinkingOptionId !== undefined) {
    const trimmed = patch.thinkingOptionId?.trim();
    if (trimmed) {
      config.thinkingOptionId = trimmed;
    } else {
      delete config.thinkingOptionId;
    }
  }
  if (patch.archiveOnFinish !== undefined) {
    config.archiveOnFinish = patch.archiveOnFinish;
  }
  if (patch.isolation !== undefined) {
    config.isolation = patch.isolation;
  }
  return { ...target, config };
}

function normalizeMaxRuns(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxRuns must be a positive integer");
  }
  return value;
}

function normalizeRunTimeoutMs(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("runTimeoutMs must be a positive integer");
  }
  return value;
}

function formatRunTimeout(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const parts = [
    hours > 0 ? `${hours}h` : "",
    minutes > 0 ? `${minutes}m` : "",
    seconds > 0 ? `${seconds}s` : "",
    millis > 0 ? `${millis}ms` : "",
  ].filter(Boolean);
  return parts.join("") || "0s";
}

// A run that never reached its target (delivered === false) is not a use of the
// schedule's maxRuns.
function countCompletedRuns(schedule: StoredSchedule): number {
  return schedule.runs.filter((run) => run.status !== "running" && run.delivered !== false).length;
}

// The slot a busy-target wait gives up at. A claim advances nextRunAt, except for the
// final allowed run, which clears it; that run still has a following slot to bound its
// wait by, because an undelivered run is re-armed (see finishRun). A paused schedule's
// manual run has no upcoming slot.
function nextSlotForBusyWait(schedule: StoredSchedule, runId: string): Date | null {
  if (schedule.nextRunAt) {
    return new Date(schedule.nextRunAt);
  }
  const run = schedule.runs.find((candidate) => candidate.id === runId);
  if (schedule.status !== "active" || !run) {
    return null;
  }
  return computeNextRunAt(schedule.cadence, new Date(run.scheduledFor));
}

function shouldArchiveScheduleRunWorkspace(input: {
  agentId: string | null;
  archiveOnFinish?: boolean;
}): boolean {
  return input.agentId === null || (input.archiveOnFinish ?? true);
}

function shouldCompleteSchedule(schedule: StoredSchedule, now: Date): boolean {
  if (schedule.expiresAt && new Date(schedule.expiresAt).getTime() <= now.getTime()) {
    return true;
  }
  if (schedule.maxRuns == null) {
    return false;
  }
  return countCompletedRuns(schedule) >= schedule.maxRuns;
}

function requireSchedule(schedule: StoredSchedule | null, id: string): StoredSchedule {
  if (!schedule) {
    throw new ScheduleNotFoundError(id);
  }
  return schedule;
}

function completeSchedule(schedule: StoredSchedule, now: Date): StoredSchedule {
  return {
    ...schedule,
    status: "completed",
    nextRunAt: null,
    pausedAt: null,
    updatedAt: now.toISOString(),
  };
}

function mergeScheduleCadenceTimezone(
  current: StoredSchedule["cadence"],
  next: StoredSchedule["cadence"],
): StoredSchedule["cadence"] {
  if (
    current.type === "cron" &&
    next.type === "cron" &&
    next.timezone === undefined &&
    current.timezone !== undefined
  ) {
    return {
      ...next,
      timezone: current.timezone,
    };
  }
  return next;
}

function buildRunOutput(params: {
  output: string | null;
  timelineText: string;
  finalText: string;
}): string | null {
  if (params.output && params.output.trim().length > 0) {
    return params.output;
  }
  if (params.finalText.trim().length > 0) {
    return params.finalText.trim();
  }
  if (params.timelineText.trim().length > 0) {
    return params.timelineText.trim();
  }
  return null;
}

type ScheduleAgentManager = Pick<
  AgentRunController,
  | "getAgent"
  | "reloadAgentSession"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "steerOrReplaceActiveTurn"
  | "streamAgent"
> &
  Pick<
    AgentManager,
    | "createAgent"
    | "getRegisteredProviderIds"
    | "hydrateTimelineFromProvider"
    | "resumeAgentFromPersistence"
    | "runAgent"
    | "waitForAgentEvent"
    | "waitForAgentClose"
    | "cancelAgentRun"
  >;

interface ScheduleWorkspaceCreateInput {
  cwd: string;
  firstAgentContext: FirstAgentContext;
}

export interface ScheduleServiceOptions {
  paseoHome: string;
  logger: Logger;
  agentManager: ScheduleAgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  createDirectoryWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<PersistedWorkspaceRecord>;
  createPaseoWorktreeWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  now?: () => Date;
  runner?: (
    schedule: StoredSchedule,
    runId: string,
    control: ScheduleRunControl,
  ) => Promise<ScheduleExecutionResult>;
}

export class ScheduleService {
  private readonly store: ScheduleStore;
  private readonly logger: Logger;
  private readonly agentManager: ScheduleAgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly createAgent: BoundCreateAgentCommand;
  private readonly createDirectoryWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<PersistedWorkspaceRecord>;
  private readonly createPaseoWorktreeWorkspace: (
    input: ScheduleWorkspaceCreateInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  private readonly archiveWorkspace: (workspaceId: string) => Promise<void>;
  private readonly now: () => Date;
  private readonly runner: (
    schedule: StoredSchedule,
    runId: string,
    control: ScheduleRunControl,
  ) => Promise<ScheduleExecutionResult>;
  private readonly runningScheduleIds = new Set<string>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ScheduleServiceOptions) {
    this.logger = options.logger.child({ module: "schedule-service" });
    this.store = new ScheduleStore(join(options.paseoHome, "schedules"), this.logger);
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.createAgent = options.createAgent;
    this.createDirectoryWorkspace = options.createDirectoryWorkspace;
    this.createPaseoWorktreeWorkspace = options.createPaseoWorktreeWorkspace;
    this.archiveWorkspace = options.archiveWorkspace;
    this.now = options.now ?? (() => new Date());
    this.runner =
      options.runner ??
      ((schedule, runId, control) => this.executeSchedule(schedule, runId, control));
  }

  async start(): Promise<void> {
    await this.recoverInterruptedRuns();
    await this.sweepOrphanedSchedules();
    if (this.tickTimer) {
      return;
    }
    const timer = setInterval(() => {
      void this.tick().catch((error) => {
        this.logger.error({ err: error }, "Failed to process schedule tick");
      });
    }, SCHEDULE_TICK_INTERVAL_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.tickTimer = timer;
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  async create(input: CreateScheduleInput): Promise<StoredSchedule> {
    const prompt = normalizePrompt(input.prompt);
    validateScheduleCadence(input.cadence);
    return this.createScheduleRecord(input, {
      name: trimOptionalName(input.name),
      prompt,
      target: input.target,
    });
  }

  private async createScheduleRecord(
    input: CreateScheduleInput,
    fields: { name: string | null; prompt: string; target: ScheduleTarget },
  ): Promise<StoredSchedule> {
    return this.store.create(this.buildScheduleRecord(input, fields));
  }

  private buildScheduleRecord(
    input: CreateScheduleInput,
    fields: { name: string | null; prompt: string; target: ScheduleTarget },
  ): Omit<StoredSchedule, "id"> {
    const now = this.now();
    const runOnCreate = input.runOnCreate ?? input.cadence.type === "every";
    const nextRunAt = runOnCreate ? now : computeNextRunAt(input.cadence, now);
    return {
      name: fields.name,
      prompt: fields.prompt,
      cadence: input.cadence,
      target: fields.target,
      status: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      nextRunAt: nextRunAt.toISOString(),
      lastRunAt: null,
      pausedAt: null,
      expiresAt: input.expiresAt ?? null,
      maxRuns: normalizeMaxRuns(input.maxRuns),
      runTimeoutMs: normalizeRunTimeoutMs(input.runTimeoutMs),
      createdByAgentId: input.createdByAgentId ?? null,
      runs: [],
    };
  }

  // Idempotent create for the MCP write path: repeating a create with the same
  // name and target (e.g. babysit-pr re-registering its heartbeat) refreshes the
  // existing non-completed schedule in place instead of minting a duplicate.
  async createOrReplace(input: CreateScheduleInput): Promise<StoredSchedule> {
    const name = trimOptionalName(input.name);
    const prompt = normalizePrompt(input.prompt);
    validateScheduleCadence(input.cadence);
    if (name === null) {
      return this.createScheduleRecord(input, { name, prompt, target: input.target });
    }

    const inputTarget = input.target;
    return this.store.upsertByNameAndTarget(name, inputTarget, {
      create: async () => {
        return this.buildScheduleRecord(input, { name, prompt, target: inputTarget });
      },
      update: async (current) => {
        const now = this.now();
        const cadence = mergeScheduleCadenceTimezone(current.cadence, input.cadence);
        const runOnCreate = input.runOnCreate ?? cadence.type === "every";
        const nextRunAt = runOnCreate ? now : computeNextRunAt(cadence, now);
        return {
          ...current,
          name,
          prompt,
          cadence,
          target: inputTarget,
          status: "active",
          pausedAt: null,
          nextRunAt: nextRunAt.toISOString(),
          expiresAt: input.expiresAt ?? null,
          maxRuns: normalizeMaxRuns(input.maxRuns),
          runTimeoutMs: normalizeRunTimeoutMs(input.runTimeoutMs),
          // An upsert records the latest caller, not the original one: that caller set
          // the cadence and prompt the schedule now runs with, and a caller that is not
          // an agent clears the field rather than leaving a stale agent id on it.
          createdByAgentId: input.createdByAgentId ?? null,
          updatedAt: now.toISOString(),
        };
      },
    });
  }

  async list(): Promise<StoredSchedule[]> {
    return this.store.list();
  }

  async inspect(id: string): Promise<StoredSchedule> {
    const schedule = await this.store.get(id);
    return requireSchedule(schedule, id);
  }

  async logs(id: string): Promise<ScheduleRun[]> {
    const schedule = await this.inspect(id);
    return [...schedule.runs].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  async pause(id: string): Promise<StoredSchedule> {
    const paused = await this.store.update(id, (schedule) => {
      if (schedule.status === "completed") {
        throw new ScheduleStateConflictError(`Schedule ${id} is already completed`);
      }
      if (schedule.status === "paused") {
        return schedule;
      }
      const now = this.now();
      return {
        ...schedule,
        status: "paused" as const,
        nextRunAt: null,
        pausedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
    });
    return requireSchedule(paused, id);
  }

  async resume(id: string): Promise<StoredSchedule> {
    const resumed = await this.store.update(id, (schedule) => {
      if (schedule.status === "completed") {
        throw new ScheduleStateConflictError(`Schedule ${id} is already completed`);
      }
      if (schedule.status === "active") {
        return schedule;
      }
      const now = this.now();
      return {
        ...schedule,
        status: "active" as const,
        pausedAt: null,
        nextRunAt: computeNextRunAt(schedule.cadence, now).toISOString(),
        updatedAt: now.toISOString(),
      };
    });
    return requireSchedule(resumed, id);
  }

  async update(input: UpdateScheduleInput): Promise<StoredSchedule> {
    const next = await this.store.update(input.id, async (schedule) => {
      const now = this.now();
      let updated: StoredSchedule = schedule;

      if (input.prompt !== undefined) {
        updated = { ...updated, prompt: normalizePrompt(input.prompt) };
      }

      if (input.name !== undefined) {
        updated = { ...updated, name: trimOptionalName(input.name) };
      }

      if (input.cadence !== undefined) {
        const cadence = mergeScheduleCadenceTimezone(updated.cadence, input.cadence);
        validateScheduleCadence(cadence);
        const nextRunAt =
          updated.status === "active" ? computeNextRunAt(cadence, now).toISOString() : null;
        updated = { ...updated, cadence, nextRunAt };
      }

      if (input.newAgentConfig !== undefined) {
        if (updated.target.type !== "new-agent") {
          throw new Error("new-agent config updates are only valid for new-agent target schedules");
        }
        const patchedTarget = applyNewAgentConfig(updated.target, input.newAgentConfig);
        updated = {
          ...updated,
          target: patchedTarget,
        };
      }

      if (input.maxRuns !== undefined) {
        updated = { ...updated, maxRuns: normalizeMaxRuns(input.maxRuns) };
      }

      if (input.expiresAt !== undefined) {
        updated = { ...updated, expiresAt: input.expiresAt };
      }

      return { ...updated, updatedAt: now.toISOString() };
    });
    return requireSchedule(next, input.id);
  }

  async delete(id: string): Promise<void> {
    await this.store.delete(id);
  }

  async completeForAgent(agentId: string): Promise<number> {
    const now = this.now();
    const schedules = await this.store.list();
    const matches = schedules.filter(
      (schedule) =>
        schedule.target.type === "agent" &&
        schedule.target.agentId === agentId &&
        schedule.status !== "completed",
    );
    const results = await Promise.allSettled(
      matches.map((schedule) => this.completeScheduleForAgent(schedule.id, agentId, now)),
    );
    let completed = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled" && result.value) {
        completed += 1;
      } else if (result.status === "rejected") {
        this.logger.warn(
          {
            err: result.reason,
            scheduleId: matches[index].id,
            agentId,
          },
          "Failed to complete schedule for archived agent; continuing",
        );
      }
    }
    return completed;
  }

  private async completeScheduleForAgent(
    scheduleId: string,
    agentId: string,
    now: Date,
  ): Promise<boolean> {
    let completed = false;
    const updated = await this.store.update(scheduleId, (schedule) => {
      if (
        schedule.target.type !== "agent" ||
        schedule.target.agentId !== agentId ||
        schedule.status === "completed"
      ) {
        return schedule;
      }
      completed = true;
      return completeSchedule(schedule, now);
    });
    requireSchedule(updated, scheduleId);
    return completed;
  }

  async runOnce(id: string): Promise<StoredSchedule> {
    const schedule = await this.inspect(id);
    if (schedule.status === "completed") {
      throw new ScheduleStateConflictError(`Schedule ${id} is already completed`);
    }
    if (this.runningScheduleIds.has(id)) {
      throw new ScheduleStateConflictError(`Schedule ${id} is already running`);
    }
    await this.runSchedule(schedule, this.now(), { manual: true });
    return this.inspect(id);
  }

  async tick(): Promise<void> {
    const now = this.now();
    const schedules = await this.store.list();
    // Runs are started without being awaited so one slow agent turn cannot hold up
    // every schedule listed after it. The tick still resolves only once all of them
    // have finished.
    const runs: Array<Promise<void>> = [];
    let results: Array<PromiseSettledResult<void>> = [];
    try {
      for (const schedule of schedules) {
        if (schedule.status !== "active" || !schedule.nextRunAt) {
          continue;
        }
        if (this.runningScheduleIds.has(schedule.id)) {
          continue;
        }
        if (shouldCompleteSchedule(schedule, now)) {
          await this.completeScheduleIfDue(schedule.id, now);
          continue;
        }
        if (new Date(schedule.nextRunAt).getTime() > now.getTime()) {
          continue;
        }
        const run = this.runSchedule(schedule, now);
        // Marks the rejection as handled while the loop is still awaiting something
        // else; the outcome is read from the allSettled below.
        run.catch(() => undefined);
        runs.push(run);
      }
    } finally {
      results = await Promise.allSettled(runs);
    }
    // Runner failures are recorded on the run, so a rejection here means the run
    // could not be recorded. Surface it to the caller only after every other run
    // has settled; the interval logs it.
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    for (const error of failures.slice(1)) {
      this.logger.error({ err: error }, "Failed to run schedule");
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  }

  private async completeScheduleIfDue(scheduleId: string, now: Date): Promise<void> {
    const updated = await this.store.update(scheduleId, (schedule) => {
      if (
        schedule.status !== "active" ||
        !schedule.nextRunAt ||
        !shouldCompleteSchedule(schedule, now)
      ) {
        return schedule;
      }
      return completeSchedule(schedule, now);
    });
    requireSchedule(updated, scheduleId);
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const schedules = await this.store.list();
    const now = this.now();
    await Promise.all(
      schedules.map((schedule) => this.recoverInterruptedSchedule(schedule.id, now)),
    );
  }

  private async recoverInterruptedSchedule(scheduleId: string, now: Date): Promise<void> {
    const interruptedWorkspaces: Array<{
      workspaceId: string;
      agentId: string | null;
      runId: string;
    }> = [];
    await this.store.update(scheduleId, (current) => {
      let updated = { ...current };
      let dirty = false;

      const runningIndex = updated.runs.findIndex((run) => run.status === "running");
      if (runningIndex !== -1) {
        const runs = [...updated.runs];
        const runningRun = runs[runningIndex];
        if (
          updated.target.type === "new-agent" &&
          runningRun.workspaceId &&
          shouldArchiveScheduleRunWorkspace({
            agentId: runningRun.agentId,
            archiveOnFinish: updated.target.config.archiveOnFinish,
          })
        ) {
          interruptedWorkspaces.push({
            workspaceId: runningRun.workspaceId,
            agentId: runningRun.agentId,
            runId: runningRun.id,
          });
        }
        runs[runningIndex] = {
          ...runningRun,
          status: "failed",
          endedAt: now.toISOString(),
          error: "Daemon restarted before the scheduled run completed",
        };
        updated = { ...updated, runs };
        if (shouldCompleteSchedule(updated, now)) {
          updated = completeSchedule(updated, now);
        }
        dirty = true;
      }

      if (
        updated.status === "active" &&
        updated.nextRunAt &&
        new Date(updated.nextRunAt).getTime() <= now.getTime()
      ) {
        let nextRunAt = computeNextRunAt(updated.cadence, new Date(updated.nextRunAt));
        while (nextRunAt.getTime() <= now.getTime()) {
          nextRunAt = computeNextRunAt(updated.cadence, nextRunAt);
        }
        updated = { ...updated, nextRunAt: nextRunAt.toISOString() };
        dirty = true;
      }

      if (dirty) {
        return { ...updated, updatedAt: now.toISOString() };
      }
      return current;
    });
    const interruptedWorkspace = interruptedWorkspaces[0];
    if (!interruptedWorkspace) {
      return;
    }
    try {
      await this.archiveWorkspace(interruptedWorkspace.workspaceId);
    } catch (error) {
      this.logger.warn(
        {
          err: error,
          agentId: interruptedWorkspace.agentId,
          workspaceId: interruptedWorkspace.workspaceId,
          scheduleId,
          runId: interruptedWorkspace.runId,
        },
        "Failed to archive interrupted scheduled workspace after daemon restart",
      );
    }
  }

  // Orphaned agent-target schedules (agent deleted while the daemon was down, or
  // archived before completeForAgent existed) can never fire successfully. Complete
  // them on startup so they stop ticking and surface as ended in the UI.
  private async sweepOrphanedSchedules(): Promise<void> {
    const now = this.now();
    const schedules = await this.store.list();
    await Promise.all(schedules.map((schedule) => this.sweepOrphanedSchedule(schedule.id, now)));
  }

  private async sweepOrphanedSchedule(scheduleId: string, now: Date): Promise<void> {
    await this.store.update(scheduleId, async (schedule) => {
      if (schedule.target.type !== "agent" || schedule.status === "completed") {
        return schedule;
      }
      const record = await this.agentStorage.get(schedule.target.agentId);
      if (record && !record.archivedAt) {
        return schedule;
      }
      return completeSchedule(schedule, now);
    });
  }

  private async runSchedule(
    schedule: StoredSchedule,
    now: Date,
    options?: { manual?: boolean },
  ): Promise<void> {
    const manual = options?.manual === true;
    // Reserve before store I/O; persisted history cannot prove a run is still alive.
    this.runningScheduleIds.add(schedule.id);
    try {
      let runId: string;
      let scheduleWithRun: StoredSchedule;
      if (manual) {
        runId = randomUUID();
        const runningRun: ScheduleRun = {
          id: runId,
          scheduledFor: now.toISOString(),
          startedAt: now.toISOString(),
          endedAt: null,
          status: "running",
          agentId: null,
          output: null,
          error: null,
        };
        scheduleWithRun = await this.appendRunningRun(schedule.id, runningRun);
      } else {
        const claimed = await this.claimDueRun(schedule.id, now);
        if (!claimed) {
          return;
        }
        ({ schedule: scheduleWithRun, runId } = claimed);
      }

      const controller = new AbortController();
      const control: ScheduleRunControl = { signal: controller.signal, waitingForTarget: false };
      const timeoutMs = scheduleWithRun.runTimeoutMs ?? null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      try {
        const runnerPromise = this.runner(scheduleWithRun, runId, control);
        // After a timeout the runner is abandoned; its late rejection must not surface
        // as an unhandled rejection.
        runnerPromise.catch(() => undefined);
        const outcome =
          timeoutMs === null
            ? await runnerPromise
            : await Promise.race([
                runnerPromise,
                new Promise<typeof RUN_TIMED_OUT>((resolve) => {
                  timeoutTimer = setTimeout(() => resolve(RUN_TIMED_OUT), timeoutMs);
                }),
              ]);
        if (outcome === RUN_TIMED_OUT) {
          await this.finishTimedOutRun({
            schedule: scheduleWithRun,
            runId,
            timeoutMs: timeoutMs ?? 0,
            controller,
            control,
            manual,
          });
          return;
        }
        const result = outcome;
        await this.finishRun({
          scheduleId: schedule.id,
          runId,
          status: "succeeded",
          agentId: result.agentId,
          output: result.output,
          error: null,
          targetGone: false,
          manual,
        });
      } catch (error) {
        await this.finishRun({
          scheduleId: schedule.id,
          runId,
          status: "failed",
          agentId: null,
          output: null,
          error: error instanceof Error ? error.message : String(error),
          targetGone: error instanceof ScheduleTargetGoneError,
          manual,
          ...(error instanceof ScheduleTargetBusyError ? { delivered: false as const } : {}),
        });
      } finally {
        if (timeoutTimer !== null) {
          clearTimeout(timeoutTimer);
        }
      }
    } finally {
      this.runningScheduleIds.delete(schedule.id);
    }
  }

  // The run outlasted the schedule's runTimeoutMs. Stop waiting for it and record the
  // outcome now: the runner's own result, if it ever arrives, is dropped because this
  // is the only finishRun for the run.
  private async finishTimedOutRun(params: {
    schedule: StoredSchedule;
    runId: string;
    timeoutMs: number;
    controller: AbortController;
    control: ScheduleRunControl;
    manual: boolean;
  }): Promise<void> {
    const { schedule, runId, timeoutMs, controller, control, manual } = params;
    const stillWaitingForTarget = control.waitingForTarget;
    const timeoutError = new Error(`Run timed out after ${formatRunTimeout(timeoutMs)}`);
    controller.abort(timeoutError);

    // Best-effort stop of the stuck work. Only a new-agent run owns its agent; an
    // agent target's turn belongs to someone else, so the wait is abandoned and the
    // turn is left alone.
    if (schedule.target.type === "new-agent") {
      const stuckAgentId = await this.findRunAgentId(schedule.id, runId);
      if (stuckAgentId) {
        void this.interruptTimedOutAgent(schedule.id, runId, stuckAgentId);
      }
    }

    await this.finishRun({
      scheduleId: schedule.id,
      runId,
      status: "failed",
      agentId: null,
      output: null,
      error:
        stillWaitingForTarget && schedule.target.type === "agent"
          ? new ScheduleTargetBusyError(schedule.target.agentId).message
          : timeoutError.message,
      targetGone: false,
      manual,
      ...(stillWaitingForTarget ? { delivered: false as const } : {}),
    });
  }

  private async findRunAgentId(scheduleId: string, runId: string): Promise<string | null> {
    try {
      const stored = await this.store.get(scheduleId);
      return stored?.runs.find((run) => run.id === runId)?.agentId ?? null;
    } catch (error) {
      this.logger.warn({ err: error, scheduleId, runId }, "Failed to look up timed-out run agent");
      return null;
    }
  }

  private async interruptTimedOutAgent(
    scheduleId: string,
    runId: string,
    agentId: string,
  ): Promise<void> {
    try {
      await this.agentManager.cancelAgentRun(agentId);
    } catch (error) {
      this.logger.warn(
        { err: error, scheduleId, runId, agentId },
        "Failed to cancel the agent of a timed-out scheduled run",
      );
    }
  }

  private async claimDueRun(
    scheduleId: string,
    now: Date,
  ): Promise<{ schedule: StoredSchedule; runId: string } | null> {
    let claimed: { schedule: StoredSchedule; runId: string } | null = null;
    const updatedSchedule = await this.store.update(scheduleId, (schedule) => {
      if (
        schedule.status !== "active" ||
        !schedule.nextRunAt ||
        shouldCompleteSchedule(schedule, now) ||
        new Date(schedule.nextRunAt).getTime() > now.getTime()
      ) {
        return schedule;
      }

      const scheduledFor = schedule.nextRunAt;
      const isFinalRun =
        schedule.maxRuns !== null && countCompletedRuns(schedule) + 1 >= schedule.maxRuns;
      const nextRunAt = isFinalRun
        ? null
        : advanceNextRunAtPast(
            schedule.cadence,
            computeNextRunAt(schedule.cadence, new Date(scheduledFor)),
            now,
          ).toISOString();

      // Claim the due slot and advance its cursor in the same serialized update.
      // A tick can hold a stale list while another tick finishes this schedule.
      const runId = randomUUID();
      const runningRun: ScheduleRun = {
        id: runId,
        scheduledFor,
        startedAt: now.toISOString(),
        endedAt: null,
        status: "running",
        agentId: null,
        output: null,
        error: null,
      };
      const updated: StoredSchedule = {
        ...schedule,
        nextRunAt,
        updatedAt: now.toISOString(),
        runs: [...schedule.runs, runningRun],
      };
      claimed = { schedule: updated, runId };
      return updated;
    });
    requireSchedule(updatedSchedule, scheduleId);
    return claimed;
  }

  private async appendRunningRun(
    scheduleId: string,
    runningRun: ScheduleRun,
  ): Promise<StoredSchedule> {
    const updated = await this.store.update(scheduleId, (schedule) => ({
      ...schedule,
      updatedAt: runningRun.startedAt,
      runs: [...schedule.runs, runningRun],
    }));
    return requireSchedule(updated, scheduleId);
  }

  private async finishRun(params: {
    scheduleId: string;
    runId: string;
    status: "succeeded" | "failed";
    agentId: string | null;
    output: string | null;
    error: string | null;
    targetGone: boolean;
    manual: boolean;
    // false when the run never reached its target; see countCompletedRuns.
    delivered?: false;
  }): Promise<void> {
    const updatedSchedule = await this.store.update(params.scheduleId, (schedule) => {
      const now = this.now();
      const completedRuns = schedule.runs.map((run) =>
        run.id === params.runId
          ? {
              ...run,
              status: params.status,
              endedAt: now.toISOString(),
              agentId: params.agentId ?? run.agentId,
              output: params.output,
              error: params.error,
              ...(params.delivered === false ? { delivered: false } : {}),
            }
          : run,
      );
      let updated: StoredSchedule = {
        ...schedule,
        runs: completedRuns,
        lastRunAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };

      if (params.targetGone) {
        // The target is permanently gone; retrying only burns the schedule down to
        // its expiry, so complete it now regardless of manual/scheduled origin.
        updated = completeSchedule(updated, now);
      } else if (updated.status === "completed") {
        // Completed concurrently (e.g. the target agent was archived mid-run);
        // record the run outcome but leave the schedule terminal — don't advance.
      } else if (params.manual) {
        // Manual one-shot runs do not advance the cadence or recompute completion.
      } else if (shouldCompleteSchedule(updated, now)) {
        updated = completeSchedule(updated, now);
      } else if (updated.status === "paused") {
        updated = {
          ...updated,
          nextRunAt: null,
        };
      } else if (params.delivered === false) {
        // The wait for a busy target gave up when the next slot came due. That slot
        // was not consumed by this run, so leave it due for the next tick instead of
        // skipping it as an elapsed one.
        if (updated.nextRunAt === null) {
          // The claim took this for the final allowed run and cleared the cursor, but an
          // undelivered run does not count against maxRuns (see countCompletedRuns), so
          // the schedule still has runs left. Re-arm the slot after the one this run took.
          const finishedRun = completedRuns.find((run) => run.id === params.runId)!;
          updated = {
            ...updated,
            nextRunAt: computeNextRunAt(
              updated.cadence,
              new Date(finishedRun.scheduledFor),
            ).toISOString(),
          };
        }
      } else {
        // A final slot has no successor until its run limit is raised or cleared.
        // Every runner invocation has a recorded run with this id.
        const finishedRun = completedRuns.find((run) => run.id === params.runId)!;
        const nextRunAt = updated.nextRunAt
          ? new Date(updated.nextRunAt)
          : computeNextRunAt(updated.cadence, new Date(finishedRun.scheduledFor));
        // Move an overdue cursor past a long run without advancing a future one twice.
        updated = {
          ...updated,
          nextRunAt: advanceNextRunAtPast(updated.cadence, nextRunAt, now).toISOString(),
        };
      }

      return updated;
    });
    requireSchedule(updatedSchedule, params.scheduleId);
  }

  private async recordRunWorkspace(params: {
    scheduleId: string;
    runId: string;
    workspaceId: string;
    agentId: string | null;
  }): Promise<void> {
    const updatedSchedule = await this.store.update(params.scheduleId, (schedule) => ({
      ...schedule,
      updatedAt: this.now().toISOString(),
      runs: schedule.runs.map((run) =>
        run.id === params.runId && run.status === "running"
          ? {
              ...run,
              workspaceId: params.workspaceId,
              agentId: params.agentId,
            }
          : run,
      ),
    }));
    requireSchedule(updatedSchedule, params.scheduleId);
  }

  private async executeSchedule(
    schedule: StoredSchedule,
    runId: string,
    control: ScheduleRunControl = { signal: new AbortController().signal, waitingForTarget: false },
  ): Promise<ScheduleExecutionResult> {
    if (schedule.target.type === "agent") {
      return this.deliverToAgentTarget(schedule, schedule.target.agentId, runId, control);
    }

    const config = schedule.target.type === "new-agent" ? schedule.target.config : null;
    if (!config) {
      throw new Error(`Schedule ${schedule.id} target changed during execution`);
    }
    await this.assertNewAgentCwdDirectory(config.cwd);
    let workspace: PersistedWorkspaceRecord | null = null;
    let agentId: string | null = null;
    try {
      workspace = await this.createScheduleRunWorkspace(config, schedule.prompt);
      await this.recordRunWorkspace({
        scheduleId: schedule.id,
        runId,
        workspaceId: workspace.workspaceId,
        agentId: null,
      });
      const runConfig = { ...config, cwd: workspace.cwd };
      const created = await this.createAgent({
        kind: "mcp",
        provider: formatScheduleProviderModel(runConfig),
        config: buildScheduleAgentConfig(runConfig),
        cwd: workspace.cwd,
        workspaceId: workspace.workspaceId,
        title: resolveScheduleAgentTitle(config, schedule.prompt),
        labels: {
          "paseo.schedule-id": schedule.id,
          "paseo.schedule-run": runId,
        },
        mode: config.modeId,
        thinking: config.thinkingOptionId,
        features: config.featureValues,
        unattended: true,
        promptFailure: "return-error",
        notifyOnFinish: false,
      });
      const agent = created.snapshot;
      agentId = agent.id;
      await this.recordRunWorkspace({
        scheduleId: schedule.id,
        runId,
        workspaceId: workspace.workspaceId,
        agentId,
      });
      if (created.initialPromptError) {
        throw created.initialPromptError;
      }
      const result = await this.agentManager.runAgent(agent.id, schedule.prompt);
      const waitResult = await this.agentManager.waitForAgentEvent(agent.id, {
        waitForActive: true,
        signal: control.signal,
      });
      if (result.canceled) {
        throw new Error(`Scheduled agent ${agent.id} was canceled`);
      }
      if (waitResult.permission) {
        throw new Error(`Scheduled agent ${agent.id} is waiting for permission`);
      }
      if (waitResult.status === "error") {
        throw new Error(waitResult.lastMessage ?? `Scheduled agent ${agent.id} failed`);
      }
      const timelineText = curateAgentActivity(result.timeline);
      return {
        agentId: agent.id,
        output: buildRunOutput({
          output: waitResult.lastMessage ?? null,
          timelineText,
          finalText: result.finalText,
        }),
      };
    } finally {
      if (
        workspace &&
        shouldArchiveScheduleRunWorkspace({ agentId, archiveOnFinish: config.archiveOnFinish })
      ) {
        try {
          await this.archiveWorkspace(workspace.workspaceId);
        } catch (error) {
          this.logger.warn(
            {
              err: error,
              agentId,
              workspaceId: workspace.workspaceId,
              scheduleId: schedule.id,
              runId,
            },
            "Failed to archive scheduled workspace after run",
          );
        }
      }
    }
  }

  private async deliverToAgentTarget(
    schedule: StoredSchedule,
    agentId: string,
    runId: string,
    control: ScheduleRunControl,
  ): Promise<ScheduleExecutionResult> {
    const wrappedPrompt = formatSystemNotificationPrompt(buildScheduleFireBody(schedule, runId));
    const record = await this.agentStorage.get(agentId);
    if (!record) {
      throw new ScheduleTargetGoneError(`Agent ${agentId} no longer exists`);
    }
    if (record.archivedAt) {
      throw new ScheduleTargetGoneError(`Agent ${agentId} is archived`);
    }

    const agent = await ensureAgentLoaded(agentId, {
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      logger: this.logger,
    });
    if (this.agentManager.hasInFlightRun(agent.id)) {
      await this.waitForTargetIdle(agent.id, schedule, runId, control);
    }
    // The run may have been abandoned while the target was busy and gone idle in the
    // same instant; do not deliver on behalf of a run that has been recorded as over.
    control.signal.throwIfAborted();
    await startAgentRun(this.agentManager, agent.id, wrappedPrompt, this.logger, {
      replaceRunning: true,
      activeTurnBehavior: "steer",
    });
    const waitResult = await this.agentManager.waitForAgentEvent(agent.id, {
      waitForActive: true,
      signal: control.signal,
    });
    if (waitResult.permission) {
      throw new Error(`Scheduled agent ${agent.id} is waiting for permission`);
    }
    if (waitResult.status === "error") {
      throw new Error(waitResult.lastMessage ?? `Scheduled agent ${agent.id} failed`);
    }
    return {
      agentId: agent.id,
      output: buildRunOutput({
        output: null,
        timelineText: "",
        finalText: waitResult.lastMessage ?? "",
      }),
    };
  }

  // Waits for a busy heartbeat target to go idle. Gives up, with
  // ScheduleTargetBusyError, when the next slot comes due (the claim has already
  // advanced nextRunAt to it) or the run is abandoned by its timeout.
  private async waitForTargetIdle(
    agentId: string,
    schedule: StoredSchedule,
    runId: string,
    control: ScheduleRunControl,
  ): Promise<void> {
    const waitController = new AbortController();
    const abandon = () => waitController.abort(control.signal.reason);
    const nextSlot = nextSlotForBusyWait(schedule, runId);
    const untilNextSlotMs = nextSlot ? nextSlot.getTime() - this.now().getTime() : 0;
    let slotTimer: ReturnType<typeof setTimeout> | null = null;
    control.waitingForTarget = true;
    if (control.signal.aborted) {
      abandon();
    } else {
      control.signal.addEventListener("abort", abandon, { once: true });
    }
    if (untilNextSlotMs > 0) {
      slotTimer = setTimeout(() => waitController.abort(), untilNextSlotMs);
    } else {
      // No upcoming slot to wait for (manual run of a paused schedule).
      waitController.abort();
    }
    try {
      while (this.agentManager.hasInFlightRun(agentId)) {
        if (waitController.signal.aborted) {
          throw new ScheduleTargetBusyError(agentId);
        }
        try {
          await this.agentManager.waitForAgentEvent(agentId, { signal: waitController.signal });
          if (this.agentManager.hasInFlightRun(agentId)) {
            await sleepUnlessAborted(TARGET_BUSY_POLL_INTERVAL_MS, waitController.signal);
          }
        } catch (error) {
          if (waitController.signal.aborted) {
            throw new ScheduleTargetBusyError(agentId);
          }
          throw error;
        }
      }
    } finally {
      if (slotTimer !== null) {
        clearTimeout(slotTimer);
      }
      control.signal.removeEventListener("abort", abandon);
      control.waitingForTarget = false;
    }
  }

  private async createScheduleRunWorkspace(
    config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
    prompt: string,
  ): Promise<PersistedWorkspaceRecord> {
    const firstAgentContext = { prompt };
    switch (config.isolation ?? "local") {
      case "local":
        return this.createDirectoryWorkspace({ cwd: config.cwd, firstAgentContext });
      case "worktree":
        return (await this.createPaseoWorktreeWorkspace({ cwd: config.cwd, firstAgentContext }))
          .workspace;
    }
  }

  private async assertNewAgentCwdDirectory(cwd: string): Promise<void> {
    try {
      const stats = await stat(cwd);
      if (!stats.isDirectory()) {
        throw new ScheduleTargetGoneError(`Working directory ${cwd} is not a directory`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ScheduleTargetGoneError(`Working directory ${cwd} no longer exists`);
      }
      throw error;
    }
  }
}

const RUN_TIMED_OUT = Symbol("run-timed-out");

// Resolves early, without rejecting, when the signal aborts.
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal }).catch(() => undefined);
}

function buildScheduleAgentConfig(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
): AgentSessionConfig {
  return {
    provider: config.provider,
    cwd: config.cwd,
    modeId: config.modeId,
    model: config.model,
    thinkingOptionId: config.thinkingOptionId,
    title: config.title,
    providerOptions: config.providerOptions,
    featureValues: config.featureValues,
    systemPrompt: config.systemPrompt,
    mcpServers: config.mcpServers as AgentSessionConfig["mcpServers"],
  };
}

function resolveScheduleAgentTitle(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
  prompt: string,
): string {
  return (
    resolveCreateAgentTitles({
      configTitle: config.title,
      initialPrompt: prompt,
    }).provisionalTitle ?? ""
  );
}

function formatScheduleProviderModel(
  config: Extract<ScheduleTarget, { type: "new-agent" }>["config"],
): string {
  return formatProviderModel(config.provider, config.model);
}
