import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as v from "valibot";
import { BUILTIN_TEMPLATE_DOCS, TEMPLATE_DOC_NAMES, EXTRA_DOCS, EXTRA_DOC_NAMES } from "../generated/builtin-templates.ts";
import type { McpServerConfig } from "../mcp/client.ts";

export interface AppConfig {
  workspaceDir: string;
  ingress: {
    host: string;
    port: number;
    token: string;
  };
  llm: {
    profiles: Record<string, LlmProfile>;
    activeName: string;
  };
  agent: {
    autoSendAssistantText: boolean;
    sessionScope: "channel" | "global";
    hideSourceInfo: boolean;
    skills: { disabled: string[] };
    compaction: {
      enabled: boolean;
      reserveTokens: number;
    };
  };
  mcp: Record<string, McpServerConfig>;
  subagents: Record<string, SubagentConfig>;
  extensions: string[];
  telegramToken?: string;
}

export interface LlmProfile {
  provider: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  providerOptions?: Record<string, unknown>;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  compat?: Record<string, unknown>;
}

export interface SubagentConfig {
  prompt: string;
  profile: string;
  tools: {
    builtins: string[];
    mcp: string[];
  };
  maxSteps: number;
}

const IngressSchema = v.object({
  host: v.optional(v.string(), "127.0.0.1"),
  port: v.optional(v.number(), 0),
  token: v.optional(v.string(), ""),
});

const createLlmProfileSchema = () => v.object({
  provider: v.string(),
  model: v.string(),
  apiKey: v.optional(v.string()),
  baseUrl: v.optional(v.string()),
  headers: v.optional(v.record(v.string(), v.string())),
  providerOptions: v.optional(v.record(v.string(), v.unknown())),
  thinkingLevel: v.optional(v.union([v.literal("off"), v.literal("minimal"), v.literal("low"), v.literal("medium"), v.literal("high")])),
  compat: v.optional(v.record(v.string(), v.unknown())),
});

const AgentSchema = v.object({
  autoSendAssistantText: v.optional(v.boolean(), false),
  sessionScope: v.optional(v.union([v.literal("channel"), v.literal("global")]), "channel"),
  hideSourceInfo: v.optional(v.boolean(), false),
  skills: v.optional(v.object({
    disabled: v.optional(v.array(v.string()), []),
  }), { disabled: [] }),
  compaction: v.optional(v.object({
    enabled: v.optional(v.boolean(), true),
    reserveTokens: v.optional(v.number(), 16384),
  }), { enabled: true, reserveTokens: 16384 }),
});

const McpServerSchema = v.object({
  transport: v.union([v.literal("stdio"), v.literal("http"), v.literal("sse")]),
  command: v.optional(v.string()),
  args: v.optional(v.array(v.string())),
  env: v.optional(v.record(v.string(), v.string())),
  url: v.optional(v.string()),
  headers: v.optional(v.record(v.string(), v.string())),
});

const SubagentToolsSchema = v.object({
  builtins: v.optional(v.array(v.string()), []),
  mcp: v.optional(v.array(v.string()), []),
});

const SubagentConfigSchema = v.object({
  prompt: v.string(),
  profile: v.string(),
  tools: v.optional(SubagentToolsSchema, { builtins: [], mcp: [] }),
  maxSteps: v.optional(v.number(), 10),
});

export function loadConfig(): AppConfig {
  const home = resolvePath(process.env.NITORI_HOME || join(homedir(), ".nitori"));
  const settingsPath = join(home, "settings.json");
  
  const rawJson = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf-8")) : {};

  const SettingsSchema = v.object({
    ingress: v.optional(IngressSchema, { host: "127.0.0.1", port: 0, token: "" }),
    llm: v.optional(v.object({
      profiles: v.optional(v.record(v.string(), createLlmProfileSchema()), {}),
      profile: v.optional(v.string(), ""),
    }), { profiles: {}, profile: "" }),
    agent: v.optional(AgentSchema, { autoSendAssistantText: false, sessionScope: "channel", skills: { disabled: [] }, compaction: { enabled: true, reserveTokens: 16384 } }),
    mcp: v.optional(v.record(v.string(), McpServerSchema), {}),
    subagents: v.optional(v.record(v.string(), SubagentConfigSchema), {}),
    extensions: v.optional(v.array(v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/))), []),
    telegramToken: v.optional(v.string()),
  });

  const parsed = v.parse(SettingsSchema, rawJson);
  const profiles = parsed.llm.profiles as Record<string, LlmProfile>;
  const activeName = parsed.llm.profile || Object.keys(profiles)[0] || "";

  return {
    ...parsed,
    workspaceDir: home,
    llm: { profiles, activeName },
    mcp: parsed.mcp as Record<string, McpServerConfig>,
    subagents: parsed.subagents as Record<string, SubagentConfig>,
  } as AppConfig;
}


export function ensureWorkspaceLayout(workspaceDir: string): void {
  const dirs = [".agents/skills", "files", "extensions", "documents"];
  mkdirSync(workspaceDir, { recursive: true });
  dirs.forEach(d => mkdirSync(join(workspaceDir, d), { recursive: true }));
  TEMPLATE_DOC_NAMES.forEach(name => {
    const dst = join(workspaceDir, name);
    if (!existsSync(dst)) writeFileSync(dst, BUILTIN_TEMPLATE_DOCS[name], "utf-8");
  });
  EXTRA_DOC_NAMES.forEach(name => {
    const dst = join(workspaceDir, "documents", name);
    if (!existsSync(dst)) writeFileSync(dst, EXTRA_DOCS[name], "utf-8");
  });
  const settingsPath = join(workspaceDir, "settings.json");
  if (!existsSync(settingsPath)) {
    const c = loadConfig();
    writeFileSync(
      settingsPath,
      JSON.stringify(
        { ingress: c.ingress, llm: c.llm, agent: c.agent, telegramToken: c.telegramToken },
        null,
        2,
      ),
      "utf-8",
    );
  }
}

export function saveActiveProfile(workspaceDir: string, profileName: string): void {
  const path = join(workspaceDir, "settings.json");
  const data = JSON.parse(readFileSync(path, "utf-8"));
  if (!data.llm) data.llm = {};
  data.llm.profile = profileName;
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function resolvePath(input: string, base = process.cwd()): string {
  if (input.startsWith("~/")) return resolve(join(homedir(), input.slice(2)));
  return isAbsolute(input) ? input : resolve(base, input);
}
