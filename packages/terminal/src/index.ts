import type { NitoriExtension } from "packages/nitori-types/index.ts";
import { closeAllTerminalSessions, createTerminalToolFactories } from "./tools.ts";

export default {
  name: "terminal",
  version: "0.1.0",
  description: "Persistent terminal sessions",

  activate(ctx) {
    for (const factory of createTerminalToolFactories()) {
      ctx.registerTool(factory);
    }
  },

  deactivate() {
    closeAllTerminalSessions();
  },
} satisfies NitoriExtension;
