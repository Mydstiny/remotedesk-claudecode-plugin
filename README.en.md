# RemoteDesk Pi Plugin

Use the [Pi coding agent](https://github.com/earendil-works/pi) on your computer from RemoteDesk on a phone or tablet. The plugin runs your own Pi through its SDK: the same credentials, models and conversations you already have.

- **Conversations**: start new ones, or continue those opened in the Pi terminal or pi-gui. Replies stream as they are written; tool steps, thinking and context usage stream too.
- **Projects**: pi-gui workspaces and folders with Pi conversations appear on their own, next to projects added in the control panel. Pair with "all projects" to reach them.
- **Models**: every model Pi is signed in to, with its thinking levels. New conversations start on the model you last used in Pi.
- **Permissions**: three Codex-style modes, read-only by default.
  - **Read-only**: Pi gets only read, grep, find and ls.
  - **Ask**: reads run directly; every command and file change goes to the phone for approval first.
  - **Full access**: everything runs without asking.
- **More**: steer or cancel a running turn, compact the context, rename a conversation, see the workspace diff, and attach images and text files.

The plugin shares the host bridge (`packages/bridge-core`) with the Codex and DSH plugins: mutual-TLS certificate pairing, access limited to authorized projects, and devices you can revoke at any time.

## Requirements

- Node.js 22.16 or newer.
- Pi 1.0 or newer (`npm i -g @earendil-works/pi-coding-agent`), signed in to at least one provider: `/login` in Pi, or sign in to pi-gui.
- The plugin looks for Pi in this order:
  1. the `REMOTEDESK_PI_PACKAGE` environment variable;
  2. the package behind the `pi` command;
  3. the global npm root.
- `PI_CODING_AGENT_DIR` overrides Pi's data directory, which defaults to `~/.pi/agent`.

## Using Pi on the computer at the same time

While pi-gui or the Pi terminal has a conversation open, the phone can read it but cannot send to it (error `PI_SESSION_OPEN_IN_APP`), so the two never write to the same session file. Switch to another conversation on the computer, or start a new conversation on the phone.

See [README.md](README.md) for commands, and [docs/protocol.md](docs/protocol.md) for the bridge interface and event format.
