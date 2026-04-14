import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

export interface LocalSkillSummary { name: string; description: string; filePath: string; }

export function loadWorkspaceSkills(workspaceDir: string): LocalSkillSummary[] {
  const skillsDir = join(workspaceDir, ".agents/skills");
  const scan = (dir: string): LocalSkillSummary[] => {
    try {
      return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          const inner = scan(p);
          const skillDoc = inner.find(s => basename(s.filePath) === "SKILL.md");
          return skillDoc ? [{ ...skillDoc, name: e.name }] : inner;
        }
        if (e.isFile() && extname(e.name) === ".md") {
          return [{ name: basename(e.name, ".md"), description: extractDesc(readFileSync(p, "utf-8")), filePath: p }];
        }
        return [];
      });
    } catch { return []; }
  };

  const all = scan(skillsDir);
  return Array.from(new Map(all.map(s => [s.name, s])).values()).sort((a, b) => a.name.localeCompare(b.name));
}

function extractDesc(content: string): string {
  const fm = content.match(/^---\n[\s\S]*?description:\s*(.+)$/m);
  if (fm) return fm[1].trim().replace(/^['"]|['"]$/g, "");
  return content.split("\n").map(l => l.trim()).find(l => l && !l.startsWith("#")) || "(no description)";
}
