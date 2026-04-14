import { loadConfig, ensureWorkspaceLayout } from "./config/index.ts";
import { runDaemon } from "./agent/daemon.ts";
import { runOAuthLoginCommand } from "./llm/profile.ts";

const config = loadConfig();

dispatchCli().catch((err) => {
  console.error("Failed to run Nitori", err);
  process.exit(1);
});

async function dispatchCli() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "onboard") {
    ensureWorkspaceLayout(config.workspaceDir);
    console.log(`[nitori] workspace initialized: ${config.workspaceDir}`);
    return;
  }

  if (cmd === "oauth" && args[0] === "login") {
    await runOAuthLoginCommand(config, args[1]);
    return;
  }

  await runDaemon(config, { cliMode: cmd === "chat" });
}

