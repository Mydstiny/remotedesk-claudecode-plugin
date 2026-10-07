# Maintainer instructions

This repository is the RemoteDesk Pi plugin (engine id `pi`). The HarmonyOS application code lives in Mydstiny/RemoteDeskHarmonyOS.

- Drive the user's own Pi through its public SDK. Never vendor, patch or redistribute Pi.
- Never read or print Pi credentials (`auth.json`) or tokens. Model availability goes through `ModelRuntime` only.
- Keep the three permission modes fail-closed:
  - read-only gives the model only the read tools;
  - ask routes every non-read tool through `core.ask`;
  - a failed or expired approval blocks the call.
- Do not load user or project Pi extensions in remote sessions (`noExtensions: true`). Only the inline approval gate is loaded.
- Respect live leases another Pi surface holds on a session file (`PI_SESSION_OPEN_IN_APP`).
- Events must stay in the format documented in docs/protocol.md, because the app parses them.
- Tests must not start a model turn. Real-turn acceptance is manual and recorded in docs/compatibility.md.
- Every task branch needs these before merging:
  - npm test;
  - node syntax checks;
  - npm pack --dry-run --ignore-scripts;
  - a PR.
