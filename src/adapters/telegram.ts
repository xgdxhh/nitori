import { Bot, GrammyError, InputFile, type Context } from "grammy";
import { attachmentTypeFromMime, type Adapter, type AdapterMessageHandler, type AttachmentRef, type InboundMessage } from "../types.ts";
import { Buffer } from "node:buffer";
import { Message, type ReactionType, Update } from "grammy/types";
import { extname } from "node:path";
import { loadTelegramBusinessConfig, type TelegramBusinessConfig } from "../config/telegram.ts";

type TelegramMessage = Message & Update.NonChannel;
type TelegramReplyMessage = NonNullable<TelegramMessage["reply_to_message"]>;
type DownloadedTelegramFile = { data: Buffer; mimeType: string };
type TelegramFileLoader = (fileId: string) => Promise<DownloadedTelegramFile>;

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
    const { chatId, threadId } = parseTelegramChannelKey(channelKey);
    const extra: Parameters<typeof bot.api.sendMessage>[2] = {
      link_preview_options: { is_disabled: true },
      message_thread_id: threadId ? Number(threadId) : undefined,
    };
    if (replyToMessageId) {
      extra.reply_parameters = { message_id: Number(replyToMessageId) };
    }
    const res = await bot.api.sendMessage(Number(chatId), text, extra);
    return String(res.message_id);
  }

  async sendFile(channelKey: string, filePath: string, caption?: string): Promise<string> {
    const bot = this.requireBot();
    const { chatId, threadId } = parseTelegramChannelKey(channelKey);
    const inputFile = new InputFile(filePath);
    const res = imageMimeType(filePath)
      ? await bot.api.sendPhoto(Number(chatId), inputFile, {
        caption,
        message_thread_id: threadId ? Number(threadId) : undefined,
      })
      : await bot.api.sendDocument(Number(chatId), inputFile, {
        caption,
        message_thread_id: threadId ? Number(threadId) : undefined,
      });
    return String(res.message_id);
  }

  async setReaction(channelKey: string, messageId: string, emoji: string): Promise<string> {
    const bot = this.requireBot();
    const { chatId } = parseTelegramChannelKey(channelKey);
    const candidate = emoji.trim();
    if (!candidate) return `reaction-rejected:${messageId}`;

    try {
      await bot.api.raw.setMessageReaction({
        chat_id: Number(chatId),
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


  private async downloadTelegramFile(fileId: string): Promise<DownloadedTelegramFile> {
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

    const config = this.getBusinessConfig();
    if (!shouldAcceptTelegramMessage(config, msg)) return;

    const inbound = await buildInboundTelegramMessage({
      msg,
      botId: this.botId,
      botUsername: this.botUsername,
      config,
      loadFile: (fileId) => this.downloadTelegramFile(fileId),
    });

    this.handler.onInbound(inbound).catch((error) => console.error("Telegram inbound dispatch failed", error));
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

function shouldAcceptTelegramMessage(config: TelegramBusinessConfig, msg: TelegramMessage): boolean {
  const chatId = String(msg.chat.id);
  const userId = String(msg.from.id);
  const isPrivate = msg.chat.type === "private";
  const isBlocked = config.blockedChatIds.includes(chatId) || config.blockedUserIds.includes(userId);
  const isAllowed =
    (config.allowedChatIds.length === 0 || config.allowedChatIds.includes(chatId))
    && (config.allowedUserIds.length === 0 || config.allowedUserIds.includes(userId));
  const canRespond = isPrivate ? config.respondInPrivate : config.respondInGroups;
  return !isBlocked && isAllowed && canRespond;
}

async function buildInboundTelegramMessage(input: {
  msg: TelegramMessage;
  botId: string;
  botUsername: string;
  config: TelegramBusinessConfig;
  loadFile: TelegramFileLoader;
}): Promise<InboundMessage> {
  const { msg, botId, botUsername, config, loadFile } = input;
  const rawMessageText = getTelegramMessageText(msg);
  const isPrivate = msg.chat.type === "private";
  const isReplyToBot = isTelegramReplyToBot(msg, botId);
  const trigger = resolveTelegramTrigger({
    config,
    isPrivate,
    isReplyToBot,
    isMention: isTelegramMention(rawMessageText, botId, botUsername),
  });

  return {
    id: String(msg.message_id),
    source: "telegram",
    channelKey: buildTelegramChannelKey({
      kind: isPrivate ? "dm" : "group",
      chatId: String(msg.chat.id),
      threadId: getTelegramThreadId(msg),
    }),
    sender: {
      id: String(msg.from.id),
      username: msg.from.username,
      name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" "),
      isBot: msg.from.is_bot,
    },
    text: buildTelegramInboundText(msg, rawMessageText),
    command: parseTelegramCommand(rawMessageText, botUsername),
    attachments: await extractTelegramAttachments(msg, loadFile),
    replyToMessageId: isReplyToBot && msg.reply_to_message ? String(msg.reply_to_message.message_id) : undefined,
    raw: { chat: msg.chat, message_id: msg.message_id },
    receivedAt: new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    trigger,
  };
}

function getTelegramMessageText(msg: TelegramMessage | TelegramReplyMessage): string {
  return (msg.text || msg.caption || "").trim();
}

function getTelegramThreadId(msg: TelegramMessage): string | undefined {
  return msg.is_topic_message && msg.message_thread_id ? String(msg.message_thread_id) : undefined;
}

function isTelegramReplyToBot(msg: TelegramMessage, botId: string): boolean {
  return msg.reply_to_message?.from ? String(msg.reply_to_message.from.id) === botId : false;
}

function isTelegramMention(text: string, botId: string, botUsername: string): boolean {
  return botUsername
    ? text.includes(`@${botUsername}`) || text.includes(botId)
    : false;
}

function resolveTelegramTrigger(input: {
  config: TelegramBusinessConfig;
  isPrivate: boolean;
  isReplyToBot: boolean;
  isMention: boolean;
}): InboundMessage["trigger"] {
  if (input.isPrivate || input.config.groupTriggerMode === "all_messages") return "direct";
  if (input.isReplyToBot) return "reply";
  if (input.isMention) return "mention";
  return "passive";
}

function parseTelegramCommand(text: string, botUsername: string): InboundMessage["command"] {
  const cmdMatch = text.match(/^\/([a-z0-9_]+)(?:@([a-zA-Z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (!cmdMatch) return undefined;

  const mentionName = cmdMatch[2];
  if (mentionName && (!botUsername || mentionName.toLowerCase() !== botUsername.toLowerCase())) {
    return undefined;
  }

  return {
    name: cmdMatch[1].toLowerCase(),
    args: (cmdMatch[3] ?? "").trim(),
  };
}

function buildTelegramInboundText(msg: TelegramMessage, rawMessageText: string): string {
  const reply = msg.reply_to_message;
  if (!reply || reply.from?.id === msg.from.id) return rawMessageText;
  return formatTelegramReplyQuote(reply, rawMessageText);
}

function formatTelegramReplyQuote(reply: TelegramReplyMessage, rawMessageText: string): string {
  const repliedSender = reply.from
    ? [reply.from.first_name, reply.from.last_name].filter(Boolean).join(" ").trim()
    : "Unknown";
  const repliedText = getTelegramMessageText(reply) || "(attachment)";
  const quoted = repliedText.split("\n").map((line) => `> ${line}`).join("\n");
  return `> [reply to ${repliedSender || "Unknown"}]\n${quoted}\n\n${rawMessageText}`.trim();
}

async function extractTelegramAttachments(msg: TelegramMessage, loadFile: TelegramFileLoader): Promise<AttachmentRef[]> {
  const attachments = await collectTelegramAttachments(msg, loadFile);
  if (attachments.length > 0 || !msg.reply_to_message) return attachments;
  return collectTelegramAttachments(msg.reply_to_message, loadFile);
}

async function collectTelegramAttachments(
  msg: TelegramMessage | TelegramReplyMessage,
  loadFile: TelegramFileLoader,
): Promise<AttachmentRef[]> {
  const attachments: AttachmentRef[] = [];

  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1];
    const { data, mimeType } = await loadFile(largest.file_id);
    attachments.push({
      type: "image",
      path: `telegram://${largest.file_id}`,
      data: data.toString("base64"),
      mimeType: mimeType || "image/jpeg",
      size: largest.file_size,
    });
  }

  if (msg.document?.file_id) {
    const mime = msg.document.mime_type;
    attachments.push({
      type: attachmentTypeFromMime(mime),
      path: `telegram://${msg.document.file_id}`,
      mimeType: mime,
      size: msg.document.file_size,
      fileName: msg.document.file_name,
    });
  }

  if (msg.video?.file_id) {
    attachments.push({
      type: "video",
      path: `telegram://${msg.video.file_id}`,
      mimeType: msg.video.mime_type ?? "video/mp4",
      size: msg.video.file_size,
      fileName: msg.video.file_name,
    });
  }

  if (msg.audio?.file_id) {
    attachments.push({
      type: "audio",
      path: `telegram://${msg.audio.file_id}`,
      mimeType: msg.audio.mime_type ?? "audio/mpeg",
      size: msg.audio.file_size,
      fileName: msg.audio.file_name,
    });
  }

  if (msg.voice?.file_id) {
    attachments.push({
      type: "audio",
      path: `telegram://${msg.voice.file_id}`,
      mimeType: msg.voice.mime_type ?? "audio/ogg",
      size: msg.voice.file_size,
    });
  }

  if (msg.animation?.file_id) {
    const { data, mimeType } = await loadFile(msg.animation.file_id);
    attachments.push({
      type: "image",
      path: `telegram://${msg.animation.file_id}`,
      data: data.toString("base64"),
      mimeType: mimeType || "image/gif",
      size: msg.animation.file_size,
      fileName: msg.animation.file_name,
    });
  }

  return attachments;
}


const TELEGRAM_CHANNEL_PREFIX = "tg";

type TelegramChannelKind = "dm" | "group";

export interface TelegramChannelParts {
  kind: TelegramChannelKind;
  chatId: string;
  threadId?: string;
}

export function buildTelegramChannelKey(parts: TelegramChannelParts): string {
  const base = `${TELEGRAM_CHANNEL_PREFIX}:${parts.kind}:${parts.chatId}`;
  return parts.threadId ? `${base}:thread:${parts.threadId}` : base;
}

export function parseTelegramChannelKey(channelKey: string): TelegramChannelParts {
  const [prefix, kind, chatId, threadLabel, threadId, extra] = channelKey.split(":");
  if (prefix !== TELEGRAM_CHANNEL_PREFIX) {
    throw new Error(`Invalid Telegram channel key prefix: ${channelKey}`);
  }
  if (kind !== "dm" && kind !== "group") {
    throw new Error(`Invalid Telegram channel kind: ${channelKey}`);
  }
  if (!chatId) {
    throw new Error(`Telegram chat id missing in channel key: ${channelKey}`);
  }
  if (!threadLabel && !threadId && !extra) {
    return { kind, chatId };
  }
  if (threadLabel !== "thread" || !threadId || extra) {
    throw new Error(`Invalid Telegram thread segment in channel key: ${channelKey}`);
  }
  return { kind, chatId, threadId };
}
