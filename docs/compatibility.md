# Compatibility

- Pi: `@earendil-works/pi-coding-agent` 1.0 or newer, installed by the user (tested with 1.0.4). The plugin imports its public SDK (`createAgentSession`, `SessionManager`, `ModelRuntime`, `DefaultResourceLoader`, `SettingsManager`, `getAgentDir`).
- Node.js 22.16 or newer (tested with 26.4.0 on darwin-arm64).
- pi-gui: optional. Its workspace list (`catalogs.json` in the app data folder) adds projects, and its session leases keep the phone from writing to a conversation pi-gui has open.
- Protocol: RemoteDesk host bridge protocol 1, shared with the Codex and DSH plugins. The engine id is `pi`; the bridge listens on 9445 and the control panel on 127.0.0.1:9545 by default.

Accepted on the host (2026-10-07) with a real model, using a stand-in for the bridge core:

- read-only turns, where the model has no write tools;
- ask turns, where an edit and a command were each approved and a command was declined;
- cancelling a running bash call, followed by another turn;
- reading history, the model list and the native projects and sessions.

Still pending: device acceptance with the HarmonyOS client.
