// Claude Agent runs on an Anthropic API key only. Anthropic does not allow third-party products built on the Claude
// Agent SDK to offer claude.ai login or subscription rate limits, so the bridge never falls back to a Claude
// account: it passes its own key to the SDK, strips other credentials from the child environment and rejects a
// session whose reported credential is not an API key.
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Fault } from "../packages/bridge-core/lib/errors.mjs";

export const API_KEY_FILE = "anthropic-api-key";
// Credential sources reported by the SDK that are API keys.
export const API_KEY_SOURCES = new Set(["ANTHROPIC_API_KEY", "apiKeyHelper"]);
const KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,250}$/;
const STRIPPED = ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

export function validApiKey(value) {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

/** The key in use: the service environment first, then the private file in the state directory. */
export async function readApiKey(state, env = process.env) {
  const fromEnvironment = typeof env?.ANTHROPIC_API_KEY === "string" ? env.ANTHROPIC_API_KEY.trim() : "";
  if (fromEnvironment !== "") return { key: fromEnvironment, source: "environment" };
  if (typeof state !== "string" || state === "") return { key: "", source: "none" };
  try {
    const stored = (await readFile(join(state, API_KEY_FILE), "utf8")).trim();
    if (stored !== "") return { key: stored, source: "file" };
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Fault("API_KEY_UNREADABLE");
  }
  return { key: "", source: "none" };
}

/** Safe to show: whether a key is configured, where it comes from and its last four characters. */
export async function apiKeyStatus(state, env = process.env) {
  const { key, source } = await readApiKey(state, env);
  return { kind: "anthropicApiKey", required: true, configured: key !== "", source, hint: key ? "…" + key.slice(-4) : "" };
}

export async function saveApiKey(state, value) {
  const key = typeof value === "string" ? value.trim() : "";
  if (!validApiKey(key)) throw new Fault("API_KEY_INVALID");
  const target = join(state, API_KEY_FILE);
  const temporary = target + "." + process.pid + ".tmp";
  await writeFile(temporary, key + "\n", { mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function clearApiKey(state) {
  await unlink(join(state, API_KEY_FILE)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

/** Child environment that can only authenticate with this API key. */
export function apiKeyEnvironment(base, key) {
  const env = { ...base };
  for (const name of STRIPPED) delete env[name];
  env.ANTHROPIC_API_KEY = key;
  return env;
}

/** `api-key --action set|status|clear`; `set` reads the key from stdin so it never appears in argv or shell history. */
export async function apiKeyCommand(state, action, input = process.stdin) {
  if (action === "set") {
    let text = "";
    for await (const chunk of input) {
      text += chunk;
      if (text.length > 4096) throw new Fault("API_KEY_INVALID");
    }
    await saveApiKey(state, text);
  } else if (action === "clear") {
    await clearApiKey(state);
  } else if (action !== "status" && action !== undefined) {
    throw new Fault("API_KEY_ACTION_INVALID");
  }
  return apiKeyStatus(state);
}
