import { streamText, stepCountIs, generateText, type Tool } from "ai";
import type { AppConfig } from "../config/index.ts";
import { generateSessionId, type SessionStorage } from "../storage/sessions.ts";
import { createToolset } from "../tools/index.ts";
import type { AdapterManager } from "../adapters/manager.ts";
import type { CronJobRequest, CronJobResult, InboundMessage, ToolContext } from "../types.ts";
import type { ToolFactory } from "../extension/types.ts";
import type { McpClientManager } from "../mcp/client.ts";
import { buildSystemPrompt } from "./prompt-builder.ts";
import { agentOutput } from "./console.ts";
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
    mcpManager: McpClientManager;
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
    mcpManager: McpClientManager;
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
  const messages: Array<{ role: string; content: unknown }> = [...session.messages];

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

  const apiKey = await getApiKeyForProfile(profile);

  const images = inMessages.flatMap(m => loadImagesFromAttachments(m.attachments));
  const userPrompt = normalizeInboxPrompt(inMessages, config.agent.hideSourceInfo);
  const userContent = images.length > 0
    ? [{ type: "text", text: userPrompt }, ...images.map(img => ({ type: "image", image: img.data, mimeType: img.mimeType }))]
    : userPrompt;

  messages.push({ role: "user", content: userContent });

  let fullResponse = "";
  let hasShownThinking = false;
  const toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown; result: unknown }> = [];

  try {
    const result = streamText({
      model,
      system: buildSystemPrompt(config.workspaceDir, config),
      messages: messages as never,
      tools,
      stopWhen: stepCountIs(20),
      onChunk: ({ chunk }) => {
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
        const { toolCall } = event;
        agentOutput.toolCall(toolCall.toolName, toolCall.input as Record<string, unknown>);
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
        agentOutput.toolResult(toolCall.toolName, 0, isError);
      },
      onFinish: (event) => {
        if (toolCalls.length > 0) {
          messages.push({
            role: "assistant",
            content: fullResponse,
            toolCalls: toolCalls.map(tc => ({
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.input,
            })),
          } as { role: string; content: unknown; toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }> });
          for (const tc of toolCalls) {
            messages.push({
              role: "tool",
              toolCallId: tc.toolCallId,
              content: tc.result,
            } as { role: string; toolCallId: string; content: unknown });
          }
        }

        const text = event.finishReason === "error" ? fullResponse : event.text;
        if (text) {
          if (toolCalls.length === 0) {
            messages.push({ role: "assistant", content: text });
          }
          agentOutput.assistant(text);
          if (config.agent.autoSendAssistantText && latest.trigger !== "scheduled") {
            adapterManager.sendMessage(channelKey, text, latest.id).catch((e) => {
              agentOutput.error(`Failed to send reply to ${channelKey}: ${e instanceof Error ? e.message : e}`);
            });
          }
        }

        if (event.finishReason === "error") agentOutput.error("Agent run error");

        if (config.agent.compaction.enabled) {
          scheduleAutoCompaction(sessionKey, sessionId, session.messages, { sessionStorage, model, apiKey, reserveTokens: config.agent.compaction.reserveTokens });
        }
      },
    });

    await Promise.race([
      result.text,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), AGENT_MAX_RUN_MS)),
    ]);
  } catch (e) {
    agentOutput.error(`Agent error: ${e instanceof Error ? e.message : e}`);
  } finally {
    sessionStorage.appendMessages(sessionKey, sessionId, messages.slice(session.messages.length));
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
    agentOutput.error(`Failed to compact session ${sessionKey}: ${e instanceof Error ? e.message : e}`);
  });

  sessionCompactions.set(sessionKey, compact);
  compact?.finally(() => {
    if (sessionCompactions.get(sessionKey) === compact) sessionCompactions.delete(sessionKey);
  });
}
