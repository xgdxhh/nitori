import type { SchedulerStorage, ScheduledEvent } from "../storage/scheduler.ts";
import type { CronJobRequest, CronJobResult, ScheduleInfo } from "../types.ts";
import { findNextCronOccurrence } from "./scheduler.ts";
import { normalizeScheduledRunAt } from "./time.ts";

export type ScheduleHandler = (channelKey: string, request: CronJobRequest) => Promise<CronJobResult>;

export function createScheduleHandler(storage: SchedulerStorage, onChanged?: () => void): ScheduleHandler {
  return (channelKey, request) => handleCronJob(storage, onChanged, channelKey, request);
}

async function handleCronJob(
  storage: SchedulerStorage,
  onChanged: (() => void) | undefined,
  channelKey: string,
  request: CronJobRequest,
): Promise<CronJobResult> {
  switch (request.op) {
    case "list":
      return {
        ok: true,
        op: "list",
        schedules: storage.list(channelKey, request.limit ?? 20).map(mapScheduleRow),
      };

    case "get": {
      const id = request.id;
      if (!id) throw new Error("cron_job get requires valid id");
      const row = storage.get(id);
      return { ok: row !== null, op: "get", schedule: row ? mapScheduleRow(row) : null };
    }

    case "cancel": {
      const id = request.id;
      if (!id) throw new Error("cron_job cancel requires valid id");
      const cancelled = storage.cancel(id);
      if (cancelled) onChanged?.();
      return { ok: cancelled !== null, op: "cancel", schedule: null };
    }

    case "create":
      return await createSchedule(storage, onChanged, channelKey, request);

    case "update":
      return await updateSchedule(storage, onChanged, channelKey, request);

    default:
      throw new Error(`Unsupported cron op: ${String(request.op)}`);
  }
}

async function createSchedule(
  storage: SchedulerStorage,
  onChanged: (() => void) | undefined,
  channelKey: string,
  request: CronJobRequest,
): Promise<CronJobResult> {
  const mutation = resolveScheduleMutation(request);
  const row = storage.insert({
    type: mutation.type,
    channelKey,
    prompt: mutation.prompt,
    runAt: mutation.runAt,
    cronExpr: mutation.cronExpr,
    timezone: mutation.timezone,
    nextRunAt: mutation.nextRunAt,
    status: "active",
    retries: 0,
  });
  onChanged?.();
  return { ok: true, op: "create", schedule: mapScheduleRow(row) };
}

async function updateSchedule(
  storage: SchedulerStorage,
  onChanged: (() => void) | undefined,
  _channelKey: string,
  request: CronJobRequest,
): Promise<CronJobResult> {
  const id = request.id;
  if (!id) throw new Error("cron_job update requires valid id");

  const row = storage.get(id);
  if (!row) {
    return { ok: false, op: "update", schedule: null };
  }

  const mutation = resolveScheduleMutation(request, row);
  const updated = storage.update(id, {
    type: mutation.type,
    prompt: mutation.prompt,
    runAt: mutation.runAt,
    cronExpr: mutation.cronExpr,
    timezone: mutation.timezone,
    nextRunAt: mutation.nextRunAt,
  });
  if (updated) onChanged?.();
  return { ok: updated !== null, op: "update", schedule: updated ? mapScheduleRow(updated) : null };
}

function mapScheduleRow(row: ScheduledEvent): ScheduleInfo {
  const kind = row.type === "periodic" ? "cron" : "once";
  return {
    id: row.id,
    kind,
    prompt: row.prompt ?? "",
    status: row.status,
    schedule: kind === "cron" ? row.cronExpr ?? "" : row.runAt ?? "",
    nextRunAt: row.nextRunAt,
    timezone: row.timezone,
  };
}

function resolveScheduleMutation(
  request: CronJobRequest,
  current?: ScheduledEvent,
): {
  type: "one-shot" | "periodic";
  prompt: string;
  runAt: string | null;
  cronExpr: string | null;
  timezone: string | null;
  nextRunAt: string;
} {
  const kind = request.kind ?? (current?.type === "periodic" ? "cron" : "once");
  if (kind !== "once" && kind !== "cron") throw new Error("cron_job requires kind");

  const prompt = (request.prompt ?? current?.prompt ?? "").trim();
  if (!prompt) throw new Error("cron_job requires prompt");

  const timezone = (request.timezone ?? current?.timezone ?? null)?.trim() || null;
  if (kind === "cron") {
    const schedule = (request.schedule ?? current?.cronExpr ?? "").trim();
    if (!schedule) throw new Error("cron_job requires schedule");
    return {
      type: "periodic",
      prompt,
      runAt: null,
      cronExpr: schedule,
      timezone,
      nextRunAt: findNextCronOccurrence(schedule, new Date(), timezone || undefined).toISOString(),
    };
  }

  const schedule = (request.schedule ?? current?.runAt ?? "").trim();
  if (!schedule) throw new Error("cron_job requires schedule");
  const runAt = normalizeScheduledRunAt(schedule, timezone || undefined);
  return {
    type: "one-shot",
    prompt,
    runAt,
    cronExpr: null,
    timezone,
    nextRunAt: runAt,
  };
}
