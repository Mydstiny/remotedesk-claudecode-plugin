#!/usr/bin/env node
import { inspectClaude } from "../src/claude-cli.mjs";

const command = process.argv[2] ?? "help";
if (command === "help") {
  console.log("remotedesk-claudecode doctor --json | probe --json");
  process.exit(0);
}
if (command !== "doctor" && command !== "probe") {
  console.error("UNKNOWN_COMMAND");
  process.exit(2);
}
const result = await inspectClaude(process.env.REMOTEDESK_CLAUDE_EXECUTABLE ?? "claude");
const output = command === "doctor"
  ? { ...result, ready: result.supported }
  : { ...result, ready: false, reason: "UNVERIFIED_CLAUDE_PROTOCOL" };
console.log(JSON.stringify(output));
process.exit(command === "doctor" && !result.supported ? 2 : 0);
