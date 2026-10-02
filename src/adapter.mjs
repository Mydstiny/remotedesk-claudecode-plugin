export { ClaudeAdapter } from "./claude-adapter.mjs";

// App/client exposure remains gated until the pinned CLI/SDK contract has been
// accepted with a real account, approval round-trip, restart and device matrix.
export const capabilities = Object.freeze({
  verified: false,
  reason: "CLAUDE_PROTOCOL_ACCEPTANCE_REQUIRED",
  sessions: true,
  approvals: true,
  questions: true,
  attachments: ["text/plain", "image/png", "image/jpeg"],
  background: false,
  cancellation: true,
});
