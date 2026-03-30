import { loadConfig, ensureWorkspaceLayout } from "./config/index.ts";
import { runDaemon } from "./agent/daemon.ts";

const config = loadConfig();

dispatchCli().catch((err) => {
  console.error("Failed to run Nitori", err);
  process.exit(1);
});

async function dispatchCli() {
  const [cmd, ..._args] = process.argv.slice(2);

  if (cmd === "onboard") {
    ensureWorkspaceLayout(config.workspaceDir);
    console.log(`[nitori] workspace initialized: ${config.workspaceDir}`);
    return;
  }

  await runDaemon(config, { cliMode: cmd === "chat" });
}

