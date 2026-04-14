import { Bot, GrammyError, InputFile, type Context } from "grammy";
import { attachmentTypeFromMime, type Adapter, type AdapterMessageHandler, type AttachmentRef, type InboundMessage } from "../types.ts";
import { Buffer } from "node:buffer";
import { Message, type ReactionType, Update } from "grammy/types";
import { extname } from "node:path";
import { loadTelegramBusinessConfig, type TelegramBusinessConfig } from "../config/telegram.ts";

export class TelegramAdapter implements Adapter {
  readonly name = "telegram";

  canHandleChannel(channelKey: string): boolean {
    return channelKey.startsWith("tg:");
  }

  canHandleFile(fileId: string): boolean {
    return fileId.startsWith("telegram://");
  }

  private bot: Bot | null = null;
  private botId = "";
  private botUsername = "";
  private running = false;
  private connectLoopPromise: Promise<void> | null = null;

  constructor(
    private readonly token: string,
    private readonly workspaceDir: string,
    private readonly handler: AdapterMessageHandler,
  ) { }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    this.connectLoopPromise = this.runConnectLoop();
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.bot?.stop();
    this.bot = null;
    if (this.connectLoopPromise) {
      await this.connectLoopPromise.catch(() => undefined);
      this.connectLoopPromise = null;
    }
  }

  private getBusinessConfig(): TelegramBusinessConfig {
    return loadTelegramBusinessConfig(this.workspaceDir);
  }

  async sendMessage(channelKey: string, text: string, replyToMessageId?: string): Promise<string> {
    const bot = this.requireBot();
    const chatId = Number(channelKey.split(":").at(-1));
    const extra: Parameters<typeof bot.api.sendMessage>[2] = {
      link_preview_options: { is_disabled: true },
    };
    if (replyToMessageId) {
      extra.reply_parameters = { message_id: Number(replyToMessageId) };
    }
    const res = await bot.api.sendMessage(chatId, text, extra);
    return String(res.message_id);
  }

  async sendFile(channelKey: string, filePath: string, caption?: string): Promise<string> {
    const bot = this.requireBot();
    const chatId = Number(channelKey.split(":").at(-1));
    const inputFile = new InputFile(filePath);
    const res = imageMimeType(filePath)
      ? await bot.api.sendPhoto(chatId, inputFile, { caption })
      : await bot.api.sendDocument(chatId, inputFile, { caption });
    return String(res.message_id);
  }

  async setReaction(channelKey: string, messageId: string, emoji: string): Promise<string> {
    const bot = this.requireBot();
    const chatId = Number(channelKey.split(":").at(-1));
    const candidate = emoji.trim();
    if (!candidate) return `reaction-rejected:${messageId}`;

    try {
      await bot.api.raw.setMessageReaction({
        chat_id: chatId,
        message_id: Number(messageId),
        reaction: [{ type: "emoji", emoji: candidate } as ReactionType],
        is_big: false,
      });
      return `${messageId}:${candidate}`;
    } catch (error) {
      if (error instanceof GrammyError && /REACTION_INVALID/i.test(error.description)) {
        console.warn(`[telegram] reaction rejected by API chat=${chatId} message=${messageId} emoji=${JSON.stringify(candidate)}`);
        return `reaction-rejected:${messageId}`;
      }
      throw error;
    }
  }

  async fetchImageContent(_channelKey: string, path: string): Promise<{ data: string; mimeType: string }> {
    const safeFileId = path.replace("telegram://", "").trim();
    if (!safeFileId) throw new Error("path is required");
    const { data, mimeType } = await this.downloadTelegramFile(safeFileId);
    return { data: data.toString("base64"), mimeType };
  }

  private async downloadTelegramFile(fileId: string): Promise<{ data: Buffer; mimeType: string }> {
    const bot = this.requireBot();
    const fileMeta = await bot.api.getFile(fileId);
    if (!fileMeta.file_path) throw new Error(`Telegram file path missing for fileId=${fileId}`);
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${fileMeta.file_path}`);
    if (!res.ok) throw new Error(`Failed to download Telegram file: ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    return { data: bytes, mimeType: imageMimeType(fileMeta.file_path) ?? "image/jpeg" };
  }

  private async handleContext(ctx: Context): Promise<void> {
    const msg = ctx.message;
    if (!msg?.from) return;
    if (String(msg.from.id) === this.botId) return;

    const { chat, from, text, caption, reply_to_message, message_id, date } = msg;
    const chatId = String(chat.id);
    const userId = String(from.id);
    const isPrivate = chat.type === "private";

    const config = this.getBusinessConfig();
    const isBlocked = config.blockedChatIds.includes(chatId) || config.blockedUserIds.includes(userId);
    const isAllowed =
      (config.allowedChatIds.length === 0 || config.allowedChatIds.includes(chatId))
      && (config.allowedUserIds.length === 0 || config.allowedUserIds.includes(userId));
    const canRespond = isPrivate ? config.respondInPrivate : config.respondInGroups;
    if (isBlocked || !isAllowed || !canRespond) return;

    const rawMessageText = (text || caption || "").trim();
    const isReplyToBot = reply_to_message?.from ? String(reply_to_message.from.id) === this.botId : false;
    const isMention = this.botUsername ? rawMessageText.includes(`@${this.botUsername}`) || rawMessageText.includes(this.botId) : false;

    const trigger: InboundMessage["trigger"] = (isPrivate || config.groupTriggerMode === "all_messages")
      ? "direct"
      : isReplyToBot ? "reply" : isMention ? "mention" : "passive";

    let command: { name: string; args: string } | undefined;
    const cmdMatch = rawMessageText.match(/^\/([a-z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/i);
    if (cmdMatch) {
      const mentionName = cmdMatch[2];
      if (!mentionName || (this.botUsername && mentionName.toLowerCase() === this.botUsername.toLowerCase())) {
        command = { name: cmdMatch[1].toLowerCase(), args: (cmdMatch[3] ?? "").trim() };
      }
    }

    let messageText = rawMessageText;
    if (reply_to_message && reply_to_message.from?.id !== from.id) {
      const repliedSender = reply_to_message.from ? [reply_to_message.from.first_name, reply_to_message.from.last_name].filter(Boolean).join(" ").trim() : "Unknown";
      const repliedText = (reply_to_message.text || reply_to_message.caption || "(attachment)").trim();
      const quoted = repliedText.split("\n").map(line => `> ${line}`).join("\n");
      messageText = `> [reply to ${repliedSender || "Unknown"}]\n${quoted}\n\n${rawMessageText}`.trim();
    }

    const inbound: InboundMessage = {
      id: String(message_id),
      source: "telegram",
      channelKey: `tg:${isPrivate ? "dm" : "group"}:${chatId}`,
      sender: {
        id: userId,
        username: from.username,
        name: [from.first_name, from.last_name].filter(Boolean).join(" "),
        isBot: from.is_bot,
      },
      text: messageText,
      command,
      attachments: this.extractAttachments(msg),
      replyToMessageId: isReplyToBot ? String(reply_to_message!.message_id) : undefined,
      raw: { chat, message_id },
      receivedAt: new Date((date || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      trigger,
    };

    this.handler.onInbound(inbound).catch((error) => console.error("Telegram inbound dispatch failed", error));
  }

  private extractAttachments(msg: Message & Update.NonChannel): AttachmentRef[] {
    const out: AttachmentRef[] = [];

    if (msg.photo?.length) {
      const largest = msg.photo[msg.photo.length - 1];
      out.push({
        type: "image",
        path: `telegram://${largest.file_id}`,
        mimeType: "image/jpeg",
        size: largest.file_size,
      });
    }

    if (msg.document?.file_id) {
      const mime = msg.document.mime_type;
      out.push({
        type: attachmentTypeFromMime(mime),
        path: `telegram://${msg.document.file_id}`,
        mimeType: mime,
        size: msg.document.file_size,
        fileName: msg.document.file_name,
      });
    }

    if (msg.video?.file_id) {
      out.push({
        type: "video",
        path: `telegram://${msg.video.file_id}`,
        mimeType: msg.video.mime_type ?? "video/mp4",
        size: msg.video.file_size,
        fileName: msg.video.file_name,
      });
    }

    if (msg.audio?.file_id) {
      out.push({
        type: "audio",
        path: `telegram://${msg.audio.file_id}`,
        mimeType: msg.audio.mime_type ?? "audio/mpeg",
        size: msg.audio.file_size,
        fileName: msg.audio.file_name,
      });
    }

    if (msg.voice?.file_id) {
      out.push({
        type: "audio",
        path: `telegram://${msg.voice.file_id}`,
        mimeType: msg.voice.mime_type ?? "audio/ogg",
        size: msg.voice.file_size,
      });
    }

    if (msg.animation?.file_id) {
      out.push({
        type: "image",
        path: `telegram://${msg.animation.file_id}`,
        mimeType: msg.animation.mime_type ?? "video/mp4",
        size: msg.animation.file_size,
        fileName: msg.animation.file_name,
      });
    }

    return out;
  }

  private requireBot(): Bot {
    if (!this.bot) throw new Error("Telegram bot is disconnected.");
    return this.bot;
  }

  private async runConnectLoop(): Promise<void> {
    let attempt = 0;
    while (this.running) {
      try {
        await this.startSingleSession();
        attempt = 0;
      } catch (error) {
        attempt += 1;
        this.bot = null;
        const delayMs = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
        console.error(`Telegram connection failed (attempt ${attempt}): ${error}. Retrying in ${Math.round(delayMs / 1000)}s`);
        if (!this.running) break;
        await sleep(delayMs);
      }
    }
  }

  private async startSingleSession(): Promise<void> {
    const bot = new Bot(this.token);
    bot.catch((err) => console.error("Telegram adapter error", err.error));
    const me = await bot.api.getMe();
    this.botId = String(me.id);
    this.botUsername = me.username ?? "";
    this.bot = bot;
    bot.on("message", async (ctx) => {
      try { await this.handleContext(ctx); } catch (error) { console.error("Telegram message handling failed", error); }
    });
    console.log(`Telegram connected as @${this.botUsername}`);
    await bot.start({ allowed_updates: ["message"], drop_pending_updates: false });
    if (this.running) throw new Error("Telegram polling stopped unexpectedly.");
  }
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function imageMimeType(path: string): string | undefined {
  return IMAGE_MIME[extname(path).toLowerCase()];
}
