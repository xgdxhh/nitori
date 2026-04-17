import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tool } from "ai";
import { z } from "zod";
import type { Tool } from "ai";
import type { ToolContext } from "../types.ts";
import { ensureParentDir, resolveInWorkspace } from "./common.ts";
import { Buffer } from "node:buffer";

const DEFAULT_READ_LIMIT = 2000;
const DEFAULT_BASH_TIMEOUT = 30_000;

type BuiltInToolContext = Pick<ToolContext, "workspaceDir">;

export function createBuiltInCodingTools(ctx: BuiltInToolContext): Tool[] {
  return [
    createReadTool(ctx),
    createBashTool(ctx),
    createEditTool(ctx),
    createWriteTool(ctx),
    createGrepTool(ctx),
    createGlobTool(ctx),
    createSystemInfoTool(),
  ];
}

function createReadTool(ctx: BuiltInToolContext): Tool {
  return tool({
    title: "read",
    description: "Read a file or list a directory.",
    inputSchema: z.object({
      path: z.string().describe("Path to read or directory to list"),
      offset: z.number().optional().describe("Line offset to start reading (1-indexed)").default(1),
      limit: z.number().optional().describe("Max lines to read").default(DEFAULT_READ_LIMIT),
    }),
    execute: async ({ path, offset = 1, limit = DEFAULT_READ_LIMIT }) => {
      const target = resolveInWorkspace(ctx.workspaceDir, path);
      const st = statSync(target);
      if (st.isDirectory()) {
        const rows = readdirSync(target, { withFileTypes: true })
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
          .sort((a, b) => a.localeCompare(b));
        return rows.join("\n");
      }

      const content = readFileSync(target, "utf-8");
      const lines = content.split(/\r?\n/);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const numbered = slice.map((line, i) => `${offset + i}: ${line}`);
      return numbered.join("\n");
    },
  });
}

function createWriteTool(ctx: BuiltInToolContext): Tool {
  return tool({
    title: "write",
    description: "Write full content to a file.",
    inputSchema: z.object({
      path: z.string().describe("Path to write to"),
      content: z.string().describe("Content to write"),
    }),
    execute: async ({ path, content }) => {
      const target = resolveInWorkspace(ctx.workspaceDir, path);
      ensureParentDir(target);
      writeFileSync(target, content, "utf-8");
      return `Wrote ${target}`;
    },
  });
}

function createEditTool(ctx: BuiltInToolContext): Tool {
  return tool({
    title: "edit",
    description: "Replace first occurrence of oldText with newText.",
    inputSchema: z.object({
      path: z.string().describe("Path to file"),
      oldText: z.string().describe("Text to find"),
      newText: z.string().describe("Text to replace with"),
    }),
    execute: async ({ path, oldText, newText }) => {
      const target = resolveInWorkspace(ctx.workspaceDir, path);
      const content = readFileSync(target, "utf-8");
      const occurrences = content.split(oldText).length - 1;

      if (occurrences === 0) {
        return `Error: oldText not found in the file. Please provide the exact existing text.`;
      }
      if (occurrences > 1) {
        return `Error: oldText found ${occurrences} times. Please provide more surrounding lines (context) to uniquely identify the replacement target.`;
      }

      writeFileSync(target, content.replace(oldText, newText), "utf-8");
      return `Edited ${target}`;
    },
  });
}

function createBashTool(ctx: BuiltInToolContext): Tool {
  return tool({
    title: "bash",
    description: "Run a shell command in workspace.",
    inputSchema: z.object({
      command: z.string().describe("Shell command to execute"),
      timeout: z.number().optional().describe("Timeout in ms").default(DEFAULT_BASH_TIMEOUT),
    }),
    execute: async ({ command, timeout = DEFAULT_BASH_TIMEOUT }) => {
      const result = await runBash(ctx.workspaceDir, command, timeout);
      return { output: result.output, exitCode: result.exitCode, timedOut: result.timedOut };
    },
  });
}

async function runBash(
  cwd: string,
  command: string,
  timeoutMs: number,
): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("bash", ["-lc", command], { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = [stdout.trimEnd(), stderr.trimEnd(), `exit code: ${String(code ?? -1)}`]
        .filter(Boolean)
        .join("\n");
      resolvePromise({ output, exitCode: code, timedOut });
    });
  });
}
function createGrepTool(ctx: BuiltInToolContext): Tool {
  return tool({
    title: "grep",
    description: "Search for a pattern in files using ripgrep (rg) or grep.",
    inputSchema: z.object({
      pattern: z.string().describe("The pattern to search for (regex supported)"),
      path: z.string().optional().describe("Path to search in (default is workspace root)").default("."),
      caseInsensitive: z.boolean().optional().describe("Whether to perform case-insensitive search").default(false),
      limit: z.number().optional().describe("Max number of matches to return").default(200),
    }),
    execute: async ({ pattern, path = ".", caseInsensitive = false, limit = 200 }) => {
      // Try rg first
      const rgArgs = ["-n", "--column", "--no-heading", "--color", "never"];
      if (caseInsensitive) rgArgs.push("-i");
      rgArgs.push("-e", pattern, path);

      const result = await runBash(ctx.workspaceDir, `rg ${rgArgs.map((a) => JSON.stringify(a)).join(" ")}`, DEFAULT_BASH_TIMEOUT);

      // Exit code 0 means matches found, 1 means no matches found, 127/missing means command not found
      if (result.exitCode === 0) {
        return truncateMatches(result.output, limit);
      }
      if (result.exitCode === 1) {
        return "No matches found.";
      }

      // Fallback to grep
      const grepArgs = ["-rnE"];
      if (caseInsensitive) grepArgs[0] += "i";
      grepArgs.push(pattern, path);
      const grepResult = await runBash(
        ctx.workspaceDir,
        `grep ${grepArgs.map((a) => JSON.stringify(a)).join(" ")}`,
        DEFAULT_BASH_TIMEOUT,
      );

      if (grepResult.exitCode === 0) {
        return truncateMatches(grepResult.output, limit);
      }
      if (grepResult.exitCode === 1) {
        return "No matches found.";
      }

      return grepResult.output || "No matches found or grep failed.";
    },
  });
}

function createGlobTool(ctx: BuiltInToolContext): Tool {
  return tool({
    title: "glob",
    description: "List files matching a glob pattern using ripgrep (rg) or bash glob.",
    inputSchema: z.object({
      pattern: z.string().describe("The glob pattern to match (e.g. **/*.ts, src/*.js)"),
      limit: z.number().optional().describe("Max number of files to return").default(200),
    }),
    execute: async ({ pattern, limit = 200 }) => {
      // Use rg --files -g for fast globbing
      const result = await runBash(
        ctx.workspaceDir,
        `rg --files -g ${JSON.stringify(pattern)}`,
        DEFAULT_BASH_TIMEOUT,
      );

      if (result.exitCode === 0) {
        return truncateMatches(result.output, limit);
      }
      if (result.exitCode === 1 && !result.output.toLowerCase().includes("not found")) {
        return "No matches found.";
      }

      // Fallback to bash glob
      const bashGlob = `bash -O globstar -c "ls -d ${pattern}"`;
      const bashResult = await runBash(ctx.workspaceDir, bashGlob, DEFAULT_BASH_TIMEOUT);

      if (bashResult.exitCode === 0) {
        return truncateMatches(bashResult.output, limit);
      }
      return "No matches found.";
    },
  });
}

function createSystemInfoTool(): Tool {
  return tool({
    title: "get_system_info",
    description: "Get current system time and environment information (uname).",
    inputSchema: z.object({}),
    execute: async () => {
      const now = new Date().toLocaleString("sv-SE", { timeZoneName: "short" });
      let uname = "unknown";
      try {
        const { execSync } = await import("node:child_process");
        uname = execSync("uname -a", { encoding: "utf-8" }).trim();
      } catch (e) {
        uname = `Error getting uname: ${e}`;
      }
      return `Current Time: ${now}\nSystem Info: ${uname}`;
    },
  });
}

function truncateMatches(output: string, limit: number): string {
  const lines = output.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length <= limit) return output;

  return (
    lines.slice(0, limit).join("\n") +
    `\n\n... and ${lines.length - limit} more matches (truncated to ${limit} lines to save tokens).`
  );
}
