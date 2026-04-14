import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolContext } from "../types.ts";

const DEFAULT_SEARCH_LIMIT = 5;

type SessionToolContext = Pick<ToolContext, "storage" | "currentChannelKey" | "currentSessionKey">;

export function createHandoffTool(ctx: SessionToolContext): Tool {
  return tool({
    description: "Archive the current session and start a fresh one.",
    inputSchema: z.object({}),
    execute: async () => {
      const created = ctx.storage.createCheckpoint(ctx.currentSessionKey);
      return {
        message: created
          ? `Started a new session for session ${ctx.currentSessionKey}.`
          : `Session ${ctx.currentSessionKey} is already at a fresh checkpoint.`,
      };
    },
  });
}

export function createRecallTool(ctx: SessionToolContext): Tool {
  return tool({
    description: "Search checkpointed old sessions across channels with SQLite FTS and recency weighting.",
    inputSchema: z.object({
      query: z.string().describe("Search term to match against previous conversation content."),
      limit: z.number().optional().describe(`Max results to return (default ${DEFAULT_SEARCH_LIMIT})`).default(DEFAULT_SEARCH_LIMIT),
      crossSession: z.boolean().optional().describe("Search across all past sessions").default(true),
      sinceDays: z.number().optional().describe("Limit search to within the last N days"),
    }),
    execute: async ({ query, limit = DEFAULT_SEARCH_LIMIT, crossSession = true, sinceDays }) => {
      const results = ctx.storage.searchArchivedSessions(query, {
        currentSessionKey: ctx.currentSessionKey,
        crossSession,
        sinceDays,
        limit,
      });
      if (!results.length) return { message: `No old session matched "${query}".`, results: [] };

      const lines = results.flatMap((result, index) => [
        `${index + 1}. session:${result.sessionKey} checkpoint:${result.checkpointId} message:${result.messageId}`,
        `   time: ${result.startedAt} -> ${result.endedAt} | checkpoint_at: ${result.checkpointAt}`,
        `   score: ${result.score.toFixed(3)} | text: ${result.textScore.toFixed(3)} | recency: ${result.recencyScore.toFixed(3)}`,
        ...result.previewLines.map((line) => `   ${line}`),
      ]);

      const scope = crossSession ? `cross-session from current:${ctx.currentSessionKey}` : `current session only:${ctx.currentSessionKey}`;
      const time = sinceDays !== undefined ? ` | sinceDays:${sinceDays}` : "";
      return { output: [`scope: ${scope}${time}`, ...lines].join("\n"), results };
    },
  });
}
