import { tool } from "ai";
import { z } from "zod";
import type { ToolFactory } from "packages/nitori-types/index.ts";
import { TerminalSessionManager } from "./session-manager.ts";

const sessions = new TerminalSessionManager();

export function createTerminalToolFactories(): ToolFactory[] {
  return [
    (ctx) => tool({
      description: "Start a persistent shell session inside the workspace.",
      inputSchema: z.object({
        shell: z.string().optional().describe("Shell to use"),
        cwd: z.string().optional().describe("Working directory"),
      }),
      execute: async ({ shell, cwd }) => {
        const session = sessions.create(ctx.workspaceDir, shell, cwd);
        return { sessionId: session.id, shell: session.shell, cwd: session.cwd, pid: session.pid };
      },
    }),
    () => tool({
      description: "Send raw input to a terminal session.",
      inputSchema: z.object({
        sessionId: z.string().describe("Session ID"),
        input: z.string().describe("Input to send"),
      }),
      execute: async ({ sessionId, input }) => {
        sessions.write(sessionId, input);
        return { sent: input.length, sessionId };
      },
    }),
    () => tool({
      description: "Read output from a terminal session since a cursor position.",
      inputSchema: z.object({
        sessionId: z.string().describe("Session ID"),
        since: z.number().optional().describe("Cursor position to read from"),
      }),
      execute: async ({ sessionId, since }) => {
        const result = sessions.read(sessionId, since);
        return {
          output: result.output,
          cursor: result.cursor,
          baseOffset: result.baseOffset,
          truncated: result.truncated,
          closed: result.closed,
          exitCode: result.exitCode,
        };
      },
    }),
    () => tool({
      description: "Terminate a terminal session.",
      inputSchema: z.object({
        sessionId: z.string().describe("Session ID"),
      }),
      execute: async ({ sessionId }) => {
        const session = sessions.close(sessionId);
        return { closed: sessionId, shell: session.shell, cwd: session.cwd, pid: session.pid };
      },
    }),
  ];
}

export function closeAllTerminalSessions(): void {
  sessions.closeAll();
}
