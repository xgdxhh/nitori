import type { InboundMessage } from "./types.ts";
const SCHEDULED_SESSION_PREFIX = "scheduled";

export function resolveSessionKey(channelKey: string): string {
  return channelKey;
}

export function resolveInboundSessionKey(message: InboundMessage): string {
  if (message.trigger !== "scheduled") {
    return resolveSessionKey(message.channelKey);
  }

  return `${message.channelKey}/${SCHEDULED_SESSION_PREFIX}/${message.id}`;
}
