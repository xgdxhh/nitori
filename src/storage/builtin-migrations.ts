export interface BuiltinMigration {
  tag: string;
  sql: string;
}

export const BUILTIN_MIGRATIONS: BuiltinMigration[] = [
  {
    tag: "0000_baseline",
    sql: `CREATE TABLE \`events\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`type\` text NOT NULL,
  \`channel_key\` text NOT NULL,
  \`prompt\` text NOT NULL,
  \`cron_expr\` text,
  \`timezone\` text,
  \`run_at\` text,
  \`next_run_at\` text,
  \`status\` text NOT NULL,
  \`retries\` integer NOT NULL,
  \`created_at\` text NOT NULL,
  \`updated_at\` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX \`idx_events_due\` ON \`events\` (\`status\`, \`next_run_at\`);
--> statement-breakpoint
CREATE INDEX \`idx_events_channel_created\` ON \`events\` (\`channel_key\`, \`created_at\`);
--> statement-breakpoint
CREATE TABLE \`inbox\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`channel_key\` text NOT NULL,
  \`source\` text NOT NULL,
  \`external_id\` text NOT NULL,
  \`sender_id\` text,
  \`sender_name\` text,
  \`trigger\` text NOT NULL,
  \`reply_to_message_id\` text,
  \`text\` text,
  \`attachments_json\` text NOT NULL,
  \`raw_json\` text NOT NULL,
  \`status\` text NOT NULL,
  \`created_at\` text NOT NULL,
  \`read_at\` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX \`uq_inbox_channel_external\` ON \`inbox\` (\`channel_key\`, \`external_id\`);
--> statement-breakpoint
CREATE INDEX \`idx_inbox_status_channel_created\` ON \`inbox\` (\`status\`, \`channel_key\`, \`created_at\`);
--> statement-breakpoint
CREATE TABLE \`session_messages\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`session_key\` text NOT NULL,
  \`role\` text NOT NULL,
  \`text\` text NOT NULL,
  \`raw_json\` text NOT NULL,
  \`timestamp_ms\` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX \`idx_session_messages_session_id\` ON \`session_messages\` (\`session_key\`, \`id\`);
--> statement-breakpoint
CREATE INDEX \`idx_session_messages_session_timestamp\` ON \`session_messages\` (\`session_key\`, \`timestamp_ms\`);
--> statement-breakpoint
CREATE TABLE \`session_checkpoints\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`session_key\` text NOT NULL,
  \`after_message_id\` integer NOT NULL,
  \`created_at\` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX \`idx_session_checkpoints_session_after\` ON \`session_checkpoints\` (\`session_key\`, \`after_message_id\` DESC);
--> statement-breakpoint
CREATE INDEX \`idx_session_checkpoints_session_created\` ON \`session_checkpoints\` (\`session_key\`, \`created_at\` DESC);
--> statement-breakpoint
CREATE VIRTUAL TABLE \`session_messages_fts\` USING fts5(
  \`text\`,
  \`session_key\` UNINDEXED,
  \`message_id\` UNINDEXED,
  tokenize='trigram'
);`,
  },
];
