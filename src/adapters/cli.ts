import { createInterface, type Interface } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import type { Adapter, AdapterMessageHandler, InboundMessage } from "../types.ts";

export class CliAdapter implements Adapter {
  readonly name = "cli";

  private rl: Interface | null = null;
  private seq = 0;

  constructor(private readonly handler: AdapterMessageHandler) { }

  canHandleChannel(channelKey: string): boolean {
    return channelKey.startsWith("cli:");
  }

  start(): Promise<void> {
    if (this.rl) return Promise.resolve();

    const rl = createInterface({ input, output, prompt: "you> " });
    this.rl = rl;

    console.log("CLI chat started. Type /exit to quit.");
    rl.prompt();

    rl.on("line", (line) => {
      const text = line.trim();
      if (!text) {
        rl.prompt();
        return;
      }
      if (text === "/exit") {
        rl.close();
        process.exit(0);
      }

      let command: { name: string; args: string } | undefined;
      const cmdMatch = text.match(/^\/([a-z0-9_]+)(?:\s+([\s\S]*))?$/i);
      if (cmdMatch) {
        command = { name: cmdMatch[1].toLowerCase(), args: (cmdMatch[2] ?? "").trim() };
      }

      const inbound: InboundMessage = {
        id: `cli-${Date.now()}-${++this.seq}`,
        source: "cli",
        channelKey: "cli:local",
        sender: { id: "local-user", name: "Master", isBot: false },
        text,
        command,
        attachments: [],
        receivedAt: new Date().toISOString(),
        trigger: "direct",
      };

      this.handler.onInbound(inbound)
        .catch((error) => {
          console.error("CLI inbound dispatch failed", error);
        })
        .finally(() => {
          rl.prompt();
        });
    });

    rl.on("close", () => {
      this.rl = null;
    });
    return Promise.resolve();
  }

  stop(): Promise<void> {
    if (!this.rl) return Promise.resolve();
    this.rl.close();
    this.rl = null;
    return Promise.resolve();
  }

  sendMessage(_channelKey: string, text: string, _replyToMessageId?: string): Promise<string> {
    output.write(`\nassistant> ${text}\n`);
    this.rl?.prompt();
    return Promise.resolve(`cli-out-${Date.now()}-${++this.seq}`);
  }
}
