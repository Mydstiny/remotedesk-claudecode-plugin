import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectClaude, parseStreamLine, printArgs, SUPPORTED_VERSION } from "../src/claude-cli.mjs";

test("probe accepts only the pinned Claude CLI contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "remotedesk-claude-probe-"));
  const fake = join(root, "claude");
  await writeFile(fake, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo '" + SUPPORTED_VERSION + "'; exit 0; fi\nprintf '%s\\n' '--print --input-format --output-format --permission-mode'\n");
  await chmod(fake, 0o700);
  try {
    const result = await inspectClaude(fake);
    assert.equal(result.supported, true);
    assert.equal(result.parity, "UNVERIFIED_CLAUDE_PROTOCOL");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("print mode is fail-closed and never enables permissions", () => {
  const args = printArgs("hello", { cwd: "/tmp/work" });
  assert.deepEqual(args.slice(0, 12), ["--print", "--input-format", "text", "--output-format", "stream-json", "--no-session-persistence", "--no-chrome", "--permission-mode", "dontAsk", "--permission-prompts", "none", "hello"].slice(0, 12));
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
});

test("stream parser rejects non-JSON and accepts bounded event objects", () => {
  assert.deepEqual(parseStreamLine('{"type":"result","subtype":"success"}'), { type: "result", subtype: "success" });
  assert.throws(() => parseStreamLine("not-json"), /CLAUDE_STREAM_INVALID/);
});
