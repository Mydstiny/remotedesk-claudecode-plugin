# Security boundary

- **Connections**: the host bridge listens with mutual TLS for paired RemoteDesk clients. Its control panel binds only to 127.0.0.1 and uses a per-launch token.
- **Projects**: the bridge exposes only the project folders a device was granted. Granting "all projects" includes pi-gui workspaces and folders with Pi conversations.
- **Remote sessions**: they run the user's own Pi with the permission mode chosen on the phone. Read-only is the default.
  - In ask mode, every command and file change waits for an explicit approval on the paired device. An approval that expires or is cancelled blocks the call.
  - User and project Pi extensions are not loaded, so remote sessions cannot run extension code or tools the phone cannot review.
- **Credentials**: the plugin never reads or prints Pi credentials. Pi resolves them itself.

Report vulnerabilities privately to the repository owner rather than in public issues.
