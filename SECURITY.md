# Security boundary

The preview host bridge listens with mutual TLS for paired RemoteDesk clients, and its control panel binds only to 127.0.0.1 with a per-launch token. It exposes only explicitly added project directories.

Authentication uses an Anthropic API key only. The key is kept in the state directory with mode 0600 or supplied through `ANTHROPIC_API_KEY`; it is never printed, returned by the panel API or written to logs, and status shows only its last four characters. The bridge never reads Claude account stores or OAuth tokens: they are removed from the Claude Code environment, and a session whose reported credential is not an API key is ended.

Unknown events, version drift and missing credentials fail closed. Report vulnerabilities privately to the repository owner rather than in public issues.
