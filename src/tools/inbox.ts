import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolContext } from "../types.ts";

export function createReadInboxTool(ctx: ToolContext): Tool {
  return tool({
    description: "Browse messages from the global inbox. Supports pagination and filtering.",
    inputSchema: z.object({
      limit: z.number().optional().describe("Max messages to return").default(20),
      offset: z.number().optional().describe("Pagination offset").default(0),
      onlyUnread: z.boolean().optional().describe("Filter for unread messages only").default(false),
      channelKey: z.string().optional().describe("Filter for a specific channel (e.g. tg:group:123)"),
    }),
    execute: async ({ limit = 20, offset = 0, onlyUnread = false, channelKey }) => {
      const rows = ctx.readInbox({ limit, offset, onlyUnread, channelKey, markAsRead: true });

      if (rows.length === 0) {
        return { message: "Inbox is empty.", count: 0 };
      }

      const lines = rows.map((m) => {
        const d = new Date(m.receivedAt);
        const time = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
        const sender = `${m.sender.name}(${m.sender.id})`;
        const attachInfo = m.attachments.length > 0 ? ` [${m.attachments.length} ${m.attachments[0].type}]` : "";

        return `MessageID:${m.id} | ${time} | ${m.channelKey} | ${sender}: ${m.text || "(empty)"}${attachInfo}`;
      });

      const header = `### Inbox (limit:${limit}, offset:${offset}, unreadOnly:${onlyUnread})\n`;
      const output = header + lines.join("\n");

      return { output, count: rows.length };
    },
  });
}
