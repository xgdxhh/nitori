import { streamText, generateText, stepCountIs, type Tool } from "ai";
import type { AppConfig } from "../config/index.ts";
import { generateSessionId, type SessionStorage } from "../storage/sessions.ts";
import { createToolset } from "../tools/index.ts";
import type { AdapterManager } from "../adapters/manager.ts";
import type { CronJobRequest, CronJobResult, InboundMessage, ToolContext, AgentHooks, TurnContext } from "../types.ts";
import type { ToolFactory } from "../extension/types.ts";
import type { McpManager } from "../mcp/client.ts";
import { buildSystemPrompt } from "./prompt-builder.ts";
import { getApiKeyForProfile, getModel } from "../llm/profile.ts";
import { loadImagesFromAttachments, normalizeInboxPrompt } from "./utils.ts";
import { resolveSessionKey } from "../session.ts";
import { createSubagentTool } from "../tools/subagent.ts";
import type { LanguageModel } from "ai";

const AGENT_MAX_RUN_MS = 30 * 60_000;
const COMPACTION_TIMEOUT_MS = 60_000;

const sessionQueues = new Map<string, Promise<void>>();
const sessionCompactions = new Map<string, Promise<void>>();

export async function processChannel(
  channelKey: string,
  inMessages: InboundMessage[],
  deps: {
    config: AppConfig;
    sessionStorage: SessionStorage;
    adapterManager: AdapterManager;
    scheduleHandler: (channelKey: string, req: CronJobRequest) => Promise<CronJobResult>;
    toolFactories?: ToolFactory[];
    turnHooks?: AgentHooks[];
    mcpManager: McpManager;
  },
): Promise<void> {
  const sessionKey = resolveSessionKey(deps.config, channelKey);
  const sessionStorage = deps.sessionStorage;
  const sessionId = getOrCreateSession(sessionStorage, sessionKey);

  const prev = sessionQueues.get(sessionKey);
  const run = (prev ?? Promise.resolve()).catch(() => {}).then(() => runSession(channelKey, inMessages, deps, sessionId));

  sessionQueues.set(sessionKey, run);
  run.catch(() => {}).finally(() => {
    if (sessionQueues.get(sessionKey) === run) sessionQueues.delete(sessionKey);
  });
}

function getOrCreateSession(sessionStorage: SessionStorage, sessionKey: string): string {
  return sessionStorage.getLatestSessionId(sessionKey) ?? generateSessionId();
}

async function runSession(
  channelKey: string,
  inMessages: InboundMessage[],
  deps: {
    config: AppConfig;
    sessionStorage: SessionStorage;
    adapterManager: AdapterManager;
    scheduleHandler: (channelKey: string, req: CronJobRequest) => Promise<CronJobResult>;
    toolFactories?: ToolFactory[];
    turnHooks?: AgentHooks[];
    mcpManager: McpManager;
  },
  sessionId: string,
): Promise<void> {
  const config = deps.config;
  const adapterManager = deps.adapterManager;
  const sessionStorage = deps.sessionStorage;
  const profile = config.llm.profiles[config.llm.activeName];
  const model = getModel(profile);
  const sessionKey = resolveSessionKey(config, channelKey);
  const latest = inMessages.at(-1)!;

  const session = sessionStorage.loadSession(sessionKey, sessionId);
  
  const images = inMessages.flatMap(m => loadImagesFromAttachments(m.attachments));
  const userPrompt = normalizeInboxPrompt(inMessages, config.agent.hideSourceInfo);
  const userContent = images.length > 0
    ? [{ type: "text", text: userPrompt }, ...images.map(img => ({ type: "image", image: img.data, mimeType: img.mimeType }))]
    : userPrompt;

  const currentUserMessage = { role: "user" as const, content: userContent };

  const toolContext: ToolContext = {
    adapterManager,
    currentChannelKey: channelKey,
    currentSessionKey: sessionKey,
    workspaceDir: config.workspaceDir,
    currentMessageId: latest.id,
    cronJob: (req) => deps.scheduleHandler(channelKey, req),
  };

  const toolsArray = createToolset(toolContext, deps.toolFactories);
  const tools: Record<string, Tool> = Object.fromEntries(toolsArray.map(t => [t.title, t]));

  const mcpTools = await deps.mcpManager.tools();
  Object.assign(tools, mcpTools);

  const subagentTool = createSubagentTool({ config, mcpManager: deps.mcpManager, toolContext });
  if (subagentTool) tools.subagent = subagentTool;

  const turnCtx: TurnContext = {
    channelKey,
    sessionKey,
    inboundMessages: inMessages,
    history: session.messages,
    newMessages: [currentUserMessage],
    llmMessages: [...session.messages, currentUserMessage],
    tools,
    state: {},
  };

  if (deps.turnHooks) {
    for (const hook of deps.turnHooks) {
      if (hook.onBeforeTurn) await hook.onBeforeTurn(turnCtx);
    }
  }

  const finalSystemPrompt = buildSystemPrompt(config.workspaceDir, config);

  let fullResponse = "";
  let isFirstDelta = true;
  const toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown; result: unknown }> = [];

  try {
    const result = streamText({
      model,
      system: finalSystemPrompt,
      messages: turnCtx.llmMessages as never,
      tools: turnCtx.tools,
      stopWhen: stepCountIs(20),
      onChunk: ({ chunk }) => {
        if (chunk.type === "text-delta") {
          if (isFirstDelta) {
            deps.adapterManager.emitStreamEvent(channelKey, { type: "assistant-start" });
            isFirstDelta = false;
          }
          const delta = chunk.text;
          fullResponse += delta;
          deps.adapterManager.emitStreamEvent(channelKey, { type: "text-delta", delta });
        }
      },
      experimental_onToolCallStart: (event) => {
        const { toolCall } = event;
        deps.adapterManager.emitStreamEvent(channelKey, {
          type: "tool-call-start",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          args: toolCall.input
        });
      },
      experimental_onToolCallFinish: (event) => {
        const { toolCall } = event;
        const isError = (toolCall as { error?: unknown }).error != null;
        toolCalls.push({
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
          result: (toolCall as { result?: unknown }).result,
        });
        deps.adapterManager.emitStreamEvent(channelKey, {
          type: "tool-call-result",
          toolCallId: toolCall.toolCallId,
          toolName: toolCall.toolName,
          result: (toolCall as { result?: unknown }).result,
          isError,
        });
      },
      onFinish: (event) => {
        if (event.response?.messages) {
          const generatedMessages = [...event.response.messages];
          if (generatedMessages.length > 0 && event.usage) {
             const lastMsg = generatedMessages[generatedMessages.length - 1];
             if (lastMsg.role === "assistant") {
                (lastMsg as any).usage = event.usage;
             }
          }
          turnCtx.newMessages.push(...(generatedMessages as never[]));
        } else {
          const text = event.finishReason === "error" ? fullResponse : event.text;
          if (text) turnCtx.newMessages.push({ role: "assistant", content: text, usage: event.usage } as never);
        }

        deps.adapterManager.emitStreamEvent(channelKey, {
          type: "turn-finish",
          text: fullResponse,
          finishReason: event.finishReason
        });

        const finalOutputText = event.finishReason === "error" ? fullResponse : event.text;
        if (finalOutputText && config.agent.autoSendAssistantText && latest.trigger !== "scheduled") {
          adapterManager.sendMessage(channelKey, finalOutputText, latest.id).catch((e) => {
            console.error(`[Agent] Failed to send reply to ${channelKey}:`, e);
          });
        }

        if (event.finishReason === "error") {
          deps.adapterManager.emitStreamEvent(channelKey, { type: "turn-error", error: new Error("Agent run error") });
        }
      },
    });

    await Promise.race([
      result.text,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), AGENT_MAX_RUN_MS)),
    ]);

    if (deps.turnHooks) {
      const turnResult = { text: fullResponse, toolCalls };
      for (const hook of deps.turnHooks) {
        if (hook.onAfterTurn) await hook.onAfterTurn(turnCtx, turnResult);
      }
    }
  } catch (e) {
    deps.adapterManager.emitStreamEvent(channelKey, { type: "turn-error", error: e });
  } finally {
    sessionStorage.appendMessages(sessionKey, sessionId, turnCtx.newMessages);

    if (config.agent.compaction.enabled) {
      const allMessages = [...turnCtx.history, ...turnCtx.newMessages];
      const apiKey = await getApiKeyForProfile(profile) || "";
      scheduleAutoCompaction(sessionKey, sessionId, allMessages, { sessionStorage, model, apiKey, reserveTokens: config.agent.compaction.reserveTokens });
    }
  }
}

async function scheduleAutoCompaction(
  sessionKey: string,
  sessionId: string,
  initialMessages: Array<{ role: string; content: unknown }>,
  opts: { sessionStorage: SessionStorage; model: LanguageModel; apiKey: string; reserveTokens: number },
): Promise<void> {
  const assistantMsgs = initialMessages.filter(m => m.role === "assistant");
  const lastMsg = assistantMsgs.at(-1);
  if (!lastMsg) return;

  const usage = (lastMsg as { usage?: { totalTokens?: number } }).usage;
  if (!usage || (usage.totalTokens || 0) < 128000 - opts.reserveTokens) return;

  let userCount = 0, splitIndex = 0;
  for (let i = initialMessages.length - 1; i >= 0; i--) {
    if (initialMessages[i].role === "user" && ++userCount === 10) {
      splitIndex = i;
      break;
    }
  }

  const toSummarize = initialMessages.slice(0, splitIndex);
  const kept = initialMessages.slice(splitIndex);
  if (toSummarize.length === 0) return;

  const prev = sessionCompactions.get(sessionKey);
  const compact = (prev ?? Promise.resolve()).catch(() => {}).then(async () => {
    const summary = await Promise.race([
      generateText({
        model: opts.model,
        prompt: `Summarize the conversation history concisely. Focus on key facts, decisions, and preferences.\n\n${toSummarize.map(m => `[${m.role}] ${m.content}`).join("\n")}`,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), COMPACTION_TIMEOUT_MS)),
    ]);

    const newSessionId = generateSessionId();
    opts.sessionStorage.compressSession(
      sessionKey,
      sessionId,
      newSessionId,
      [{ role: "user", content: `[Context Summary ${new Date().toISOString()}]\n${summary.text}` }, ...kept],
    );
  }).catch((e) => {
    console.error(`[Agent] Failed to compact session ${sessionKey}:`, e);
  });

  sessionCompactions.set(sessionKey, compact);
  compact?.finally(() => {
    if (sessionCompactions.get(sessionKey) === compact) sessionCompactions.delete(sessionKey);
  });
}
