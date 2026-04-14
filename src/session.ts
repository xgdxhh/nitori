import type { AppConfig } from "./config/index.ts";

export const GLOBAL_SESSION_KEY = "global";

export function resolveSessionKey(config: Pick<AppConfig, "agent">, channelKey: string): string {
  return config.agent.sessionScope === "global" ? GLOBAL_SESSION_KEY : channelKey;
}
