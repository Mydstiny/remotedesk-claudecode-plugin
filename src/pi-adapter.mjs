import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { Fault, requireThat, string } from "../packages/bridge-core/lib/errors.mjs";
import { validateNativeAnswer } from "../packages/bridge-core/lib/native-answers.mjs";
import { loadPi } from "./pi-runtime.mjs";
import {
  ALL_TOOLS,
  READ_TOOLS,
  THINKING_LEVELS,
  firstLine,
  historyEvents,
  lastUsage,
  modelKey,
  supportedThinkingLevels,
  tokenUsageEvent,
  toolResultBlock,
  toolView,
  userBlocks,
} from "./pi-events.mjs";

const exec = promisify(execFile);
export const PERMISSION_MODES = Object.freeze(["read-only", "ask", "full-access"]);
const MAX_HISTORY_EVENTS = 6000;
const PAGE = 200;
const CHUNK_FLUSH_MS = 120;
const CHUNK_FLUSH_CHARS = 1500;
const UNNAMED = new Set(["", "New thread", "RemoteDesk session", "新会话", "新对话"]);
const REMOTE_PROMPT = [
  "This Pi session is driven from the RemoteDesk app on the user's phone or tablet; the user reads your replies there.",
  "Keep work inside the project folder unless the user asks otherwise.",
  "RemoteDesk has three permission modes: read-only (read, grep, find and ls only), ask (the user approves every command and file change on the phone) and full access.",
  "When a tool call is blocked, say what you wanted to do and that the user can allow it by changing the permission mode in the app; do not retry the same call.",
  "Answer in the language the user writes in.",
].join(" ");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where the pi-gui desktop app keeps its workspace list (catalogs.json). */
export function appDataDirectory(env = process.env, os = platform()) {
  if (env.REMOTEDESK_PI_APP_DATA) return env.REMOTEDESK_PI_APP_DATA;
  if (os === "darwin") return join(homedir(), "Library", "Application Support", "pi");
  if (os === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "pi");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi");
}

/** A live lease another Pi surface (pi-gui, the terminal UI) holds on a session file, or null. */
export async function foreignLease(file) {
  let lease;
  try {
    lease = JSON.parse(await readFile(file + ".lease", "utf8"));
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(lease?.pid) || lease.pid === process.pid) return null;
  if (lease.hostname && lease.hostname !== hostname()) return null;
  try {
    process.kill(lease.pid, 0);
    return lease;
  } catch (error) {
    return error?.code === "EPERM" ? lease : null;
  }
}

function composeInput(text, attachments) {
  const parts = [text];
  const images = [];
  for (const attachment of attachments ?? []) {
    if (attachment.mime === "text/plain") parts.push(Buffer.from(attachment.data, "base64").toString("utf8"));
    else if (attachment.mime === "image/png" || attachment.mime === "image/jpeg")
      images.push({ type: "image", data: attachment.data, mimeType: attachment.mime });
  }
  return { text: parts.join("\n\n"), images };
}

/**
 * Pi coding agent host adapter: runs the user's own Pi (sessions, credentials and models in ~/.pi/agent) through its
 * SDK. The bridge protocol and mTLS layer are shared with Codex/DSH. Permission modes follow Codex: read-only gives
 * the model only the read tools; ask routes every command and file change to the phone; full access allows all.
 */
export class PiAdapter {
  capabilities = {
    sessions: true,
    turns: true,
    steer: true,
    cancel: true,
    approvals: true,
    questions: false,
    diffs: true,
    files: "pi-native-tools",
    models: true,
    rename: true,
    fork: false,
    compact: true,
    terminalManagement: false,
    attachments: ["text/plain", "image/png", "image/jpeg"],
    execution: "pi-sdk",
    permissionModes: [...PERMISSION_MODES],
    approvalDecisions: ["accept", "decline", "cancel"],
    outsideSandboxApproval: false,
    extensions: false,
    delegation: false,
    processScope: "pi-agent-session",
    nativeSessions: true,
    appProjects: true,
  };

  constructor({ env = process.env, load = loadPi } = {}) {
    this.env = env;
    this.load = load;
    this.pi = null;
    this.handles = new Map();
    this.stored = new Map();
    this.closed = false;
    this.core = null;
  }

  bind(core) {
    this.core = core;
  }

  async prepare() {
    this.pi ??= await this.load(this.env);
    return this.pi;
  }

  get sdk() {
    requireThat(this.pi, "PI_NOT_READY");
    return this.pi.sdk;
  }

  /** A fresh model runtime: credentials the user adds in Pi later (pi /login, pi-gui) apply without a restart. */
  async modelRuntime() {
    await this.prepare();
    return this.sdk.ModelRuntime.create();
  }

  project(session) {
    const project = this.core.projects.find((entry) => entry.id === session.project);
    requireThat(project, "PROJECT_NOT_FOUND");
    return project;
  }

  /** The folder the session runs in: its own (an imported conversation may sit in a project's sub-root). */
  cwd(session, project = this.project(session)) {
    const roots = project.roots ?? [project.path];
    return session.cwd && roots.some((root) => session.cwd === root || session.cwd.startsWith(root + "/")) ? session.cwd : project.path;
  }

  validateSettings(value = {}) {
    if (value.model !== undefined) string(value.model, 200);
    if (value.reasoningEffort !== undefined) {
      string(value.reasoningEffort, 20);
      requireThat(THINKING_LEVELS.includes(value.reasoningEffort), "REASONING_EFFORT_INVALID");
    }
    if (value.permissionMode !== undefined) requireThat(PERMISSION_MODES.includes(value.permissionMode), "PERMISSION_MODE_INVALID");
    return { ...value };
  }

  validateAnswer(request, answer) {
    validateNativeAnswer(request, answer);
  }

  metadata(session) {
    return Object.fromEntries(["upstream", "model", "reasoningEffort", "permissionMode", "executionProfile"].map((key) => [key, session[key]]));
  }

  toolsFor(session) {
    return (session.permissionMode ?? "read-only") === "read-only" ? [...READ_TOOLS] : [...ALL_TOOLS];
  }

  findModel(runtime, key) {
    const slash = key.indexOf("/");
    if (slash > 0) return runtime.getModel(key.slice(0, slash), key.slice(slash + 1));
    return runtime.getAvailableSnapshot?.().find((model) => model.id === key) ?? runtime.getAllModels().find((model) => model.id === key);
  }

  sessionFile(session, cwd) {
    if (session.piFile && existsSync(session.piFile)) return session.piFile;
    return session.upstream ? this.sdk.SessionManager.findById(cwd, session.upstream) : undefined;
  }

  checkpoint(session, patch) {
    Object.assign(session, patch);
    this.core?.checkpoint?.(session, patch);
  }

  open(session, project = this.project(session), authorize = () => {}) {
    if (this.closed) return Promise.reject(new Fault("ADAPTER_DISPOSED"));
    const existing = this.handles.get(session.id);
    if (existing) {
      existing.session = session;
      return existing.ready;
    }
    const handle = { session, project, history: [], sequence: 0, run: null, chunk: "", chunkTimer: null, agent: null, unsubscribe: null };
    handle.ready = this.create_(handle, authorize).catch(async (error) => {
      this.handles.delete(session.id);
      handle.unsubscribe?.();
      try { handle.agent?.dispose(); } catch { /* never started */ }
      throw error instanceof Fault ? error : new Fault(error?.code === "PI_NOT_INSTALLED" ? "PI_NOT_INSTALLED" : "PI_INITIALIZATION_FAILED");
    });
    this.handles.set(session.id, handle);
    return handle.ready;
  }

  async create_(handle, authorize) {
    const { session, project } = handle;
    authorize();
    await this.prepare();
    const sdk = this.sdk;
    const cwd = this.cwd(session, project);
    handle.cwd = cwd;
    let manager;
    if (session.upstream) {
      const file = this.sessionFile(session, cwd);
      requireThat(file, "PI_SESSION_NOT_FOUND");
      manager = sdk.SessionManager.open(file);
    } else {
      manager = sdk.SessionManager.create(cwd);
    }
    handle.history = historyEvents(manager.getBranch());
    handle.sequence = handle.history.length;
    const runtime = await this.modelRuntime();
    // A new conversation starts on the model chosen on the phone, else the one the user last used in Pi.
    const key = session.model ?? (session.upstream ? undefined : (await this.preferred(cwd)).model);
    const model = key ? this.findModel(runtime, key) : undefined;
    const loader = new sdk.DefaultResourceLoader({
      cwd,
      agentDir: sdk.getAgentDir(),
      // The user's and the project's Pi extensions run arbitrary code and add tools the phone cannot review.
      noExtensions: true,
      extensionFactories: [(pi) => this.gate(handle, pi)],
      appendSystemPrompt: [REMOTE_PROMPT],
    });
    await loader.reload();
    authorize();
    const { session: agent } = await sdk.createAgentSession({
      cwd,
      modelRuntime: runtime,
      ...(model ? { model } : {}),
      ...(session.reasoningEffort ? { thinkingLevel: session.reasoningEffort } : !session.upstream && !session.model ? await this.preferred(cwd).then((p) => (p.effort ? { thinkingLevel: p.effort } : {})) : {}),
      // Every tool is registered (Pi cannot activate one left out here later); the mode picks the active ones.
      tools: [...ALL_TOOLS],
      resourceLoader: loader,
      sessionManager: manager,
    });
    agent.setActiveToolsByName(this.toolsFor(session));
    handle.agent = agent;
    handle.unsubscribe = agent.subscribe((event) => this.onEvent(handle, event));
    if (!session.upstream && session.title && !UNNAMED.has(session.title)) agent.setSessionName(session.title.slice(0, 200));
    this.checkpoint(session, {
      upstream: session.upstream ?? agent.sessionId,
      piFile: agent.sessionFile,
      cwd,
      model: modelKey(agent.model) ?? session.model,
      reasoningEffort: agent.thinkingLevel,
      permissionMode: session.permissionMode ?? "read-only",
      executionProfile: "pi-sdk-v1",
      nativePhase: "ready",
    });
    this.stored.delete(session.id);
    return handle;
  }

  /** The approval gate: an inline Pi extension that sees every tool call before it runs. */
  gate(handle, pi) {
    pi.on("tool_call", async (event) => {
      const mode = handle.session.permissionMode ?? "read-only";
      if (mode === "full-access" || READ_TOOLS.includes(event.toolName)) return undefined;
      if (mode === "read-only")
        return { block: true, reason: "RemoteDesk 当前是只读模式：不能运行命令或修改文件。需要的话请让用户在手机上切换到「修改前询问」或「完全访问」。" };
      const run = handle.run;
      if (!run || run.finished) return { block: true, reason: "RemoteDesk 的这一轮已经结束。" };
      const view = toolView(event.toolName, event.input);
      const file = event.toolName === "edit" || event.toolName === "write";
      const request = file
        ? { kind: "fileChange", engine: "pi", tool: view.name, input: view.input, toolUseID: event.toolCallId, cwd: handle.cwd, grantScope: "once", nativeItemComplete: true }
        : { kind: "command", engine: "pi", tool: view.name, input: view.input, command: typeof view.input.command === "string" ? view.input.command : view.name + " " + JSON.stringify(view.input), cwd: handle.cwd, toolUseID: event.toolCallId, grantScope: "once" };
      try {
        const answer = await this.core.ask(handle.session.id, request, run.controller.signal);
        run.authorize?.();
        if (answer?.decision === "accept") return undefined;
        if (answer?.decision === "cancel") {
          run.cancelRequested = true;
          void handle.agent?.abort().catch(() => {});
          return { block: true, reason: "用户在 RemoteDesk 上取消了这一轮。" };
        }
        return { block: true, reason: "用户在 RemoteDesk 上拒绝了这一步。换一种做法，或先说明原因再请用户批准。" };
      } catch {
        return { block: true, reason: "审批已过期或被取消，这一步没有执行。" };
      }
    });
  }

  emit(handle, type, data = {}, turn = handle.run?.turnId) {
    if (type !== "assistant/chunk") this.flush(handle);
    const event = { seq: handle.sequence++, type, data, ...(turn ? { turn } : {}) };
    handle.history.push(event);
    if (handle.history.length > MAX_HISTORY_EVENTS) handle.history.splice(0, handle.history.length - MAX_HISTORY_EVENTS);
    this.core?.emit(handle.session.id, event);
  }

  /** Text deltas are batched: one event per ~120 ms keeps the bridge's event log from filling with fragments. */
  chunk(handle, text) {
    handle.chunk += text;
    if (handle.chunk.length >= CHUNK_FLUSH_CHARS) this.flush(handle);
    else handle.chunkTimer ??= setTimeout(() => this.flush(handle), CHUNK_FLUSH_MS);
  }

  flush(handle) {
    if (handle.chunkTimer) clearTimeout(handle.chunkTimer);
    handle.chunkTimer = null;
    if (!handle.chunk) return;
    const text = handle.chunk;
    handle.chunk = "";
    this.emit(handle, "assistant/chunk", { chunk: { text } });
  }

  onEvent(handle, event) {
    try {
      switch (event?.type) {
        case "message_update": {
          const delta = event.assistantMessageEvent;
          if (delta?.type === "text_delta" && delta.delta) this.chunk(handle, delta.delta);
          return;
        }
        case "message_end":
          this.messageEnd(handle, event.message ?? {});
          return;
        case "compaction_end":
          if (event.result && !event.aborted) this.emit(handle, "session/compacted", { reason: event.reason, tokensBefore: event.result.tokensBefore ?? 0 });
          else if (event.errorMessage && handle.run) handle.run.error = event.errorMessage;
          return;
        case "auto_retry_start":
          this.emit(handle, "session/status", { status: "retrying", attempt: event.attempt, maxAttempts: event.maxAttempts });
          return;
        case "session_info_changed":
          if (event.name && !UNNAMED.has(event.name)) this.checkpoint(handle.session, { title: event.name.slice(0, 200) });
          return;
        case "agent_settled":
          if (handle.run) this.settle(handle, handle.run);
          return;
        default:
      }
    } catch (error) {
      process.stderr.write(JSON.stringify({ piEvent: event?.type, error: String(error?.message ?? error).slice(0, 200) }) + "\n");
    }
  }

  messageEnd(handle, message) {
    if (message.role === "user") {
      const content = userBlocks(message.content);
      if (content.length) this.emit(handle, "user/message", { message: { role: "user", content } });
      // A conversation started without a name takes its first prompt's first line, here and in Pi (pi-gui shows it).
      const first = content.find((block) => block.type === "text")?.text;
      if (first && UNNAMED.has(handle.session.title ?? "")) {
        const title = firstLine(first, 40);
        if (title) {
          this.checkpoint(handle.session, { title });
          try { handle.agent?.setSessionName(title); } catch { /* the bridge title still changed */ }
        }
      }
    } else if (message.role === "assistant") {
      for (const block of message.content ?? []) {
        if (block?.type === "thinking" && block.thinking && !block.redacted) this.emit(handle, "assistant/message", { message: block.thinking, kind: "thinking" });
        else if (block?.type === "text" && block.text) this.emit(handle, "assistant/message", { message: block.text, kind: "text" });
        else if (block?.type === "toolCall") {
          const view = toolView(block.name, block.arguments);
          this.emit(handle, "tool/call", { id: block.id, name: view.name, input: view.input });
        }
      }
      if (message.usage && message.stopReason !== "aborted" && message.stopReason !== "error")
        this.emit(handle, "tokenUsage", tokenUsageEvent(message.usage, handle.agent?.model?.contextWindow));
      if (handle.run && message.stopReason === "error") handle.run.error = message.errorMessage || "Pi 回复失败";
      if (handle.run && message.stopReason === "aborted") handle.run.aborted = true;
    } else if (message.role === "toolResult") {
      this.emit(handle, "user/message", { message: { role: "user", content: [toolResultBlock(message)] } });
    }
  }

  newRun(handle, authorize) {
    requireThat(!handle.run, "TURN_ALREADY_RUNNING");
    const run = { turnId: randomUUID(), controller: new AbortController(), authorize, finished: false };
    run.done = new Promise((resolve) => { run.resolve = resolve; });
    handle.run = run;
    this.core.storage.put("nativeActivity", handle.session.id, { id: handle.session.id, project: handle.session.project, upstream: handle.session.upstream, started: Date.now(), scope: "pi-agent-session" });
    this.emit(handle, "turn/start", { id: run.turnId });
    return run;
  }

  /** The end of a turn: Pi settled, the prompt promise ended, or a cancel gave up waiting. Runs once per turn. */
  settle(handle, run, failure) {
    if (run.finished) return;
    if (failure && !run.error) run.error = failure;
    const status = run.cancelRequested || run.aborted ? "interrupted" : run.error ? "failed" : "completed";
    this.emit(handle, "turn/end", { status, result: status === "failed" ? run.error : "" }, run.turnId);
    run.finished = true;
    if (handle.run === run) handle.run = null;
    this.core.storage.delete("nativeActivity", handle.session.id);
    // execution.idle releases the project lock in the bridge, whatever the outcome; turn/end carries the status.
    this.emit(handle, "execution.idle", { status }, run.turnId);
    run.controller.abort();
    run.resolve();
  }

  async assertWritable(handle) {
    const file = handle.agent?.sessionFile;
    if (file && (await foreignLease(file))) throw new Fault("PI_SESSION_OPEN_IN_APP");
  }

  async create(session, project, authorize = () => {}) {
    await this.open(session, project, authorize);
    return this.metadata(session);
  }

  async resume(session, authorize = () => {}) {
    await this.open(session, this.project(session), authorize);
  }

  async start(session, text, attachments = [], settings = {}, authorize = () => {}) {
    if (Object.keys(settings).length) await this.update(session, settings, authorize);
    const handle = await this.open(session, this.project(session), authorize);
    authorize();
    await this.assertWritable(handle);
    const run = this.newRun(handle, authorize);
    const input = composeInput(text, attachments);
    handle.agent
      .prompt(input.text, input.images.length ? { images: input.images } : {})
      .then(
        () => this.settle(handle, run),
        (error) => this.settle(handle, run, String(error?.message ?? error).slice(0, 2000) || "Pi 回复失败"),
      );
    return { turnId: run.turnId };
  }

  async steer(session, text) {
    const handle = this.handles.get(session.id);
    requireThat(handle?.run && !handle.run.finished, "NO_ACTIVE_TURN");
    await handle.agent.steer(text);
    return { accepted: true };
  }

  async cancel(session) {
    const handle = this.handles.get(session.id);
    const run = handle?.run;
    if (!run) return;
    run.cancelRequested = true;
    run.controller.abort();
    try {
      if (handle.agent?.isCompacting) handle.agent.abortCompaction();
      await handle.agent?.abort();
    } catch { /* settle below is authoritative */ }
    await Promise.race([run.done, sleep(20000)]);
    this.settle(handle, run);
  }

  async update(session, settings, authorize = () => {}) {
    await this.quiescent(session);
    authorize();
    const { title, ...rest } = settings;
    const handle = this.handles.get(session.id);
    if (handle) {
      await handle.ready;
      if (rest.model !== undefined) {
        const model = this.findModel(handle.agent.modelRuntime, rest.model);
        requireThat(model, "MODEL_UNAVAILABLE");
        await handle.agent.setModel(model);
      }
      Object.assign(session, rest);
      if (rest.reasoningEffort !== undefined) handle.agent.setThinkingLevel(rest.reasoningEffort);
      if (rest.permissionMode !== undefined) handle.agent.setActiveToolsByName(this.toolsFor(session));
      if (title !== undefined) {
        await this.assertWritable(handle);
        handle.agent.setSessionName(String(title).slice(0, 200));
      }
      session.model = modelKey(handle.agent.model) ?? session.model;
      session.reasoningEffort = handle.agent.thinkingLevel;
    } else {
      Object.assign(session, rest);
      if (title !== undefined && session.upstream) {
        await this.prepare();
        const file = this.sessionFile(session, this.cwd(session));
        if (file && !(await foreignLease(file))) this.sdk.SessionManager.open(file).appendSessionInfo(String(title).slice(0, 200));
      }
    }
    this.stored.delete(session.id);
    this.checkpoint(session, { ...this.metadata(session), ...(title !== undefined ? { title } : {}) });
    return { ...this.metadata(session), ...(title !== undefined ? { title } : {}) };
  }

  async compact(session, authorize = () => {}) {
    const handle = await this.open(session, this.project(session), authorize);
    await this.assertWritable(handle);
    const run = this.newRun(handle, authorize);
    handle.agent.compact().then(
      () => this.settle(handle, run),
      (error) => this.settle(handle, run, String(error?.message ?? error).slice(0, 2000) || "压缩失败"),
    );
    return { accepted: true, turnId: run.turnId };
  }

  /** History of a session nobody has opened here: read from its Pi file, cached until the file changes. */
  async storedHistory(session) {
    await this.prepare();
    const file = this.sessionFile(session, this.cwd(session));
    if (!file) return { events: [], usage: null, context: null };
    const { mtimeMs } = await stat(file);
    const cached = this.stored.get(session.id);
    if (cached && cached.file === file && cached.mtimeMs === mtimeMs) return cached;
    const manager = this.sdk.SessionManager.open(file);
    const branch = manager.getBranch();
    const context = manager.buildSessionContext();
    const entry = { file, mtimeMs, events: historyEvents(branch), usage: lastUsage(branch), context };
    this.stored.set(session.id, entry);
    return entry;
  }

  async read(session, { cursor } = {}) {
    const start = cursor === undefined || cursor === "" ? 0 : Number(cursor);
    requireThat(Number.isSafeInteger(start) && start >= 0, "CURSOR_INVALID");
    const handle = this.handles.get(session.id);
    let events;
    let usage = null;
    let window = 0;
    let modalities = ["text"];
    const meta = this.metadata(session);
    if (handle) {
      await handle.ready;
      events = handle.history;
      const stats = handle.agent.getContextUsage?.();
      window = handle.agent.model?.contextWindow ?? 0;
      modalities = handle.agent.model?.input ?? modalities;
      if (stats?.tokens) usage = { input: stats.tokens, output: 0 };
    } else {
      const stored = await this.storedHistory(session);
      events = stored.events;
      usage = stored.usage;
      if (stored.context?.model) {
        meta.model ??= stored.context.model.provider + "/" + stored.context.model.modelId;
        meta.reasoningEffort ??= stored.context.thinkingLevel;
        try {
          const model = (await this.modelRuntime()).getModel(stored.context.model.provider, stored.context.model.modelId);
          window = model?.contextWindow ?? 0;
          modalities = model?.input ?? modalities;
        } catch { /* the catalog is optional here */ }
      }
    }
    meta.permissionMode ??= "read-only";
    const page = events.slice(start, start + PAGE);
    return {
      ...meta,
      status: handle?.run ? "running" : "idle",
      events: page,
      nextCursor: start + PAGE < events.length ? String(start + PAGE) : "",
      inputModalities: modalities,
      // Shaped like a tokenUsage event (as Codex reports it), so the app reads snapshot and live usage alike.
      ...(usage || window ? { nativeState: { tokenUsage: tokenUsageEvent(usage ?? {}, window) } } : {}),
    };
  }

  async items(session, { turnId, cursor } = {}) {
    if (turnId !== undefined) string(turnId, 500);
    const snapshot = await this.read(session, { cursor });
    return { data: snapshot.events.filter((event) => !turnId || String(event.turn) === turnId), nextCursor: snapshot.nextCursor || null };
  }

  /**
   * The model and thinking level a new conversation starts with: Pi's configured default, else those of the user's
   * most recent conversation (pi-gui keeps its choice to itself, so its last conversation stands in for it).
   */
  async preferred(cwd) {
    await this.prepare();
    try {
      const settings = this.sdk.SettingsManager.create(cwd, this.sdk.getAgentDir());
      if (settings.getDefaultProvider() && settings.getDefaultModel())
        return { model: settings.getDefaultProvider() + "/" + settings.getDefaultModel(), effort: settings.getDefaultThinkingLevel() };
    } catch { /* no settings file */ }
    if (this.recent && Date.now() - this.recent.at < 60000) return this.recent.value;
    let value = {};
    try {
      const sessions = (await this.sdk.SessionManager.listAll()).filter((info) => info.messageCount).sort((a, b) => b.modified - a.modified);
      for (const info of sessions.slice(0, 5)) {
        const context = this.sdk.SessionManager.open(info.path).buildSessionContext();
        if (context.model) {
          value = { model: context.model.provider + "/" + context.model.modelId, effort: context.thinkingLevel };
          break;
        }
      }
    } catch { /* fall back to Pi's own choice */ }
    this.recent = { at: Date.now(), value };
    return value;
  }

  async models(project) {
    const runtime = await this.modelRuntime();
    const available = await runtime.getAvailable();
    const { model: preferred, effort } = await this.preferred(project.path);
    const data = available.map((model) => {
      const levels = supportedThinkingLevels(model);
      const fallback = levels.includes(effort ?? "medium") ? effort ?? "medium" : levels.at(-1);
      return {
        id: modelKey(model),
        model: modelKey(model),
        provider: model.provider,
        displayName: model.name || model.id,
        description: model.provider,
        inputModalities: model.input ?? ["text"],
        contextWindow: model.contextWindow,
        supportedReasoningEfforts: levels.map((reasoningEffort) => ({ reasoningEffort })),
        defaultReasoningEffort: fallback,
        isDefault: modelKey(model) === preferred,
      };
    });
    data.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    return { data, nextCursor: null, source: "pi-model-runtime", dynamicCatalog: true };
  }

  /** Conversations Pi (terminal or pi-gui) holds for the project's folders, newest first. Empty ones are left out. */
  async nativeSessions(project, { limit = 100 } = {}) {
    await this.prepare();
    const rows = [];
    for (const root of project.roots ?? [project.path]) {
      for (const info of await this.sdk.SessionManager.list(root)) {
        if (!info.messageCount) continue;
        rows.push({
          upstream: info.id,
          title: (info.name && !UNNAMED.has(info.name) ? info.name : firstLine(info.firstMessage)) || "未命名会话",
          updatedAt: info.modified instanceof Date ? info.modified.getTime() : Date.now(),
          cwd: info.cwd || root,
        });
      }
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  /**
   * The pi-gui app's workspaces, then every other folder Pi has conversations in; a folder that is already a
   * configured project is left to it (listed twice, its conversations would be too).
   */
  async nativeProjects() {
    await this.prepare();
    const real = async (path) => realpath(path).catch(() => path);
    const configured = new Set(await Promise.all((this.core?.projects ?? []).filter((project) => !project.app)
      .flatMap((project) => project.roots ?? [project.path]).map(real)));
    const byPath = new Map();
    try {
      const catalog = JSON.parse(await readFile(join(appDataDirectory(this.env), "catalogs.json"), "utf8"));
      for (const workspace of catalog.workspaces ?? []) {
        if (typeof workspace?.path === "string" && workspace.path) byPath.set(workspace.path, String(workspace.displayName || basename(workspace.path)));
      }
    } catch { /* pi-gui is optional */ }
    for (const info of await this.sdk.SessionManager.listAll()) {
      if (info.cwd && info.messageCount && !byPath.has(info.cwd)) byPath.set(info.cwd, basename(info.cwd));
    }
    const rows = [];
    for (const [path, title] of byPath) {
      if (!configured.has(await real(path))) rows.push({ key: "pi:" + path, title, roots: [path] });
    }
    return rows;
  }

  async diff(session) {
    try {
      const result = await exec("git", ["-C", this.project(session).path, "diff", "--no-ext-diff", "--binary"], { timeout: 10000, maxBuffer: 4_000_000, windowsHide: true });
      return { diff: result.stdout, scope: "working-tree", available: true };
    } catch {
      return { diff: "", scope: "working-tree", available: false };
    }
  }

  async quiescent(session) {
    requireThat(!this.handles.get(session.id)?.run, "TURN_NOT_QUIESCENT");
  }

  async deactivate(session) {
    await this.cancel(session);
    await this.closeHandle(session.id);
  }

  async closeHandle(id) {
    const handle = this.handles.get(id);
    if (!handle) return;
    this.handles.delete(id);
    try { await handle.ready; } catch { return; }
    this.flush(handle);
    handle.unsubscribe?.();
    try { handle.agent?.dispose(); } catch { /* already disposed */ }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.handles.values()].map(async (handle) => {
      if (handle.run) await this.cancel(handle.session);
      await this.closeHandle(handle.session.id);
    }));
  }
}
