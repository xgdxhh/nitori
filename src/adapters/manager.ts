import type { Adapter, InboundMessage } from "../types.ts";

export class AdapterManager {
  private readonly adapters = new Map<string, Adapter>();

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

  fetchImageContent(channelKey: string, path: string): Promise<{ data: string; mimeType: string }> {
    let adapter: Adapter | undefined;
    for (const a of this.adapters.values()) {
      if (a.canHandleFile?.(path)) {
        adapter = a;
        break;
      }
    }

    if (!adapter) {
      adapter = this.requireAdapterForChannel(channelKey);
    }

    if (!adapter.fetchImageContent) {
      return Promise.reject(new Error(`fetchImageContent not supported by adapter '${adapter.name}'`));
    }
    return adapter.fetchImageContent(channelKey, path);
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
