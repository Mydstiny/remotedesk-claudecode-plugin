# Security boundary

This initial package only probes the locally installed Claude Code CLI. It does not open a listener, mint pairing invitations, expose a project, read Claude session stores, or forward credentials.

The full RemoteDesk host bridge remains blocked until the Claude Code stream-json event contract, permission prompts, session identity and cancellation semantics are pinned and independently tested. Any unknown event or version drift fails closed.
