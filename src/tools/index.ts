import { type Tool } from "ai";
import type { ToolContext } from "../types.ts";
import type { ToolFactory } from "../extension/types.ts";
import { createBuiltInCodingTools } from "./builtins.ts";
import { createAttachTool } from "./attach.ts";
import { createCronJobTool } from "./cron.ts";
import { createReadInboxTool } from "./inbox.ts";
import { createGetInboxMessageTool } from "./inbox-get.ts";
import { createReplyTool, createSendTool } from "./message-action.ts";
import { createFetchImageTool } from "./fetch-image.ts";
import { createReactMessageTool } from "./react-message.ts";
import { createWebFetchTool, createWebSearchTool } from "./web.ts";

export function createToolset(ctx: ToolContext, extraFactories: ToolFactory[] = []): Tool[] {
  const builtIns = createBuiltInCodingTools(ctx);

  return [
    ...builtIns,
    createWebFetchTool(ctx),
    createWebSearchTool(ctx),
    createAttachTool(ctx),
    createReadInboxTool(ctx),
    createGetInboxMessageTool(ctx),
    createFetchImageTool(ctx),
    createCronJobTool(ctx),
    createSendTool(ctx),
    createReplyTool(ctx),
    createReactMessageTool(ctx),
    ...extraFactories.map(f => f(ctx)),
  ];
}
