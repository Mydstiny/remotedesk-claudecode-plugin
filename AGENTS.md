# Maintainer instructions

This repository is the RemoteDesk Claude Code plugin. HarmonyOS application code belongs in Mydstiny/RemoteDeskHarmonyOS.

- Keep the CLI version exact and fail closed on drift.
- Do not read or print Claude account/session stores, API keys, OAuth tokens or transcripts.
- Do not claim DSH/Codex protocol parity until a pinned Claude Code stream contract, approval boundary, session persistence mapping, mTLS host bridge and native client acceptance are independently verified.
- A CLI probe may inspect `claude --version` and `claude --help`; it must not start a model turn during tests.
- Every task branch needs npm test, node syntax checks, npm pack --dry-run --ignore-scripts and a PR before merge.
