#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { main } from "../packages/bridge-core/lib/cli.mjs";
import { Bridge } from "../packages/bridge-core/lib/server.mjs";
import { doctor } from "../src/doctor.mjs";
import { ClaudeAdapter } from "../src/claude-adapter.mjs";
import { runControlPanel } from "../src/control-panel.mjs";
import { apiKeyCommand } from "../src/api-key.mjs";
import { privateDirectory } from "../packages/bridge-core/lib/privacy.mjs";

const entry = fileURLToPath(import.meta.url);
await main({
  engine: "claudecode",
  defaultPort: 9445,
  entry,
  doctor,
  serve: async (directory) => {
    const adapter = new ClaudeAdapter({
      state: directory,
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || join(directory, "claude-home"),
      },
    });
    const bridge = new Bridge(directory, adapter);
    let stopping;
    const stop = () => (stopping ??= (async () => {
      try { await bridge.stop(); } catch { process.exitCode = 2; }
    })());
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await bridge.start();
      console.log(JSON.stringify({ ready: true, engine: "claudecode", protocol: 1 }));
    } catch (error) {
      await stop();
      throw error;
    }
  },
  extra: async (command, state, _config, options) => {
    if (command === "api-key") {
      await privateDirectory(state);
      console.log(JSON.stringify(await apiKeyCommand(state, options.action), null, 2));
      return true;
    }
    if (command !== "panel") return false;
    await runControlPanel(state, { engine: "claudecode", port: options.port === undefined ? undefined : Number(options.port) });
    return true;
  },
});
