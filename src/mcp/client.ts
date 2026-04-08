import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "ai";

export interface McpServerConfig {
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface ManagedClient {
  name: string;
  client: MCPClient;
}

export class McpClientManager {
  private clients: ManagedClient[] = [];

  async start(servers: Record<string, McpServerConfig>): Promise<void> {
    const entries = Object.entries(servers);
    if (entries.length === 0) return;

    const results = await Promise.allSettled(
      entries.map(async ([name, config]) => {
        const client = await this.createClient(name, config);
        return { name, client };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        this.clients.push(result.value);
        console.log(`[mcp] connected: ${result.value.name}`);
      } else {
        console.error(`[mcp] failed to connect:`, result.reason);
      }
    }
  }

  async tools(): Promise<Record<string, Tool>> {
    const merged: Record<string, Tool> = {};

    const results = await Promise.allSettled(
      this.clients.map(async ({ name, client }) => {
        const tools = await client.tools() as Record<string, Tool>;
        return { name, tools };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const [toolName, tool] of Object.entries(result.value.tools)) {
          merged[`${result.value.name}:${toolName}`] = tool;
        }
      } else {
        console.error(`[mcp] failed to fetch tools:`, result.reason);
      }
    }

    return merged;
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      this.clients.map(({ client }) => client.close()),
    );
    this.clients = [];
  }

  private async createClient(name: string, config: McpServerConfig): Promise<MCPClient> {
    if (config.transport === "stdio") {
      return createMCPClient({
        name,
        transport: new StdioClientTransport({
          command: config.command!,
          args: config.args,
          env: config.env as Record<string, string> | undefined,
        }),
      });
    }

    return createMCPClient({
      name,
      transport: {
        type: config.transport,
        url: config.url!,
        headers: config.headers,
      },
    });
  }
}
