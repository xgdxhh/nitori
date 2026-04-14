import { join } from "node:path";
import { createSessionStorage } from "../storage/sessions.ts";
import { createSchedulerStorage } from "../storage/scheduler.ts";
import { processChannel } from "./kernel.ts";
import { createScheduleHandler } from "../schedule/handler.ts";
import { handleControlCommand } from "./commands.ts";
import { TelegramAdapter } from "../adapters/telegram.ts";
import { CliAdapter } from "../adapters/cli.ts";
import { createWebAdapter } from "../adapters/web.ts";
import { AdapterManager } from "../adapters/manager.ts";
import { EventScheduler } from "../schedule/scheduler.ts";
import type { InboundMessage, TriggerType } from "../types.ts";
import { createIngressServer, shouldStartIngressServer, type IngressServer } from "../ingress/server.ts";

import { loadExtensions, type ExtensionRegistry } from "../extension/loader.ts";
import { createMcpManager } from "../mcp/client.ts";
import type { AppConfig } from "../config/index.ts";
import { agentOutput } from "./console.ts";
import type { AgentStreamEvent } from "../types.ts";

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
  const mcpManager = createMcpManager();
  const webAdapterInstance = createWebAdapter();

  async function processAndReply(message: InboundMessage) {
    await processChannel(message.channelKey, [message], {
      config,
      sessionStorage,
      adapterManager,
      scheduleHandler,
      toolFactories: extRegistry?.activeToolFactories ?? [],
      turnHooks: extRegistry?.activeHooks ?? [],
      mcpManager,
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
        turnHooks: extRegistry?.activeHooks ?? [],
        mcpManager,
      });
    },
  });

  for (const adapter of extRegistry.activeAdapters) {
    adapterManager.register(adapter);
  }

  // Register Web Adapter
  adapterManager.register(webAdapterInstance.adapter);

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
    ingressServer = createIngressServer(config, messageHandler.onInbound, webAdapterInstance);
  }

  adapterManager.events.on("stream", (channelKey: string, event: AgentStreamEvent) => {
    // Forward to WebAdapter for real-time UI
    webAdapterInstance.pushEvent(channelKey, event);

    switch (event.type) {
      case "assistant-start":
        agentOutput.assistantStarted();
        break;
      case "text-delta":
        agentOutput.assistantDelta(event.delta);
        break;
      case "thinking":
        agentOutput.thinkingDelta(event.delta);
        break;
      case "tool-call-start":
        agentOutput.toolCall(event.toolName, event.args as Record<string, unknown>);
        break;
      case "tool-call-result":
        agentOutput.toolResult(event.toolName, 0, event.isError);
        break;
      case "turn-finish":
      case "turn-error":
        break;
    }
  });

  await mcpManager.start(config.mcp, config.workspaceDir);
  await adapterManager.start();
  scheduler.start();

  const stop = async () => {
    scheduler?.stop();
    await ingressServer?.stop();
    await adapterManager.stop();
    await extRegistry?.unloadAll();
    await mcpManager.close();
  };

  process.on("SIGINT", () => stop().then(() => process.exit(0)));
  process.on("SIGTERM", () => stop().then(() => process.exit(0)));
}
