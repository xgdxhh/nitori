import { join } from "node:path";
import { createSessionStorage } from "../storage/sessions.ts";
import { createSchedulerStorage } from "../storage/scheduler.ts";
import { processChannel } from "./kernel.ts";
import { createScheduleHandler } from "../schedule/handler.ts";
import { handleControlCommand } from "./commands.ts";
import { TelegramAdapter } from "../adapters/telegram.ts";
import { CliAdapter } from "../adapters/cli.ts";
import { AdapterManager } from "../adapters/manager.ts";
import { EventScheduler } from "../schedule/scheduler.ts";
import type { InboundMessage, TriggerType } from "../types.ts";
import { createIngressServer, shouldStartIngressServer, type IngressServer } from "../ingress/server.ts";

import { loadExtensions, type ExtensionRegistry } from "../extension/loader.ts";
import type { AppConfig } from "../config/index.ts";

function createExtensionAgentMessage(extensionName: string, request: { channelKey: string; prompt: string; trigger?: TriggerType; metadata?: Record<string, unknown> }): InboundMessage {
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
  const sessionStorage = createSessionStorage(join(config.workspaceDir, "chats"));
  const schedulerStorage = createSchedulerStorage(config.workspaceDir);
  let scheduler: EventScheduler | null = null;
  let ingressServer: IngressServer | null = null;
  let extRegistry: ExtensionRegistry | null = null;
  const scheduleHandler = createScheduleHandler(schedulerStorage, () => scheduler?.signal());
  const adapterManager = new AdapterManager();

  async function processAndReply(message: InboundMessage) {
    await processChannel(message.channelKey, [message], {
      config,
      sessionStorage,
      adapterManager,
      scheduleHandler,
      toolFactories: extRegistry?.activeToolFactories ?? [],
    });
  }

  const messageHandler = {
    onInbound: async (message: InboundMessage) => {
      const api = { replyMessage: (id: string, text: string) => adapterManager.sendMessage(message.channelKey, text, id) };

      if (await handleControlCommand({ message, config, storage: null as never, sessionStorage, api, extRegistry: extRegistry ?? undefined, adapterManager })) {
        return;
      }

      if (adapterManager.shouldProcessRealtime(message)) {
        await processAndReply(message);
      }
    }
  };

  extRegistry = await loadExtensions({
    extensionNames: config.extensions,
    workspaceDir: config.workspaceDir,
    messageHandler,
    agentEnqueue: async (extensionName, request, getToolFactories) => {
      const message = createExtensionAgentMessage(extensionName, request);
      await processChannel(message.channelKey, [message], {
        config,
        sessionStorage,
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

  scheduler = new EventScheduler(schedulerStorage, async (msgs) => {
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
  };

  process.on("SIGINT", () => stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => stop().then(() => process.exit(0)));
}
