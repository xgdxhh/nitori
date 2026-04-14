import { streamText, stepCountIs } from "ai";
import type { AppConfig } from "../config/index.ts";
import { Storage } from "../storage/db.ts";
import { createToolset } from "../tools/index.ts";
import type { AdapterManager } from "../adapters/manager.ts";
import type { CronJobRequest, CronJobResult, InboundMessage, ToolContext } from "../types.ts";
import type { ToolFactory } from "../extension/types.ts";
import { buildSystemPrompt } from "./prompt-builder.ts";
import { agentOutput, DIM, RESET } from "./console.ts";
import { getApiKeyForProfile } from "../llm/profile.ts";
import { loadImagesFromAttachments, normalizeInboxPrompt } from "./utils.ts";
import {
  shouldAutoCompact,
  prepareLinearCompaction,
  generateCompactionSummary,
  createCompactionSummaryMessage,
} from "./compact.ts";
import { resolveSessionKey } from "../session.ts";
import type { LanguageModel } from "ai";

const AGENT_IDLE_TIMEOUT_MS = 5 * 60_000;
const AGENT_MAX_RUN_MS = 30 * 60_000;
const COMPACTION_TIMEOUT_MS = 60_000;

type SessionPhase = "queued" | "llm" | "tool" | "persist" | "done";
type TimeoutKind = "idle" | "max";

interface SessionRunMeta {
  sessionKey: string;
  channelKey: string;
  messageId: string;
  startedAt: number;
  lastActivityAt: number;
  phase: SessionPhase;
  toolName: string | null;
}

interface SessionSnapshot {
  checkpointAfterId: number;
  tipId: number;
  messages: Array<{ role: string; content: unknown }>;
}

interface RunTimeout {
  touch: () => void;
  run: <T>(promise: Promise<T>) => Promise<T>;
  stop: () => void;
}

class SessionCoordinator {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, SessionRunMeta>();

  enqueue(
    sessionKey: string,
    channelKey: string,
    messageId: string,
    run: (runMeta: SessionRunMeta) => Promise<void>,
  ): Promise<void> {
    const previous = this.queues.get(sessionKey);
    if (previous) {
      console.log(formatWaitingForSessionLock(this.activeRuns.get(sessionKey), sessionKey, channelKey, messageId));
    }

    const runMeta: SessionRunMeta = {
      sessionKey,
      channelKey,
      messageId,
      startedAt: 0,
      lastActivityAt: 0,
      phase: "queued",
      toolName: null,
    };

    const queuedRun = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const now = Date.now();
        runMeta.startedAt = now;
        runMeta.lastActivityAt = now;
        runMeta.phase = "llm";
        this.activeRuns.set(sessionKey, runMeta);
        try {
          await run(runMeta);
        } finally {
          runMeta.phase = "done";
          this.activeRuns.delete(sessionKey);
        }
      });

    let queueTail: Promise<void>;
    queueTail = queuedRun.finally(() => {
      if (this.queues.get(sessionKey) === queueTail) {
        this.queues.delete(sessionKey);
      }
    });

    this.queues.set(sessionKey, queueTail);
    return queueTail;
  }
}

class SessionTurnWriter {
  private readonly persistedMessages: Array<{ role: string; content: unknown }>;
  private observedMessageCount: number;
  private tipId: number;

  constructor(
    private readonly storage: Storage,
    private readonly sessionKey: string,
    initialMessages: Array<{ role: string; content: unknown }>,
    private readonly checkpointAfterId: number,
    initialTipId: number,
  ) {
    this.persistedMessages = [...initialMessages];
    this.observedMessageCount = initialMessages.length;
    this.tipId = initialTipId;
  }

  flush(messages: Array<{ role: string; content: unknown }>): void {
    if (messages.length <= this.observedMessageCount) return;

    const freshMessages = messages.slice(this.observedMessageCount);
    this.observedMessageCount = messages.length;

    const persistableMessages = freshMessages.filter(isPersistableMessage);
    if (persistableMessages.length === 0) return;

    const insertedIds = this.storage.appendSessionMessages(this.sessionKey, persistableMessages as never[]);
    if (insertedIds.length > 0) {
      this.tipId = insertedIds[insertedIds.length - 1];
    }
    this.persistedMessages.push(...persistableMessages);
  }

  snapshot(): SessionSnapshot {
    return {
      checkpointAfterId: this.checkpointAfterId,
      tipId: this.tipId,
      messages: [...this.persistedMessages],
    };
  }
}

const sessionCoordinator = new SessionCoordinator();
const sessionCompactions = new Map<string, Promise<void>>();

export async function processChannel(
  channelKey: string,
  inMessages: InboundMessage[],
  deps: {
    config: AppConfig;
    storage: Storage;
    adapterManager: AdapterManager;
    scheduleHandler: (channelKey: string, req: CronJobRequest) => Promise<CronJobResult>;
    toolFactories?: ToolFactory[];
  },
): Promise<void> {
  const sessionKey = resolveSessionKey(deps.config, channelKey);
  const latest = inMessages.at(-1);
  return sessionCoordinator.enqueue(sessionKey, channelKey, latest?.id ?? "unknown", (runMeta) =>
    _run(channelKey, inMessages, deps, runMeta),
  );
}

async function _run(
  channelKey: string,
  inMessages: InboundMessage[],
  deps: {
    config: AppConfig;
    storage: Storage;
    adapterManager: AdapterManager;
    scheduleHandler: (channelKey: string, req: CronJobRequest) => Promise<CronJobResult>;
    toolFactories?: ToolFactory[];
  },
  runMeta: SessionRunMeta,
): Promise<void> {
  const { storage, config, adapterManager } = deps;
  const latest = inMessages.at(-1);
  if (!latest) return;

  const profile = config.llm.profiles[config.llm.activeName];
  if (!profile) throw new Error(`Active profile '${config.llm.activeName}' missing`);
  const model = getModel(profile);
  const activeSession = storage.loadActiveSessionState(runMeta.sessionKey);
  const writer = new SessionTurnWriter(
    storage,
    runMeta.sessionKey,
    activeSession.messages as Array<{ role: string; content: unknown }>,
    activeSession.checkpointAfterId,
    activeSession.tipId,
  );

  const toolContext: ToolContext = {
    storage,
    adapterManager,
    currentChannelKey: channelKey,
    currentSessionKey: runMeta.sessionKey,
    workspaceDir: config.workspaceDir,
    currentMessageId: latest.id,
    cronJob: (req) => deps.scheduleHandler(channelKey, req),
    readInbox: (opts) => storage.listInbox(opts),
  };

  const toolsArray = createToolset(toolContext, deps.toolFactories);
  const tools: Record<string, typeof toolsArray[number]> = {};
  for (const t of toolsArray) {
    tools[t.type] = t;
  }

  const systemPrompt = buildSystemPrompt(config.workspaceDir, config);
  const messages: Array<{ role: string; content: unknown }> = [...activeSession.messages as Array<{ role: string; content: unknown }>];
  const images = inMessages.flatMap((message) => loadImagesFromAttachments(message.attachments));

  const apiKey = await getApiKeyForProfile(profile);
  if (!apiKey) throw new Error(`No API key for profile '${config.llm.activeName}'`);

  const timeout = createRunTimeout({
    idleMs: AGENT_IDLE_TIMEOUT_MS,
    maxMs: AGENT_MAX_RUN_MS,
    runMeta,
    onTimeout: (kind, elapsedMs) => {
      const limitMs = kind === "idle" ? AGENT_IDLE_TIMEOUT_MS : AGENT_MAX_RUN_MS;
      const label = kind === "idle" ? "idle" : "overall";
      return new Error(`Agent run ${label} timeout after ${limitMs}ms (elapsed=${elapsedMs}ms, ${describeActiveRun(runMeta)})`);
    },
  });

  const userPrompt = normalizeInboxPrompt(inMessages);
  agentOutput.userPrompt(inMessages);
  runMeta.phase = "llm";

  const userContent: unknown = images.length > 0
    ? [{ type: "text", text: userPrompt }, ...images.map((img) => ({ type: "image", image: img.data, mimeType: img.mimeType }))]
    : userPrompt;

  messages.push({ role: "user", content: userContent });

  const toolStartTimes = new Map<string, number>();
  let fullResponse = "";
  let hasShownThinking = false;

  try {
    const result = streamText({
      model,
      system: systemPrompt,
      messages: messages as never,
      tools,
      stopWhen: stepCountIs(20),
      onChunk: ({ chunk }) => {
        timeout.touch();
        if (chunk.type === "text-delta") {
          const delta = chunk.text;
          if (delta.includes("<thinking>")) {
            if (!hasShownThinking) {
              agentOutput.thinking();
              hasShownThinking = true;
            }
            agentOutput.thinkingDelta(delta.replace(/<[^>]+>/g, ""));
          } else {
            fullResponse += delta;
          }
        }
      },
      experimental_onToolCallStart: (event) => {
        timeout.touch();
        const tc = event.toolCall;
        runMeta.phase = "tool";
        runMeta.toolName = tc.toolName;
        toolStartTimes.set(tc.toolCallId, Date.now());
        agentOutput.toolCall(tc.toolName, tc.input as Record<string, unknown>);
      },
      experimental_onToolCallFinish: (event) => {
        timeout.touch();
        const tc = event.toolCall;
        runMeta.phase = "llm";
        runMeta.toolName = null;
        const duration = Date.now() - (toolStartTimes.get(tc.toolCallId) ?? 0);
        const isError = (tc as { error?: unknown }).error != null;
        agentOutput.toolResult(tc.toolName, duration, isError);
      },
      onFinish: (event) => {
        timeout.touch();
        runMeta.phase = "persist";
        runMeta.toolName = null;
        writer.flush(messages);

        const text = event.finishReason === "error" ? fullResponse : event.text;
        if (text) {
          agentOutput.assistant(text);
          if (config.agent.autoSendAssistantText && latest.trigger !== "scheduled") {
            void adapterManager.sendMessage(channelKey, text, latest.id).catch((error: unknown) => {
              agentOutput.error(formatErrorMessage(error, `Failed to send assistant reply to ${channelKey}`));
            });
          }
        }

        if (event.finishReason === "error") {
          agentOutput.error("Agent run error");
        }
      },
    });

    await timeout.run(result.text as Promise<string>);
  } finally {
    timeout.stop();
    runMeta.phase = "persist";
    writer.flush(messages);
  }

  if (apiKey && config.agent.compaction.enabled) {
    scheduleAutoCompaction(runMeta.sessionKey, writer.snapshot(), {
      storage,
      model,
      apiKey,
      contextWindow: 128000,
      reserveTokens: config.agent.compaction.reserveTokens,
    });
  }
}

function getModel(profile: { provider: string; model: string; apiKey?: string }): LanguageModel {
  const { provider, model: modelId, apiKey } = profile;

  switch (provider) {
    case "anthropic": {
      const { createAnthropic } = require("@ai-sdk/anthropic");
      const client = createAnthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY });
      return client(modelId);
    }
    case "openai": {
      const { createOpenAI } = require("@ai-sdk/openai");
      const client = createOpenAI({ apiKey: apiKey || process.env.OPENAI_API_KEY });
      return client(modelId);
    }
    case "google": {
      const { createGoogleGenerativeAI } = require("@ai-sdk/google");
      const client = createGoogleGenerativeAI({ apiKey: apiKey || process.env.GOOGLE_GENERATIVE_AI_API_KEY });
      return client(modelId);
    }
    default: {
      throw new Error(`Unsupported provider: ${provider}`);
    }
  }
}

function scheduleAutoCompaction(
  sessionKey: string,
  snapshot: SessionSnapshot,
  opts: {
    storage: Storage;
    model: LanguageModel;
    apiKey: string;
    contextWindow: number;
    reserveTokens: number;
  },
): void {
  const lastMessage = snapshot.messages.filter((m) => m.role === "assistant").at(-1);
  if (!lastMessage) return;
  if (!shouldAutoCompact(lastMessage, opts.contextWindow, { enabled: true, reserveTokens: opts.reserveTokens })) {
    return;
  }

  const { messagesToSummarize, keptMessages } = prepareLinearCompaction(snapshot.messages);
  if (messagesToSummarize.length === 0) return;

  const previous = sessionCompactions.get(sessionKey);
  const queuedCompaction = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const summary = await withTimeout(
        generateCompactionSummary(messagesToSummarize, opts.model, opts.reserveTokens),
        COMPACTION_TIMEOUT_MS,
        () => {
          throw new Error(`Compaction timed out after ${COMPACTION_TIMEOUT_MS}ms (session=${sessionKey})`);
        },
      );

      opts.storage.applyCompaction(
        sessionKey,
        snapshot.checkpointAfterId,
        snapshot.tipId,
        [createCompactionSummaryMessage(summary, new Date().toISOString()), ...keptMessages],
      );
    })
    .catch((error: unknown) => {
      agentOutput.error(formatErrorMessage(error, `Failed to compact session ${sessionKey}`));
    });

  let compactionTail: Promise<void>;
  compactionTail = queuedCompaction.finally(() => {
    if (sessionCompactions.get(sessionKey) === compactionTail) {
      sessionCompactions.delete(sessionKey);
    }
  });

  sessionCompactions.set(sessionKey, compactionTail);
}

function isPersistableMessage(message: { role: string; content: unknown }): boolean {
  return message.role !== "assistant" || !((message.content as string)?.startsWith?.("[ERROR]"));
}

function formatWaitingForSessionLock(
  activeRun: SessionRunMeta | undefined,
  sessionKey: string,
  channelKey: string,
  messageId: string,
): string {
  if (!activeRun) {
    return `${DIM}[nitori] waiting for session lock: ${sessionKey} channel=${channelKey} message=${messageId}${RESET}`;
  }

  const waitMs = Date.now() - activeRun.startedAt;
  const idleMs = Date.now() - activeRun.lastActivityAt;
  const tool = activeRun.toolName ? ` tool=${activeRun.toolName}` : "";
  return `${DIM}[nitori] waiting for session lock: ${sessionKey} channel=${channelKey} message=${messageId} activeChannel=${activeRun.channelKey} activeMessage=${activeRun.messageId} phase=${activeRun.phase}${tool} ageMs=${waitMs} idleMs=${idleMs}${RESET}`;
}

function describeActiveRun(runMeta: SessionRunMeta): string {
  const tool = runMeta.toolName ? ` tool=${runMeta.toolName}` : "";
  const idleMs = Math.max(0, Date.now() - runMeta.lastActivityAt);
  return `session=${runMeta.sessionKey} channel=${runMeta.channelKey} message=${runMeta.messageId} phase=${runMeta.phase}${tool} idleMs=${idleMs}`;
}

function formatErrorMessage(error: unknown, prefix: string): string {
  return error instanceof Error ? `${prefix}: ${error.message}` : prefix;
}

function createRunTimeout(opts: {
  idleMs: number;
  maxMs: number;
  runMeta: SessionRunMeta;
  onTimeout: (kind: TimeoutKind, elapsedMs: number) => Error;
}): RunTimeout {
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let maxTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  let rejectTimeout: ((reason?: unknown) => void) | null = null;

  const fail = (kind: TimeoutKind) => {
    if (finished || !rejectTimeout) return;
    finished = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (maxTimer) clearTimeout(maxTimer);
    rejectTimeout(opts.onTimeout(kind, Date.now() - opts.runMeta.startedAt));
  };

  const touch = () => {
    opts.runMeta.lastActivityAt = Date.now();
    if (finished) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail("idle"), opts.idleMs);
  };

  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
    maxTimer = setTimeout(() => fail("max"), opts.maxMs);
    touch();
  });

  return {
    touch,
    run: async <T>(promise: Promise<T>) => Promise.race([promise, timeoutPromise]),
    stop: () => {
      if (finished) return;
      finished = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (maxTimer) clearTimeout(maxTimer);
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => never): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          try {
            onTimeout();
          } catch (error) {
            reject(error);
          }
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
