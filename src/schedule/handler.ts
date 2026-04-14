import type { Storage } from "../storage/db.ts";
import type { CronJobRequest, CronJobResult, ScheduleInfo } from "../types.ts";
import { findNextCronOccurrence } from "./scheduler.ts";
import { normalizeScheduledRunAt } from "./time.ts";

export type ScheduleHandler = (channelKey: string, request: CronJobRequest) => Promise<CronJobResult>;

export function createScheduleHandler(storage: Storage, onChanged?: () => void): ScheduleHandler {
  return (channelKey, request) => handleCronJob(storage, onChanged, channelKey, request);
}

async function handleCronJob(
  storage: Storage,
  onChanged: (() => void) | undefined,
  channelKey: string,
  request: CronJobRequest,
): Promise<CronJobResult> {
  switch (request.op) {
    case "list":
      return {
        ok: true,
        op: "list",
        schedules: storage.listEvents(channelKey, request.limit ?? 20).map(mapScheduleRow),
      };

    case "get": {
      const id = Number(request.id);
      if (!(id > 0)) throw new Error("cron_job get requires valid id");
      const row = storage.getEvent(id, channelKey);
      return { ok: row !== null, op: "get", schedule: row ? mapScheduleRow(row) : null };
    }

    case "cancel": {
      const id = Number(request.id);
      if (!(id > 0)) throw new Error("cron_job cancel requires valid id");
      const cancelled = storage.cancelEvent(id, channelKey);
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
  storage: Storage,
  onChanged: (() => void) | undefined,
  channelKey: string,
  request: CronJobRequest,
): Promise<CronJobResult> {
  const mutation = resolveScheduleMutation(request);
  const row = storage.insertEvent({
    type: mutation.type,
    channelKey,
    prompt: mutation.prompt,
    runAt: mutation.runAt,
    cronExpr: mutation.cronExpr,
    timezone: mutation.timezone,
    nextRunAt: mutation.nextRunAt,
  });
  onChanged?.();
  return { ok: true, op: "create", schedule: mapScheduleRow(row) };
}

async function updateSchedule(
  storage: Storage,
  onChanged: (() => void) | undefined,
  channelKey: string,
  request: CronJobRequest,
): Promise<CronJobResult> {
  const id = Number(request.id);
  if (!(id > 0)) throw new Error("cron_job update requires valid id");

  const row = storage.getEvent(id, channelKey);
  if (!row) {
    return { ok: false, op: "update", schedule: null };
  }

  const mutation = resolveScheduleMutation(request, row);
  const updated = storage.updateEvent(id, channelKey, {
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

function mapScheduleRow(row: {
  id: number;
  type: "one-shot" | "periodic";
  prompt: string | null;
  status: string;
  cron_expr: string | null;
  run_at: string | null;
  next_run_at: string | null;
  timezone: string | null;
}): ScheduleInfo {
  const kind = row.type === "periodic" ? "cron" : "once";
  return {
    id: row.id,
    kind,
    prompt: row.prompt ?? "",
    status: row.status,
    schedule: kind === "cron" ? row.cron_expr ?? "" : row.run_at ?? "",
    nextRunAt: row.next_run_at,
    timezone: row.timezone,
  };
}

function resolveScheduleMutation(
  request: CronJobRequest,
  current?: {
    type: "one-shot" | "periodic";
    prompt: string | null;
    cron_expr: string | null;
    run_at: string | null;
    timezone: string | null;
  },
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
    const schedule = (request.schedule ?? current?.cron_expr ?? "").trim();
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

  const schedule = (request.schedule ?? current?.run_at ?? "").trim();
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
