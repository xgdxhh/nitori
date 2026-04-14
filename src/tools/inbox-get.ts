import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolContext } from "../types.ts";

export function createGetInboxMessageTool(ctx: ToolContext): Tool {
  return tool({
    description: "Fetch a single inbox message by ID (external_id) and channel_key.",
    inputSchema: z.object({
      id: z.string().describe("Inbox message id (external_id)"),
      channelKey: z.string().optional().describe("Channel key. Defaults to current channel."),
    }),
    execute: async ({ id, channelKey }) => {
      const ck = (channelKey ?? ctx.currentChannelKey).trim();
      const msg = ctx.storage.getInboxMessage(ck, id, { markAsRead: true });
      if (!msg) {
        return { found: false, message: `Inbox message not found. channelKey=${ck} id=${id}` };
      }
      const attachments = msg.attachments.map((a) => `- ${a.type}: ${a.path}`).join("\n");

      const text = [
        `received_at: ${msg.receivedAt}`,
        `sender: ${msg.sender.name || "Unknown"} (${msg.sender.id})`,
        `text: ${msg.text?.trim() || "(no text)"}`,
        attachments && `attachments:\n${attachments}`,
      ]
        .filter(Boolean)
        .join("\n");

      return { found: true, ...msg, text };
    },
  });
}
