import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface TelegramBusinessConfig {
  respondInPrivate: boolean;
  respondInGroups: boolean;
  groupTriggerMode: "mention_or_reply" | "all_messages";
  allowedChatIds: string[];
  blockedChatIds: string[];
  allowedUserIds: string[];
  blockedUserIds: string[];
}

const DEFAULT_CONFIG: TelegramBusinessConfig = {
  respondInPrivate: true,
  respondInGroups: true,
  groupTriggerMode: "mention_or_reply",
  allowedChatIds: [],
  blockedChatIds: [],
  allowedUserIds: [],
  blockedUserIds: [],
};

export function loadTelegramBusinessConfig(workspaceDir: string): TelegramBusinessConfig {
  const path = join(workspaceDir, "telegram.json");
  if (!existsSync(path)) return DEFAULT_CONFIG;
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(path, "utf-8")) };
}

