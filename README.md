# RemoteDesk Claude Code Plugin

This is the first compatibility-gated skeleton for a future RemoteDesk Claude Code host bridge. It currently verifies the installed Claude Code CLI and records the protocol work that must be completed before remote access is enabled.

The current release is **probe-only**. It does not open a network listener, start a model turn, expose project files, or claim DSH/Codex feature parity.

## Probe

```sh
node bin/remotedesk-claudecode.mjs doctor --json
node bin/remotedesk-claudecode.mjs probe --json
```

The probe accepts Claude Code **2.1.286** only. It checks `claude --version` and the supported non-interactive flags without reading account/session stores.

See [the compatibility boundary](docs/compatibility.md) and [the roadmap](docs/roadmap.md).
