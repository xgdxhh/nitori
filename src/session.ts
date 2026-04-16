import type { AppConfig } from "./config/index.ts";
import type { InboundMessage } from "./types.ts";

export const GLOBAL_SESSION_KEY = "global";
const SCHEDULED_SESSION_PREFIX = "scheduled";

export function resolveSessionKey(config: Pick<AppConfig, "agent">, channelKey: string): string {
  return config.agent.sessionScope === "global" ? GLOBAL_SESSION_KEY : channelKey;
}

export function resolveInboundSessionKey(config: Pick<AppConfig, "agent">, message: InboundMessage): string {
  if (message.trigger !== "scheduled") {
    return resolveSessionKey(config, message.channelKey);
  }

  return `${message.channelKey}/${SCHEDULED_SESSION_PREFIX}/${message.id}`;
}
