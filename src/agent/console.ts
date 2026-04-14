import type { InboundMessage } from "../types.ts";

export const RESET = "\x1b[0m";
export const DIM = "\x1b[2m";
export const CYAN = "\x1b[36m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const MAGENTA = "\x1b[35m";

const truncate = (text: string, len = 200) =>
  text.length > len ? text.slice(0, len) + "..." : text;

export const agentOutput = {
  userPrompt(messages: InboundMessage[]) {
    for (const m of messages) {
      const sender = m.trigger === "scheduled" ? "system" : (m.sender.name || m.sender.id);
      const content = truncate(m.text || "(attachment)", 100).replace(/\n/g, " ");
      console.log(`${CYAN}> [${m.channelKey}] ${sender}: ${content}${RESET}`);
    }
  },

  toolCall(toolName: string, args: Record<string, unknown>) {
    const argsStr = Object.entries(args)
      .map(([k, v]) => `${k}=${truncate(JSON.stringify(v), 50)}`)
      .join(", ");
    process.stdout.write(`\n${YELLOW}> ${toolName}${RESET}(${DIM}${argsStr}${RESET})\n`);
  },

  toolResult(toolName: string, durationMs: number, isError = false) {
    const symbol = isError ? "\x1b[31mx" : GREEN + "<";
    process.stdout.write(`${symbol} ${toolName}${RESET} ${DIM}(${durationMs}ms)${RESET}\n`);
  },

  assistant(text: string) {
    process.stdout.write(`\n${MAGENTA}> ${truncate(text, 600)}${RESET}\n`);
  },

  thinking() {
    process.stdout.write(`${DIM}> thinking: ${RESET}`);
  },

  thinkingDelta(delta: string) {
    process.stdout.write(`${DIM}${delta.replace(/\n/g, " ")}${RESET}`);
  },

  assistantDelta(delta: string) {
    process.stdout.write(`${MAGENTA}${delta.replace(/\n/g, " ")}${RESET}`);
  },

  assistantStarted() {
    process.stdout.write(`\n${MAGENTA}> ${RESET}`);
  },

  error(msg: string) {
    process.stdout.write(`\n\x1b[31m[error] ${msg}\x1b[0m\n`);
  },
};

