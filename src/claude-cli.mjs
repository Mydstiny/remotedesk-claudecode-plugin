import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const SUPPORTED_VERSION = "2.1.286";
export const REQUIRED_FLAGS = ["--print", "--input-format", "--output-format", "--permission-mode"];

export function parseVersion(text) {
  const match = /(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/.exec(String(text));
  return match?.[1] ?? "";
}

export async function inspectClaude(executable = "claude") {
  try {
    const versionResult = await execFileAsync(executable, ["--version"], { timeout: 5000, windowsHide: true });
    const version = parseVersion(versionResult.stdout + "\n" + versionResult.stderr);
    const helpResult = await execFileAsync(executable, ["--help"], { timeout: 5000, windowsHide: true });
    const help = helpResult.stdout + "\n" + helpResult.stderr;
    const missing = REQUIRED_FLAGS.filter((flag) => !help.includes(flag));
    return {
      executable,
      version,
      supported: version === SUPPORTED_VERSION && missing.length === 0,
      parity: "UNVERIFIED_CLAUDE_PROTOCOL",
      missingFlags: missing,
    };
  } catch (error) {
    return {
      executable,
      version: "",
      supported: false,
      parity: "CLAUDE_EXECUTABLE_UNAVAILABLE",
      missingFlags: REQUIRED_FLAGS,
      error: error?.code === "ENOENT" ? "CLAUDE_EXECUTABLE_UNAVAILABLE" : "CLAUDE_PROBE_FAILED",
    };
  }
}

export function printArgs(prompt, { cwd, permissionMode = "dontAsk" } = {}) {
  if (typeof prompt !== "string" || prompt.length > 128000) throw new Error("PROMPT_INVALID");
  if (typeof cwd !== "string" || cwd === "") throw new Error("WORKSPACE_REQUIRED");
  if (!["dontAsk", "plan", "manual"].includes(permissionMode)) throw new Error("PERMISSION_MODE_UNSUPPORTED");
  return ["--print", "--input-format", "text", "--output-format", "stream-json", "--no-session-persistence", "--no-chrome", "--permission-mode", permissionMode, "--permission-prompts", "none", prompt];
}

export function parseStreamLine(line) {
  if (line.trim() === "") return null;
  let event;
  try { event = JSON.parse(line); } catch { throw new Error("CLAUDE_STREAM_INVALID"); }
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("CLAUDE_STREAM_INVALID");
  return event;
}

export function spawnPrint(executable, prompt, options = {}) {
  const child = spawn(executable, printArgs(prompt, options), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return child;
}
