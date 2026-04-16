import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolContext } from "../types.ts";
import { createSessionStorage } from "../storage/sessions.ts";

const DEFAULT_LIMIT = 10;
const DEFAULT_READ_LIMIT = 12;

export function createListSessionsTool(ctx: ToolContext): Tool {
  return tool({
    title: "list_sessions",
    description: "List sessions for the current session scope or a specified session key. Returns metadata only, not raw jsonl.",
    inputSchema: z.object({
      session_key: z.string().optional().describe("Optional explicit session key. Defaults to the current session key."),
      offset: z.number().optional().describe("Session offset for pagination").default(0),
      limit: z.number().optional().describe("Max sessions to return").default(DEFAULT_LIMIT),
    }),
    execute: async ({ session_key, offset = 0, limit = DEFAULT_LIMIT }) => {
      const storage = createSessionStorage(join(ctx.workspaceDir, "chats"));
      const sessionKey = session_key || ctx.currentSessionKey;
      const sessions = storage.listSessionSummaries(sessionKey, offset, limit);
      return {
        sessionKey,
        offset,
        limit,
        sessions,
      };
    },
  });
}

export function createRecallTool(ctx: ToolContext): Tool {
  return tool({
    title: "recall",
    description: "Search sanitized session history for relevant past messages. Returns short previews only. Use read_session to inspect full context.",
    inputSchema: z.object({
      query: z.string().describe("Search text"),
      session_key: z.string().optional().describe("Optional explicit session key. Defaults to the current session key."),
      limit: z.number().optional().describe("Max sessions with matches to return").default(DEFAULT_LIMIT),
    }),
    execute: async ({ query, session_key, limit = DEFAULT_LIMIT }) => {
      const storage = createSessionStorage(join(ctx.workspaceDir, "chats"));
      const sessionKey = session_key || ctx.currentSessionKey;
      const matches = storage.searchSessions(sessionKey, query, limit);
      return {
        sessionKey,
        query,
        matches,
        note: "recall returns previews only; call read_session for surrounding context before relying on details",
      };
    },
  });
}

export function createReadSessionTool(ctx: ToolContext): Tool {
  return tool({
    title: "read_session",
    description: "Read sanitized messages from a session. Supports pagination or reading around a specific message index.",
    inputSchema: z.object({
      session_id: z.string().describe("Session id to read"),
      session_key: z.string().optional().describe("Optional explicit session key. Defaults to the current session key."),
      start: z.number().optional().describe("Start message index when not using around_message_index").default(0),
      limit: z.number().optional().describe("Max messages to return when not using around_message_index").default(DEFAULT_READ_LIMIT),
      around_message_index: z.number().optional().describe("Center the result around this message index"),
      before: z.number().optional().describe("Messages before around_message_index").default(3),
      after: z.number().optional().describe("Messages after around_message_index").default(5),
    }),
    execute: async ({
      session_id,
      session_key,
      start = 0,
      limit = DEFAULT_READ_LIMIT,
      around_message_index,
      before = 3,
      after = 5,
    }) => {
      const storage = createSessionStorage(join(ctx.workspaceDir, "chats"));
      const sessionKey = session_key || ctx.currentSessionKey;

      if (typeof around_message_index === "number") {
        const aroundStart = Math.max(0, around_message_index - before);
        const aroundLimit = before + after + 1;
        return {
          sessionKey,
          aroundMessageIndex: around_message_index,
          ...storage.readSessionSlice(sessionKey, session_id, aroundStart, aroundLimit),
        };
      }

      return {
        sessionKey,
        ...storage.readSessionSlice(sessionKey, session_id, start, limit),
      };
    },
  });
}
