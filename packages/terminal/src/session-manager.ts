import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve, sep } from "node:path";

const MAX_BUFFER_LENGTH = 128 * 1024;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface TerminalSession {
  id: string;
  shell: string;
  cwd: string;
  pid: number;
  baseOffset: number;
  cursor: number;
  buffer: string;
  child: ChildProcessWithoutNullStreams;
  closed: boolean;
  exitCode: number | null;
  lastTouchedAt: number;
}

export interface TerminalReadResult {
  output: string;
  cursor: number;
  baseOffset: number;
  truncated: boolean;
  closed: boolean;
  exitCode: number | null;
}

export class TerminalSessionManager {
  private readonly sessions = new Map<string, TerminalSession>();

  create(workspaceDir: string, shell?: string, cwd?: string): TerminalSession {
    this.closeIdleSessions();

    const sessionCwd = resolveSessionCwd(workspaceDir, cwd);
    const sessionShell = shell?.trim() || process.env.SHELL || "bash";
    const child = spawn(sessionShell, ["-i"], {
      cwd: sessionCwd,
      env: process.env,
      stdio: "pipe",
    });

    if (!child.pid) {
      throw new Error(`failed to start shell: ${sessionShell}`);
    }

    const session: TerminalSession = {
      id: randomUUID(),
      shell: sessionShell,
      cwd: sessionCwd,
      pid: child.pid,
      baseOffset: 0,
      cursor: 0,
      buffer: "",
      child,
      closed: false,
      exitCode: null,
      lastTouchedAt: Date.now(),
    };

    child.stdout.on("data", (chunk: Buffer) => {
      this.append(session, chunk.toString("utf-8"));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.append(session, chunk.toString("utf-8"));
    });

    child.on("close", (code) => {
      session.closed = true;
      session.exitCode = code;
      this.append(session, `\n[terminal exited with code ${String(code ?? -1)}]\n`);
    });

    child.on("error", (error) => {
      session.closed = true;
      this.append(session, `\n[terminal error: ${error.message}]\n`);
    });

    this.sessions.set(session.id, session);
    return session;
  }

  write(sessionId: string, input: string): TerminalSession {
    const session = this.get(sessionId);
    if (session.closed) {
      throw new Error(`terminal session is closed: ${sessionId}`);
    }
    session.child.stdin.write(input);
    session.lastTouchedAt = Date.now();
    return session;
  }

  read(sessionId: string, since?: number): TerminalReadResult {
    const session = this.get(sessionId);
    session.lastTouchedAt = Date.now();

    const start = Math.max(since ?? session.baseOffset, session.baseOffset);
    const output = session.buffer.slice(start - session.baseOffset);

    return {
      output,
      cursor: session.cursor,
      baseOffset: session.baseOffset,
      truncated: typeof since === "number" && since < session.baseOffset,
      closed: session.closed,
      exitCode: session.exitCode,
    };
  }

  close(sessionId: string): TerminalSession {
    const session = this.get(sessionId);
    session.child.kill("SIGTERM");
    this.sessions.delete(sessionId);
    return session;
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.child.kill("SIGTERM");
    }
    this.sessions.clear();
  }

  closeIdleSessions(now = Date.now()): void {
    for (const session of this.sessions.values()) {
      if (now - session.lastTouchedAt <= IDLE_TIMEOUT_MS) {
        continue;
      }
      session.child.kill("SIGTERM");
      this.sessions.delete(session.id);
    }
  }

  private get(sessionId: string): TerminalSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`terminal session not found: ${sessionId}`);
    }
    return session;
  }

  private append(session: TerminalSession, chunk: string): void {
    session.buffer += chunk;
    session.cursor += chunk.length;
    session.lastTouchedAt = Date.now();

    if (session.buffer.length <= MAX_BUFFER_LENGTH) {
      return;
    }

    const overflow = session.buffer.length - MAX_BUFFER_LENGTH;
    session.buffer = session.buffer.slice(overflow);
    session.baseOffset += overflow;
  }
}

function resolveSessionCwd(workspaceDir: string, cwd?: string): string {
  if (!cwd) {
    return workspaceDir;
  }

  const target = resolve(workspaceDir, cwd);
  if (target !== workspaceDir && !target.startsWith(`${workspaceDir}${sep}`)) {
    throw new Error(`cwd must stay inside workspace: ${cwd}`);
  }
  return target;
}
