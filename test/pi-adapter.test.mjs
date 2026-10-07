import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter, foreignLease } from "../src/pi-adapter.mjs";
import { READ_TOOLS } from "../src/pi-events.mjs";

const MODEL = { provider: "openai-codex", id: "gpt-test", name: "GPT Test", reasoning: true, input: ["text", "image"], contextWindow: 272000 };

/** A stand-in for the Pi SDK: one scripted reply per prompt, and the inline extensions it was given. */
function fakeSdk({ script = async () => {}, sessions = [], files = {} } = {}) {
  const sdk = { created: [] };
  const manager = (file, entries = []) => ({ file, getBranch: () => entries, buildSessionContext: () => ({ model: null, thinkingLevel: "medium" }), appendSessionInfo() {} });
  sdk.SessionManager = {
    create: (cwd) => manager(join(cwd, "new.jsonl")),
    open: (file) => manager(file, files[file] ?? []),
    findById: (cwd, id) => Object.keys(files).find((file) => file.includes(id)),
    list: async (cwd) => sessions.filter((info) => info.cwd === cwd),
    listAll: async () => sessions,
  };
  sdk.ModelRuntime = {
    create: async () => ({
      getAvailable: async () => [MODEL],
      getAvailableSnapshot: () => [MODEL],
      getAllModels: () => [MODEL],
      getModel: (provider, id) => (provider === MODEL.provider && id === MODEL.id ? MODEL : undefined),
    }),
  };
  sdk.getAgentDir = () => "/nonexistent/.pi/agent";
  sdk.SettingsManager = { create: () => ({ getDefaultProvider: () => undefined, getDefaultModel: () => undefined, getDefaultThinkingLevel: () => undefined }) };
  sdk.DefaultResourceLoader = class {
    constructor(options) { this.options = options; }
    async reload() {}
  };
  sdk.createAgentSession = async (options) => {
    const handlers = {};
    for (const factory of options.resourceLoader.options.extensionFactories) factory({ on: (type, fn) => { handlers[type] = fn; } });
    const listeners = new Set();
    const agent = {
      options,
      handlers,
      sessionId: "pi-session-1",
      sessionFile: options.sessionManager.file,
      model: options.model ?? MODEL,
      thinkingLevel: options.thinkingLevel ?? "medium",
      tools: options.tools,
      modelRuntime: options.modelRuntime,
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      emit: (event) => { for (const fn of listeners) fn(event); },
      prompt: async (text) => script(agent, text),
      steer: async () => "queued",
      abort: async () => {},
      setModel: async (model) => { agent.model = model; },
      setThinkingLevel: (level) => { agent.thinkingLevel = level; },
      setActiveToolsByName: (names) => { agent.tools = names; },
      setSessionName: (name) => { agent.name = name; },
      getContextUsage: () => ({ tokens: 1234 }),
      compact: async () => {},
      dispose: () => {},
    };
    sdk.created.push(agent);
    return { session: agent };
  };
  return sdk;
}

function harness(sdk, answer = { decision: "accept" }) {
  const events = [];
  const asks = [];
  const project = { id: "p", path: "/work/p", roots: ["/work/p"] };
  const adapter = new PiAdapter({ env: {}, load: async () => ({ sdk, version: "1.0.4", directory: "/fake" }) });
  adapter.bind({
    projects: [project],
    emit: (_id, event) => events.push(event),
    ask: async (_id, request) => { asks.push(request); return answer; },
    storage: { put() {}, delete() {} },
    checkpoint() {},
  });
  return { adapter, events, asks, project };
}

async function gateResult(mode, toolName, answer) {
  const sdk = fakeSdk();
  const { adapter, asks, project } = harness(sdk, answer);
  const session = { id: "s", project: "p", title: "t", permissionMode: mode };
  await adapter.create(session, project);
  const agent = sdk.created[0];
  adapter.newRun(adapter.handles.get("s"), () => {});
  const result = await agent.handlers.tool_call({ toolName, toolCallId: "c1", input: toolName === "bash" ? { command: "rm -rf build" } : { path: "a.ts", content: "x", edits: [{ oldText: "a", newText: "b" }] } });
  return { result, asks, agent };
}

test("read-only gives the model only the read tools and blocks the rest without asking", async () => {
  const { result, asks, agent } = await gateResult("read-only", "bash");
  assert.deepEqual(agent.tools, [...READ_TOOLS]);
  assert.equal(result.block, true);
  assert.match(result.reason, /只读模式/);
  assert.equal(asks.length, 0);
  assert.equal((await gateResult("read-only", "read")).result, undefined);
});

test("ask routes commands and file changes to the phone; reads run directly", async () => {
  const accepted = await gateResult("ask", "bash", { decision: "accept" });
  assert.equal(accepted.result, undefined);
  assert.equal(accepted.asks[0].kind, "command");
  assert.equal(accepted.asks[0].engine, "pi");
  assert.equal(accepted.asks[0].command, "rm -rf build");
  const edit = await gateResult("ask", "edit", { decision: "accept" });
  assert.deepEqual([edit.asks[0].kind, edit.asks[0].tool, edit.asks[0].input.old_string], ["fileChange", "Edit", "a"]);
  assert.equal(edit.asks[0].nativeItemComplete, true, "the whole edit is in the request");
  const declined = await gateResult("ask", "write", { decision: "decline" });
  assert.equal(declined.result.block, true);
  const grep = await gateResult("ask", "grep");
  assert.equal(grep.result, undefined);
  assert.equal(grep.asks.length, 0);
  assert.ok(grep.agent.tools.includes("bash"));
});

test("full access runs everything without asking", async () => {
  const { result, asks } = await gateResult("full-access", "bash");
  assert.equal(result, undefined);
  assert.equal(asks.length, 0);
});

test("a turn streams batched text, the reply, tool steps, usage and its end", async () => {
  const sdk = fakeSdk({
    script: async (agent) => {
      agent.emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
      agent.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
      agent.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } });
      agent.emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", usage: { input: 10, output: 5 },
        content: [{ type: "text", text: "Hello" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } });
      agent.emit({ type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "a\nb" }] } });
      agent.emit({ type: "agent_settled" });
    },
  });
  const { adapter, events, project } = harness(sdk);
  const session = { id: "s", project: "p", title: "新会话" };
  await adapter.create(session, project);
  assert.equal(sdk.created[0].name, undefined, "a placeholder title is not written to Pi");
  const { turnId } = await adapter.start(session, "hi");
  await adapter.handles.get("s").run?.done;
  assert.deepEqual(events.map((e) => e.type), ["turn/start", "user/message", "assistant/chunk", "assistant/message", "tool/call", "tokenUsage", "user/message", "turn/end", "execution.idle"]);
  assert.ok(events.every((e) => e.turn === turnId));
  assert.equal(events[2].data.chunk.text, "Hello", "deltas are batched into one chunk");
  assert.deepEqual(events[4].data, { id: "c1", name: "Bash", input: { command: "ls" } });
  assert.equal(events[5].data.tokenUsage.modelContextWindow, 272000);
  assert.deepEqual(events[7].data, { status: "completed", result: "" });
  assert.equal(session.upstream, "pi-session-1");
  assert.equal(session.title, "hi", "an untitled conversation is named after its first prompt");
  assert.equal(sdk.created[0].name, "hi");
  assert.equal(session.permissionMode, "read-only", "new sessions start read-only");
  const snapshot = await adapter.read(session);
  assert.equal(snapshot.status, "idle");
  assert.equal(snapshot.events.length, events.length);
  assert.equal(snapshot.nativeState.tokenUsage.last.totalTokens, 1234);
});

test("a prompt that fails ends the turn as failed with the reason", async () => {
  const sdk = fakeSdk({ script: async () => { throw new Error("No API key for openai-codex"); } });
  const { adapter, events, project } = harness(sdk);
  const session = { id: "s", project: "p", title: "t" };
  await adapter.create(session, project);
  await adapter.start(session, "hi");
  await new Promise((resolve) => setImmediate(resolve));
  const end = events.find((e) => e.type === "turn/end");
  assert.equal(end.data.status, "failed");
  assert.match(end.data.result, /No API key/);
  assert.equal(events.at(-1).type, "execution.idle", "the project lock is released whatever the outcome");
});

test("settings switch the model, thinking level and tools in place", async () => {
  const sdk = fakeSdk();
  const { adapter, project } = harness(sdk);
  const session = { id: "s", project: "p", title: "t" };
  await adapter.create(session, project);
  const result = await adapter.update(session, { model: "openai-codex/gpt-test", reasoningEffort: "high", permissionMode: "ask", title: "新标题" });
  assert.deepEqual([result.model, result.reasoningEffort, result.permissionMode, result.title], ["openai-codex/gpt-test", "high", "ask", "新标题"]);
  assert.ok(sdk.created[0].tools.includes("edit"));
  assert.equal(sdk.created[0].name, "新标题");
  await assert.rejects(adapter.update(session, { model: "nope/none" }), { code: "MODEL_UNAVAILABLE" });
  assert.throws(() => adapter.validateSettings({ permissionMode: "workspace-write" }), { code: "PERMISSION_MODE_INVALID" });
  assert.throws(() => adapter.validateSettings({ reasoningEffort: "ultra" }), { code: "REASONING_EFFORT_INVALID" });
  adapter.validateAnswer({ kind: "command" }, { decision: "accept" });
  assert.throws(() => adapter.validateAnswer({ kind: "command" }, { decision: "always" }));
});

test("conversations Pi or pi-gui holds are listed per project, with the app's workspaces as projects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "remotedesk-pi-app-"));
  try {
    await writeFile(join(dir, "catalogs.json"), JSON.stringify({ workspaces: [{ path: "/work/gui", displayName: "Gui 工作区" }] }));
    const sessions = [
      { id: "a", cwd: "/work/p", name: "修复登录", firstMessage: "x", messageCount: 4, modified: new Date(2000) },
      { id: "b", cwd: "/work/p", name: "New thread", firstMessage: "\n  第一行\n第二行", messageCount: 2, modified: new Date(3000) },
      { id: "c", cwd: "/work/p", name: "", firstMessage: "", messageCount: 0, modified: new Date(4000) },
      { id: "d", cwd: "/work/other", name: "", firstMessage: "hi", messageCount: 1, modified: new Date(1000) },
    ];
    const sdk = fakeSdk({ sessions });
    const { adapter, project } = harness(sdk);
    adapter.env = { REMOTEDESK_PI_APP_DATA: dir };
    const rows = await adapter.nativeSessions(project);
    assert.deepEqual(rows.map((row) => [row.upstream, row.title]), [["b", "第一行"], ["a", "修复登录"]]);
    assert.equal(rows[0].updatedAt, 3000);
    const projects = await adapter.nativeProjects();
    assert.deepEqual(projects.map((row) => [row.key, row.title]), [["pi:/work/gui", "Gui 工作区"], ["pi:/work/p", "p"], ["pi:/work/other", "other"]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a conversation another Pi surface has open can be read but not continued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "remotedesk-pi-lease-"));
  try {
    const file = join(dir, "s.jsonl");
    await writeFile(file, "");
    await writeFile(file + ".lease", JSON.stringify({ pid: process.ppid, hostname: hostname(), surface: "pi-gui" }));
    assert.equal((await foreignLease(file)).surface, "pi-gui");
    const sdk = fakeSdk({ files: { [file]: [{ type: "message", id: "u", message: { role: "user", content: "hi" } }] } });
    const { adapter, project } = harness(sdk);
    const session = { id: "s", project: "p", upstream: "s.jsonl", piFile: file };
    assert.equal((await adapter.read(session)).events[0].type, "user/message");
    await adapter.resume(session);
    await assert.rejects(adapter.start(session, "hi"), { code: "PI_SESSION_OPEN_IN_APP" });
    await writeFile(file + ".lease", JSON.stringify({ pid: 2 ** 31 - 2, hostname: hostname() }));
    assert.equal(await foreignLease(file), null, "a lease of a process that is gone does not count");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
