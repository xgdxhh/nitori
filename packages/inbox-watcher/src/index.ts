import type { ExtensionContext, NitoriExtension } from "nitori-types";

const POLL_MS = 5 * 60 * 1000;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pollUnreadInbox(ctx: ExtensionContext): Promise<void> {
  const channels = ctx.host.inbox.listUnreadChannels();
  if (channels.length === 0) return;

  for (const channel of channels) {
    await ctx.host.agent.enqueue({
      channelKey: channel.channelKey,
      prompt: `You have ${channel.unreadCount} unread inbox messages for this channel. Use \`read_inbox\` to review them before taking action.`,
      trigger: "scheduled",
      metadata: {
        kind: "inbox-watcher",
        unreadCount: channel.unreadCount,
      },
    });
  }

  ctx.host.log.info("nudged unread channels", { channels: channels.length });
}

export default {
  name: "inbox-watcher",
  version: "0.1.0",
  description: "Periodically nudges the agent to process unread inbox messages",

  activate(ctx: ExtensionContext) {
    let running = false;

    const run = async () => {
      if (running) return;
      running = true;

      try {
        await pollUnreadInbox(ctx);
      } catch (error) {
        ctx.host.log.error("poll failed", { error: getErrorMessage(error) });
      } finally {
        running = false;
      }
    };

    const timer = setInterval(() => {
      void run();
    }, POLL_MS);

    ctx.host.lifecycle.onDeactivate(() => {
      clearInterval(timer);
    });

    ctx.host.log.info("started", { pollMs: POLL_MS });
    void run();
  },
} satisfies NitoriExtension;
