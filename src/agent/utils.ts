import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { InboundMessage } from "../types.ts";

interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export function getLastAssistantMessage(messages: Array<{ role: string; content: unknown }>): { role: string; content: unknown } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") return msg;
  }
  return null;
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: unknown) => (p as { type?: string; text?: string })?.type === "text" ? String((p as { text?: string }).text) : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function loadImagesFromAttachments(attachments: InboundMessage["attachments"]): ImageContent[] {
  return attachments
    .filter(a => a.type === "image" && a.path && !a.path.includes("://"))
    .map(a => {
      const abs = resolve(a.path);
      return existsSync(abs) ? { type: "image" as const, data: readFileSync(abs).toString("base64"), mimeType: a.mimeType || "image/jpeg" } : null;
    })
    .filter((x): x is ImageContent => !!x);
}

export function normalizeUserPrompt(m: InboundMessage): string {
  if (m.trigger === "scheduled") return `kind: event\nchannel: ${m.channelKey}\nevent: ${m.trigger}\ntext: ${m.text || "(no text)"}`;

  const sender = `${m.sender.name || "Unknown"} (${m.sender.id})`;
  const attachments = m.attachments.map(a => `- ${a.type}: ${a.path}`).join("\n");

  return [
    `channel_key: ${m.channelKey}`,
    `sender: ${sender}`,
    `trigger: ${m.trigger}`,
    `message id: ${m.id}`,
    `text: ${m.text?.trim() || "(no text)"}`,
    attachments && `attachments:\n${attachments}`
  ].filter(Boolean).join("\n");
}

export function normalizeInboxPrompt(
  messages: InboundMessage[]
): string {
  const now = new Date().toLocaleString("sv-SE", { timeZoneName: "short" });
  const parts = messages.map(m => normalizeUserPrompt(m));
  return parts.join("\n\n---\n\n") + `\n\ncurrent time: ${now}`;
}
