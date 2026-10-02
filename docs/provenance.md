# Provenance

- Claude Code CLI: externally installed `@anthropic-ai/claude-code` 2.1.286. The binary and its dependencies are not redistributed.
- Claude Agent SDK: pinned npm dependency `@anthropic-ai/claude-agent-sdk` 0.3.286, matching the CLI version; its package lock and license metadata are shipped with the plugin.
- RemoteDesk protocol: vendored shared bridge-core source is the same reviewed protocol implementation used by the Codex/DSH plugins.
- Tests use deterministic SDK/query fakes and never invoke a real model turn.
