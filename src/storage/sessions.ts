import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../types.ts";

export type SessionMessage = Message;

export interface SessionState {
  sessionId: string;
  messages: SessionMessage[];
}

export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  messageCount: number;
  preview: string;
}

export interface SessionReadMessage {
  index: number;
  role: string;
  timestamp: number | null;
  text: string;
}

export interface SessionReadResult {
  sessionId: string;
  totalMessages: number;
  start: number;
  end: number;
  messages: SessionReadMessage[];
}

export interface SessionRecallHit {
  messageIndex: number;
  role: string;
  timestamp: number | null;
  snippet: string;
}

export interface SessionRecallResult {
  sessionId: string;
  updatedAt: number;
  hitCount: number;
  hits: SessionRecallHit[];
}

export interface SessionStorage {
  loadSession(sessionKey: string, sessionId: string): SessionState;
  appendMessages(sessionKey: string, sessionId: string, messages: SessionMessage[]): void;
  createSession(sessionKey: string, sessionId: string, initialMessages?: SessionMessage[]): void;
  listSessions(sessionKey: string): string[];
  listSessionSummaries(sessionKey: string, offset?: number, limit?: number): SessionSummary[];
  readSessionSlice(sessionKey: string, sessionId: string, start: number, limit: number): SessionReadResult;
  searchSessions(sessionKey: string, query: string, limit: number): SessionRecallResult[];
  getLatestSessionId(sessionKey: string): string | null;
  compressSession(
    sessionKey: string,
    oldSessionId: string,
    newSessionId: string,
    messages: SessionMessage[],
  ): void;
}

function getSessionDir(chatsDir: string, sessionKey: string): string {
  return join(chatsDir, sessionKey);
}

function getSessionFile(chatsDir: string, sessionKey: string, sessionId: string): string {
  return join(getSessionDir(chatsDir, sessionKey), `${sessionId}.jsonl`);
}

export function createSessionStorage(chatsDir: string): SessionStorage {
  return new FileSessionStorage(chatsDir);
}

class FileSessionStorage implements SessionStorage {
  constructor(private readonly chatsDir: string) {}

  private ensureSessionDir(sessionKey: string): void {
    const dir = getSessionDir(this.chatsDir, sessionKey);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  loadSession(sessionKey: string, sessionId: string): SessionState {
    const filePath = getSessionFile(this.chatsDir, sessionKey, sessionId);
    if (!existsSync(filePath)) {
      return { sessionId, messages: [] };
    }

    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim());
    const messages: SessionMessage[] = lines.map((line) => JSON.parse(line) as SessionMessage);

    return { sessionId, messages };
  }

  appendMessages(sessionKey: string, sessionId: string, messages: SessionMessage[]): void {
    if (messages.length === 0) return;

    this.ensureSessionDir(sessionKey);
    const filePath = getSessionFile(this.chatsDir, sessionKey, sessionId);
    const stream = createWriteStream(filePath, { flags: "a" });

    try {
      for (const message of messages) {
        stream.write(JSON.stringify(message) + "\n");
      }
    } finally {
      stream.end();
    }
  }

  createSession(sessionKey: string, sessionId: string, initialMessages?: SessionMessage[]): void {
    this.ensureSessionDir(sessionKey);
    const filePath = getSessionFile(this.chatsDir, sessionKey, sessionId);

    if (initialMessages && initialMessages.length > 0) {
      const stream = createWriteStream(filePath);
      try {
        for (const message of initialMessages) {
          stream.write(JSON.stringify(message) + "\n");
        }
      } finally {
        stream.end();
      }
    } else {
      writeFileSync(filePath, "", { flag: "w" });
    }
  }

  listSessions(sessionKey: string): string[] {
    const dir = getSessionDir(this.chatsDir, sessionKey);
    if (!existsSync(dir)) {
      return [];
    }

    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(".jsonl", ""))
      .sort((a, b) => {
        const statA = statSync(join(dir, `${a}.jsonl`));
        const statB = statSync(join(dir, `${b}.jsonl`));
        return statB.mtimeMs - statA.mtimeMs;
      });
  }

  listSessionSummaries(sessionKey: string, offset = 0, limit = 20): SessionSummary[] {
    return this.listSessions(sessionKey)
      .slice(offset, offset + limit)
      .map((sessionId) => {
        const session = this.loadSession(sessionKey, sessionId);
        const filePath = getSessionFile(this.chatsDir, sessionKey, sessionId);
        const preview = findSessionPreview(session.messages);
        return {
          sessionId,
          updatedAt: statSync(filePath).mtimeMs,
          messageCount: session.messages.length,
          preview,
        };
      });
  }

  readSessionSlice(sessionKey: string, sessionId: string, start: number, limit: number): SessionReadResult {
    const session = this.loadSession(sessionKey, sessionId);
    const boundedStart = Math.max(0, start);
    const slice = session.messages.slice(boundedStart, boundedStart + limit);
    const messages = slice.map((message, index) => ({
      index: boundedStart + index,
      role: message.role,
      timestamp: typeof message.timestamp === "number" ? message.timestamp : null,
      text: sanitizeSessionMessage(message),
    }));

    return {
      sessionId,
      totalMessages: session.messages.length,
      start: boundedStart,
      end: boundedStart + messages.length,
      messages,
    };
  }

  searchSessions(sessionKey: string, query: string, limit: number): SessionRecallResult[] {
    const normalizedQuery = normalizeWhitespace(query).toLowerCase();
    if (!normalizedQuery) return [];

    const matches: SessionRecallResult[] = [];

    for (const sessionId of this.listSessions(sessionKey)) {
      const session = this.loadSession(sessionKey, sessionId);
      const hits = session.messages
        .map((message, index) => {
          const text = sanitizeSessionMessage(message);
          const snippet = buildSnippet(text, normalizedQuery);
          if (!snippet) return null;
          return {
            messageIndex: index,
            role: message.role,
            timestamp: typeof message.timestamp === "number" ? message.timestamp : null,
            snippet,
          } satisfies SessionRecallHit;
        })
        .filter((hit): hit is SessionRecallHit => hit !== null);

      if (hits.length === 0) continue;

      const filePath = getSessionFile(this.chatsDir, sessionKey, sessionId);
      matches.push({
        sessionId,
        updatedAt: statSync(filePath).mtimeMs,
        hitCount: hits.length,
        hits: hits.slice(0, 3),
      });

      if (matches.length >= limit) break;
    }

    return matches;
  }

  getLatestSessionId(sessionKey: string): string | null {
    const sessions = this.listSessions(sessionKey);
    return sessions[0] ?? null;
  }

  compressSession(
    sessionKey: string,
    _oldSessionId: string,
    newSessionId: string,
    messages: SessionMessage[],
  ): void {
    this.createSession(sessionKey, newSessionId, messages);
  }
}

function findSessionPreview(messages: SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = sanitizeSessionMessage(messages[i]);
    if (text) return clipText(text, 160);
  }
  return "";
}

function sanitizeSessionMessage(message: SessionMessage): string {
  return clipText(normalizeWhitespace(extractSearchableText(message.content)), 4_000);
}

function extractSearchableText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(extractSearchableText).filter(Boolean).join("\n");
  }
  if (!isRecord(value)) return "";

  if (typeof value.text === "string") {
    return value.text;
  }

  const parts = [
    readStringField(value, "input"),
    readStringField(value, "output"),
    readStringField(value, "args"),
    readStringField(value, "toolName"),
    extractSearchableText(value.content),
    extractSearchableText(value.result),
  ].filter(Boolean);

  return parts.join("\n");
}

function readStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clipText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildSnippet(text: string, query: string): string {
  const lowered = text.toLowerCase();
  const index = lowered.indexOf(query);
  if (index === -1) return "";

  const radius = 120;
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + query.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

export function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
