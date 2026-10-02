# RemoteDesk Claude Code Plugin

This package provides the RemoteDesk Claude Code host bridge preview. It uses the pinned Claude Agent SDK to keep sessions, streaming turns, cancellation, approvals, questions, attachments, history, fork/rename and mTLS pairing behind the same RemoteDesk protocol used by Codex and DSH.

The host bridge is available for controlled preview. App exposure and parity claims remain gated until a real Claude account, approval round-trip, restart/recovery and HarmonyOS client matrix have passed.

## Probe

```sh
node bin/remotedesk-claudecode.mjs doctor --json
node bin/remotedesk-claudecode.mjs probe --json
node bin/remotedesk-claudecode.mjs init --state "$STATE" --host 127.0.0.1 --hosts localhost,127.0.0.1 --port 9445
node bin/remotedesk-claudecode.mjs serve --state "$STATE"
node bin/remotedesk-claudecode.mjs panel --state "$STATE" --port 9545
```

The probe accepts Claude Code **2.1.286** and Agent SDK **0.3.286** only. It checks `claude --version`, stream/permission flags and the installed SDK package without starting a model turn or printing account/session data.

See [the compatibility boundary](docs/compatibility.md) and [the roadmap](docs/roadmap.md).
