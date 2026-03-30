import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ScheduledEvent {
  id: string;
  type: "one-shot" | "periodic";
  channelKey: string;
  prompt: string;
  cronExpr: string | null;
  timezone: string | null;
  runAt: string | null;
  nextRunAt: string | null;
  status: "active" | "running" | "done" | "failed";
  retries: number;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulerStorage {
  insert(event: Omit<ScheduledEvent, "id" | "createdAt" | "updatedAt">): ScheduledEvent;
  list(channelKey: string, limit?: number): ScheduledEvent[];
  get(id: string): ScheduledEvent | null;
  update(id: string, patch: Partial<Omit<ScheduledEvent, "id" | "createdAt">>): ScheduledEvent | null;
  cancel(id: string): ScheduledEvent | null;
  claimDue(limit?: number): ScheduledEvent[];
  peekNextDue(): string | null;
  completeOneShot(id: string): void;
  reschedulePeriodic(id: string, nextRunAt: string): void;
  releaseAfterFailure(id: string, nextRunAt: string): void;
  fail(id: string): void;
}

function getSchedulerDir(workspaceDir: string): string {
  return join(workspaceDir, "scheduler");
}

function getEventsFile(workspaceDir: string): string {
  return join(getSchedulerDir(workspaceDir), "events.jsonl");
}

export function createSchedulerStorage(workspaceDir: string): SchedulerStorage {
  return new FileSchedulerStorage(workspaceDir);
}

class FileSchedulerStorage implements SchedulerStorage {
  constructor(private readonly workspaceDir: string) {
    const dir = getSchedulerDir(workspaceDir);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private loadEvents(): Map<string, ScheduledEvent> {
    const filePath = getEventsFile(this.workspaceDir);
    if (!existsSync(filePath)) {
      return new Map();
    }

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());
    const events = new Map<string, ScheduledEvent>();
    for (const line of lines) {
      const event = JSON.parse(line) as ScheduledEvent;
      events.set(event.id, event);
    }
    return events;
  }

  private saveEvents(events: Map<string, ScheduledEvent>): void {
    const filePath = getEventsFile(this.workspaceDir);
    const lines = Array.from(events.values()).map((e) => JSON.stringify(e));
    writeFileSync(filePath, lines.join("\n") + "\n");
  }

  private generateId(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  insert(event: Omit<ScheduledEvent, "id" | "createdAt" | "updatedAt">): ScheduledEvent {
    const events = this.loadEvents();
    const now = new Date().toISOString();
    const newEvent: ScheduledEvent = {
      ...event,
      id: this.generateId(),
      createdAt: now,
      updatedAt: now,
    };
    events.set(newEvent.id, newEvent);
    this.saveEvents(events);
    return newEvent;
  }

  list(channelKey: string, limit = 20): ScheduledEvent[] {
    const events = this.loadEvents();
    return Array.from(events.values())
      .filter((e) => e.channelKey === channelKey)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  get(id: string): ScheduledEvent | null {
    const events = this.loadEvents();
    return events.get(id) ?? null;
  }

  update(id: string, patch: Partial<Omit<ScheduledEvent, "id" | "createdAt">>): ScheduledEvent | null {
    const events = this.loadEvents();
    const event = events.get(id);
    if (!event || !["active", "running"].includes(event.status)) {
      return null;
    }

    const updated: ScheduledEvent = {
      ...event,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    events.set(id, updated);
    this.saveEvents(events);
    return updated;
  }

  cancel(id: string): ScheduledEvent | null {
    const events = this.loadEvents();
    const event = events.get(id);
    if (!event || !["active", "running"].includes(event.status)) {
      return null;
    }

    const updated: ScheduledEvent = {
      ...event,
      status: "done",
      updatedAt: new Date().toISOString(),
    };
    events.set(id, updated);
    this.saveEvents(events);
    return updated;
  }

  claimDue(limit = 50): ScheduledEvent[] {
    const events = this.loadEvents();
    const now = new Date().toISOString();
    const due: ScheduledEvent[] = [];

    for (const event of events.values()) {
      if (event.status !== "active") continue;
      if (!event.nextRunAt) continue;
      if (event.nextRunAt > now) continue;

      due.push(event);
      event.status = "running";
      event.updatedAt = new Date().toISOString();
      event.retries += 1;
    }

    due.sort((a, b) => new Date(a.nextRunAt!).getTime() - new Date(b.nextRunAt!).getTime());
    this.saveEvents(events);
    return due.slice(0, limit);
  }

  peekNextDue(): string | null {
    const events = this.loadEvents();
    let earliest: string | null = null;

    for (const event of events.values()) {
      if (event.status !== "active") continue;
      if (!event.nextRunAt) continue;
      if (!earliest || event.nextRunAt < earliest) {
        earliest = event.nextRunAt;
      }
    }

    return earliest;
  }

  completeOneShot(id: string): void {
    this.update(id, { status: "done" });
  }

  reschedulePeriodic(id: string, nextRunAt: string): void {
    this.update(id, { status: "active", nextRunAt });
  }

  releaseAfterFailure(id: string, nextRunAt: string): void {
    this.update(id, { status: "active", nextRunAt });
  }

  fail(id: string): void {
    this.update(id, { status: "failed" });
  }
}
