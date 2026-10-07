import { test } from "node:test";
import assert from "node:assert/strict";
import { historyEvents, lastUsage, supportedThinkingLevels, tokenUsageEvent, toolView, usageOf } from "../src/pi-events.mjs";

test("Pi tools read as the tools the app already shows", () => {
  assert.deepEqual(toolView("read", { path: "a.ts", offset: 3 }), { name: "Read", input: { file_path: "a.ts", offset: 3 } });
  assert.deepEqual(toolView("bash", { command: "ls" }), { name: "Bash", input: { command: "ls" } });
  assert.deepEqual(toolView("edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }),
    { name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } });
  assert.deepEqual(toolView("edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }, { oldText: "p", newText: "q" }] }),
    { name: "MultiEdit", input: { file_path: "a.ts", edits: [{ old_string: "x", new_string: "y" }, { old_string: "p", new_string: "q" }] } });
  assert.deepEqual(toolView("write", { path: "b.md", content: "hi" }), { name: "Write", input: { file_path: "b.md", content: "hi" } });
  assert.equal(toolView("find", { pattern: "*.ts" }).name, "Glob");
  assert.equal(toolView("grep", { pattern: "x" }).name, "Grep");
  assert.equal(toolView("ls", {}).name, "LS");
  assert.equal(toolView("custom", null).name, "custom");
});

test("a stored session becomes turns of user, reply, tool and result events", () => {
  const entries = [
    { type: "message", id: "sys", message: { role: "system", content: "" } },
    { type: "model_change", id: "m" },
    { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "看看 a.ts" }, { type: "image", data: "AAAA", mimeType: "image/png" }] } },
    { type: "message", id: "a1", message: { role: "assistant", stopReason: "toolUse", usage: { input: 100, cacheRead: 50, output: 10 },
      content: [{ type: "thinking", thinking: "先读文件" }, { type: "text", text: "我先读一下" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }] } },
    { type: "message", id: "r1", message: { role: "toolResult", toolCallId: "c1", toolName: "read", isError: false, content: [{ type: "text", text: "export {}" }] } },
    { type: "message", id: "a2", message: { role: "assistant", stopReason: "error", errorMessage: "rate limited", usage: {}, content: [] } },
    { type: "compaction", id: "k", tokensBefore: 9000 },
  ];
  const events = historyEvents(entries);
  assert.deepEqual(events.map((e) => e.type), ["user/message", "assistant/message", "user/message", "turn/end", "session/compacted"]);
  assert.ok(events.every((e, i) => e.seq === i && e.turn === "u1"));
  assert.deepEqual(events[0].data.message.content, [{ type: "text", text: "看看 a.ts" }, { type: "image" }], "image bytes stay on the computer");
  assert.deepEqual(events[1].data.message.content[2], { type: "tool_use", id: "c1", name: "Read", input: { file_path: "a.ts" } });
  assert.equal(events[1].data.message.content[0].thinking, "先读文件");
  assert.deepEqual(events[2].data.message.content[0], { type: "tool_result", tool_use_id: "c1", content: "export {}", is_error: false });
  assert.deepEqual(events[3].data, { status: "failed", result: "rate limited" });
});

test("long tool output is clipped and the last usable reply gives the context in use", () => {
  const events = historyEvents([
    { type: "message", id: "u", message: { role: "user", content: "run" } },
    { type: "message", id: "r", message: { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: "x".repeat(20000) }] } },
  ]);
  assert.ok(events[1].data.message.content[0].content.length < 16100);
  const usage = { input: 1000, cacheRead: 500, cacheWrite: 0, output: 200 };
  assert.deepEqual(usageOf(usage), { inputTokens: 1500, outputTokens: 200, contextTokens: 1700 });
  assert.deepEqual(tokenUsageEvent(usage, 272000).tokenUsage, { last: { totalTokens: 1700, inputTokens: 1500, outputTokens: 200 }, modelContextWindow: 272000 });
  const entries = [
    { type: "message", message: { role: "assistant", usage, stopReason: "stop" } },
    { type: "message", message: { role: "assistant", usage: { input: 1 }, stopReason: "aborted" } },
  ];
  assert.equal(lastUsage(entries), usage);
  assert.equal(lastUsage([...entries, { type: "compaction" }]), null, "after a compaction the old usage no longer applies");
});

test("thinking levels follow Pi's per-model map", () => {
  assert.deepEqual(supportedThinkingLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(supportedThinkingLevels({ reasoning: true }), ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } }),
    ["minimal", "low", "medium", "high", "xhigh", "max"]);
});
