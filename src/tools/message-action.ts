import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolContext } from "../types.ts";
import { resolveMessageId } from "./message-id.ts";

export function createSendTool(ctx: ToolContext): Tool {
  return tool({
    title: "send",
    description: "Send a new message to the current session.",
    inputSchema: z.object({
      content: z.string().describe("Message content"),
      channel: z.string().optional().describe("Optional channel key, e.g. tg:dm:123 or tg:group:456"),
    }),
    execute: async ({ content, channel }) => {
      if (!content.trim()) {
        return { skipped: true, message: "empty content" };
      }

      const messageId = await ctx.adapterManager.sendMessage(channel || ctx.currentChannelKey, content);
      return { messageId, sent: true };
    },
  });
}

export function createReplyTool(ctx: ToolContext): Tool {
  return tool({
    title: "reply",
    description: "Reply to a specific inbox external_id (platform message id).",
    inputSchema: z.object({
      message_id: z.string().describe("Inbox external_id (platform message id)"),
      content: z.string().describe("Reply content"),
      channel: z.string().optional().describe("Optional channel key, e.g. tg:dm:123 or tg:group:456"),
    }),
    execute: async ({ message_id, content, channel }) => {
      if (!content.trim()) {
        return { skipped: true, message: "empty content" };
      }

      const targetId = resolveMessageId(message_id, undefined, "message_id", "reply");
      const sentId = await ctx.adapterManager.sendMessage(channel || ctx.currentChannelKey, content, targetId);
      return { messageId: targetId, sentId, replied: true };
    },
  });
}
