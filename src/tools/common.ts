import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function ensureParentDir(path: string): void {
  const dir = dirname(resolve(path));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function resolveInWorkspace(workspaceDir: string, input: string): string {
  const raw = input.trim();
  if (!raw) return resolve(workspaceDir);
  if (raw.startsWith("~/")) return resolve(raw.replace("~", process.env.HOME || "~"));
  if (raw.startsWith("/")) return resolve(raw);
  return resolve(workspaceDir, raw);
}

export function resolveMessageId(
  provided: string | undefined,
  fallback: string | undefined,
  fieldName: string,
  errorContext: string,
): string {
  const candidate = provided?.trim() || fallback?.trim();
  if (!candidate) {
    throw new Error(`${fieldName} is required for ${errorContext}`);
  }
  return candidate;
}
