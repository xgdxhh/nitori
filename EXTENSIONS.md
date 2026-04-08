capabilities).

> [!TIP]
> For simple tools or cross-service tool discovery, consider using **Model Context Protocol (MCP)** instead of writing a full extension. See the main README for MCP configuration.


## Core Design

- **Zero Compilation**: Leveraging Bun's native features, extensions are written
  and loaded directly as `.ts` or `.js` files.
- **Declarative**: Extension names are explicitly listed in your
  `settings.json`.
- **Factory Pattern**: Tools and Adapters are registered using factory functions
  to ensure they receive the correct runtime context (like `channelKey` or
  `messageHandler`).
- **Stable Host API**: Background extensions use `ctx.host` for inbox access,
  agent dispatch, lifecycle cleanup, and logging.

## Quick Start

Configure your extension names in `~/.nitori/settings.json` (extensions must be
placed in `~/.nitori/extensions/<name>/`):

```json
{
  "extensions": [
    "my-extension"
  ]
}
```

The extension directory must be named with only lowercase letters, numbers, and
hyphens (e.g., `my-extension`). Nitori expects an `index.ts` or `index.js`
inside this directory.

## Writing an Extension

Every extension must `default export` an object implementing the
`NitoriExtension` interface.

### 1. Extending Tools

To give the Agent new skills:

```typescript
import { type NitoriExtension, Type } from "nitori-types";

export default {
  name: "hello-tools",
  version: "0.1.0",
  description: "Example greeting tools",

  activate(ctx) {
    ctx.registerTool((toolCtx) => ({
      name: "hello",
      label: "Say hello",
      description: "Greet someone by name.",
      parameters: Type.Object({
        name: Type.String(),
      }),
      async execute(_id, params) {
        const { name } = params as { name: string };
        return {
          content: [{ type: "text", text: `Hello, ${name}! I am Nitori.` }],
          details: { channel: toolCtx.currentChannelKey },
        };
      },
    }));
  },
} satisfies NitoriExtension;
```

Tool return values have two parts:

- `content`: The actual tool result exposed to the agent. Put anything the model
  must read here.
- `details`: Structured metadata for runtime use, UI display, or logs. Treat
  this as program-facing metadata, not the main channel for model-visible
  output.

Use `details` for fields like `messageId`, file paths, sizes, or exit codes. If
a fact is important for the agent's next step, include it in `content`.

### 2. Background work with `ctx.host`

For polling, syncing, or inbox nudging, use the stable host API:

```typescript
import type { ExtensionContext, NitoriExtension } from "nitori-types";

const POLL_MS = 60_000;

export default {
  name: "watcher",
  version: "0.1.0",

  activate(ctx: ExtensionContext) {
    const timer = setInterval(async () => {
      const unread = ctx.host.inbox.listUnreadChannels();
      for (const channel of unread) {
        await ctx.host.agent.enqueue({
          channelKey: channel.channelKey,
          prompt:
            `You have ${channel.unreadCount} unread inbox messages. Use read_inbox.`,
          trigger: "scheduled",
        });
      }
    }, POLL_MS);

    ctx.host.lifecycle.onDeactivate(() => {
      clearInterval(timer);
    });
  },
} satisfies NitoriExtension;
```

### 3. Extending Adapters

To integrate a new chat platform:

```typescript
import type { Adapter, NitoriExtension } from "nitori-types";

class MyCustomAdapter implements Adapter {
  readonly name = "my-platform";

  constructor(private handler: { onInbound: Function }) {}

  canHandleChannel(key: string) {
    return key.startsWith("custom:");
  }

  async start() {
    // Connect to your platform...
    // When a message is received, call:
    // this.handler.onInbound({ ...InboundMessage });
  }

  async stop() {/* Disconnect logic */}

  async sendMessage(channelKey: string, text: string) {
    console.log(`Sending to ${channelKey}: ${text}`);
    return "msg_id_123";
  }
}

export default {
  name: "my-platform",
  version: "0.1.0",

  activate(ctx) {
    ctx.registerAdapter((handler) => new MyCustomAdapter(handler));
  },
} satisfies NitoriExtension;
```

## API Reference

### `NitoriExtension`

- `name`: (Required) Unique name identifier for the extension.
- `version`: (Required) Semver version string.
- `description`: (Optional) Brief description of what the extension does.
- `activate(ctx: ExtensionContext)`: Entry point for initialization.
- `deactivate()`: (Optional) Cleanup hook called when the extension is disabled
  or the daemon shuts down.

### `ExtensionContext`

- `registerAdapter(factory)`: Register an adapter factory. Nitori will inject
  the `messageHandler` into your factory.
- `registerTool(factory)`: Register a tool factory. This factory is called for
  every Agent response to create fresh tool instances.
- `extensionDir`: Absolute path to the directory containing the extension file
  (useful for reading local config files).
- `workspaceDir`: The Nitori home directory (usually `~/.nitori`).
- `host`: Stable runtime capabilities for inbox access, agent dispatch,
  lifecycle cleanup, and logging.

### `ExtensionHost`

- `host.inbox.list(options)`: Read inbox messages with filters and optional
  `markAsRead`.
- `host.inbox.listUnreadChannels()`: Return unread message counts grouped by
  `channelKey`.
- `host.agent.enqueue({ channelKey, prompt, trigger, metadata })`: Start an
  agent run from extension code.
- `host.lifecycle.onDeactivate(cleanup)`: Register cleanup callbacks for timers,
  sockets, or other background resources.
- `host.log.info()` / `host.log.error()`: Structured extension-scoped logging.

## Type Support

Install `nitori-types` to get full IDE type hinting:

```bash
bun add -d nitori-types
```

## Best Practices

1. **Storage**: Extensions are responsible for their own data persistence. We
   recommend storing data inside a subfolder in the `workspaceDir`.
2. **Dependencies**: Extensions run in the same Bun process as Nitori. You can
   use any dependencies already present in the main project.
3. **JS Support**: You can also write extensions in plain `.js`. Use JSDoc
   annotations to maintain type safety.
