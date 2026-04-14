import { EventEmitter } from "node:events";
import type { Adapter, AgentStreamEvent, InboundMessage } from "../types.ts";

export class AdapterManager {
  public readonly events = new EventEmitter();
  private readonly adapters = new Map<string, Adapter>();

  emitStreamEvent(channelKey: string, event: AgentStreamEvent): void {
    this.events.emit(`stream:${channelKey}`, event);
    this.events.emit("stream", channelKey, event); // Global listener support
  }

  subscribeStream(channelKey: string, listener: (event: AgentStreamEvent) => void): () => void {
    const eventName = `stream:${channelKey}`;
    this.events.on(eventName, listener);
    return () => this.events.off(eventName, listener);
  }

  register(adapter: Adapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  unregister(name: string): void {
    this.adapters.delete(name);
  }

  async start(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start();
    }
  }

  async stop(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  sendMessage(channelKey: string, text: string, replyToMessageId?: string): Promise<string> {
    return this.requireAdapterForChannel(channelKey).sendMessage(channelKey, text, replyToMessageId);
  }

  sendFile(channelKey: string, path: string, caption?: string): Promise<string> {
    const adapter = this.requireAdapterForChannel(channelKey);
    return adapter.sendFile
      ? adapter.sendFile(channelKey, path, caption)
      : adapter.sendMessage(channelKey, `[file] ${path}`);
  }

  setReaction(channelKey: string, messageId: string, emoji: string): Promise<string> {
    const adapter = this.requireAdapterForChannel(channelKey);
    return adapter.setReaction
      ? adapter.setReaction(channelKey, messageId, emoji)
      : Promise.resolve(`no-reaction:${messageId}:${emoji}`);
  }


  shouldProcessRealtime(message: InboundMessage): boolean {
    const trigger = message.trigger;
    return trigger === "direct" || trigger === "mention" || trigger === "reply";
  }

  private findAdapterForChannel(channelKey: string): Adapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.canHandleChannel(channelKey)) {
        return adapter;
      }
    }
    return undefined;
  }

  private requireAdapterForChannel(channelKey: string): Adapter {
    const adapter = this.findAdapterForChannel(channelKey);
    if (!adapter) {
      throw new Error(`No adapter available for channel ${channelKey}`);
    }
    return adapter;
  }
}
