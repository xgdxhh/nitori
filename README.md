# Nitori

A personal AI agent you run on your own machine. Chat with it on Telegram,
Discord, or your terminal. It manages sessions, schedules tasks, searches the
web, and reads/writes files — all with the tools you need built in.

## Quick Start

```bash
nitori onboard        # Initialize ~/.nitori workspace
```

## CLI Commands

| Command          | Description                                            |
| ---------------- | ------------------------------------------------------ |
| `nitori onboard` | Initialize workspace (`~/.nitori`) with default config |
| `nitori chat`    | Run in CLI chat mode instead of Telegram/Discord       |

## Adapters

Telegram, Discord, and CLI adapters are built-in. Extensions can register
additional adapters.

### Telegram

Requires `settings.json`:

```json
{
  "telegramToken": "<bot-token>"
}
```

### Discord

```json
{
  "discordToken": "<bot-token>"
}
```

### CLI

Run `nitori chat` for interactive terminal chat.

## Message Flow

1. Inbound messages are written to `inbox` first
2. Group chats require mention/reply triggers; DMs use direct signals
3. Realtime triggers process immediately via `processAndReply`
4. Passive messages sit in inbox until agent polls with `read_inbox`
5. Outbound uses `send`, `reply`, or `telegram_react_message`

## Built-in Tools

### File Operations

- `read` - Read file or list directory (offset/limit support)
- `write` - Write full content to file
- `edit` - Replace first occurrence of pattern in file
- `bash` - Execute shell command (120s timeout default)

### Messaging

- `send` - Send message to current session or specified channel
- `reply` - Reply to specific inbox message ID
- `telegram_react_message` - React to message with emoji
- `attach` - Send local file back to conversation
- `fetch_image` - Fetch image as base64 for LLM

### Inbox & Session

- `read_inbox` - Browse messages with pagination/filtering
- `handoff` - Archive current session, start fresh (creates checkpoint)
- `recall` - Search checkpoints via SQLite FTS with recency weighting

### Scheduling

- `cron_job` - Manage schedules: `create`, `list`, `get`, `update`, `cancel`

- `webfetch` - Fetch URL via Jina Reader as markdown

### Model Context Protocol (MCP)

Nitori supports connecting to MCP servers to dynamically expand its toolset. MCP
tools are namespaced by their server name: `serverName:toolName`.

Configure servers in `settings.json`:

```json
{
  "mcp": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/path/to/extra/files"
      ]
    },
    "fetch": {
      "transport": "http",
      "url": "https://mcp-server.example.com/mcp"
    }
  }
}
```

Supported transports: `stdio`, `http`, `sse`.

### subagent

```json
{
  "subagents": {
    "researcher": {
      "prompt": "You are a research assistant...",
      "profile": "gemini",
      "tools": {
        "builtins": ["web_search", "web_fetch", "read"],
        "mcp": ["browser:*"]
      },
      "maxSteps": 10
    }
  }
}
```

## LLM Configuration

`settings.json` structure:

```json
{
  "agent": {
    "sessionScope": "channel"
  },
  "llm": {
    "profile": "default",
    "profiles": {
      "default": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-5",
        "apiKey": "<key>"
      }
    }
  }
}
```

`agent.sessionScope` supports:

- `channel`: each channel uses its own session
- `global`: all channels share one session, and the session key is fixed to
  `global`

### MCP Configuration

| Field       | Type                       | Description                   |
| ----------- | -------------------------- | ----------------------------- |
| `transport` | `stdio` \| `http` \| `sse` | Communication method          |
| `command`   | `string`                   | Command to run (for `stdio`)  |
| `args`      | `string[]`                 | Arguments for the command     |
| `env`       | `Record<string, string>`   | Environment variables         |
| `url`       | `string`                   | Server URL (for `http`/`sse`) |
| `headers`   | `Record<string, string>`   | Custom HTTP headers           |

### Supported Providers

`anthropic`, `google`, `openai`, `groq`, `cerebras`, `openrouter`, `mistral`,
`opencode`, `kimi-coding`, `github-copilot`, and more.

### Auth Modes

- `apiKey` - Direct API key

### Google Native Tools

```json
{
  "providerOptions": {
    "google": {
      "nativeTools": [
        { "urlContext": {} },
        { "googleSearch": {} },
        { "codeExecution": {} }
      ]
    }
  }
}
```

Note: Use SDK-style `camelCase` names (`urlContext`), not REST API `snake_case`.

## Extensions

Extensions are `.ts`/`.js` files loaded from `~/.nitori/extensions/`.

```json
{
  "extensions": ["my-extension"]
}
```

Directory structure:

```
~/.nitori/extensions/my-extension/index.ts
```

Extension interface:

```typescript
interface NitoriExtension {
  name: string;
  activate(ctx: ExtensionContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

interface ExtensionContext {
  registerAdapter(factory: AdapterFactory): void;
  registerTool(factory: ToolFactory): void;
  extensionDir: string;
  workspaceDir: string;
}
```

Runtime control via `/ext`:

- `/ext list` - Show loaded extensions
- `/ext enable <name>` / `/ext disable <name>` - Toggle extension

## HTTP Ingress

Accept events from external bridge apps:

```json
{
  "ingress": {
    "host": "127.0.0.1",
    "port": 8787,
    "token": "replace-me"
  }
}
```

```bash
curl -X POST http://127.0.0.1:8787/events \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer replace-me' \
  -d '{
    "event": {
      "id": "evt-1",
      "source": "bluesky",
      "channelKey": "ext:bluesky:rin",
      "sender": { "id": "alice", "name": "Alice" },
      "text": "notification text",
      "attachments": [],
      "trigger": "active"
    }
  }'
```

`trigger: "active"` processes in background; `passive` only writes to inbox.

## System Prompt Templates

Files in workspace root shape agent behavior:

- `SOUL.md` - Identity/character
- `AGENTS.md` - Behavior guidelines

## Workspace Layout

Created by `nitori onboard`:

```
~/.nitori/
├── settings.json
├── telegram.json      # Telegram allow/block lists
├── SOUL.md
├── AGENTS.md
├── .agents/skills/
├── extensions/
├── files/
└── documents/
```

## Typecheck

```bash
bun run typecheck
```
