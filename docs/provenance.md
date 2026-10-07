# Provenance

- Pi coding agent: installed by the user (`@earendil-works/pi-coding-agent`, MIT). It is located at run time and never redistributed.
- RemoteDesk host bridge: the vendored `packages/bridge-core` is the same protocol implementation the Codex and DSH plugins use. This copy matches the Codex plugin's 0.3.0 tree and adds the `pi` engine.
- Pairing QR: `src/vendor/qrcode-generator-2.0.4.cjs` (MIT).
- Tests use fakes of the Pi SDK and never start a model turn.
