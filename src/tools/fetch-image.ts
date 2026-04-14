import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolContext } from "../types.ts";

export function createFetchImageTool(ctx: ToolContext): Tool {
  return tool({
    description: "Fetch image bytes by path (see attachments in prompt).",
    inputSchema: z.object({
      path: z.string().describe("Image path from attachments list."),
    }),
    execute: async ({ path }) => {
      if (!path) throw new Error("image path is required.");

      const image = await ctx.adapterManager.fetchImageContent(ctx.currentChannelKey, path);
      if (!image.mimeType.startsWith("image/")) {
        return {
          error: "not_an_image",
          message: `The file at ${path} is not an image (mimeType: ${image.mimeType}). fetch_image only supports image files.`,
          path,
          mimeType: image.mimeType,
        };
      }

      return {
        path,
        mimeType: image.mimeType,
        message: `Image fetched: ${path} (${image.mimeType})`,
        hasImage: true,
      };
    },
  });
}
