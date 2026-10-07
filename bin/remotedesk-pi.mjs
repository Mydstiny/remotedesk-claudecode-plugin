#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { main } from "../packages/bridge-core/lib/cli.mjs";
import { Bridge } from "../packages/bridge-core/lib/server.mjs";
import { doctor } from "../src/doctor.mjs";
import { PiAdapter } from "../src/pi-adapter.mjs";
import { runControlPanel } from "../src/control-panel.mjs";

const entry = fileURLToPath(import.meta.url);
await main({
  engine: "pi",
  defaultPort: 9445,
  entry,
  doctor,
  serve: async (directory) => {
    const adapter = new PiAdapter({ env: process.env });
    const bridge = new Bridge(directory, adapter);
    let stopping;
    const stop = () => (stopping ??= (async () => {
      try {
        await bridge.stop();
      } catch (error) {
        console.error(JSON.stringify({ error: "ENGINE_CLEANUP_UNCONFIRMED", detail: String(error?.code ?? error?.message ?? error).slice(0, 200) }));
        process.exitCode = 2;
      }
    })());
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await bridge.start();
      console.log(JSON.stringify({ ready: true, engine: "pi", protocol: 1 }));
    } catch (error) {
      await stop();
      throw error;
    }
  },
  extra: async (command, state, _config, options) => {
    if (command !== "panel") return false;
    await runControlPanel(state, { engine: "pi", port: options.port === undefined ? undefined : Number(options.port) });
    return true;
  },
});
