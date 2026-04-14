import { generateText, type LanguageModel } from "ai";

export function shouldAutoCompact(
  lastAssistantMessage: { role: string; content: unknown } | null,
  contextWindow: number,
  config: { enabled: boolean; reserveTokens: number },
): boolean {
  if (!config.enabled || !lastAssistantMessage) return false;
  const usage = (lastAssistantMessage as { usage?: { totalTokens?: number } }).usage;
  return !!usage && (usage.totalTokens || 0) > contextWindow - config.reserveTokens;
}

export function prepareLinearCompaction(messages: Array<{ role: string; content: unknown }>) {
  let userCount = 0, splitIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user" && ++userCount === 10) {
      splitIndex = i;
      break;
    }
  }
  return { messagesToSummarize: messages.slice(0, splitIndex), keptMessages: messages.slice(splitIndex) };
}

export async function generateCompactionSummary(messages: Array<{ role: string; content: unknown }>, model: LanguageModel, _reserveTokens: number): Promise<string> {
  const text = messages.map(m => `[${m.role}] ${extractText(m.content)}`).join("\n");
  const prompt = `Summarize the following conversation history concisely. Focus on key facts, decisions, and user preferences mentioned.\n\n${text}`;
  const result = await generateText({
    model,
    prompt,
  });
  return result.text;
}

export function createCompactionSummaryMessage(summary: string, timestamp: string): { role: string; content: unknown } {
  return { role: "user", content: [{ type: "text", text: `[Context Summary ${timestamp}]\n${summary}` }] };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: unknown) => (p as { type?: string; text?: string })?.type === "text" ? String((p as { text?: string }).text) : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}
