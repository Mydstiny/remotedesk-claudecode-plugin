// Pi messages and session entries to the RemoteDesk transcript events the app already reads for agent engines
// (assistant/chunk, assistant/message, tool/call, user/message with tool_result blocks, turn/end, session/compacted).
// Pi names its tools in lower case with its own arguments; the app shows them under the tool names it already knows (Read, Bash, Edit, …).

export const READ_TOOLS = Object.freeze(["read", "grep", "find", "ls"]);
export const WRITE_TOOLS = Object.freeze(["bash", "edit", "write"]);
export const ALL_TOOLS = Object.freeze([...READ_TOOLS, ...WRITE_TOOLS]);
export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const OUTPUT_LIMIT = 16000;

const TOOL_NAMES = { read: "Read", bash: "Bash", edit: "Edit", write: "Write", grep: "Grep", find: "Glob", ls: "LS" };

function clip(text, limit = OUTPUT_LIMIT) {
  const value = typeof text === "string" ? text : "";
  return value.length > limit ? value.slice(0, limit) + "\n…（输出过长，其余内容在电脑端）" : value;
}

/** A Pi tool call as the app's tool name and input (Read/Edit/Write take file_path; Edit old_string/new_string). */
export function toolView(name, args) {
  const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  switch (name) {
    case "read":
      return { name: "Read", input: { file_path: input.path, ...(input.offset ? { offset: input.offset } : {}), ...(input.limit ? { limit: input.limit } : {}) } };
    case "bash":
      return { name: "Bash", input: { command: input.command, ...(input.timeout ? { timeout: input.timeout } : {}) } };
    case "edit": {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      if (edits.length === 1)
        return { name: "Edit", input: { file_path: input.path, old_string: edits[0]?.oldText ?? "", new_string: edits[0]?.newText ?? "" } };
      return { name: "MultiEdit", input: { file_path: input.path, edits: edits.map((edit) => ({ old_string: edit?.oldText ?? "", new_string: edit?.newText ?? "" })) } };
    }
    case "write":
      return { name: "Write", input: { file_path: input.path, content: input.content } };
    case "grep":
    case "find":
    case "ls":
      return { name: TOOL_NAMES[name], input };
    default:
      return { name: String(name ?? "tool"), input };
  }
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

/** User content: text stays, images become a marker (the app shows ［图片］ and never needs the bytes back). */
export function userBlocks(content) {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (block?.type === "text" && block.text) return [{ type: "text", text: block.text }];
    if (block?.type === "image") return [{ type: "image" }];
    return [];
  });
}

export function assistantBlocks(content) {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (block?.type === "text" && block.text) return [{ type: "text", text: block.text }];
    if (block?.type === "thinking" && block.thinking && !block.redacted) return [{ type: "thinking", thinking: block.thinking }];
    if (block?.type === "toolCall") {
      const view = toolView(block.name, block.arguments);
      return [{ type: "tool_use", id: block.id, name: view.name, input: view.input }];
    }
    return [];
  });
}

export function toolResultBlock(message) {
  return { type: "tool_result", tool_use_id: message.toolCallId, content: clip(textOf(message.content)), is_error: message.isError === true };
}

/** Tokens the model saw for this reply (prompt incl. cache) and wrote; the prompt plus reply is the context in use. */
export function usageOf(usage) {
  const prompt = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
  return { inputTokens: prompt, outputTokens: usage?.output ?? 0, contextTokens: prompt + (usage?.output ?? 0) };
}

export function tokenUsageEvent(usage, contextWindow) {
  const used = usageOf(usage);
  return { tokenUsage: { last: { totalTokens: used.contextTokens, inputTokens: used.inputTokens, outputTokens: used.outputTokens }, ...(contextWindow ? { modelContextWindow: contextWindow } : {}) } };
}

/** Thinking levels a model accepts, as Pi computes them (pi-ai getSupportedThinkingLevels). */
export function supportedThinkingLevels(model) {
  if (!model?.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

export function modelKey(model) {
  return model ? model.provider + "/" + model.id : undefined;
}

export function firstLine(text, limit = 80) {
  const line = String(text ?? "").split("\n").map((value) => value.trim()).find(Boolean) ?? "";
  return line.length > limit ? line.slice(0, limit) + "…" : line;
}

/**
 * The active branch of a stored Pi session as transcript events. A turn starts at each user message; replies,
 * tool calls and tool results that follow belong to it. A failed or aborted reply ends its turn with that status.
 */
export function historyEvents(entries) {
  const events = [];
  let turn = "";
  const push = (type, data) => events.push({ seq: events.length, type, data, ...(turn ? { turn } : {}) });
  for (const entry of entries ?? []) {
    if (entry?.type === "compaction") {
      push("session/compacted", { tokensBefore: entry.tokensBefore ?? 0 });
      continue;
    }
    if (entry?.type !== "message") continue;
    const message = entry.message ?? {};
    if (message.role === "user") {
      turn = entry.id;
      const content = userBlocks(message.content);
      if (content.length) push("user/message", { message: { role: "user", content } });
    } else if (message.role === "assistant") {
      const content = assistantBlocks(message.content);
      if (content.length) push("assistant/message", { message: { role: "assistant", content }, usage: usageOf(message.usage) });
      if (message.stopReason === "error") push("turn/end", { status: "failed", result: message.errorMessage ?? "" });
      else if (message.stopReason === "aborted") push("turn/end", { status: "interrupted", result: "" });
    } else if (message.role === "toolResult") {
      push("user/message", { message: { role: "user", content: [toolResultBlock(message)] } });
    } else if (message.role === "bashExecution") {
      // A shell command the user ran directly in Pi (`!cmd`): a finished Bash step.
      push("tool/call", { id: entry.id, name: "Bash", input: { command: message.command } });
      push("user/message", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: entry.id, content: clip(message.output), is_error: message.exitCode !== 0 && message.exitCode !== undefined }] } });
    }
  }
  return events;
}

/** The newest assistant usage on the branch: what the context held after the last reply. */
export function lastUsage(entries) {
  for (let i = (entries?.length ?? 0) - 1; i >= 0; i--) {
    const message = entries[i]?.type === "message" ? entries[i].message : null;
    if (message?.role === "assistant" && message.usage && message.stopReason !== "aborted" && message.stopReason !== "error") return message.usage;
    if (entries[i]?.type === "compaction") return null;
  }
  return null;
}
