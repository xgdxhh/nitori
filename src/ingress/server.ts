import { object, optional, parse, picklist, string, array, boolean, number, record, unknown, type InferOutput } from "valibot";
import type { InboundMessage } from "../types.ts";
import type { AppConfig } from "../config/index.ts";

const senderSchema = object({
  id: string(),
  name: optional(string()),
  username: optional(string()),
  isBot: optional(boolean()),
});

const attachmentSchema = object({
  type: picklist(["image", "video", "audio", "file"]),
  path: string(),
  mimeType: optional(string()),
  size: optional(number()),
  fileName: optional(string()),
});

const eventSchema = object({
  id: string(),
  source: string(),
  channelKey: string(),
  sender: senderSchema,
  text: optional(string()),
  attachments: optional(array(attachmentSchema)),
  replyToMessageId: optional(string()),
  receivedAt: optional(string()),
  trigger: optional(picklist(["active", "passive", "scheduled", "direct", "mention", "reply"])),
  raw: optional(record(string(), unknown())),
});

const requestSchema = object({
  event: eventSchema,
});

type IngressEventPayload = InferOutput<typeof eventSchema>;

export interface IngressServer {
  stop(): Promise<void>;
}

export function shouldStartIngressServer(config: AppConfig): boolean {
  return config.ingress.port > 0 && config.ingress.token.length > 0;
}

export function createIngressServer(
  config: AppConfig,
  onInbound: (message: InboundMessage) => Promise<void>,
): IngressServer {
  const server = Bun.serve({
    hostname: config.ingress.host,
    port: config.ingress.port,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true });
      }
      if (request.method !== "POST" || url.pathname !== "/events") {
        return Response.json({ ok: false, error: "not_found" }, { status: 404 });
      }

      const token = getBearerToken(request.headers.get("authorization"));
      if (token !== config.ingress.token) {
        return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      }

      const body = parse(requestSchema, await request.json());
      const message = toInboundMessage(body.event);
      void onInbound(message).catch((error: unknown) => {
        console.error("[ingress] failed to process inbound event", error);
      });
      return Response.json({ ok: true, accepted: true, channelKey: message.channelKey, id: message.id }, { status: 202 });
    },
  });

  console.log(`[ingress] listening on http://${config.ingress.host}:${config.ingress.port}`);

  return {
    async stop() {
      server.stop();
    },
  };
}

function getBearerToken(header: string | null): string {
  return header?.replace(/^Bearer\s+/u, "") || "";
}

function toInboundMessage(event: IngressEventPayload): InboundMessage {
  return {
    id: event.id,
    source: event.source,
    channelKey: event.channelKey,
    sender: event.sender,
    text: event.text,
    attachments: event.attachments || [],
    replyToMessageId: event.replyToMessageId,
    raw: event.raw,
    receivedAt: event.receivedAt || new Date().toISOString(),
    trigger: mapTrigger(event.trigger),
  };
}

function mapTrigger(trigger: IngressEventPayload["trigger"]): InboundMessage["trigger"] {
  if (trigger === "active") return "direct";
  if (trigger === "scheduled") return "scheduled";
  if (trigger === "mention" || trigger === "reply" || trigger === "direct") return trigger;
  return "passive";
}


