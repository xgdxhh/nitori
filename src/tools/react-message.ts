import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolContext } from "../types.ts";
import { resolveMessageId } from "./common.ts";

export function createReactMessageTool(ctx: ToolContext): Tool {
  return tool({
    title: "react",
    description: "React to a message with an emoji.",
    inputSchema: z.object({
      messageId: z.string().optional().describe("Message ID to react to"),
      emoji: z.string().describe("Emoji to add"),
      channel: z.string().optional().describe("Optional channel key, e.g. tg:dm:123 or tg:group:-100456"),
    }),
    execute: async ({ messageId: rawMessageId, emoji, channel }) => {
      const messageId = resolveTargetMessageId(ctx, rawMessageId);
      const reactionId = await ctx.adapterManager.setReaction(channel || ctx.currentChannelKey, messageId, emoji);
      return { messageId, emoji, reactionId, ok: true };
    },
  });
}

function resolveTargetMessageId(ctx: ToolContext, provided: string | undefined): string {
  return resolveMessageId(provided, ctx.currentMessageId, "messageId", "this action");
}
