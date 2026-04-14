import { Storage } from "../storage/db.ts";
import { processChannel } from "./kernel.ts";
import { createScheduleHandler } from "../schedule/handler.ts";
import { handleControlCommand } from "./commands.ts";
import { TelegramAdapter } from "../adapters/telegram.ts";
import { CliAdapter } from "../adapters/cli.ts";
import { AdapterManager } from "../adapters/manager.ts";
import { EventScheduler } from "../schedule/scheduler.ts";
import type { ExtensionAgentEnqueueRequest, InboundMessage } from "../types.ts";
import { createIngressServer, shouldStartIngressServer, type IngressServer } from "../ingress/server.ts";


import { loadExtensions, type ExtensionRegistry } from "../extension/loader.ts";
import type { AppConfig } from "../config/index.ts";

function createExtensionAgentMessage(extensionName: string, request: ExtensionAgentEnqueueRequest): InboundMessage {
  return {
    id: `ext-${extensionName}-${crypto.randomUUID()}`,
    source: `extension:${extensionName}`,
    channelKey: request.channelKey,
    sender: {
      id: `extension:${extensionName}`,
      name: extensionName,
      isBot: true,
    },
    text: request.prompt,
    attachments: [],
    receivedAt: new Date().toISOString(),
    trigger: request.trigger ?? "scheduled",
    raw: request.metadata ? { extension: extensionName, ...request.metadata } : { extension: extensionName },
  };
}

export async function runDaemon(config: AppConfig, options: { cliMode: boolean }) {
  const storage = new Storage(config.dbPath).init();
  let scheduler: EventScheduler | null = null;
  let ingressServer: IngressServer | null = null;
  let extRegistry: ExtensionRegistry | null = null;
  const scheduleHandler = createScheduleHandler(storage, () => scheduler?.signal());
  const adapterManager = new AdapterManager();

  async function processAndReply(message: InboundMessage) {
    await processChannel(message.channelKey, [message], {
      config,
      storage,
      adapterManager,
      scheduleHandler,
      toolFactories: extRegistry?.activeToolFactories ?? [],
    });
  }

  const messageHandler = {
    onInbound: async (message: InboundMessage) => {
      if (!storage.insertInboxMessage(message)) return;

      const api = { replyMessage: (id: string, text: string) => adapterManager.sendMessage(message.channelKey, text, id) };

      if (await handleControlCommand({ message, config, storage, api, extRegistry: extRegistry ?? undefined, adapterManager })) {
        storage.markInboxMessageRead(message.channelKey, message.id);
        return;
      }

      if (adapterManager.shouldProcessRealtime(message)) {
        storage.markInboxMessageRead(message.channelKey, message.id);
        await processAndReply(message);
      }
    }
  };

  extRegistry = await loadExtensions({
    extensionNames: config.extensions,
    workspaceDir: config.workspaceDir,
    messageHandler,
    inboxList: (options) => storage.listInbox(options),
    listUnreadChannels: () => storage.listUnreadInboxChannels(),
    agentEnqueue: async (extensionName, request, getToolFactories) => {
      const message = createExtensionAgentMessage(extensionName, request);
      await processChannel(message.channelKey, [message], {
        config,
        storage,
        adapterManager,
        scheduleHandler,
        toolFactories: getToolFactories(),
      });
    },
  });

  for (const adapter of extRegistry.activeAdapters) {
    adapterManager.register(adapter);
  }

  if (options.cliMode) {
    adapterManager.register(new CliAdapter(messageHandler));
  } else {
    if (config.telegramToken) {
      adapterManager.register(new TelegramAdapter(config.telegramToken, config.workspaceDir, messageHandler));
    }
  }

  scheduler = new EventScheduler(storage, async (msgs) => {
    for (const m of msgs) await processAndReply(m);
  });

  if (shouldStartIngressServer(config)) {
    ingressServer = createIngressServer(config, messageHandler.onInbound);
  }

  await adapterManager.start();
  scheduler.start();

  const stop = async () => {
    scheduler?.stop();
    await ingressServer?.stop();
    await adapterManager.stop();
    await extRegistry?.unloadAll();
    storage.close();
  };



  process.on("SIGINT", () => stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => stop().then(() => process.exit(0)));
}
