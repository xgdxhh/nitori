import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { InboundMessage, TriggerType, AttachmentRef, ExtensionInboxListOptions, ExtensionUnreadChannel } from "../types.ts";
import { BUILTIN_MIGRATIONS, type BuiltinMigration } from "./builtin-migrations.ts";

interface SessionMessage {
  role: string;
  content: unknown;
  timestamp?: number;
}

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

interface SessionSearchRow {
  checkpoint_id: number;
  session_key: string;
  message_id: number;
  snippet: string;
  text_rank: number;
  started_ts: number;
  ended_ts: number;
  checkpoint_created_at: string;
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

interface ArchivedSessionSearchHit {
  checkpointId: number;
  sessionKey: string;
  messageId: number;
  startedAt: string;
  endedAt: string;
  checkpointAt: string;
  snippet: string;
  score: number;
  textScore: number;
  recencyScore: number;
  previewLines: string[];
}

interface SearchArchivedSessionsOptions {
  currentSessionKey: string;
  crossSession?: boolean;
  sinceDays?: number;
  limit?: number;
}

export interface ActiveSessionState {
  checkpointAfterId: number;
  tipId: number;
  messages: SessionMessage[];
}

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

  loadActiveSessionState(sessionKey: string): ActiveSessionState {
    const checkpointAfterId = this.getActiveCheckpointMessageId(sessionKey);
    const rows = this.db
      .prepare("SELECT id, raw_json FROM session_messages WHERE session_key = ? AND id > ? ORDER BY id ASC")
      .all(sessionKey, checkpointAfterId) as Array<{ id: number; raw_json: string }>;
    return {
      checkpointAfterId,
      tipId: rows.length > 0 ? rows[rows.length - 1].id : checkpointAfterId,
      messages: rows.map((row) => JSON.parse(row.raw_json) as SessionMessage),
    };
  }

  loadActiveSessionMessages(sessionKey: string): SessionMessage[] {
    return this.loadActiveSessionState(sessionKey).messages;
  }

  appendSessionMessages(sessionKey: string, messages: SessionMessage[]): number[] {
    if (messages.length === 0) return [];
    const insertMessage = this.db.prepare(
      `INSERT INTO session_messages (
        session_key, role, text, raw_json, timestamp_ms
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertFts = this.db.prepare(
      "INSERT INTO session_messages_fts(text, session_key, message_id) VALUES (?, ?, ?)",
    );

    return this.db.transaction(() => {
      const insertedIds: number[] = [];
      for (let i = 0; i < messages.length; i += 1) {
        const message = messages[i];
        const timestamp = extractMessageTimestamp(message, i);
        const text = extractMessageText(message);
        const res = insertMessage.run(
          sessionKey,
          message.role,
          text,
          JSON.stringify(message),
          timestamp,
        );
        const messageId = Number(res.lastInsertRowid);
        insertFts.run(text, sessionKey, messageId);
        insertedIds.push(messageId);
      }
      return insertedIds;
    })();
  }

  applyCompaction(sessionKey: string, expectedCheckpointAfterId: number, expectedTipId: number, messages: SessionMessage[]): boolean {
    if (messages.length === 0) return false;

    const latestCheckpoint = this.db.prepare(
      "SELECT after_message_id FROM session_checkpoints WHERE session_key = ? ORDER BY after_message_id DESC LIMIT 1",
    );
    const latestMessage = this.db.prepare(
      "SELECT coalesce(max(id), 0) AS id FROM session_messages WHERE session_key = ?",
    );
    const insertCheckpoint = this.db.prepare(
      "INSERT INTO session_checkpoints(session_key, after_message_id, created_at) VALUES (?, ?, ?)",
    );
    const insertMessage = this.db.prepare(
      `INSERT INTO session_messages (
        session_key, role, text, raw_json, timestamp_ms
      ) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertFts = this.db.prepare(
      "INSERT INTO session_messages_fts(text, session_key, message_id) VALUES (?, ?, ?)",
    );

    return this.db.transaction(() => {
      const checkpointRow = latestCheckpoint.get(sessionKey) as { after_message_id: number } | undefined;
      const latestMessageRow = latestMessage.get(sessionKey) as { id: number };
      const currentCheckpointAfterId = checkpointRow?.after_message_id ?? 0;
      if (currentCheckpointAfterId !== expectedCheckpointAfterId || latestMessageRow.id !== expectedTipId) {
        return false;
      }

      insertCheckpoint.run(sessionKey, expectedTipId, nowIso());
      for (let i = 0; i < messages.length; i += 1) {
        const message = messages[i];
        const timestamp = extractMessageTimestamp(message, i);
        const text = extractMessageText(message);
        const res = insertMessage.run(
          sessionKey,
          message.role,
          text,
          JSON.stringify(message),
          timestamp,
        );
        insertFts.run(text, sessionKey, Number(res.lastInsertRowid));
      }
      return true;
    })();
  }

  createCheckpoint(sessionKey: string): boolean {
    const latestMessageId = this.db
      .prepare("SELECT coalesce(max(id), 0) AS id FROM session_messages WHERE session_key = ?")
      .get(sessionKey) as { id: number };
    const cutoffMessageId = this.getActiveCheckpointMessageId(sessionKey);
    const now = nowIso();
    if (latestMessageId.id <= cutoffMessageId) return false;

    this.db
      .prepare("INSERT INTO session_checkpoints(session_key, after_message_id, created_at) VALUES (?, ?, ?)")
      .run(sessionKey, latestMessageId.id, now);
    return true;
  }

  searchArchivedSessions(query: string, options: SearchArchivedSessionsOptions): ArchivedSessionSearchHit[] {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];

    const { currentSessionKey, crossSession = true, sinceDays, limit = 5 } = options;
    const candidateLimit = Math.max(limit * 10, 30);
    const matchSessionFilter = crossSession ? "" : "AND session_key = ?";
    const checkpointTimeFilter = sinceDays !== undefined ? "AND cp.created_at >= ?" : "";
    const sql = `WITH matches AS (
          SELECT
            CAST(session_key AS TEXT) AS session_key,
            CAST(message_id AS INTEGER) AS message_id,
            snippet(session_messages_fts, 0, '[', ']', '...', 24) AS snippet,
            bm25(session_messages_fts) AS text_bm25
          FROM session_messages_fts
          WHERE session_messages_fts MATCH ?
            ${matchSessionFilter}
          ORDER BY bm25(session_messages_fts) ASC, CAST(message_id AS INTEGER) DESC
          LIMIT ?
        ),
        annotated AS (
          SELECT
            matches.*,
            (
              SELECT cp.id
              FROM session_checkpoints cp
              WHERE cp.session_key = matches.session_key
                AND cp.after_message_id >= matches.message_id
              ORDER BY cp.after_message_id ASC
              LIMIT 1
            ) AS checkpoint_id
          FROM matches
        ),
        ranked AS (
          SELECT
            annotated.*,
            row_number() OVER (ORDER BY annotated.text_bm25 ASC, annotated.message_id DESC) AS text_rank,
            row_number() OVER (PARTITION BY annotated.checkpoint_id ORDER BY annotated.text_bm25 ASC, annotated.message_id DESC) AS checkpoint_rank
          FROM annotated
          WHERE annotated.checkpoint_id IS NOT NULL
        ),
        resolved AS (
          SELECT
            ranked.checkpoint_id,
            ranked.session_key,
            ranked.message_id,
            ranked.snippet,
            ranked.text_rank,
            cp.created_at AS checkpoint_created_at,
            cp.after_message_id AS cp_after_id,
            coalesce(
              (SELECT prev.after_message_id
               FROM session_checkpoints prev
               WHERE prev.session_key = ranked.session_key
                 AND prev.after_message_id < cp.after_message_id
               ORDER BY prev.after_message_id DESC
               LIMIT 1),
              0
            ) AS prev_after_id
          FROM ranked
          JOIN session_checkpoints cp ON cp.id = ranked.checkpoint_id
          WHERE ranked.checkpoint_rank = 1
            ${checkpointTimeFilter}
        )
        SELECT
          resolved.checkpoint_id,
          resolved.session_key,
          resolved.message_id,
          resolved.snippet,
          resolved.text_rank,
          (SELECT min(sm.timestamp_ms) FROM session_messages sm
           WHERE sm.session_key = resolved.session_key
             AND sm.id > resolved.prev_after_id AND sm.id <= resolved.cp_after_id
          ) AS started_ts,
          (SELECT max(sm.timestamp_ms) FROM session_messages sm
           WHERE sm.session_key = resolved.session_key
             AND sm.id > resolved.prev_after_id AND sm.id <= resolved.cp_after_id
          ) AS ended_ts,
          resolved.checkpoint_created_at
        FROM resolved
        LIMIT ?`;
    const params: Array<string | number> = [normalizedQuery];
    if (!crossSession) params.push(currentSessionKey);
    params.push(candidateLimit);
    if (sinceDays !== undefined) params.push(new Date(Date.now() - sinceDays * 86_400_000).toISOString());
    params.push(candidateLimit);

    const rows = this.db.prepare(sql).all(...params) as SessionSearchRow[];

    const now = Date.now();
    return rows
      .map((row) => {
        const textScore = 1 / row.text_rank;
        const recencyScore = scoreRecency(row.ended_ts, now);
        return {
          checkpointId: row.checkpoint_id,
          sessionKey: row.session_key,
          messageId: row.message_id,
          startedAt: new Date(row.started_ts).toISOString(),
          endedAt: new Date(row.ended_ts).toISOString(),
          checkpointAt: row.checkpoint_created_at,
          snippet: row.snippet,
          score: textScore * 0.85 + recencyScore * 0.15,
          textScore,
          recencyScore,
          previewLines: this.buildRecallPreview(row.session_key, row.checkpoint_id, row.message_id),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private buildRecallPreview(sessionKey: string, checkpointId: number, messageId: number): string[] {
    const checkpoint = this.db
      .prepare("SELECT after_message_id FROM session_checkpoints WHERE id = ?")
      .get(checkpointId) as { after_message_id: number } | undefined;
    if (!checkpoint) return [];

    const previous = this.db
      .prepare(
        `SELECT after_message_id
         FROM session_checkpoints
         WHERE session_key = ?
           AND after_message_id < ?
         ORDER BY after_message_id DESC
         LIMIT 1`,
      )
      .get(sessionKey, checkpoint.after_message_id) as { after_message_id: number } | undefined;

    const startId = Number(previous?.after_message_id ?? 0);
    const windowStart = Math.max(startId + 1, messageId - 1);
    const windowEnd = Math.min(checkpoint.after_message_id, messageId + 1);

    const rows = this.db
      .prepare(
        `SELECT id, raw_json
         FROM session_messages
         WHERE session_key = ?
           AND id BETWEEN ? AND ?
         ORDER BY id ASC`,
      )
      .all(sessionKey, windowStart, windowEnd) as Array<{ id: number; raw_json: string }>;

    return rows
      .map((row) => compactRecallLine(row.raw_json, row.id === messageId))
      .filter((line) => line.length > 0)
      .slice(0, 3);
  }


  private getActiveCheckpointMessageId(sessionKey: string): number {
    const row = this.db
      .prepare(
        "SELECT after_message_id FROM session_checkpoints WHERE session_key = ? ORDER BY after_message_id DESC LIMIT 1",
      )
      .get(sessionKey) as { after_message_id: number } | undefined;
    return row?.after_message_id ?? 0;
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


function extractMessageTimestamp(message: SessionMessage, fallbackIndex: number): number {
  const value = (message as { timestamp?: unknown }).timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return Date.now() + fallbackIndex;
}

function extractMessageText(message: SessionMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ");
}

function scoreRecency(endedTimestampMs: number, now: number): number {
  const ageDays = Math.max(0, (now - endedTimestampMs) / 86_400_000);
  return 1 / (1 + ageDays / 30);
}

function compactRecallLine(rawJson: string, isHit: boolean): string {
  const message = JSON.parse(rawJson) as SessionMessage & { toolName?: string };
  const role = formatRecallRole(message);
  const text = truncateRecallText(extractMessageText(message).replace(/\s+/g, " ").trim(), 160);
  if (!text) return "";
  return `${isHit ? "hit" : "ctx"}:[${role}] ${text}`;
}

function formatRecallRole(message: SessionMessage & { toolName?: string }): string {
  if (message.role !== "toolResult") return message.role;
  return message.toolName ? `toolResult:${message.toolName}` : "toolResult";
}

function truncateRecallText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
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
