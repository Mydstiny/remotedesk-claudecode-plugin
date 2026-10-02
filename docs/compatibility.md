# Compatibility boundary

The local machine has Claude Code 2.1.286 installed. The CLI exposes `--print`, `--input-format`, `--output-format stream-json`, permission modes and session controls, but the RemoteDesk plugin has not yet pinned the event schema or lifecycle mapping needed for a host bridge.

The probe therefore reports `UNVERIFIED_CLAUDE_PROTOCOL` even when the executable version is correct. DSH/Codex parity requires, at minimum:

- exact stream-json input/output event fixtures;
- session create/read/resume/archive and cancellation mapping;
- permission prompt forwarding with fail-closed unknown events;
- mTLS pairing and project authorization through the shared protocol;
- restart/unknown-operation recovery and a real client acceptance matrix.
