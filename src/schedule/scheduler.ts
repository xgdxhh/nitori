import { Cron } from "croner";
import type { SchedulerStorage, ScheduledEvent } from "../storage/scheduler.ts";
import type { InboundMessage, TriggerType } from "../types.ts";

const MAX_SLEEP_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;

export class EventScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private pendingSignal = false;

  constructor(
    private readonly storage: SchedulerStorage,
    private readonly enqueue: (messages: InboundMessage[], trigger: TriggerType) => Promise<void>,
  ) { }

  start(): void {
    this.stopped = false;
    this.pendingSignal = false;
    this.rearm(0);
  }

  stop(): void {
    this.stopped = true;
    this.pendingSignal = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  signal(): void {
    if (this.stopped) return;
    if (this.running) {
      this.pendingSignal = true;
      return;
    }
    this.rearm(0);
  }

  private rearm(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake().catch((err) => {
        console.error("Scheduler wake failed", err);
      });
    }, Math.max(0, delayMs));
  }

  private async wake(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.pendingSignal = true;
      return;
    }
    this.running = true;
    try {
      while (!this.stopped) {
        this.pendingSignal = false;

        const due = this.storage.claimDue();
        await Promise.allSettled(due.map((event) => this.dispatch(event)));

        if (this.pendingSignal) {
          continue;
        }

        const nextRunAt = this.storage.peekNextDue();
        if (this.pendingSignal) {
          continue;
        }

        if (!nextRunAt) {
          this.rearm(MAX_SLEEP_MS);
          return;
        }

        const wakeAt = new Date(nextRunAt).getTime();
        const delay = Number.isFinite(wakeAt)
          ? Math.min(MAX_SLEEP_MS, Math.max(0, wakeAt - Date.now()))
          : MAX_SLEEP_MS;
        this.rearm(delay);
        return;
      }
    } catch (error) {
      console.error("Scheduler wake iteration failed", error);
      if (!this.stopped) {
        this.rearm(10_000);
      }
    } finally {
      this.running = false;
      if (!this.stopped && this.pendingSignal) {
        this.rearm(0);
      }
    }
  }

  private async dispatch(event: ScheduledEvent): Promise<void> {
    const channelKey = (event.channelKey ?? "").trim();
    if (!channelKey) {
      console.error(`Event ${event.id}: missing channelKey`);
      this.storage.fail(event.id);
      return;
    }

    let nextRunAt: string | undefined;
    if (event.type === "periodic") {
      const cronExpr = event.cronExpr?.trim();
      if (!cronExpr) {
        console.error(`Event ${event.id}: missing cron expression`);
        this.storage.fail(event.id);
        return;
      }
      try {
        nextRunAt = findNextCronOccurrence(cronExpr, new Date(), event.timezone || undefined).toISOString();
      } catch (error) {
        console.error(`Event ${event.id}: invalid cron expression`, error);
        this.storage.fail(event.id);
        return;
      }
    }

    try {
      const prompt = (event.prompt ?? "").trim();
      if (!prompt) {
        console.error(`Event ${event.id}: missing prompt`);
        this.storage.fail(event.id);
        return;
      }
      const msg: InboundMessage = {
        id: `event-${event.id}-${Date.now()}`,
        source: "system",
        channelKey,
        sender: { id: "system", name: "scheduler", isBot: true },
        text: prompt,
        attachments: [],
        receivedAt: new Date().toISOString(),
        trigger: "scheduled",
        raw: {
          scheduleId: event.id,
          scheduleType: event.type,
          scheduleAt: event.nextRunAt,
        },
      };
      await this.enqueue([msg], "scheduled");

      if (event.type === "one-shot") {
        this.storage.completeOneShot(event.id);
        return;
      }

      this.storage.reschedulePeriodic(event.id, nextRunAt!);
    } catch (error) {
      const retryAt = new Date(Date.now() + getRetryDelayMs(event.retries)).toISOString();
      this.storage.releaseAfterFailure(event.id, retryAt);
      console.error(`Scheduled event ${event.id} failed`, error);
    }
  }
}

function getRetryDelayMs(retries: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** Math.min(retries, 8));
}

export function findNextCronOccurrence(expr: string, after: Date, timezone?: string): Date {
  const cronExpr = expr.trim();
  if (!cronExpr) {
    throw new Error("Cron expression is required");
  }

  const tz = (timezone ?? "").trim();
  const cron = new Cron(cronExpr, {
    paused: true,
    timezone: tz || undefined,
  });

  try {
    const next = cron.nextRun(after);
    if (!next) {
      throw new Error(`No future run found for '${cronExpr}'`);
    }
    return next;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid cron expression '${cronExpr}': ${detail}`);
  } finally {
    cron.stop();
  }
}
