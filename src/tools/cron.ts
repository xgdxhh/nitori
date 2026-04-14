import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { CronJobRequest, ToolContext } from "../types.ts";

export function createCronJobTool(ctx: ToolContext): Tool {
  return tool({
    description: "Manage internal schedules for the current channel. Use create, list, get, update, or cancel. Not OS crontab.",
    inputSchema: z.object({
      op: z.enum(["create", "list", "get", "update", "cancel"]).describe("Operation to perform"),
      id: z.number().optional().describe("Schedule id for get, update, or cancel"),
      kind: z.enum(["once", "cron"]).optional().describe("Schedule kind"),
      prompt: z.string().optional().describe("Message text sent back to the agent when the schedule fires"),
      schedule: z.string().optional().describe("For kind=once use a datetime string. For kind=cron use a cron expression"),
      timezone: z.string().optional().describe("IANA timezone used to evaluate schedule"),
      limit: z.number().optional().describe("Max schedules to return for list"),
    }),
    execute: async (params) => {
      const request = params as CronJobRequest;
      const result = await ctx.cronJob(request);

      if (request.op === "list") {
        return { ...result, schedules: result.schedules || [] };
      }

      if (request.op === "get") {
        return { ...result, schedule: result.schedule || null };
      }

      return result;
    },
  });
}
