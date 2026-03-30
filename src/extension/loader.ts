import { resolve } from "node:path";
import type {
  Adapter,
  AdapterMessageHandler,
  ExtensionAgentEnqueueRequest,
  ExtensionHost,
  ExtensionLogValue,
} from "../types.ts";
import type { AdapterFactory, ExtensionContext, NitoriExtension, ToolFactory } from "./types.ts";

type DeactivateHandler = () => void | Promise<void>;

interface ExtensionRuntime {
  agentEnqueue: (
    extensionName: string,
    request: ExtensionAgentEnqueueRequest,
    getToolFactories: () => ToolFactory[],
  ) => Promise<void>;
}

interface LoadedExtension {
  ext: NitoriExtension;
  extensionDir: string;
  workspaceDir: string;
  messageHandler: AdapterMessageHandler;
  adapters: Adapter[];
  toolFactories: ToolFactory[];
  cleanupHandlers: DeactivateHandler[];
  enabled: boolean;
}

export interface LoadExtensionsOptions {
  extensionNames: string[];
  workspaceDir: string;
  messageHandler: AdapterMessageHandler;
  agentEnqueue: (
    extensionName: string,
    request: ExtensionAgentEnqueueRequest,
    getToolFactories: () => ToolFactory[],
  ) => Promise<void>;
}

function ensureExtensionEnabled(entry: LoadedExtension): void {
  if (!entry.enabled) {
    throw new Error(`Extension '${entry.ext.name}' is disabled`);
  }
}

function formatLogFields(fields?: Record<string, ExtensionLogValue>): string {
  if (!fields) return "";
  const values = Object.entries(fields).map(([key, value]) => `${key}=${String(value)}`);
  return values.length > 0 ? ` ${values.join(" ")}` : "";
}

function createExtensionLogger(name: string): ExtensionHost["log"] {
  return {
    info(message, fields) {
      console.log(`[extension:${name}] ${message}${formatLogFields(fields)}`);
    },
    error(message, fields) {
      console.error(`[extension:${name}] ${message}${formatLogFields(fields)}`);
    },
  };
}

function createGuardedToolFactory(entry: LoadedExtension, factory: ToolFactory): ToolFactory {
  return (ctx) => {
    const tool = factory(ctx);
    return {
      ...tool,
      execute: async (...args: Parameters<typeof tool.execute>) => {
        ensureExtensionEnabled(entry);
        return await tool.execute(...args);
      },
    };
  };
}

function isNitoriExtension(value: unknown): value is NitoriExtension {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === "string"
    && typeof candidate.version === "string"
    && typeof candidate.activate === "function";
}

async function runDeactivateHandlers(name: string, handlers: DeactivateHandler[]): Promise<void> {
  for (let index = handlers.length - 1; index >= 0; index--) {
    try {
      await handlers[index]();
    } catch (error) {
      console.error(`[extension] cleanup failed for '${name}'`, error);
    }
  }
}

async function runExtensionDeactivation(entry: LoadedExtension, handlers: DeactivateHandler[]): Promise<void> {
  await runDeactivateHandlers(entry.ext.name, handlers);

  try {
    await entry.ext.deactivate?.();
  } catch (error) {
    console.error(`[extension] failed to deactivate '${entry.ext.name}'`, error);
  }
}

export class ExtensionRegistry {
  private readonly entries = new Map<string, LoadedExtension>();

  constructor(private readonly runtime: ExtensionRuntime) { }

  get activeAdapters(): Adapter[] {
    return [...this.entries.values()].filter((entry) => entry.enabled).flatMap((entry) => entry.adapters);
  }

  get activeToolFactories(): ToolFactory[] {
    return [...this.entries.values()].filter((entry) => entry.enabled).flatMap((entry) => entry.toolFactories);
  }

  get names(): string[] {
    return [...this.entries.keys()];
  }

  getMetadata(name: string) {
    return this.entries.get(name)?.ext;
  }

  isEnabled(name: string): boolean {
    return this.entries.get(name)?.enabled ?? false;
  }

  async enable(name: string): Promise<Adapter[]> {
    const entry = this.entries.get(name);
    if (!entry || entry.enabled) return [];

    const adapterFactories: AdapterFactory[] = [];
    const toolFactories: ToolFactory[] = [];
    const cleanupHandlers: DeactivateHandler[] = [];

    const ctx: ExtensionContext = {
      registerAdapter: (factory) => adapterFactories.push(factory),
      registerTool: (factory) => toolFactories.push(factory),
      extensionDir: entry.extensionDir,
      workspaceDir: entry.workspaceDir,
      host: this.createHost(entry, cleanupHandlers),
    };

    entry.enabled = true;

    try {
      await entry.ext.activate(ctx);
      entry.adapters = adapterFactories.map((factory) => factory(entry.messageHandler));
      entry.toolFactories = toolFactories.map((factory) => createGuardedToolFactory(entry, factory));
      entry.cleanupHandlers = cleanupHandlers;
      return [...entry.adapters];
    } catch (error) {
      entry.enabled = false;
      await runExtensionDeactivation(entry, cleanupHandlers);
      throw error;
    }
  }

  async disable(name: string): Promise<Adapter[]> {
    const entry = this.entries.get(name);
    if (!entry || !entry.enabled) return [];

    entry.enabled = false;
    const adapters = [...entry.adapters];
    const cleanupHandlers = entry.cleanupHandlers;

    entry.adapters = [];
    entry.toolFactories = [];
    entry.cleanupHandlers = [];

    await runExtensionDeactivation(entry, cleanupHandlers);
    return adapters;
  }

  /** @internal */
  _addEntry(entry: LoadedExtension): void {
    if (this.entries.has(entry.ext.name)) {
      throw new Error(`Duplicate extension name '${entry.ext.name}'`);
    }
    this.entries.set(entry.ext.name, entry);
  }

  /** @internal */
  _deleteEntry(name: string): void {
    this.entries.delete(name);
  }

  async unloadAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (!entry.enabled) continue;

      entry.enabled = false;
      const cleanupHandlers = entry.cleanupHandlers;

      entry.adapters = [];
      entry.toolFactories = [];
      entry.cleanupHandlers = [];

      await runExtensionDeactivation(entry, cleanupHandlers);
    }
  }

  private createHost(entry: LoadedExtension, cleanupHandlers: DeactivateHandler[]): ExtensionHost {
    return {
      agent: {
        enqueue: async (request) => {
          ensureExtensionEnabled(entry);
          await this.runtime.agentEnqueue(entry.ext.name, request, () => this.activeToolFactories);
        },
      },
      lifecycle: {
        onDeactivate: (cleanup) => {
          cleanupHandlers.push(cleanup);
        },
      },
      log: createExtensionLogger(entry.ext.name),
    };
  }
}

export async function loadExtensions(options: LoadExtensionsOptions): Promise<ExtensionRegistry> {
  const registry = new ExtensionRegistry({
    agentEnqueue: options.agentEnqueue,
  });

  for (const configuredName of options.extensionNames) {
    let registeredName: string | null = null;

    try {
      const extensionDir = resolve(options.workspaceDir, "extensions", configuredName);

      // Import the directory directly; Bun will resolve index.ts or index.js automatically.
      const mod = await import(extensionDir);
      const ext = mod.default;

      if (!isNitoriExtension(ext)) {
        throw new Error(`Extension '${configuredName}' must default export an object with name, version, and activate()`);
      }

      registry._addEntry({
        ext,
        extensionDir,
        workspaceDir: options.workspaceDir,
        messageHandler: options.messageHandler,
        adapters: [],
        toolFactories: [],
        cleanupHandlers: [],
        enabled: false,
      });

      registeredName = ext.name;
      await registry.enable(ext.name);
      console.log(`[extension] loaded: ${ext.name} v${ext.version}`);
    } catch (error) {
      if (registeredName) {
        registry._deleteEntry(registeredName);
      }
      console.error(`[extension] failed to load '${configuredName}'`, error);
    }
  }

  return registry;
}
