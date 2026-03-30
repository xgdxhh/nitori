import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { InboundMessage, TriggerType, AttachmentRef, ExtensionInboxListOptions, ExtensionUnreadChannel } from "../types.ts";
import { BUILTIN_MIGRATIONS, type BuiltinMigration } from "./builtin-migrations.ts";

interface InboxRow {
  id: number;
  channel_key: string;
  source: string;
  external_id: string;
  sender_id: string | null;
  sender_name: string | null;
  trigger: string;
  reply_to_message_id: string | null;
  text: string | null;
  attachments_json: string;
  raw_json: string;
  status: string;
  created_at: string;
  read_at: string | null;
}

export interface EventRow {
  id: number;
  type: "one-shot" | "periodic";
  channel_key: string;
  prompt: string;
  cron_expr: string | null;
  timezone: string | null;
  run_at: string | null;
  next_run_at: string | null;
  status: string;
  retries: number;
}

type EventPatch = {
  type: "one-shot" | "periodic";
  prompt: string;
  runAt: string | null;
  cronExpr: string | null;
  timezone: string | null;
  nextRunAt: string;
};

export class Storage {
  readonly db: Database;

  constructor(dbPath: string) {
    if (!existsSync(dirname(dbPath))) {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    runEmbeddedMigrations(this.db);
  }

  init(): this {
    this.recoverRunningEvents();
    return this;
  }

  close(): void {
    this.db.close();
  }

  private recoverRunningEvents(): void {
    this.db
      .prepare("UPDATE events SET status = 'active', retries = retries + 1, updated_at = ? WHERE status = 'running'")
      .run(nowIso());
  }

  insertInboxMessage(message: InboundMessage): boolean {
    const now = message.receivedAt || nowIso();
    const res = this.db
      .prepare(
        `INSERT INTO inbox (
          channel_key, source, external_id, sender_id, sender_name, trigger, reply_to_message_id, text, attachments_json, raw_json, status, created_at, read_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, NULL)
        ON CONFLICT(channel_key, external_id) DO NOTHING`,
      )
      .run(
        message.channelKey,
        message.source,
        message.id,
        message.sender.id,
        message.sender.name || message.sender.username || null,
        message.trigger,
        message.replyToMessageId || null,
        message.text || "",
        JSON.stringify(message.attachments || []),
        JSON.stringify(message.raw || {}),
        now,
      );
    return Number(res.changes) > 0;
  }

  getInboxMessage(channelKey: string, externalId: string, opts?: { onlyUnread?: boolean; markAsRead?: boolean }): InboundMessage | null {
    const unread = opts?.onlyUnread ? " AND status = 'unread'" : "";
    const row = this.db
      .prepare(`SELECT * FROM inbox WHERE channel_key = ? AND external_id = ?${unread} LIMIT 1`)
      .get(channelKey, externalId) as InboxRow | undefined;
    if (row && opts?.markAsRead) {
      this.markInboxRowsRead([row.id]);
    }
    return row ? this.rowToInbound(row) : null;
  }

  markInboxMessageRead(channelKey: string, externalId: string): boolean {
    const res = this.db
      .prepare("UPDATE inbox SET status = 'read', read_at = ? WHERE channel_key = ? AND external_id = ? AND status = 'unread'")
      .run(nowIso(), channelKey, externalId);
    return Number(res.changes) > 0;
  }

  listUnreadInboxChannels(): ExtensionUnreadChannel[] {
    const rows = this.db
      .prepare(
        `SELECT channel_key, COUNT(*) AS unread_count
         FROM inbox
         WHERE status = 'unread'
         GROUP BY channel_key
         ORDER BY MAX(created_at) DESC`,
      )
      .all() as Array<{ channel_key: string; unread_count: number }>;

    return rows.map((row) => ({
      channelKey: row.channel_key,
      unreadCount: row.unread_count,
    }));
  }

  listInbox(options: ExtensionInboxListOptions): InboundMessage[] {
    let sql = "SELECT * FROM inbox";
    const params: Array<string | number> = [];
    const where: string[] = [];

    if (options.onlyUnread) {
      where.push("status = 'unread'");
    }
    if (options.channelKey) {
      where.push("channel_key = ?");
      params.push(options.channelKey);
    }

    if (where.length > 0) {
      sql += " WHERE " + where.join(" AND ");
    }

    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(options.limit, options.offset || 0);

    const rows = this.db.prepare(sql).all(...params) as InboxRow[];
    if (options.markAsRead && rows.length > 0) {
      this.markInboxRowsRead(rows.map((row) => row.id));
    }
    return rows.map((row) => this.rowToInbound(row));
  }

  private markInboxRowsRead(rowIds: number[]): void {
    const unreadIds = [...new Set(rowIds.filter((rowId) => rowId > 0))];
    if (unreadIds.length === 0) return;
    const placeholders = unreadIds.map(() => "?").join(", ");
    this.db
      .prepare(`UPDATE inbox SET status = 'read', read_at = ? WHERE id IN (${placeholders}) AND status = 'unread'`)
      .run(nowIso(), ...unreadIds);
  }

  private rowToInbound(row: InboxRow): InboundMessage {
    return {
      id: row.external_id,
      source: row.source,
      channelKey: row.channel_key,
      sender: {
        id: row.sender_id ?? "unknown",
        name: row.sender_name ?? undefined,
      },
      text: row.text ?? "",
      attachments: JSON.parse(row.attachments_json) as AttachmentRef[],
      replyToMessageId: row.reply_to_message_id ?? undefined,
      raw: JSON.parse(row.raw_json) as Record<string, unknown>,
      receivedAt: row.created_at,
      trigger: row.trigger as TriggerType,
    };
  }

  // --- Events ---

  insertEvent(opts: {
    type: "one-shot" | "periodic";
    channelKey: string;
    prompt: string;
    runAt?: string | null;
    cronExpr?: string | null;
    timezone?: string | null;
    nextRunAt?: string | null;
  }): EventRow {
    const now = nowIso();
    return this.db
      .prepare(
        `INSERT INTO events (
          type, channel_key, prompt, run_at, cron_expr, timezone, next_run_at, status, retries, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)
        RETURNING *`,
      )
      .get(opts.type, opts.channelKey, opts.prompt, opts.runAt ?? null, opts.cronExpr ?? null, opts.timezone ?? null, opts.nextRunAt ?? opts.runAt ?? now, now, now) as EventRow;
  }

  listEvents(channelKey: string, limit = 20): EventRow[] {
    return this.db
      .prepare("SELECT * FROM events WHERE channel_key = ? ORDER BY created_at DESC LIMIT ?")
      .all(channelKey, Math.max(1, limit)) as EventRow[];
  }

  getEvent(id: number, channelKey: string): EventRow | null {
    const row = this.db
      .prepare("SELECT * FROM events WHERE id = ? AND channel_key = ? LIMIT 1")
      .get(id, channelKey) as EventRow | undefined;
    return row || null;
  }

  updateEvent(id: number, channelKey: string, patch: EventPatch): EventRow | null {
    const updated = this.db
      .prepare(`
        UPDATE events
        SET type = ?, prompt = ?, run_at = ?, cron_expr = ?, timezone = ?, next_run_at = ?, status = 'active', updated_at = ?
        WHERE id = ? AND channel_key = ? AND status IN ('active', 'running')
        RETURNING *
      `)
      .get(patch.type, patch.prompt, patch.runAt, patch.cronExpr, patch.timezone, patch.nextRunAt, nowIso(), id, channelKey) as EventRow | undefined;
    return updated || null;
  }

  cancelEvent(id: number, channelKey: string): EventRow | null {
    const res = this.db
      .prepare("UPDATE events SET status = 'done', updated_at = ? WHERE id = ? AND channel_key = ? AND status IN ('active', 'running') RETURNING *")
      .get(nowIso(), id, channelKey) as EventRow | undefined;
    return res || null;
  }

  claimDueEvents(limit = 50, now = nowIso()): EventRow[] {
    return this.db
      .prepare(`
      WITH candidate AS (
        SELECT id FROM events WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at GLOB '????-??-??T*' AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?
      )
      UPDATE events SET status = 'running', updated_at = ? WHERE id IN (SELECT id FROM candidate) AND status = 'active' RETURNING *
    `)
      .all(now, Math.max(1, limit), now) as EventRow[];
  }

  peekNextDueEventAt(): string | null {
    const row = this.db
      .prepare("SELECT next_run_at FROM events WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at GLOB '????-??-??T*' ORDER BY next_run_at ASC LIMIT 1")
      .get() as { next_run_at: string | null } | undefined;
    return row?.next_run_at || null;
  }

  completeOneShotEvent(id: number): void {
    this.updateEventById(id, "status = 'done'");
  }

  reschedulePeriodicEvent(id: number, nextRunAt: string): void {
    this.updateEventById(id, "next_run_at = ?, status = 'active'", nextRunAt);
  }

  releaseEventAfterFailure(id: number, nextRunAt: string): void {
    this.updateEventById(id, "status = 'active', retries = retries + 1, next_run_at = ?", nextRunAt);
  }

  failEvent(id: number): void {
    this.updateEventById(id, "status = 'failed'");
  }

  private updateEventById(id: number, set: string, ...params: (string | number)[]): void {
    this.db.prepare(`UPDATE events SET ${set}, updated_at = ? WHERE id = ?`).run(...params, nowIso(), id);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function runEmbeddedMigrations(db: Database): void {
  runTaggedMigrations(db, BUILTIN_MIGRATIONS);
}

function runTaggedMigrations(db: Database, migrations: BuiltinMigration[]): void {
  db.exec("CREATE TABLE IF NOT EXISTS _nitori_migrations (tag TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)");
  const appliedRows = db.prepare("SELECT tag FROM _nitori_migrations").all() as Array<{ tag: string }>;
  const applied = new Set(appliedRows.map((row) => row.tag));
  const markApplied = db.prepare("INSERT INTO _nitori_migrations(tag, applied_at) VALUES(?, ?)");
  for (const migration of migrations) {
    if (applied.has(migration.tag)) continue;
    db.transaction(() => {
      for (const statement of migration.sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) {
        db.exec(statement);
      }
      markApplied.run(migration.tag, nowIso());
    })();
  }
}
