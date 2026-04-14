import type { AdapterManager } from "./adapters/manager.ts";
import type { Storage } from "./storage/db.ts";

import type { InboundMessage } from "../packages/nitori-types/index.ts";

export * from "../packages/nitori-types/index.ts";

export interface RuntimeAction {
  type:
  | "message_send"
  | "message_reply"
  | "react_message"
  | "attach_file"
  | "cron_once"
  | "cron_recurring"
  | "cron_cancel"
  | "read_inbox"
  | "fetch_image";
  data: Record<string, unknown>;
}

export interface CronJobRequest {
  op: "create" | "list" | "get" | "update" | "cancel";
  id?: number;
  kind?: "once" | "cron";
  prompt?: string;
  schedule?: string;
  timezone?: string;
  limit?: number;
}

export interface ScheduleInfo {
  id: number;
  kind: "once" | "cron";
  prompt: string;
  status: string;
  schedule: string;
  nextRunAt: string | null;
  timezone: string | null;
}

export interface CronJobResult {
  ok: boolean;
  op: CronJobRequest["op"];
  schedule?: ScheduleInfo | null;
  schedules?: ScheduleInfo[];
}

export interface ToolContext {
  storage: Storage;
  adapterManager: AdapterManager;
  currentChannelKey: string;
  currentSessionKey: string;
  workspaceDir: string;
  currentMessageId?: string;
  cronJob: (request: CronJobRequest) => Promise<CronJobResult>;
  readInbox: (options: { limit: number; offset?: number; onlyUnread?: boolean; channelKey?: string; markAsRead?: boolean }) => InboundMessage[];
}
