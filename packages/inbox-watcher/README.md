# nitori-inbox-watcher

Periodically nudges Nitori to process unread inbox messages.

## What it does

- polls the global inbox every 5 minutes
- groups unread messages by `channelKey`
- enqueues a scheduled agent run for each unread channel
- lets the agent decide what to do by using `read_inbox`

## Load it as an extension

Nitori loads extensions from `~/.nitori/extensions/<name>/`.

Create a thin shim:

### `~/.nitori/extensions/inbox-watcher/index.ts`

```ts
export { default } from "/Users/rin/workspace/nitori/packages/nitori-inbox-watcher/src/index.ts";
```

Then enable it in `~/.nitori/settings.json`:

```json
{
  "extensions": ["inbox-watcher"]
}
```
