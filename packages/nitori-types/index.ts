import type { Tool } from "ai";

// ── Message types ──────────────────────────────────────────────

export type SourceType = string;

export type TriggerType = "direct" | "mention" | "reply" | "scheduled" | "passive";

export interface SenderInfo {
  id: string;
  name?: string;
  username?: string;
  isBot?: boolean;
}

export interface AttachmentRef {
  type: "image" | "video" | "audio" | "file";
  path: string;
  mimeType?: string;
  size?: number;
  fileName?: string;
}

export function attachmentTypeFromMime(mime?: string): AttachmentRef["type"] {
  if (!mime) return "file";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}


export interface InboundMessage {
  id: string;
  source: SourceType;
  channelKey: string;
  sender: SenderInfo;
  text?: string;
  command?: { name: string; args: string };
  attachments: AttachmentRef[];
  replyToMessageId?: string;
  raw?: Record<string, unknown>;
  receivedAt: string;
  trigger: TriggerType;
}

// ── Adapter types ──────────────────────────────────────────────

export interface AdapterMessageHandler {
  onInbound: (message: InboundMessage) => Promise<void>;
}

export interface Adapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  canHandleChannel(channelKey: string): boolean;
  canHandleFile?(path: string): boolean;
  sendMessage(channelKey: string, text: string, replyToMessageId?: string): Promise<string>;
  sendFile?(channelKey: string, filePath: string, caption?: string): Promise<string>;
  setReaction?(channelKey: string, messageId: string, emoji: string): Promise<string>;
  fetchImageContent?(channelKey: string, path: string): Promise<{ data: string; mimeType: string }>;
}

// ── Tool types ─────────────────────────────────────────────────

/** Context available to tool factories at runtime */
export interface ToolContext {
  currentChannelKey: string;
  workspaceDir: string;
  currentMessageId?: string;
}

// ── Extension types ────────────────────────────────────────────

export type ExtensionLogValue = string | number | boolean | null;

export interface ExtensionInboxListOptions {
  limit: number;
  offset?: number;
  onlyUnread?: boolean;
  channelKey?: string;
  markAsRead?: boolean;
}

export interface ExtensionUnreadChannel {
  channelKey: string;
  unreadCount: number;
}

export interface ExtensionAgentEnqueueRequest {
  channelKey: string;
  prompt: string;
  trigger?: "scheduled" | "passive";
  metadata?: Record<string, unknown>;
}

export interface ExtensionInboxApi {
  list(options: ExtensionInboxListOptions): InboundMessage[];
  listUnreadChannels(): ExtensionUnreadChannel[];
}

export interface ExtensionAgentApi {
  enqueue(request: ExtensionAgentEnqueueRequest): Promise<void>;
}

export interface ExtensionLifecycleApi {
  onDeactivate(cleanup: () => void | Promise<void>): void;
}

export interface ExtensionLogApi {
  info(message: string, fields?: Record<string, ExtensionLogValue>): void;
  error(message: string, fields?: Record<string, ExtensionLogValue>): void;
}

export interface ExtensionHost {
  agent: ExtensionAgentApi;
  lifecycle: ExtensionLifecycleApi;
  log: ExtensionLogApi;
}

/** Tool factory: called per agent run with the current ToolContext */
export type ToolFactory = (ctx: ToolContext) => Tool;

/** Adapter factory: receives messageHandler, returns an Adapter */
export type AdapterFactory = (handler: AdapterMessageHandler) => Adapter;

/**
 * Context passed to extension activate()
 */
export interface ExtensionContext {
  /** Register an adapter factory. The handler is injected automatically at startup. */
  registerAdapter(factory: AdapterFactory): void;
  /**
   * Register a tool factory.
   * The factory is called every time an agent session starts to create fresh tool instances.
   */
  registerTool(factory: ToolFactory): void;
  /** Absolute path to the directory containing the extension file */
  extensionDir: string;
  /** Nitori workspace directory (~/.nitori) */
  workspaceDir: string;
  /** Stable host capabilities exposed to the extension runtime. */
  host: ExtensionHost;
  /** Register a lifecycle hook to intercept agent turns */
  registerHook(hook: AgentHooks): void;
}

/**
 * Metadata for a Nitori extension.
 */
export interface ExtensionMetadata {
  /** Unique name identifier for the extension, e.g., 'discord-adapter' */
  name: string;
  /** Semver version string */
  version: string;
  /** Brief description of what the extension does */
  description?: string;
  /** Author name */
  author?: string;
  /** URL to the extension's homepage or repository */
  homepage?: string;
}

/**
 * Every extension module must default-export an object implementing this interface.
 */
export interface NitoriExtension extends ExtensionMetadata {
  /** Lifecycle hook: called when extension is loaded during daemon startup */
  activate(ctx: ExtensionContext): void | Promise<void>;
  /** Lifecycle hook: called when the extension is disabled or the daemon shuts down */
  deactivate?(): void | Promise<void>;
}

// ── Event Bus & Hooks ──────────────────────────────────────────

export type AgentStreamEvent =
  | { type: "assistant-start" }
  | { type: "text-delta"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool-call-start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool-call-result"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "turn-finish"; text: string; finishReason: string }
  | { type: "turn-error"; error: unknown };

export interface TurnContext {
  channelKey: string;
  sessionKey: string;
  inboundMessages: InboundMessage[];
  history: Array<{ role: string; content: unknown }>;
  newMessages: Array<{ role: string; content: unknown }>;
  llmMessages: Array<{ role: string; content: unknown }>;
  tools: Record<string, Tool>;
  state: Record<string, unknown>;
}

export interface AgentHooks {
  onBeforeTurn?: (ctx: TurnContext) => Promise<void> | void;
  onAfterTurn?: (ctx: TurnContext, result: { text: string; toolCalls: any[] }) => Promise<void> | void;
}

