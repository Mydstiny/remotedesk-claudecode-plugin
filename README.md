# RemoteDesk Claude Agent Plugin

This package provides the RemoteDesk Claude Agent host bridge preview. It uses the pinned Claude Agent SDK, which drives the locally installed Claude Code CLI, to keep sessions, streaming turns, cancellation, approvals, questions, attachments, history, fork/rename and mTLS pairing behind the same RemoteDesk protocol used by Codex and DSH.

The host bridge is available for controlled preview. App exposure and parity claims remain gated until a real API key turn, approval round-trip, restart/recovery and HarmonyOS client matrix have passed.

## Authentication: Anthropic API key only

Anthropic does not allow third-party products built on the Claude Agent SDK to offer claude.ai login or subscription rate limits unless previously approved ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)). The bridge therefore authenticates with an Anthropic API key and nothing else:

- Set the key in the local control panel, with `api-key --action set` (the key is read from stdin, never from argv), or through `ANTHROPIC_API_KEY` in the service environment.
- The key is stored in `<state>/anthropic-api-key` with mode 0600. Status output and the panel show only its last four characters.
- A session does not start without a key. The Claude Code environment gets this key, OAuth tokens and third-party cloud switches are removed, and a session ends if the SDK reports any credential other than an API key.

## Naming

The plugin is presented as **Claude Agent**, following Anthropic's branding guidelines for Agent SDK products; it is not Claude Code and does not imitate it. `claudecode` stays the internal engine id of the RemoteDesk protocol and of the state directory.

## Commands

```sh
node bin/remotedesk-claudecode.mjs doctor --json
node bin/remotedesk-claudecode.mjs probe --json
node bin/remotedesk-claudecode.mjs init --state "$STATE" --host 127.0.0.1 --hosts localhost,127.0.0.1 --port 9445
node bin/remotedesk-claudecode.mjs api-key --state "$STATE" --action set < key.txt
node bin/remotedesk-claudecode.mjs api-key --state "$STATE" --action status
node bin/remotedesk-claudecode.mjs serve --state "$STATE"
node bin/remotedesk-claudecode.mjs panel --state "$STATE" --port 9545
```

The probe accepts Claude Code CLI **2.1.286** and Agent SDK **0.3.286** only. It checks `claude --version`, stream/permission flags, the installed SDK package and whether an API key is configured, without starting a model turn or printing account, key or session data.

See [the compatibility boundary](docs/compatibility.md) and [the roadmap](docs/roadmap.md).
