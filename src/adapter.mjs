import { inspectClaude } from "./claude-cli.mjs";

export const capabilities = Object.freeze({
  verified: false,
  reason: "UNVERIFIED_CLAUDE_PROTOCOL",
  sessions: false,
  approvals: false,
  attachments: false,
  background: false,
  cancellation: false,
});

export class ClaudeAdapter {
  constructor({ executable = "claude" } = {}) { this.executable = executable; }
  async doctor() { return inspectClaude(this.executable); }
  async start() { throw new Error("UNVERIFIED_CLAUDE_PROTOCOL"); }
  async write() { throw new Error("UNVERIFIED_CLAUDE_PROTOCOL"); }
  async read() { throw new Error("UNVERIFIED_CLAUDE_PROTOCOL"); }
}
