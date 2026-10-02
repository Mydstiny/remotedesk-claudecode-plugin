# Compatibility boundary

The local machine has Claude Code 2.1.286 and the matching Claude Agent SDK 0.3.286 installed. The preview bridge maps the SDK query/control surface into the shared RemoteDesk mTLS protocol; it does not use Claude's cloud-only `--remote-control` session as a transport.

The bridge remains acceptance-gated even when both versions are correct. DSH/Codex parity requires, at minimum:

- pinned SDK query/control fixtures for text, tool, result and interrupt events;
- session create/read/resume/archive and cancellation mapping;
- permission and question forwarding with fail-closed unknown events;
- mTLS pairing and project authorization through the shared protocol;
- restart/unknown-operation recovery and a real client acceptance matrix.

The preview deliberately keeps `appExposure:false` until those checks pass. The host service can be inspected and exercised with a dedicated test project without adding Claude to the HarmonyOS backend picker.
