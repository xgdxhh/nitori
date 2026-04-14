# nitori-terminal

Persistent shell sessions for Nitori as an extension.

## Tools

- `terminal_create`
- `terminal_input`
- `terminal_read`
- `terminal_close`

This is a shell session MVP, not a PTY-backed terminal. It keeps shell state
across tool calls, but full-screen terminal apps like `vim`, `less`, and `top`
will not behave like a real terminal.

## Load it as an extension

Nitori currently loads extensions from `~/.nitori/extensions/<name>/`.

Create a thin shim:

### `~/.nitori/extensions/terminal/index.ts`

```ts
export { default } from "/Users/rin/workspace/nitori/packages/nitori-terminal/src/index.ts";
```

Then enable it in `~/.nitori/settings.json`:

```json
{
  "extensions": ["terminal"]
}
```
