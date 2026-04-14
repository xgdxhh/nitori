import { existsSync, statSync } from "node:fs";
import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolContext } from "../types.ts";
import { resolveInWorkspace } from "./common.ts";

export function createAttachTool(ctx: ToolContext): Tool {
  return tool({
    description: "Send a local file back to the current conversation.",
    inputSchema: z.object({
      path: z.string().describe("Path to file"),
      caption: z.string().optional().describe("Optional caption"),
    }),
    execute: async ({ path: rawPath, caption }) => {
      const path = resolveInWorkspace(ctx.workspaceDir, rawPath);
      if (!existsSync(path)) throw new Error(`File not found: ${path}`);
      const stat = statSync(path);
      if (!stat.isFile()) throw new Error("Path is not a file.");
      const messageId = await ctx.adapterManager.sendFile(ctx.currentChannelKey, path, caption);
      return { path, messageId, size: stat.size, attached: true };
    },
  });
}
