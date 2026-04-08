import { generateText, stepCountIs, tool, type Tool } from "ai";
import { z } from "zod";
import type { AppConfig, SubagentConfig } from "../config/index.ts";
import type { McpClientManager } from "../mcp/client.ts";
import type { ToolContext } from "../types.ts";
import { createToolset } from "./index.ts";
import { getModel } from "../llm/profile.ts";
import { agentOutput } from "../agent/console.ts";

interface SubagentDeps {
  config: AppConfig;
  mcpManager: McpClientManager;
  toolContext: ToolContext;
}

export function createSubagentTool(deps: SubagentDeps): Tool | null {
  const names = Object.keys(deps.config.subagents);
  if (names.length === 0) return null;

  return tool({
    title: "subagent",
    description: `Delegate a task to a specialized subagent. Available: ${names.join(", ")}`,
    inputSchema: z.object({
      name: z.string().describe(`Subagent name. Available: ${names.join(", ")}`),
      task: z.string().describe("Detailed task description for the subagent"),
    }),
    execute: async ({ name, task }) => {
      const subConfig = deps.config.subagents[name];
      const profile = deps.config.llm.profiles[subConfig.profile];
      const model = getModel(profile);
      const tools = await buildSubagentTools(subConfig.tools, deps.toolContext, deps.mcpManager);

      agentOutput.toolCall("subagent", { name, toolCount: Object.keys(tools).length });

      const result = await generateText({
        model,
        system: subConfig.prompt,
        prompt: task,
        tools,
        stopWhen: stepCountIs(subConfig.maxSteps),
      });

      return result.text;
    },
  });
}

async function buildSubagentTools(
  toolsConfig: SubagentConfig["tools"],
  toolContext: ToolContext,
  mcpManager: McpClientManager,
): Promise<Record<string, Tool>> {
  const result: Record<string, Tool> = {};

  const builtinSet = new Set(toolsConfig.builtins);
  if (builtinSet.size > 0) {
    for (const t of createToolset(toolContext)) {
      if (builtinSet.has(t.title)) result[t.title] = t;
    }
  }

  if (toolsConfig.mcp.length > 0) {
    const allMcp = await mcpManager.tools();
    for (const [key, t] of Object.entries(allMcp)) {
      if (toolsConfig.mcp.some(p => matchPattern(p, key))) result[key] = t;
    }
  }

  return result;
}

function matchPattern(pattern: string, key: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(":*")) return key.startsWith(pattern.slice(0, -1));
  return pattern === key;
}
