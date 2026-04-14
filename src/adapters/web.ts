import type { Adapter, AgentStreamEvent } from "../types.ts";
import type { ServerWebSocket } from "bun";

export interface WebAdapterInstance {
  adapter: Adapter;
  handleUpgrade(ws: ServerWebSocket<unknown>, channelKey: string): void;
  handleClose(channelKey: string): void;
  pushEvent(channelKey: string, event: AgentStreamEvent): void;
}

/**
 * WebAdapter handles real-time communication with web-based clients via WebSockets.
 * It maps channel keys (starting with 'web:') to active WebSocket connections.
 */
export function createWebAdapter(): WebAdapterInstance {
  const connections = new Map<string, ServerWebSocket<unknown>>();

  const adapter: Adapter = {
    name: "web",
    start: async () => {},
    stop: async () => {
      connections.clear();
    },
    canHandleChannel: (channelKey) => channelKey.startsWith("web:"),
    sendMessage: async (channelKey, text, replyToMessageId) => {
      const ws = connections.get(channelKey);
      if (ws) {
        ws.send(JSON.stringify({ type: "assistant-message", text, replyToMessageId }));
      }
      return `web-msg-${Date.now()}`;
    },
  };

  return {
    adapter,
    handleUpgrade: (ws, channelKey) => {
      connections.set(channelKey, ws);
    },
    handleClose: (channelKey) => {
      connections.delete(channelKey);
    },
    pushEvent: (channelKey, event) => {
      const ws = connections.get(channelKey);
      if (ws) {
        ws.send(JSON.stringify(event));
      }
    },
  };
}
