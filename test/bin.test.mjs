import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the service keeps its stop listeners so signal-exit in Pi's dependencies cannot kill it mid-stop", async () => {
  const bin = await readFile(new URL("../bin/remotedesk-pi.mjs", import.meta.url), "utf8");
  assert.match(bin, /process\.on\("SIGTERM", stopAndExit\)/);
  assert.match(bin, /process\.on\("SIGINT", stopAndExit\)/);
  assert.doesNotMatch(bin, /process\.once\("SIG/);
  assert.match(bin, /engine: "pi",\n  defaultPort: 9445/);
});
