import type { AppConfig } from "../config/index.ts";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadWorkspaceSkills } from "./skills.ts";

const cache = new Map<string, { mtime: number; content: string }>();

function readIfExistsCached(path: string): string {
  try {
    if (!existsSync(path)) {
      cache.delete(path);
      return "";
    }
    const mtime = statSync(path).mtimeMs;
    const cached = cache.get(path);
    if (cached && cached.mtime === mtime) return cached.content;

    const content = readFileSync(path, "utf-8");
    cache.set(path, { mtime, content });
    return content;
  } catch {
    return "";
  }
}

export function buildSystemPrompt(workspaceDir: string, config: AppConfig): string {
  const agentsDoc = readIfExistsCached(join(workspaceDir, "AGENTS.md"));
  const soulDoc = readIfExistsCached(join(workspaceDir, "SOUL.md"));
  const skills = loadSkillsSummary(workspaceDir, config.agent.skills.disabled);

  return `${soulDoc || "SOUL.md: (missing)"}
  
${agentsDoc || "AGENTS.md: (missing)"}

Skills:
${skills || "(none)"}

WorkspaceDir: ${workspaceDir}`;
}

function loadSkillsSummary(workspaceDir: string, disabledSkillNames: string[]): string {
  const globalDir = join(workspaceDir, ".agents/skills");
  if (!existsSync(globalDir)) return "";

  const disabled = new Set(disabledSkillNames);
  const skills = loadWorkspaceSkills(workspaceDir).filter((skill) => !disabled.has(skill.name));

  const lines = skills.map((s) => `- ${s.name}: ${s.description} (${s.filePath})`);
  return lines.join("\n");
}
