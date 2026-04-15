import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "ai";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface McpServerConfig {
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpManager {
  start: (servers: Record<string, McpServerConfig>, workspaceDir: string) => Promise<void>;
  tools: () => Promise<Record<string, Tool>>;
  close: () => Promise<void>;
}

export function createMcpManager(): McpManager {
  let clients: { name: string; client: MCPClient }[] = [];

  const start = async (servers: Record<string, McpServerConfig>, workspaceDir: string) => {
    const entries = Object.entries(servers);
    if (entries.length === 0) return;

    // Ensure logs directory exists
    const logDir = join(workspaceDir, "logs");
    try {
      mkdirSync(logDir, { recursive: true });
    } catch {
      // Ignore
    }

    const results = await Promise.allSettled(
      entries.map(async ([name, config]) => {
        const client = await createClient(name, config, logDir);
        return { name, client };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        clients.push(result.value);
        console.log(`[mcp] connected: ${result.value.name}`);
      } else {
        console.error(`[mcp] failed to connect:`, result.reason);
      }
    }
  };

  const tools = async () => {
    const merged: Record<string, Tool> = {};

    const results = await Promise.allSettled(
      clients.map(async ({ name, client }) => {
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
  };

  const close = async () => {
    await Promise.allSettled(clients.map(({ client }) => client.close()));
    clients = [];
  };

  return { start, tools, close };
}

async function createClient(name: string, config: McpServerConfig, logDir: string): Promise<MCPClient> {
  if (config.transport === "stdio") {
    const logFile = join(logDir, `mcp-${name}.log`);
    const logStream = createWriteStream(logFile, { flags: "a" });
    const timestamp = new Date().toISOString();
    logStream.write(`\n--- Starting ${name} at ${timestamp} ---\n`);

    const transportOptions: StdioServerParameters = {
      command: config.command!,
      args: config.args,
      env: {
        ...process.env,
        ...config.env,
      },
      stderr: "pipe",
    };
    const transport = new StdioClientTransport(transportOptions);

    const stderr = transport.stderr;
    if (stderr) {
      stderr.pipe(logStream);
    }

    return createMCPClient({
      name,
      transport,
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
