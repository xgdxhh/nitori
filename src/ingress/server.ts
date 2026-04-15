import { object, optional, parse, picklist, string, array, boolean, number, record, unknown, type InferOutput } from "valibot";
import type { ServerWebSocket } from "bun";
import type { InboundMessage } from "../types.ts";
import type { AppConfig } from "../config/index.ts";
import type { WebAdapterInstance } from "../adapters/web.ts";
import { join } from "node:path";

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
type IngressSocket = ServerWebSocket<{ channelKey?: string }>;
type IngressSession = {
  authenticated: boolean;
  channelKey?: string;
  timeout: ReturnType<typeof setTimeout>;
};

export interface IngressServer {
  stop(): Promise<void>;
}

export function shouldStartIngressServer(config: AppConfig): boolean {
  return config.ingress.port > 0 && config.ingress.token.length > 0;
}

export function createIngressServer(
  config: AppConfig,
  onInbound: (message: InboundMessage) => Promise<void>,
  webAdapter?: WebAdapterInstance,
): IngressServer {
  const wsSessions = new Map<IngressSocket, IngressSession>();

  const server = Bun.serve<{ channelKey?: string }>({
    hostname: config.ingress.host,
    port: config.ingress.port,
    fetch: async (request, server) => {
      const url = new URL(request.url);

      // 1. Health check
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true });
      }

      // 2. WebSocket upgrade
      if (url.pathname === "/ws") {
        const success = server.upgrade(request, { data: { channelKey: undefined } });
        return success ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      }

      // 3. Static files
      if (request.method === "GET") {
        let filePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const fullPath = join(process.cwd(), "web", filePath);
        const file = Bun.file(fullPath);
        if (await file.exists()) {
          return new Response(file);
        }
      }

      // 4. Ingress Events (External Pushes)
      if (request.method === "POST" && url.pathname === "/events") {
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
      }

      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    },
    websocket: {
      open(ws) {
        const timeout = setTimeout(() => {
          if (!wsSessions.get(ws)?.authenticated) {
            ws.close(4001, "Auth timeout");
          }
        }, 10000);
        wsSessions.set(ws, { authenticated: false, timeout });
      },
      async message(ws, message) {
        const session = wsSessions.get(ws);
        if (!session) return;

        try {
          const data = JSON.parse(message as string);

          // Handle Handshake
          if (!session.authenticated) {
            if (data.type === "auth" && data.token === config.ingress.token && data.channelKey) {
              clearTimeout(session.timeout);
              session.authenticated = true;
              session.channelKey = data.channelKey;
              webAdapter?.handleUpgrade(ws, data.channelKey);
              ws.send(JSON.stringify({ type: "auth-success" }));
            } else {
              ws.close(4002, "Invalid handshake");
            }
            return;
          }

          // Handle Inbound Message
          if (data.type === "message" && session.channelKey) {
            const inbound: InboundMessage = {
              id: `web-${crypto.randomUUID()}`,
              source: "web",
              channelKey: session.channelKey,
              sender: data.sender || { id: "web-user", name: "Web User" },
              text: data.text,
              attachments: [],
              receivedAt: new Date().toISOString(),
              trigger: "direct",
            };
            await onInbound(inbound);
          }
        } catch (e) {
          console.error("[ingress] WS message error", e);
        }
      },
      close(ws) {
        const session = wsSessions.get(ws);
        if (session?.channelKey) {
          webAdapter?.handleClose(session.channelKey);
        }
        wsSessions.delete(ws);
      },
    },
  });

  console.log(`[ingress] running at http://${config.ingress.host}:${config.ingress.port}`);

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

