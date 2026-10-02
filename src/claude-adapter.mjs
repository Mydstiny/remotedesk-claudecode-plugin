import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { inspectClaude } from "./claude-cli.mjs";
import { Fault, requireThat, string } from "../packages/bridge-core/lib/errors.mjs";

const exec = promisify(execFile);
const SDK_VERSION = "0.3.286";
const MAX_HISTORY_EVENTS = 4000;

class AsyncQueue {
  constructor() {
    this.values = [];
    this.waiters = [];
    this.closed = false;
  }
  push(value) {
    if (this.closed) throw new Fault("CLAUDE_SESSION_CLOSED");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  async next() {
    if (this.values.length) return { value: this.values.shift(), done: false };
    if (this.closed) return { value: undefined, done: true };
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  [Symbol.asyncIterator]() { return this; }
}

function textOf(value, depth = 0) {
  if (value === null || value === undefined || depth > 8) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => textOf(item, depth + 1)).filter(Boolean).join("\n");
  if (typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (value.content !== undefined) return textOf(value.content, depth + 1);
  if (value.message !== undefined) return textOf(value.message, depth + 1);
  return "";
}

function messageContent(message) {
  return message?.message?.content ?? message?.content ?? "";
}

function inputBlocks(text, attachments) {
  const blocks = [{ type: "text", text }];
  for (const attachment of attachments ?? []) {
    if (attachment.mime === "text/plain") {
      blocks.push({ type: "text", text: Buffer.from(attachment.data, "base64").toString("utf8") });
    } else if (attachment.mime === "image/png" || attachment.mime === "image/jpeg") {
      blocks.push({ type: "image", source: { type: "base64", media_type: attachment.mime, data: attachment.data } });
    }
  }
  return blocks;
}

/**
 * Claude Agent SDK host adapter. The bridge protocol and mTLS layer are shared
 * with Codex/DSH; only the local engine lifecycle is implemented here.
 */
export class ClaudeAdapter {
  capabilities = {
    sessions: true,
    turns: true,
    steer: true,
    cancel: true,
    approvals: true,
    questions: true,
    diffs: true,
    files: "claude-native-tools",
    models: true,
    rename: true,
    fork: true,
    compact: true,
    terminalManagement: false,
    attachments: ["text/plain", "image/png", "image/jpeg"],
    execution: "claude-agent-sdk",
    permissionModes: ["read-only", "workspace-write", "plan"],
    approvalDecisions: ["accept", "decline", "cancel"],
    outsideSandboxApproval: false,
    extensions: false,
    delegation: false,
    processScope: "claude-agent-sdk-query",
  };

  constructor({ command, sdk = ClaudeSdk, env } = {}) {
    this.command = command ?? process.env.REMOTEDESK_CLAUDE_EXECUTABLE ?? "claude";
    this.sdk = sdk;
    this.env = env ?? { ...process.env };
    this.handles = new Map();
    this.runs = new Map();
    this.history = new Map();
    this.closed = false;
    this.core = null;
  }

  bind(core) {
    this.core = core;
  }

  async prepare() {
    const report = await inspectClaude(this.command);
    requireThat(report.supported, report.error || "CLAUDE_VERSION_UNVERIFIED");
    const sdkPackage = JSON.parse(await readFile(new URL("../node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url), "utf8"));
    requireThat(sdkPackage.version === SDK_VERSION, "CLAUDE_SDK_VERSION_UNVERIFIED");
  }

  project(session) {
    const project = this.core.projects.find((entry) => entry.id === session.project);
    requireThat(project, "PROJECT_NOT_FOUND");
    return project;
  }

  validateSettings(value = {}) {
    if (value.model !== undefined) string(value.model, 200);
    if (value.reasoningEffort !== undefined) {
      string(value.reasoningEffort, 20);
      requireThat(["low", "medium", "high", "xhigh", "max"].includes(value.reasoningEffort), "REASONING_EFFORT_INVALID");
    }
    if (value.permissionMode !== undefined)
      requireThat(this.capabilities.permissionModes.includes(value.permissionMode), "PERMISSION_MODE_INVALID");
    return { ...value };
  }

  metadata(session) {
    return Object.fromEntries(["upstream", "model", "reasoningEffort", "permissionMode", "executionProfile"].map((key) => [key, session[key]]));
  }

  mode(session) {
    return session.permissionMode === "read-only" || session.permissionMode === "plan" ? "plan" : "default";
  }

  options(session, project, queue) {
    const options = {
      cwd: project.path,
      pathToClaudeCodeExecutable: this.command,
      permissionMode: this.mode(session),
      permissionPrompts: "host",
      persistSession: true,
      includePartialMessages: true,
      settingSources: ["project", "local"],
      strictMcpConfig: true,
      mcpServers: {},
      tools: { type: "preset", preset: "claude_code" },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        snapshot: true,
        append: "This is a RemoteDesk session for the explicitly authorized project. Keep all work inside the project directory. RemoteDesk forwards tool approvals and questions to the paired client. Do not claim that cancelled work stopped detached processes. MCP servers, extensions and delegation are unavailable.",
      },
      env: {
        ...this.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "remotedesk-claudecode/0.2.0",
      },
      canUseTool: (toolName, input, request) => this.canUseTool(session, toolName, input, request),
      onUserDialog: (request, options_) => this.onUserDialog(session, request, options_),
    };
    if (session.upstream) options.resume = session.upstream;
    else options.sessionId = randomUUID();
    if (session.model) options.model = session.model;
    if (session.reasoningEffort) options.effort = session.reasoningEffort;
    return options;
  }

  async open(session, project = this.project(session), authorize = () => {}) {
    if (this.closed) throw new Fault("ADAPTER_DISPOSED");
    if (this.handles.has(session.id)) return this.handles.get(session.id);
    authorize();
    const queue = new AsyncQueue();
    const query = this.sdk.query({ prompt: queue, options: this.options(session, project, queue) });
    const handle = { session, project, queue, query, history: this.history.get(session.id) ?? [], sequence: 0, initialized: false, consume: null };
    this.handles.set(session.id, handle);
    handle.consume = this.consume(handle);
    try {
      const initialization = await query.initializationResult();
      const upstream = initialization.session_id;
      session.upstream ??= upstream;
      session.model ??= initialization.model;
      session.executionProfile = "claude-sdk-v1";
      session.permissionMode ??= session.permissionMode === "read-only" ? "read-only" : "workspace-write";
      handle.initialized = true;
      this.history.set(session.id, handle.history);
      this.checkpoint(session, { upstream: session.upstream, model: session.model, executionProfile: session.executionProfile, permissionMode: session.permissionMode, nativePhase: "ready" });
      return handle;
    } catch (error) {
      await this.closeHandle(session.id);
      throw new Fault("CLAUDE_INITIALIZATION_FAILED");
    }
  }

  checkpoint(session, patch) {
    Object.assign(session, patch);
    this.core?.checkpoint?.(session, patch);
  }

  async consume(handle) {
    try {
      for await (const message of handle.query) this.message(handle, message);
    } catch (error) {
      if (!this.closed && !handle.queue.closed) this.emit(handle, "error", { code: "CLAUDE_QUERY_FAILED" });
    } finally {
      for (const run of this.runs.values()) {
        if (run.sessionId === handle.session.id) this.finish(handle.session, run, "failed");
      }
    }
  }

  emit(handle, type, data = {}, turn = undefined) {
    const event = {
      seq: handle.sequence++,
      type,
      data,
      ...(turn ? { turn } : {}),
    };
    handle.history.push(event);
    if (handle.history.length > MAX_HISTORY_EVENTS) handle.history.splice(0, handle.history.length - MAX_HISTORY_EVENTS);
    this.core?.emit(handle.session.id, event);
  }

  message(handle, message) {
    const turn = message.user_message_uuid || message.user_message_uuids?.at(-1) || this.runs.get(handle.session.id)?.turnId;
    if (message.type === "system") {
      if (message.subtype === "init") {
        handle.session.model ??= message.model;
        this.emit(handle, "session/ready", { model: message.model, cwd: message.cwd, tools: message.tools ?? [] }, turn);
      } else if (message.subtype === "status" || message.subtype === "session_state_changed") {
        this.emit(handle, "session/status", { subtype: message.subtype, status: message.status ?? message.state }, turn);
      } else if (message.subtype === "compact_boundary") {
        this.emit(handle, "session/compacted", { metadata: message.compact_metadata ?? {} }, turn);
      } else if (message.subtype === "permission_denied") {
        this.emit(handle, "tool/result", { name: message.tool_name, denied: true, message: message.message }, turn);
      }
      return;
    }
    if (message.type === "user") {
      this.emit(handle, "user/message", { message: messageContent(message) }, turn);
      return;
    }
    if (message.type === "stream_event") {
      const event = message.event;
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text)
        this.emit(handle, "assistant/chunk", { chunk: { text: event.delta.text } }, turn);
      return;
    }
    if (message.type === "assistant") {
      for (const block of message.message?.content ?? []) {
        if (block.type === "tool_use") this.emit(handle, "tool/call", { id: block.id, name: block.name, input: block.input }, turn);
        else if (block.type === "text" || block.type === "thinking") this.emit(handle, "assistant/message", { message: textOf(block), kind: block.type }, turn);
      }
      return;
    }
    if (message.type === "result") {
      this.emit(handle, "turn/end", { status: message.is_error ? "failed" : message.terminal_reason === "interrupted" ? "interrupted" : "completed", result: message.result ?? "", cost: message.total_cost_usd }, turn);
      const run = this.runs.get(handle.session.id);
      if (run) this.finish(handle.session, run, message.is_error ? "failed" : message.terminal_reason === "interrupted" ? "interrupted" : "completed");
    }
  }

  async canUseTool(session, toolName, input, options) {
    const run = this.runs.get(session.id);
    if (!run || run.finished) return { behavior: "deny", message: "RemoteDesk turn is no longer active." };
    const kind = toolName === "Bash" ? "command" : ["Edit", "Write", "NotebookEdit"].includes(toolName) ? "fileChange" : toolName === "AskUserQuestion" ? "questions" : "permissions";
    const request = {
      kind,
      engine: "claudecode",
      tool: toolName,
      input,
      title: options?.title,
      description: options?.description,
      toolUseID: options?.toolUseID,
      grantScope: kind === "permissions" ? "turn" : "once",
      requiresExplicitScope: kind === "permissions",
    };
    try {
      const answer = await this.core.ask(session.id, request, options?.signal);
      run.authorize();
      if (kind === "questions") return { behavior: "allow", updatedInput: answer.answers ?? input };
      if (answer.decision === "accept") return { behavior: "allow", updatedInput: input };
      return { behavior: "deny", message: answer.message || "RemoteDesk client declined this action." };
    } catch {
      return { behavior: "deny", message: "RemoteDesk approval expired or was cancelled." };
    }
  }

  async onUserDialog(session, request, options) {
    const run = this.runs.get(session.id);
    if (!run || run.finished) return { behavior: "cancelled" };
    try {
      const answer = await this.core.ask(session.id, { kind: "questions", engine: "claudecode", dialog: request, grantScope: "once" }, options?.signal);
      run.authorize();
      return answer.answers ? { behavior: "submitted", answers: answer.answers } : { behavior: "cancelled" };
    } catch {
      return { behavior: "cancelled" };
    }
  }

  async create(session, project, authorize = () => {}) {
    await this.open(session, project, authorize);
    if (session.title && this.sdk.renameSession && session.upstream)
      await this.sdk.renameSession(session.upstream, session.title, { dir: project.path });
    return this.metadata(session);
  }

  async resume(session, authorize = () => {}) {
    await this.open(session, this.project(session), authorize);
  }

  async start(session, text, attachments = [], settings = {}, authorize = () => {}) {
    if (Object.keys(settings).length) await this.update(session, settings, authorize);
    const handle = await this.open(session, this.project(session), authorize);
    authorize();
    requireThat(!this.runs.has(session.id), "TURN_ALREADY_RUNNING");
    const run = {
      sessionId: session.id,
      turnId: randomUUID(),
      queue: handle.queue,
      controller: new AbortController(),
      authorize,
      finished: false,
      done: null,
    };
    run.done = new Promise((resolve) => { run.resolve = resolve; });
    this.runs.set(session.id, run);
    this.core.storage.put("nativeActivity", session.id, { id: session.id, project: session.project, upstream: session.upstream, started: Date.now(), scope: "claude-agent-sdk-query" });
    this.emit(handle, "turn/start", { id: run.turnId }, run.turnId);
    try {
      handle.queue.push({
        type: "user",
        message: { role: "user", content: inputBlocks(text, attachments) },
        parent_tool_use_id: null,
        uuid: run.turnId,
        session_id: session.upstream,
        client_composed: true,
      });
      return { turnId: run.turnId };
    } catch (error) {
      this.finish(session, run, "failed");
      throw error;
    }
  }

  async steer(session, text) {
    const run = this.runs.get(session.id);
    requireThat(run && !run.finished, "NO_ACTIVE_TURN");
    run.queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: randomUUID(), session_id: session.upstream, client_composed: true });
    return { accepted: true };
  }

  async cancel(session) {
    const run = this.runs.get(session.id);
    if (!run) return;
    run.cancelRequested = true;
    try { await this.handles.get(session.id)?.query.interrupt(); } catch { /* cleanup below remains authoritative */ }
    await Promise.race([run.done, new Promise((resolve) => setTimeout(resolve, 20000))]);
    if (this.runs.has(session.id)) this.finish(session, run, "interrupted");
    this.core.storage.delete("nativeActivity", session.id);
  }

  async update(session, settings, authorize = () => {}) {
    await this.quiescent(session);
    authorize();
    Object.assign(session, settings);
    await this.deactivate(session);
    await this.open(session, this.project(session), authorize);
    return this.metadata(session);
  }

  async fork(session, child, { lastTurnId } = {}, authorize = () => {}) {
    authorize();
    requireThat(this.sdk.forkSession && session.upstream, "CAPABILITY_UNAVAILABLE");
    const result = await this.sdk.forkSession(session.upstream, { dir: this.project(session).path, ...(lastTurnId ? { upToMessageId: lastTurnId } : {}), title: child.title });
    child.upstream = result.sessionId;
    await this.open(child, this.project(child), authorize);
    return this.metadata(child);
  }

  async compact(session, authorize = () => {}) {
    const handle = await this.open(session, this.project(session), authorize);
    const run = await this.start(session, "/compact", [], {}, authorize);
    return { accepted: true, turnId: run.turnId };
  }

  async read(session, { cursor } = {}) {
    const project = this.project(session);
    let events = this.history.get(session.id);
    if (!events || events.length === 0) {
      const messages = session.upstream && this.sdk.getSessionMessages ? await this.sdk.getSessionMessages(session.upstream, { dir: project.path, includeSystemMessages: true }) : [];
      events = this.messagesToHistory(messages);
      this.history.set(session.id, events);
    }
    const start = cursor === undefined || cursor === "" ? 0 : Number(cursor);
    requireThat(Number.isSafeInteger(start) && start >= 0, "CURSOR_INVALID");
    const page = events.slice(start, start + 100);
    return { ...this.metadata(session), status: this.runs.has(session.id) ? "running" : "idle", events: page, nextCursor: start + 100 < events.length ? String(start + 100) : "" };
  }

  async items(session, { turnId, cursor } = {}) {
    string(turnId, 500);
    const snapshot = await this.read(session, { cursor });
    return { data: snapshot.events.filter((event) => !turnId || String(event.turn) === turnId), nextCursor: snapshot.nextCursor || null };
  }

  messagesToHistory(messages) {
    let sequence = 0;
    return messages.map((message) => {
      const type = message.type === "assistant" ? "assistant/message" : message.type === "user" ? "user/message" : "session/status";
      const content = message.type === "system" ? message.message ?? {} : message.message;
      return { seq: sequence++, type, data: { message: content, text: textOf(content) }, turn: message.uuid };
    });
  }

  async models(project) {
    const queue = new AsyncQueue();
    const query = this.sdk.query({ prompt: queue, options: { cwd: project.path, pathToClaudeCodeExecutable: this.command, persistSession: false, settingSources: ["project", "local"], strictMcpConfig: true, mcpServers: {}, permissionMode: "plan", tools: { type: "preset", preset: "claude_code" }, env: this.env } });
    try {
      await query.initializationResult();
      const models = await query.supportedModels();
      return { data: models.map((model) => ({ id: model.value ?? model.id, model: model.value ?? model.id, provider: "anthropic", displayName: model.displayName ?? model.name ?? model.value ?? model.id, inputModalities: ["text", "image"], supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" })), nextCursor: null, source: "claude-agent-sdk", dynamicCatalog: true };
    } finally {
      queue.close();
      query.close();
    }
  }

  async diff(session) {
    try {
      const result = await exec("git", ["-C", this.project(session).path, "diff", "--no-ext-diff", "--binary"], { timeout: 10000, maxBuffer: 4_000_000, windowsHide: true });
      return { diff: result.stdout, scope: "working-tree", available: true };
    } catch {
      return { diff: "", scope: "working-tree", available: false };
    }
  }

  finish(session, run, status) {
    if (!run || run.finished) return;
    run.finished = true;
    this.runs.delete(session.id);
    this.core.storage.delete("nativeActivity", session.id);
    const handle = this.handles.get(session.id);
    if (handle) this.emit(handle, "execution." + (status === "completed" ? "idle" : status), { status }, run.turnId);
    run.resolve?.();
  }

  async quiescent(session) {
    requireThat(!this.runs.has(session.id), "TURN_NOT_QUIESCENT");
  }

  async deactivate(session) {
    await this.cancel(session);
    await this.closeHandle(session.id);
  }

  async closeHandle(id) {
    const handle = this.handles.get(id);
    if (!handle) return;
    this.handles.delete(id);
    handle.queue.close();
    try { handle.query.close(); } catch { /* already closed */ }
    await Promise.race([handle.consume, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.handles.keys()].map((id) => this.closeHandle(id)));
  }
}
