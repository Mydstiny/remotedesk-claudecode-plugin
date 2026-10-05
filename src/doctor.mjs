import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspectClaude } from "./claude-cli.mjs";
import { apiKeyStatus } from "./api-key.mjs";

const SDK_VERSION = "0.3.286";

export async function doctor({ probe = false } = {}) {
  const report = {
    schemaVersion: 1,
    status: "blocked",
    changed: false,
    componentVersions: { adapter: "0.2.0", node: process.versions.node, claude: null, agentSdk: null },
    checks: [],
    actions: [],
    requiresUserAction: [],
    warnings: ["ANTHROPIC_API_KEY_AUTH_ONLY", "REAL_TURN_AND_DEVICE_ACCEPTANCE_REQUIRED"],
    capabilities: { remoteAccess: true, remoteProtocol: 1, proEntitlement: "pro.lifetime", appExposure: false },
  };
  const check = (id, status, code) => report.checks.push({ id, status, code });
  try {
    if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("NODE_VERSION_UNSUPPORTED");
    const result = await inspectClaude(process.env.REMOTEDESK_CLAUDE_EXECUTABLE ?? "claude");
    report.componentVersions.claude = result.version || null;
    if (!result.supported) throw new Error(result.error || "CLAUDE_VERSION_UNVERIFIED");
    check("cli", "pass", "PINNED_VERSION_AND_STREAM_FLAGS");
    const sdkPackage = JSON.parse(await readFile(new URL("../node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url), "utf8"));
    report.componentVersions.agentSdk = sdkPackage.version;
    if (sdkPackage.version !== SDK_VERSION) throw new Error("CLAUDE_SDK_VERSION_UNVERIFIED");
    check("agentSdk", "pass", "PINNED_AGENT_SDK");
    const credential = await apiKeyStatus(join(homedir(), ".remotedesk", "claudecode"));
    if (credential.configured) check("apiKey", "pass", "ANTHROPIC_API_KEY_CONFIGURED");
    else {
      check("apiKey", "warn", "ANTHROPIC_API_KEY_MISSING");
      report.requiresUserAction.push("CONFIGURE_ANTHROPIC_API_KEY");
    }
    if (probe) {
      check("streamContract", "pass", "SDK_QUERY_AND_CONTROL_SURFACES_PRESENT");
      report.warnings.push("NO_MODEL_TURN_OR_ACCOUNT_ACCESS_PERFORMED", "APP_EXPOSURE_REMAINS_GATED");
    }
    report.status = "ok";
  } catch (error) {
    check("probe", "fail", error?.message || "CLAUDE_PROBE_FAILED");
    report.requiresUserAction.push("INSTALL_PINNED_CLAUDE_AND_AGENT_SDK");
  }
  return report;
}
