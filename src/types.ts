import type { AdapterManager } from "./adapters/manager.ts";

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
  | "fetch_image";
  data: Record<string, unknown>;
}

export interface CronJobRequest {
  op: "create" | "list" | "get" | "update" | "cancel";
  id?: string;
  kind?: "once" | "cron";
  prompt?: string;
  schedule?: string;
  timezone?: string;
  limit?: number;
}

export interface ScheduleInfo {
  id: string;
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
  adapterManager: AdapterManager;
  currentChannelKey: string;
  currentSessionKey: string;
  workspaceDir: string;
  currentMessageId?: string;
  cronJob: (request: CronJobRequest) => Promise<CronJobResult>;
}
