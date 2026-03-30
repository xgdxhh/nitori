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
CREATE INDEX \`idx_inbox_status_channel_created\` ON \`inbox\` (\`status\`, \`channel_key\`, \`created_at\`);`,
  },
];
