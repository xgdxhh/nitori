import { join } from "node:path";
import { saveActiveProfile as save } from "../config/index.ts";
import type { AppConfig } from "../config/index.ts";
import type { InboundMessage } from "../types.ts";
import type { ExtensionRegistry } from "../extension/loader.ts";
import type { AdapterManager } from "../adapters/manager.ts";
import { resolveSessionKey } from "../session.ts";
import { createSessionStorage, generateSessionId, type SessionStorage } from "../storage/sessions.ts";

export interface CommandChannelApi {
  replyMessage: (messageId: string, text: string) => Promise<string>;
}

interface ControlCommandContext {
  message: InboundMessage;
  config: AppConfig;
  storage: null;
  sessionStorage?: SessionStorage;
  api: CommandChannelApi;
  extRegistry?: ExtensionRegistry;
  adapterManager?: AdapterManager;
}

const handlers: Record<string, (ctx: ControlCommandContext, args: string) => Promise<void>> = {
  stop: async ({ message, api }) => {
    await api.replyMessage(message.id, "Kernel is functional and stateless. Direct stop ignored.");
  },
  handoff: async ({ message, api, config, sessionStorage }) => {
    if (!sessionStorage) {
      sessionStorage = createSessionStorage(join(config.workspaceDir, "chats"));
    }
    const sessionKey = resolveSessionKey(config, message.channelKey);
    const newSessionId = generateSessionId();
    sessionStorage.createSession(sessionKey, newSessionId);
    await api.replyMessage(message.id, `Started a new session: ${newSessionId.slice(0, 8)}...`);
  },
  profile: handleProfileCommand,
  ext: handleExtCommand,
};

export async function handleControlCommand(ctx: ControlCommandContext): Promise<boolean> {
  const cmd = ctx.message.command;
  if (!cmd || !handlers[cmd.name]) return false;
  await handlers[cmd.name](ctx, cmd.args);
  return true;
}

async function handleProfileCommand({ message, config, api }: ControlCommandContext, args: string): Promise<void> {
  const requested = args.trim();
  const profiles = config.llm.profiles;
  if (!requested) {
    const p = profiles[config.llm.activeName];
    await api.replyMessage(message.id, `Current profile: ${config.llm.activeName} (${p?.provider}/${p?.model})\nAvailable: ${Object.keys(profiles).join(", ")}`);
    return;
  }

  if (!profiles[requested]) {
    await api.replyMessage(message.id, `Unknown profile: ${requested}. Available: ${Object.keys(profiles).join(", ")}`);
    return;
  }

  save(config.workspaceDir, requested);
  config.llm.activeName = requested;

  const p = profiles[requested];
  await api.replyMessage(message.id, `Switched to '${requested}' (${p.provider}/${p.model})`);
}

async function handleExtCommand({ message, api, extRegistry, adapterManager }: ControlCommandContext, args: string): Promise<void> {
  if (!extRegistry || !adapterManager) {
    await api.replyMessage(message.id, "Extension system unavailable.");
    return;
  }

  const [action, name] = args.split(/\s+/, 2);

  if (!action || action === "list") {
    const lines = extRegistry.names.map(n => {
      const meta = extRegistry.getMetadata(n);
      return `${extRegistry.isEnabled(n) ? "●" : "○"} ${n}${meta ? ` v${meta.version}` : ""}`;
    });
    await api.replyMessage(message.id, lines.length ? lines.join("\n") : "No extensions.");
    return;
  }

  if ((action === "enable" || action === "disable") && name) {
    if (action === "enable") {
      for (const a of await extRegistry.enable(name)) {
        adapterManager.register(a);
        await a.start();
      }
      await api.replyMessage(message.id, `Enabled: ${name}`);
    } else {
      for (const a of await extRegistry.disable(name)) {
        await a.stop();
        adapterManager.unregister(a.name);
      }
      await api.replyMessage(message.id, `Disabled: ${name}`);
    }
    return;
  }

  await api.replyMessage(message.id, "Usage: /ext [list | enable <name> | disable <name>]");
}

