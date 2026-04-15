import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message } from "../types.ts";

export type SessionMessage = Message;

export interface SessionState {
  sessionId: string;
  messages: SessionMessage[];
}

export interface SessionStorage {
  loadSession(sessionKey: string, sessionId: string): SessionState;
  appendMessages(sessionKey: string, sessionId: string, messages: SessionMessage[]): void;
  createSession(sessionKey: string, sessionId: string, initialMessages?: SessionMessage[]): void;
  listSessions(sessionKey: string): string[];
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

export function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
