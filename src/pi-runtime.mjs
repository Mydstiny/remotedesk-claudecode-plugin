import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
// The SDK surfaces the adapter relies on (sessions, model runtime, inline extensions) are stable from 1.0.
export const PI_MIN_VERSION = [1, 0, 0];

function newer(version, minimum) {
  const parts = String(version).split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((parts[i] ?? 0) !== minimum[i]) return (parts[i] ?? 0) > minimum[i];
  }
  return true;
}

async function packageAt(directory) {
  try {
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    return manifest.name === PI_PACKAGE ? { directory, version: manifest.version } : null;
  } catch {
    return null;
  }
}

/**
 * Where the user's Pi lives: REMOTEDESK_PI_PACKAGE, then the package behind the `pi` command on PATH, then the
 * global npm root. RemoteDesk drives the same Pi, credentials and sessions the user already has.
 */
export async function locatePi(env = process.env) {
  const candidates = [];
  if (env.REMOTEDESK_PI_PACKAGE) candidates.push(env.REMOTEDESK_PI_PACKAGE);
  try {
    const { stdout } = await exec("/usr/bin/env", ["which", "pi"], { env, timeout: 5000 });
    const command = await realpath(stdout.trim());
    // <package>/dist/bundle/cli.js or <package>/dist/cli.js
    let directory = dirname(command);
    for (let i = 0; i < 4; i++, directory = dirname(directory)) candidates.push(directory);
  } catch {
    // No pi on PATH; the npm root below may still have it.
  }
  try {
    const { stdout } = await exec("npm", ["root", "-g"], { env, timeout: 10000 });
    candidates.push(join(stdout.trim(), PI_PACKAGE));
  } catch {
    // npm unavailable.
  }
  candidates.push(join("/opt/homebrew/lib/node_modules", PI_PACKAGE), join("/usr/local/lib/node_modules", PI_PACKAGE));
  for (const candidate of candidates) {
    const found = await packageAt(candidate);
    if (found) return found;
  }
  return null;
}

/** Imports the user's Pi SDK. Throws PI_NOT_INSTALLED or PI_VERSION_UNSUPPORTED. */
export async function loadPi(env = process.env) {
  const found = await locatePi(env);
  if (!found) throw Object.assign(new Error("PI_NOT_INSTALLED"), { code: "PI_NOT_INSTALLED" });
  if (!newer(found.version, PI_MIN_VERSION))
    throw Object.assign(new Error("PI_VERSION_UNSUPPORTED"), { code: "PI_VERSION_UNSUPPORTED", version: found.version });
  const sdk = await import(pathToFileURL(join(found.directory, "dist", "index.js")).href);
  return { sdk, version: found.version, directory: found.directory };
}
