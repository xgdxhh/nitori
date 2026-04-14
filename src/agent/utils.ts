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
    .filter(a => a.type === "image")
    .map(a => {
      if (a.data) {
        return { type: "image" as const, data: a.data, mimeType: a.mimeType || "image/jpeg" };
      }
      if (a.path && !a.path.includes("://")) {
        const abs = resolve(a.path);
        return existsSync(abs) ? { type: "image" as const, data: readFileSync(abs).toString("base64"), mimeType: a.mimeType || "image/jpeg" } : null;
      }
      return null;
    })
    .filter((x): x is ImageContent => !!x);
}

export function normalizeUserPrompt(m: InboundMessage, hideSourceInfo = false): string {
  if (m.trigger === "scheduled") return `kind: event\nchannel: ${m.channelKey}\nevent: ${m.trigger}\ntext: ${m.text || "(no text)"}`;

  const sender = `${m.sender.name || "Unknown"} (${m.sender.id})`;
  const attachments = m.attachments.map(a => `- ${a.type}: ${a.path}`).join("\n");

  const parts = [
    hideSourceInfo ? null : `channel_key: ${m.channelKey}`,
    hideSourceInfo ? null : `sender: ${sender}`,
    hideSourceInfo ? null : `trigger: ${m.trigger}`,
    hideSourceInfo ? null : `message id: ${m.id}`,
    `text: ${m.text?.trim() || "(no text)"}`,
    attachments && `attachments:\n${attachments}`
  ].filter(Boolean);

  return parts.join("\n");
}

export function normalizeInboxPrompt(
  messages: InboundMessage[],
  hideSourceInfo = false
): string {
  const now = new Date().toLocaleString("sv-SE", { timeZoneName: "short" });
  const parts = messages.map(m => normalizeUserPrompt(m, hideSourceInfo));
  return parts.join("\n\n---\n\n") + `\n\ncurrent time: ${now}`;
}
